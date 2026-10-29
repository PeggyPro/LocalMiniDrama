const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const planning = require('../src/services/videoPlanningService');
const execution = require('../src/services/videoPlanExecutionService');
const { snapshotConnection } = require('../src/services/videoExecutionProvider');

function fixture(t) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE episodes(id INTEGER PRIMARY KEY,drama_id INTEGER,deleted_at TEXT);
    CREATE TABLE storyboards(id INTEGER PRIMARY KEY,episode_id INTEGER,storyboard_number INTEGER,title TEXT,description TEXT,video_prompt TEXT,duration REAL,deleted_at TEXT);
    CREATE TABLE ai_service_configs(id INTEGER PRIMARY KEY,service_type TEXT,provider TEXT,api_protocol TEXT,base_url TEXT,api_key TEXT,model TEXT,default_model TEXT,settings TEXT,is_active INTEGER,is_default INTEGER,priority INTEGER,deleted_at TEXT);
    INSERT INTO episodes VALUES(1,10,NULL),(2,10,NULL),(3,20,NULL);
    INSERT INTO storyboards VALUES(1,1,1,'A','first','first',5,NULL),(2,1,2,'B','second','second',5,NULL),(3,2,1,'C','cross episode','cross episode',5,NULL),(4,3,1,'D','other drama','other drama',5,NULL);
    INSERT INTO ai_service_configs VALUES(1,'video','comfyui','comfyui','http://original:8188','original-secret','["h3-long-drama-first"]','h3-long-drama-first','{}',1,1,0,NULL);`);
  planning.ensureVideoPlanningSchema(db); execution.ensureVideoExecutionSchema(db);
  t.after(() => db.close());
  return db;
}
function choose(db, id, model = 'h3-long-drama-first', source = null) {
  const revision = planning.getStoryboardVideoPlan(db, id).choice_revision;
  return planning.setVideoChoice(db, id, { expected_revision: revision, model_id: model, source_ref: source, manual_locked: true });
}
function adapters(db, options = {}) {
  const calls = { submit: [], poll: [], preflight: [], compose: [] };
  let count = 0;
  const identity = n => ({ task_id: 'lmd-comfy-' + n.toString(16).padStart(32, '0'), prompt_id: 'prompt-' + n });
  const provider = {
    snapshotConnection,
    async preflight(connection, node, source) {
      calls.preflight.push({ connection, node, source });
      if (options.preflight) await options.preflight(connection, node, source);
      return { body: {} };
    },
    async submit(connection, node, prepared, attempt) {
      assert.equal(db.prepare('SELECT status FROM video_execution_attempts WHERE id=?').get(attempt.id).status, 'submitting', 'attempt is durable before submission');
      assert.equal(db.prepare('SELECT status FROM video_execution_nodes WHERE id=?').get(node.id).status, 'submitting');
      calls.submit.push({ connection, node, attempt });
      const result = { ...identity(++count), status: options.processing ? 'processing' : 'completed', model: node.model_id, video_url: connection.base_url + '/view?filename=clip.mp4' };
      if (options.submit) return options.submit(connection, node, attempt, result);
      return result;
    },
    async poll(connection, node, attempt) {
      calls.poll.push({ connection, node, attempt });
      if (options.poll) return options.poll(connection, node, attempt);
      return { task_id: attempt.task_id, prompt_id: attempt.prompt_id, status: 'completed', video_url: connection.base_url + '/view?filename=clip.mp4' };
    },
    async resolveLatent(connection, node, attempt, result, iteration) {
      if (options.noLatent) return { state: 'blocked', blocking_reasons: ['latent_missing'] };
      const filename = `latents/localminidrama/${attempt.task_id}/latent_00001.safetensors`;
      return { state: 'ready', structure_verified: true, loadability_verified: false, blocking_reasons: [], filename, loader_ref: filename + ' [output]',
        task_id: attempt.task_id, prompt_id: attempt.prompt_id, connection_identity: connection.identity,
        continuation_model: node.workflow.continuation_model, iteration, save_node_id: '910', evidence: 'test_history' };
    },
  };
  const media = {
    async materialize(connection, node, result, id) {
      if (options.mediaFail) throw new Error('test_download_failure');
      return { video_url: '/static/' + id + '.mp4', local_path: id + '.mp4', duration: 5 };
    },
    async compose(connection, segments, id) {
      calls.compose.push(segments.map(s => s.id));
      return { video_url: '/static/' + id + '.mp4', local_path: id + '.mp4', duration: segments.reduce((n, s) => n + s.duration, 0) };
    },
  };
  return { calls, options, service: execution.createVideoPlanExecutionService({ provider, media, autoSchedule: false }) };
}
const preview = (service, db, ids = [1], extras = {}) => service.previewPlan(db, {}, null, { episode_id: ids[0] === 3 ? 2 : 1, storyboard_ids: ids, ...extras });
const run = (service, db, plan) => service.runPlan(db, {}, null, plan.id, { expected_revision: plan.revision });

test('preview freezes a finite graph, canonical choice, input and original connection without submitting', async t => {
  const db = fixture(t); choose(db, 1); choose(db, 2, 'h3-long-drama-continue', { kind: 'storyboard', storyboard_id: 1, choice_revision: 1 });
  const { service, calls } = adapters(db);
  const plan = await preview(service, db, [2, 1], { inputs: { 2: { prompt: 'frozen prompt', first_frame_url: '/static/start.png', duration: 6 } } });
  assert.equal(plan.status, 'preview'); assert.equal(plan.nodes.length, 2);
  assert.equal(plan.nodes[0].status, 'waiting_dependency'); assert.equal(plan.nodes[0].source_node_id, plan.nodes[1].id);
  assert.equal(plan.nodes[0].inputs.prompt, 'frozen prompt');
  assert.equal(calls.submit.length, 0); assert.equal(calls.preflight.length, 0);
  assert.ok(!JSON.stringify(plan).includes('original-secret'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM video_execution_nodes').get().n, 2);
  db.prepare("UPDATE ai_service_configs SET base_url='http://replacement:8188',api_key='new-secret'").run();
  const result = await run(service, db, plan);
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls.submit.map(c => c.node.storyboard_id), [1, 2]);
  assert.ok(calls.submit.every(c => c.connection.base_url === 'http://original:8188' && c.connection.api_key === 'original-secret'));
  assert.equal(calls.preflight[1].source.iteration, 0);
  assert.equal(db.prepare('SELECT iteration FROM video_segments WHERE storyboard_id=2').get().iteration, 1);
  assert.ok(calls.compose.every(members => members.length === 1));
  assert.equal(planning.getStoryboardVideoPlan(db, 1).selected_version_id, null);
});

test('choice/content changes after preview reject run, including edits while preflight awaits', async t => {
  const db = fixture(t); choose(db, 1);
  const { service, calls } = adapters(db);
  const plan = await preview(service, db);
  db.prepare("UPDATE storyboards SET video_prompt='changed' WHERE id=1").run();
  await assert.rejects(run(service, db, plan), { status: 409 });
  assert.equal(calls.submit.length, 0);
  choose(db, 1);
  const a = adapters(db, { preflight: async () => { choose(db, 1); } });
  const p2 = await preview(a.service, db);
  const result = await run(a.service, db, p2);
  assert.equal(result.nodes[0].status, 'blocked'); assert.equal(a.calls.submit.length, 0);
});

test('unbound outside-plan future source stays waiting and does not generate another episode', async t => {
  const db = fixture(t); choose(db, 1); choose(db, 3, 'h3-long-drama-continue', { kind: 'storyboard', storyboard_id: 1, choice_revision: 1 });
  const { service, calls } = adapters(db);
  const plan = await preview(service, db, [3]);
  const result = await run(service, db, plan);
  assert.equal(result.nodes[0].status, 'waiting_dependency');
  assert.equal(calls.submit.length, 0); assert.equal(result.nodes.length, 1);
  assert.equal((await service.resumePlan(db, {}, null, plan.id)).nodes.length, 1);
});

test('completed video without latent stays playable/adoptable but cannot start its child', async t => {
  const db = fixture(t); choose(db, 1); choose(db, 2, 'h3-long-drama-continue', { kind: 'storyboard', storyboard_id: 1, choice_revision: 1 });
  const { service, calls } = adapters(db, { noLatent: true });
  const result = await run(service, db, await preview(service, db, [1, 2]));
  assert.equal(result.status, 'partial'); assert.equal(result.nodes[0].status, 'completed'); assert.equal(result.nodes[1].status, 'blocked');
  assert.equal(calls.submit.length, 1);
  const version = service.listVersions(db, 1).items[0];
  assert.equal(version.status, 'completed'); assert.equal(version.continuable, false); assert.deepEqual(version.blocking_reasons, ['latent_missing']);
  const adopted = service.adoptVersion(db, 1, { expected_revision: 0, version_id: version.id });
  assert.equal(adopted.selected_version_id, version.id); assert.equal(adopted.adoption_revision, 1);
  assert.equal(adopted.choice.revision, 1);
  assert.throws(() => service.adoptVersion(db, 1, { expected_revision: 0, version_id: version.id }), { status: 409 });
  assert.throws(() => service.adoptVersion(db, 2, { expected_revision: 0, version_id: version.id }), { status: 400 });
});

test('cross-episode continuation creates a new segment only; explicit same-card append keeps only that version members', async t => {
  const db = fixture(t); choose(db, 1);
  const { service, calls } = adapters(db);
  const first = await run(service, db, await preview(service, db));
  const v1 = service.listVersions(db, 1).items[0];
  choose(db, 3, 'h3-long-drama-continue', v1.source_ref);
  await run(service, db, await preview(service, db, [3]));
  const cross = service.listVersions(db, 3).items[0];
  assert.equal(cross.segment_ids.length, 1); assert.ok(!cross.segment_ids.includes(v1.tail_segment_id));
  assert.equal(db.prepare('SELECT parent_segment_id FROM video_segments WHERE id=?').get(cross.tail_segment_id).parent_segment_id, v1.tail_segment_id);
  await assert.rejects(preview(service, db, [3], { append_version_id: v1.id }), { status: 400 });
  choose(db, 1, 'h3-long-drama-continue', v1.source_ref);
  await run(service, db, await preview(service, db, [1], { append_version_id: v1.id }));
  const versions = service.listVersions(db, 1).items;
  const appended = versions.find(v => v.append_version_id === v1.id);
  assert.deepEqual(appended.segment_ids.slice(0, -1), v1.segment_ids);
  assert.equal(appended.segment_ids.length, 2); assert.equal(appended.duration, 10);
  assert.deepEqual(versions.find(v => v.id === v1.id), v1, 'old immutable version unchanged');
  assert.equal(first.nodes[0].version_id, v1.id); assert.equal(calls.compose.at(-1).length, 2);
});

test('network ambiguity persists submitted_unknown and every resume/recovery refuses resubmission', async t => {
  const db = fixture(t); choose(db, 1);
  const a = adapters(db, { submit: async () => { throw new Error('socket lost original-secret'); } });
  const result = await run(a.service, db, await preview(a.service, db));
  assert.equal(result.status, 'submitted_unknown'); assert.equal(result.nodes[0].attempt.status, 'submitted_unknown');
  assert.ok(!JSON.stringify(result).includes('original-secret'));
  await a.service.resumePlan(db, {}, null, result.id); await a.service.recoverPlans(db, {}, null);
  const restarted = adapters(db); await restarted.service.recoverPlans(db, {}, null);
  assert.equal(a.calls.submit.length, 1); assert.equal(restarted.calls.submit.length, 0); assert.equal(restarted.calls.poll.length, 0);
});

test('known-task restart polls persisted original connection even if config is deleted', async t => {
  const db = fixture(t); choose(db, 1);
  const a = adapters(db, { processing: true });
  const result = await run(a.service, db, await preview(a.service, db));
  assert.equal(result.nodes[0].status, 'processing');
  db.exec('DELETE FROM ai_service_configs');
  choose(db, 1); // New intent does not destroy an already submitted historical version.
  const restarted = adapters(db); await restarted.service.recoverPlans(db, {}, null);
  assert.equal(restarted.calls.submit.length, 0); assert.equal(restarted.calls.poll.length, 1);
  assert.equal(restarted.calls.poll[0].connection.base_url, 'http://original:8188');
  assert.equal(restarted.calls.poll[0].attempt.task_id, result.nodes[0].attempt.task_id);
  assert.equal(restarted.service.getPlan(db, result.id).status, 'completed');
});

test('crash with persisted submitting attempt but no task is unknown; media failure retries only local finalization', async t => {
  const db = fixture(t); choose(db, 1);
  const a = adapters(db, { processing: true });
  const result = await run(a.service, db, await preview(a.service, db));
  db.prepare("UPDATE video_execution_attempts SET task_id=NULL,prompt_id=NULL,status='submitting'").run();
  await a.service.resumePlan(db, {}, null, result.id);
  assert.equal(a.service.getPlan(db, result.id).status, 'submitted_unknown'); assert.equal(a.calls.submit.length, 1);
  const b = adapters(db, { mediaFail: true });
  const failed = await run(b.service, db, await preview(b.service, db));
  assert.equal(failed.nodes[0].status, 'media_failed');
  b.options.mediaFail = false;
  await b.service.resumePlan(db, {}, null, failed.id);
  assert.equal(b.service.getPlan(db, failed.id).status, 'completed'); assert.equal(b.calls.submit.length, 1); assert.equal(b.calls.poll.length, 0);
});

test('concurrent resume calls cannot submit a duplicate and preview cannot be resumed', async t => {
  const db = fixture(t); choose(db, 1);
  const { service, calls } = adapters(db, { processing: true });
  const plan = await preview(service, db);
  await assert.rejects(service.resumePlan(db, {}, null, plan.id), { status: 409 });
  await run(service, db, plan);
  await Promise.all([service.resumePlan(db, {}, null, plan.id), service.resumePlan(db, {}, null, plan.id)]);
  assert.equal(calls.submit.length, 1); assert.equal(calls.poll.length, 1);
  await assert.rejects(run(service, db, plan), { status: 409 });
});

test('cyclic or draft imported choices cannot execute; unrelated ready nodes still run', async t => {
  const db = fixture(t); choose(db, 1); choose(db, 2);
  db.prepare("UPDATE storyboard_video_plans SET choice_phase='draft' WHERE storyboard_id=2").run();
  const { service, calls } = adapters(db);
  const result = await run(service, db, await preview(service, db, [1, 2]));
  assert.equal(result.nodes[0].status, 'completed'); assert.equal(result.nodes[1].status, 'blocked'); assert.equal(calls.submit.length, 1);
  for (const id of [1, 2]) db.prepare("UPDATE storyboard_video_plans SET choice_json=?,choice_phase='final' WHERE storyboard_id=?").run(JSON.stringify({model_id:'h3-long-drama-continue',source_ref:{kind:'storyboard',storyboard_id:3-id,choice_revision:1}}),id);
  const cycle = await run(service, db, await preview(service, db, [1, 2]));
  assert.ok(cycle.nodes.every(n => n.status === 'blocked' && n.blocking_reasons.includes('dependency_cycle')));
  assert.equal(calls.submit.length, 1);
});

test('same-revision results from another plan never replace the frozen producer node', async t => {
  const db = fixture(t); choose(db, 1); choose(db, 2, 'h3-long-drama-continue', { kind: 'storyboard', storyboard_id: 1, choice_revision: 1 });
  const { service } = adapters(db);
  await run(service, db, await preview(service, db));
  const oldVersion = service.listVersions(db, 1).items[0];
  const plan = await preview(service, db, [2, 1]);
  assert.equal(plan.nodes[0].source_version_id, null);
  assert.equal(plan.nodes[0].source_node_id, plan.nodes[1].id);
  const result = await run(service, db, plan);
  const tail = db.prepare('SELECT parent_segment_id FROM video_segments WHERE id=?').get(service.listVersions(db, 2).items[0].tail_segment_id);
  assert.notEqual(tail.parent_segment_id, oldVersion.tail_segment_id);
  assert.equal(tail.parent_segment_id, service.listVersions(db, 1).items.find(v => v.id === result.nodes[1].version_id).tail_segment_id);
});

test('upstream failure blocks its earlier-positioned child instead of leaving permanent waiting', async t => {
  const db = fixture(t); choose(db, 1); choose(db, 2, 'h3-long-drama-continue', { kind: 'storyboard', storyboard_id: 1, choice_revision: 1 });
  const a = adapters(db, { submit: async (connection, node, attempt, result) => ({ ...result, status: 'failed', error: 'execution failed' }) });
  const plan = await run(a.service, db, await preview(a.service, db, [2, 1]));
  assert.equal(plan.nodes[0].status, 'blocked'); assert.deepEqual(plan.nodes[0].blocking_reasons, ['source_execution_failed']);
  assert.equal(a.calls.submit.length, 1);
});

test('effective frozen continuation prompt forbids cuts; style and randomized seed remain frozen', async t => {
  const db = fixture(t); choose(db, 1); choose(db, 2, 'h3-long-drama-continue', { kind: 'storyboard', storyboard_id: 1, choice_revision: 1 });
  const { service } = adapters(db);
  const plan = await preview(service, db, [1, 2], { inputs: { 1: { style: 'cinematic', seed: -1 }, 2: { prompt: '切换镜头到另一个房间' } } });
  assert.equal(plan.nodes[0].inputs.style, 'cinematic'); assert.equal(plan.nodes[0].inputs.prompt, 'first. Style: cinematic'); assert.ok(plan.nodes[0].inputs.seed >= 0);
  const styled = await preview(service, db, [1, 2], { inputs: { 1: { prompt: 'CINEMATIC first', style: ' cinematic ' }, 2: { prompt: '继续对话', style: '切换镜头到另一场景' } } });
  assert.equal(styled.nodes[0].inputs.prompt, 'CINEMATIC first');
  assert.ok(styled.nodes[1].blocking_reasons.includes('continuation_prompt_has_cut_instructions'));
  assert.equal(service.getPlan(db, plan.id).nodes[0].inputs.seed, plan.nodes[0].inputs.seed);
  assert.equal(plan.nodes[1].status, 'blocked'); assert.ok(plan.nodes[1].blocking_reasons.includes('continuation_prompt_has_cut_instructions'));
});

test('source picker propagates stale upstream validation; explicit resume safely retries preflight only', async t => {
  const db = fixture(t); choose(db, 1); choose(db, 2, 'h3-long-drama-continue', { kind: 'storyboard', storyboard_id: 1, choice_revision: 1 });
  const a = adapters(db, { preflight: async () => { throw new Error('runtime missing'); } });
  const plan = await run(a.service, db, await preview(a.service, db, [1, 2]));
  assert.equal(plan.nodes[0].status, 'blocked'); assert.equal(plan.nodes[1].status, 'blocked');
  a.options.preflight = null;
  await a.service.resumePlan(db, {}, null, plan.id);
  assert.equal(a.service.getPlan(db, plan.id).status, 'completed'); assert.equal(a.calls.submit.length, 2);
  db.prepare("UPDATE storyboards SET video_prompt='changed source' WHERE id=1").run();
  assert.equal(a.service.listSources(db, 10).storyboards.find(s => s.storyboard_id === 2).eligible, false);
});

test('known task with unexpected status remains recoverable instead of becoming unknown submission', async t => {
  const db = fixture(t); choose(db, 1);
  const a = adapters(db, { submit: async (connection, node, attempt, result) => ({ ...result, status: 'unrecognized' }) });
  const plan = await run(a.service, db, await preview(a.service, db));
  assert.equal(plan.nodes[0].status, 'processing'); assert.ok(plan.nodes[0].attempt.task_id);
  await a.service.resumePlan(db, {}, null, plan.id);
  assert.equal(a.calls.submit.length, 1); assert.equal(a.calls.poll.length, 1); assert.equal(a.service.getPlan(db, plan.id).status, 'completed');
});

test('default scheduler returns a persisted queue before slow provider preflight starts', async t => {
  const db = fixture(t); choose(db, 1);
  let called = false;
  const service = execution.createVideoPlanExecutionService({ provider: { snapshotConnection, preflight: async () => { called = true; throw new Error('unused'); } } });
  t.after(() => service.dispose(db));
  const plan = await preview(service, db);
  const result = await run(service, db, plan);
  assert.equal(result.status, 'running'); assert.equal(result.nodes[0].status, 'queued'); assert.equal(called, false);
  service.dispose(db);
});

test('read getters on legacy database never migrate or infer completed-video latent eligibility', t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  assert.deepEqual(execution.listVersions(db, 1), { items: [] }); assert.equal(execution.getPlan(db, 'missing'), null);
  assert.deepEqual(execution.listSources(db, 1), { storyboards: [], versions: [] });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n, 0);
});
