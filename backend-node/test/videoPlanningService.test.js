'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const planning = require('../src/services/videoPlanningService');

function createDb(t, schema = true) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE dramas (id INTEGER PRIMARY KEY, deleted_at TEXT);
    CREATE TABLE episodes (id INTEGER PRIMARY KEY, drama_id INTEGER, deleted_at TEXT);
    CREATE TABLE storyboards (id INTEGER PRIMARY KEY, episode_id INTEGER, storyboard_number INTEGER, title TEXT,
      description TEXT, action TEXT, video_prompt TEXT, duration REAL, image_url TEXT, video_url TEXT, status TEXT, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE video_plan_versions (id TEXT PRIMARY KEY, storyboard_id INTEGER, model_id TEXT, tail_segment_id TEXT,
      status TEXT, video_url TEXT, local_path TEXT, duration REAL, created_at TEXT);
    INSERT INTO dramas (id) VALUES (1),(2);
    INSERT INTO episodes (id,drama_id) VALUES (10,1),(11,1),(20,2);
    INSERT INTO storyboards (id,episode_id,storyboard_number,title,duration) VALUES
      (101,10,1,'第一镜',8),(102,10,2,'追逐战斗',15),(103,10,3,'第三镜',5),
      (111,11,1,'跨集来源',8),(112,11,2,'跨集后继',8),(201,20,1,'其他项目',8);`);
  if (schema) planning.ensureVideoPlanningSchema(db);
  return db;
}
const choose = (db, id, model, source = null, expected = 0) => planning.setVideoChoice(db, id, {
  expected_revision: expected, manual_locked: true, model_id: model, source_ref: source,
});
const ref = (id, revision = 1) => ({ kind: 'storyboard', storyboard_id: id, choice_revision: revision });
const raw = (id, model, predecessor, number) => ({ id, ...(number ? { shot_number: number } : {}),
  video_recommendation: { model_id: model, reason: '测试理由', ...(model.endsWith('-continue') ? { continuous_shot: true } : {}), ...(predecessor ? { predecessor } : {}) } });
const apply = (db, rows, options = {}) => planning.applyStoryboardRecommendations(db, 10, rows, { phase: 'final', ...options });
const plan = (db, id) => planning.getStoryboardVideoPlan(db, id);

test('old/minimal database getters return empty DTO without secretly creating planning tables', (t) => {
  const db = createDb(t, false);
  const before = db.prepare('SELECT name FROM sqlite_master ORDER BY name').all();
  const result = planning.getEpisodeVideoPlans(db, 10);
  assert.equal(result.items.length, 3);
  assert.equal(result.items[0].choice, null);
  assert.deepEqual(result.items[0].validation, { state: 'unplanned', blocking_reasons: [] });
  assert.equal(planning.invalidateStoryboardVideoPlan(db, 101, 'changed'), false);
  assert.throws(() => choose(db, 101, 'h3-standard'), { statusCode: 409 });
  assert.deepEqual(db.prepare('SELECT name FROM sqlite_master ORDER BY name').all(), before);
  planning.ensureVideoPlanningSchema(db);
  planning.ensureVideoPlanningSchema(db);
  assert.equal(choose(db, 101, 'h3-standard').choice.revision, 1);
});

test('choice CAS is strict, aliases canonicalize, and manual locks cannot bypass input/model validation', (t) => {
  const db = createDb(t);
  assert.throws(() => planning.setVideoChoice(db, 101, { model_id: 'h3-standard', manual_locked: true }), { statusCode: 400 });
  assert.throws(() => choose(db, 101, 'does-not-exist'), { statusCode: 400 });
  assert.throws(() => choose(db, 101, 'h3-digital-human'), { statusCode: 400 });
  assert.throws(() => choose(db, 101, 'h3-standard', ref(111)), { statusCode: 400 });
  assert.throws(() => choose(db, 101, 'h3-long-drama-continue'), { statusCode: 400 });
  const result = choose(db, 101, 'huobao_minimax_h3_reference_turbo_api');
  assert.equal(result.choice.model_id, 'h3-standard');
  assert.equal(result.validation.state, 'ready');
  assert.throws(() => choose(db, 101, 'h3-drama'), { statusCode: 409 });
  assert.equal(plan(db, 101).choice.model_id, 'h3-standard');
  assert.throws(() => choose(db, 999, 'h3-drama'), { statusCode: 404 });
});

test('recommending preserves manual choice, adoption and actual execution; following is explicit CAS', (t) => {
  const db = createDb(t);
  choose(db, 101, 'h3-action');
  db.prepare('UPDATE storyboard_video_plans SET selected_version_id = ?, adoption_revision = 7, last_execution_json = ? WHERE storyboard_id = 101')
    .run('adopted-v1', JSON.stringify({ plan_id: 'last-plan' }));
  apply(db, [raw(101, 'h3-drama')]);
  const result = plan(db, 101);
  assert.equal(result.recommendation.model_id, 'h3-drama');
  assert.equal(result.choice.model_id, 'h3-action');
  assert.equal(result.choice.revision, 1);
  assert.equal(result.selected_version_id, 'adopted-v1');
  assert.equal(result.adoption_revision, 7);
  assert.deepEqual(result.last_execution, { plan_id: 'last-plan' });
  assert.throws(() => planning.setVideoChoice(db, 101, { expected_revision: 1, manual_locked: false, model_id: 'h3-standard' }), { statusCode: 400 });
  const followed = planning.setVideoChoice(db, 101, { expected_revision: 1, manual_locked: false });
  assert.equal(followed.choice.model_id, 'h3-drama');
  assert.equal(followed.choice.manual_locked, false);
  assert.equal(followed.choice.revision, 2);
  assert.equal(followed.selected_version_id, 'adopted-v1');
});

test('cross-episode sources are allowed within drama; foreign drama, cycles and revision drift are rejected', (t) => {
  const db = createDb(t);
  choose(db, 111, 'h3-long-drama-first');
  const child = choose(db, 101, 'h3-long-drama-continue', ref(111));
  assert.equal(child.validation.state, 'waiting_dependency');
  choose(db, 201, 'h3-long-drama-first');
  assert.throws(() => choose(db, 102, 'h3-long-drama-continue', ref(201)), { statusCode: 400 });
  assert.throws(() => choose(db, 111, 'h3-long-drama-continue', ref(101), 1), { statusCode: 400 });
  assert.throws(() => choose(db, 103, 'h3-long-drama-continue', ref(103, 0)), { statusCode: 400 });
  choose(db, 111, 'h3-long-drama-first', null, 1);
  assert.equal(plan(db, 101).validation.state, 'stale');
  assert.deepEqual(plan(db, 101).validation.blocking_reasons, ['source_choice_revision_changed']);
  assert.throws(() => choose(db, 102, 'h3-long-drama-continue', ref(111)), { statusCode: 400 });
  choose(db, 112, 'h3-long-action-first');
  assert.throws(() => choose(db, 102, 'h3-long-drama-continue', ref(112)), { statusCode: 400 });
});

test('version references bind exact immutable tail, not the newest video or matching family alone', (t) => {
  const db = createDb(t);
  const put = db.prepare('INSERT INTO video_plan_versions (id,storyboard_id,model_id,tail_segment_id,status,video_url) VALUES (?, ?, ?, ?, ?, ?)');
  put.run('old-good', 111, 'h3-long-drama-first', 'tail-1', 'completed', '/old.mp4');
  put.run('latest-bad', 111, 'h3-long-action-first', 'tail-2', 'completed', '/new.mp4');
  const options = { versionEligibility: (_db, row) => ({ continuable: row.id === 'old-good' }) };
  const source = { kind: 'version', version_id: 'old-good', tail_segment_id: 'tail-1' };
  const result = planning.setVideoChoice(db, 101, { expected_revision: 0, manual_locked: true, model_id: 'h3-long-drama-continue', source_ref: source }, options);
  assert.deepEqual(result.choice.source_ref, source);
  assert.equal(result.validation.state, 'ready');
  assert.equal(planning.validateVideoChoice(db, 101, { model_id: 'h3-long-drama-continue', source_ref: { ...source, tail_segment_id: 'tail-2' } }, options).state, 'blocked');
  assert.equal(planning.validateVideoChoice(db, 101, { model_id: 'h3-long-drama-continue', source_ref: { kind: 'version', version_id: 'latest-bad' } }, options).state, 'blocked');
  assert.equal(planning.validateVideoChoice(db, 101, { model_id: 'h3-long-drama-continue', source_ref: source }, { versionEligibility: () => ({ continuable: false }) }).state, 'blocked');
  put.run('foreign', 201, 'h3-long-drama-first', 'tail-x', 'completed', '/foreign.mp4');
  assert.equal(planning.validateVideoChoice(db, 101, { model_id: 'h3-long-drama-continue', source_ref: { kind: 'version', version_id: 'foreign' } }, options).blocking_reasons[0], 'source_cross_drama');
});

test('fingerprint detects semantic edits and propagates upstream stale, without treating completed video as content change', (t) => {
  const db = createDb(t);
  choose(db, 111, 'h3-long-drama-first');
  choose(db, 101, 'h3-long-drama-continue', ref(111));
  const fingerprint = planning.getStoryboardContentFingerprint(db, 111);
  db.prepare("UPDATE storyboards SET video_url = '/finished.mp4', status = 'completed', updated_at = 'later' WHERE id = 111").run();
  assert.equal(planning.getStoryboardContentFingerprint(db, 111), fingerprint);
  assert.equal(plan(db, 101).validation.state, 'waiting_dependency');
  db.prepare("UPDATE storyboards SET image_url = '/different-reference.png' WHERE id = 111").run();
  assert.notEqual(planning.getStoryboardContentFingerprint(db, 111), fingerprint);
  assert.equal(plan(db, 111).validation.state, 'stale');
  assert.equal(plan(db, 101).validation.state, 'stale');
  assert.equal(plan(db, 111).choice.manual_locked, true);
  db.prepare("UPDATE storyboards SET deleted_at = 'deleted' WHERE id = 111").run();
  assert.equal(planning.invalidateStoryboardVideoPlan(db, 111, 'retired'), true);
  assert.equal(plan(db, 101).validation.state, 'blocked');
  assert.equal(plan(db, 101).validation.blocking_reasons[0], 'source_storyboard_missing');
});

test('draft and truncated output never activate; final reconciles exact saved mapping despite newer duplicate shot numbers', (t) => {
  const db = createDb(t);
  db.prepare("INSERT INTO storyboards (id,episode_id,storyboard_number,title) VALUES (199,10,1,'旧镜号的最新记录不可猜测')").run();
  const rows = [
    { shot_number: 2, video_recommendation: { model_id: 'h3-long-drama-continue', continuous_shot: true, reason: '续接', predecessor: { kind: 'draft_shot', shot_number: 1 } } },
    { shot_number: 1, video_recommendation: { model_id: 'h3-long-drama-first', reason: '首段' } },
  ];
  const options = { saved_storyboards: [{ id: 101, shot_number: 1 }, { id: 102, shot_number: 2 }], generation_run_id: 'run-1' };
  apply(db, rows, { ...options, phase: 'draft', partial: true });
  assert.equal(plan(db, 101).choice, null);
  assert.equal(plan(db, 102).validation.state, 'draft');
  assert.throws(() => choose(db, 101, 'h3-standard', null, plan(db, 101).choice_revision), { code: 'DRAFT_PLAN_NOT_FINAL' });
  assert.throws(() => apply(db, rows, { ...options, truncated: true }), { code: 'INCOMPLETE_RECOMMENDATIONS' });
  apply(db, rows, options);
  const first = plan(db, 101), next = plan(db, 102);
  assert.equal(first.validation.state, 'ready');
  assert.equal(next.validation.state, 'waiting_dependency');
  assert.deepEqual(next.choice.source_ref, ref(101, first.choice.revision));
  assert.equal(plan(db, 199).choice, null);
  assert.throws(() => apply(db, rows), { code: 'MISSING_SAVED_MAPPING' });
  assert.throws(() => apply(db, rows, { ...options, phase: 'draft' }), { code: 'GENERATION_ALREADY_FINAL' });
});

test('untrusted AI IDs, URLs and unsupported source keys stay blocked while locked choices survive', (t) => {
  const db = createDb(t);
  choose(db, 101, 'h3-action');
  apply(db, [raw(101, 'h3-long-drama-continue', { kind: 'version', version_id: 'injected' }),
    raw(102, 'h3-long-drama-continue', { kind: 'source_key', key: '__proto__' }),
    { id: 103, video_recommendation: { model_id: 'h3-standard', reason: 'x', latent_path: '/arbitrary/file' } }]);
  assert.equal(plan(db, 101).choice.model_id, 'h3-action');
  assert.ok(plan(db, 101).recommendation.blocking_reasons.includes('untrusted_predecessor'));
  assert.equal(plan(db, 102).validation.state, 'blocked');
  assert.equal(plan(db, 103).choice, null);
  assert.ok(plan(db, 103).validation.blocking_reasons.includes('untrusted_recommendation_fields'));
});

test('bounded prompt source keys bind captured revisions and exact source content, even across episodes', (t) => {
  const db = createDb(t);
  choose(db, 111, 'h3-long-drama-first');
  choose(db, 201, 'h3-long-drama-first');
  const context = planning.getPlanningPromptContext(db, 10, { max_sources: 1 });
  assert.equal(context.allowed_sources.length, 1);
  assert.ok(context.instruction.length < 12000);
  const key = context.allowed_sources[0].key;
  assert.deepEqual(context.source_keys[key], ref(111));
  apply(db, [raw(101, 'h3-long-drama-continue', { kind: 'source_key', key })], { source_context: context });
  assert.equal(plan(db, 101).validation.state, 'waiting_dependency');
  db.prepare("UPDATE storyboards SET title = 'changed' WHERE id = 111").run();
  apply(db, [raw(102, 'h3-long-drama-continue', { kind: 'source_key', key })], { source_context: context });
  assert.equal(plan(db, 102).choice, null);
  assert.ok(plan(db, 102).validation.blocking_reasons.includes('source_content_changed'));
  const candidates = planning.listPlanningSources(db, 1);
  assert.equal(candidates.storyboards.some((row) => row.storyboard_id === 201), false);
  assert.equal(candidates.storyboards.find((row) => row.storyboard_id === 111).eligible, false);
});

test('same-ID recommendation defaults to labeled heuristic, preserving adopted video and manual locks', async (t) => {
  const db = createDb(t);
  choose(db, 101, 'h3-standard');
  db.prepare("UPDATE storyboard_video_plans SET selected_version_id = 'chosen' WHERE storyboard_id = 101").run();
  db.prepare("UPDATE storyboards SET video_url = '/existing.mp4' WHERE id = 101").run();
  let calls = 0;
  const before = db.prepare('SELECT * FROM storyboards ORDER BY id').all();
  const output = await planning.recommendEpisodeVideoPlans(db, {}, {}, 10, {}, { generateText: () => { calls++; throw Error('must not call'); } });
  assert.equal(calls, 0);
  assert.equal(output.items.length, 3);
  assert.equal(output.items[0].recommendation.origin, 'heuristic');
  assert.equal(output.items[1].recommendation.model_id, 'h3-long-action-first');
  assert.equal(output.items[0].choice.model_id, 'h3-standard');
  assert.equal(output.items[0].selected_version_id, 'chosen');
  assert.deepEqual(db.prepare('SELECT * FROM storyboards ORDER BY id').all(), before);
});

test('AI re-recommendation uses mock only on explicit strategy, requires complete JSON and preserves prior records on truncation', async (t) => {
  const db = createDb(t);
  let calls = 0;
  const options = { generateText: async (_db, _log, kind, prompt, system) => {
    calls++;
    assert.equal(kind, 'text');
    assert.ok(system.includes('video_recommendation'));
    assert.equal(JSON.parse(prompt).storyboards.length, 1);
    return JSON.stringify({ storyboards: [{ shot_number: 2, video_recommendation: { model_id: 'h3-action', reason: 'AI测试' } }] });
  } };
  await planning.recommendEpisodeVideoPlans(db, {}, {}, 10, { strategy: 'ai', storyboard_ids: [102] }, options);
  assert.equal(calls, 1);
  assert.equal(plan(db, 102).recommendation.origin, 'ai');
  const before = db.prepare('SELECT * FROM storyboard_video_plans').all();
  await assert.rejects(planning.recommendEpisodeVideoPlans(db, {}, {}, 10, { strategy: 'ai' }, { generateText: async () => '{"storyboards":[{' }), { code: 'INCOMPLETE_RECOMMENDATIONS' });
  assert.deepEqual(db.prepare('SELECT * FROM storyboard_video_plans').all(), before);
});

test('in-flight AI recommendations use content/revision snapshots and cannot clobber concurrent edits', async (t) => {
  const db = createDb(t);
  const output = JSON.stringify({ storyboards: [{ shot_number: 1, video_recommendation: { model_id: 'h3-drama', reason: 'AI测试' } }] });
  await assert.rejects(planning.recommendEpisodeVideoPlans(db, {}, {}, 10, { strategy: 'ai', storyboard_ids: [101] }, {
    generateText: async () => { choose(db, 101, 'h3-action'); return output; },
  }), { statusCode: 409 });
  assert.equal(plan(db, 101).choice.model_id, 'h3-action');
  await assert.rejects(planning.recommendEpisodeVideoPlans(db, {}, {}, 10, { strategy: 'ai', storyboard_ids: [101] }, {
    generateText: async () => { db.prepare("UPDATE storyboards SET video_prompt = 'new prompt' WHERE id = 101").run(); return output; },
  }), { code: 'CONTENT_CHANGED' });
  assert.equal(plan(db, 101).recommendation, null);
});

test('continuous draft dependencies upgrade an unlocked single predecessor to the exact paired first workflow', (t) => {
  const db = createDb(t);
  apply(db, [raw(101, 'h3-drama'), raw(102, 'h3-long-drama-continue', { kind: 'draft_shot', shot_number: 1 })]);
  const first = plan(db, 101), child = plan(db, 102);
  assert.equal(first.choice.model_id, 'h3-long-drama-first');
  assert.equal(first.recommendation.upgraded_from_model_id, 'h3-drama');
  assert.equal(first.recommendation.origin, 'ai');
  assert.equal(child.validation.state, 'waiting_dependency');
  assert.equal(child.recommendation.continuous_shot, true);
  assert.deepEqual(child.choice.source_ref, ref(101, first.choice.revision));
});

test('reverse upgrades preserve manual locks and reject conflicting requested continuation families', (t) => {
  const db = createDb(t);
  choose(db, 101, 'h3-drama');
  apply(db, [raw(101, 'h3-drama'), raw(102, 'h3-long-drama-continue', { kind: 'draft_shot', shot_number: 1 })]);
  assert.equal(plan(db, 101).choice.model_id, 'h3-drama');
  assert.equal(plan(db, 102).choice, null);
  assert.ok(plan(db, 102).validation.blocking_reasons.includes('source_manual_lock_incompatible'));
  planning.setVideoChoice(db, 101, { manual_locked: false, expected_revision: 1 });
  apply(db, [raw(101, 'h3-drama'), raw(102, 'h3-long-drama-continue', { kind: 'draft_shot', shot_number: 1 }),
    raw(103, 'h3-long-action-continue', { kind: 'draft_shot', shot_number: 1 })]);
  assert.equal(plan(db, 101).choice.model_id, 'h3-drama');
  assert.ok(plan(db, 102).validation.blocking_reasons.includes('conflicting_continuation_models'));
  assert.ok(plan(db, 103).validation.blocking_reasons.includes('conflicting_continuation_models'));
});

test('AI continuation requires explicit continuous-shot intent and rejects cut instructions; ordinary sequel stays independent', async (t) => {
  const db = createDb(t);
  const noIntent = raw(102, 'h3-long-drama-continue', { kind: 'draft_shot', shot_number: 1 });
  delete noIntent.video_recommendation.continuous_shot;
  apply(db, [raw(101, 'h3-drama'), noIntent]);
  assert.ok(plan(db, 102).validation.blocking_reasons.includes('continuation_intent_required'));
  assert.equal(plan(db, 101).choice.model_id, 'h3-drama');
  db.prepare("UPDATE storyboards SET video_prompt = '角色向前奔跑，随后切镜到远处人群' WHERE id = 102").run();
  apply(db, [raw(101, 'h3-drama'), raw(102, 'h3-long-drama-continue', { kind: 'draft_shot', shot_number: 1 })]);
  assert.ok(plan(db, 102).validation.blocking_reasons.includes('continuation_prompt_contains_cuts'));
  assert.equal(plan(db, 101).choice.model_id, 'h3-drama');
  db.prepare("UPDATE storyboards SET video_prompt = '保持连续跟拍，不切镜，no cuts' WHERE id = 102").run();
  apply(db, [raw(101, 'h3-drama'), raw(102, 'h3-long-drama-continue', { kind: 'draft_shot', shot_number: 1 })]);
  assert.equal(plan(db, 102).validation.state, 'waiting_dependency');
  const nextEpisode = await planning.recommendEpisodeVideoPlans(db, {}, {}, 11, {});
  assert.equal(nextEpisode.items.every((item) => !item.choice.model_id.endsWith('-continue')), true);
  const context = planning.getPlanningPromptContext(db, 11);
  assert.ok(context.instruction.includes('续集、同角色'));
  assert.ok(context.instruction.includes('continuous_shot:true'));
});

test('missing recommendation finalizes as explicitly blocked, never falls back or leaves an executable stale choice', (t) => {
  const db = createDb(t);
  apply(db, [raw(101, 'h3-drama')]);
  db.prepare("UPDATE storyboard_video_plans SET selected_version_id = 'keep-adoption' WHERE storyboard_id = 101").run();
  apply(db, [{ id: 101 }], { phase: 'draft' });
  assert.equal(plan(db, 101).validation.state, 'draft');
  apply(db, [{ id: 101 }]);
  assert.equal(plan(db, 101).validation.state, 'blocked');
  assert.deepEqual(plan(db, 101).validation.blocking_reasons, ['missing_recommendation']);
  assert.equal(plan(db, 101).choice, null);
  assert.equal(plan(db, 101).selected_version_id, 'keep-adoption');
});

test('adopting a legacy video output preserves locked input choice and downstream eligibility', (t) => {
  const db = createDb(t);
  db.exec(`ALTER TABLE storyboards ADD COLUMN local_path TEXT;
    CREATE TABLE video_generations (id INTEGER PRIMARY KEY, storyboard_id INTEGER, video_url TEXT, local_path TEXT, status TEXT, deleted_at TEXT);
    INSERT INTO video_generations VALUES (1,101,'https://example.invalid/one.mp4','videos/one.MP4','completed',NULL),
      (2,101,'https://example.invalid/two.webm','videos/two.webm?download=1','completed',NULL);`);
  const before = choose(db, 101, 'h3-long-drama-first');
  choose(db, 102, 'h3-long-drama-continue', ref(101));
  const storyboard = require('../src/services/storyboardService');
  const log = { info() {}, warn() {} };
  for (const [revision, url] of ['https://example.invalid/one.mp4', 'https://example.invalid/two.webm'].entries()) {
    storyboard.updateStoryboard(db, log, 101, { video_url: url, expected_adoption_revision: revision });
    const current = plan(db, 101);
    assert.equal(current.adoption_revision, revision + 1);
    assert.equal(current.content_fingerprint, before.content_fingerprint);
    assert.deepEqual(current.choice, before.choice);
    assert.equal(current.validation.state, 'ready');
    assert.equal(plan(db, 102).validation.state, 'waiting_dependency');
  }
});

test('image input removal still invalidates a lock even when the shared path becomes a video output', (t) => {
  const db = createDb(t);
  db.exec("ALTER TABLE storyboards ADD COLUMN local_path TEXT; UPDATE storyboards SET local_path='images/input.png' WHERE id=101");
  const before = choose(db, 101, 'h3-standard');
  db.prepare('UPDATE storyboards SET local_path=? WHERE id=101').run('videos/output.mp4');
  assert.notEqual(plan(db, 101).content_fingerprint, before.content_fingerprint);
  assert.deepEqual(plan(db, 101).validation, { state: 'stale', blocking_reasons: ['content_changed'] });
  assert.deepEqual(plan(db, 101).choice, before.choice);
});

test('prop membership invalidates locked inputs and dependents, but row insertion order does not', (t) => {
  const db = createDb(t);
  db.exec(`CREATE TABLE storyboard_props (storyboard_id INTEGER, prop_id INTEGER, UNIQUE(storyboard_id,prop_id));
    INSERT INTO storyboard_props VALUES (101,9),(101,3);`);
  const before = choose(db, 101, 'h3-long-drama-first');
  choose(db, 102, 'h3-long-drama-continue', ref(101));
  const storyboard = require('../src/services/storyboardService');
  const log = { info() {}, warn() {} };
  storyboard.updateStoryboard(db, log, 101, { prop_ids: [3, 9] });
  assert.equal(plan(db, 101).content_fingerprint, before.content_fingerprint);
  assert.equal(plan(db, 101).validation.state, 'ready');
  storyboard.updateStoryboard(db, log, 101, { prop_ids: [3, 7] });
  assert.deepEqual(plan(db, 101).validation, { state: 'stale', blocking_reasons: ['content_changed'] });
  assert.deepEqual(plan(db, 101).choice, before.choice);
  assert.deepEqual(plan(db, 102).validation, { state: 'stale', blocking_reasons: ['source_content_changed'] });
});

test('a late AI response cannot replace a more recent recommendation behind an unchanged manual lock', async (t) => {
  const db = createDb(t);
  choose(db, 101, 'h3-standard');
  await assert.rejects(planning.recommendEpisodeVideoPlans(db, {}, {}, 10, { strategy: 'ai', storyboard_ids: [101] }, {
    generateText: async () => {
      apply(db, [raw(101, 'h3-action')]);
      return JSON.stringify({ storyboards: [{ shot_number: 1, video_recommendation: { model_id: 'h3-drama', reason: 'late' } }] });
    },
  }), { code: 'RECOMMENDATION_REVISION_CONFLICT' });
  assert.equal(plan(db, 101).recommendation.model_id, 'h3-action');
  assert.equal(plan(db, 101).choice.model_id, 'h3-standard');
});
