'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const planning = require('../src/services/videoPlanningService');

function fixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE dramas(id INTEGER PRIMARY KEY, deleted_at TEXT);
    CREATE TABLE episodes(id INTEGER PRIMARY KEY, drama_id INTEGER, deleted_at TEXT);
    CREATE TABLE storyboards(id INTEGER PRIMARY KEY,episode_id INTEGER,storyboard_number INTEGER,
      title TEXT,description TEXT,action TEXT,video_prompt TEXT,universal_segment_text TEXT,creation_mode TEXT,
      scene_id INTEGER,location TEXT,time TEXT,dialogue TEXT,movement TEXT,result TEXT,shot_type TEXT,duration REAL,deleted_at TEXT);
    INSERT INTO dramas(id) VALUES(1);
    INSERT INTO episodes(id,drama_id) VALUES(10,1),(11,1);
    INSERT INTO storyboards(id,episode_id,storyboard_number,title,video_prompt,scene_id,location,time,duration) VALUES
      (101,10,1,'凝视','人物含泪凝视',5,'泥屋','黄昏',5),
      (102,10,2,'继续凝视','承接上一镜末帧，人物含泪凝视，不切镜',5,'泥屋','黄昏',5),
      (103,10,3,'继续落泪','从前镜尾帧继续，人物继续落泪，不切镜',5,'泥屋','黄昏',5),
      (111,11,1,'另一集','人物沉默',5,'泥屋','黄昏',5);
  `);
  require('./helpers/videoConfigs').seedVideoConfigs(db);
  planning.ensureVideoPlanningSchema(db);
  return db;
}
const plan = (db, id) => planning.getStoryboardVideoPlan(db, id);
function choose(db, id, model_id, manual_locked = false) {
  return planning.setVideoChoice(db, id, { model_id, expected_revision: plan(db, id).choice_revision, manual_locked });
}
function rec(number, model_id, predecessor) {
  return { shot_number: number, video_recommendation: { model_id, reason: '明确画面重心和连续关系',
    ...(predecessor ? { continuous_shot: true, predecessor } : {}) } };
}

test('rule recommendations activate a paired three-shot chain with exact future revisions without generation', async t => {
  const db = fixture(t);
  const before = db.prepare('SELECT * FROM storyboards ORDER BY id').all();
  await planning.recommendEpisodeVideoPlans(db, {}, {}, 10, {}, { generateText() { throw Error('must not call AI'); } });
  assert.deepEqual([101, 102, 103].map(id => plan(db, id).choice.model_id), ['h3-long-drama-first', 'h3-long-drama-continue', 'h3-long-drama-continue']);
  assert.deepEqual(plan(db, 102).choice.source_ref, { kind: 'storyboard', storyboard_id: 101, choice_revision: 1 });
  assert.deepEqual(plan(db, 103).choice.source_ref, { kind: 'storyboard', storyboard_id: 102, choice_revision: 1 });
  assert.equal(plan(db, 103).validation.state, 'waiting_dependency');
  assert.deepEqual(db.prepare('SELECT * FROM storyboards ORDER BY id').all(), before);
});

test('rule chain respects a compatible manual source at its unchanged revision', async t => {
  const db = fixture(t);
  choose(db, 101, 'h3-long-drama-first', true);
  await planning.recommendEpisodeVideoPlans(db, {}, {}, 10);
  assert.equal(plan(db, 101).choice.model_id, 'h3-long-drama-first');
  assert.equal(plan(db, 101).choice_revision, 1);
  assert.equal(plan(db, 102).choice.source_ref.choice_revision, 1);
  assert.equal(plan(db, 103).validation.state, 'waiting_dependency');
});

test('rule chain cannot upgrade a manual single or force its child to use a continuation', async t => {
  const db = fixture(t);
  choose(db, 101, 'h3-standard', true);
  await planning.recommendEpisodeVideoPlans(db, {}, {}, 10, { storyboard_ids: [101, 102] });
  assert.equal(plan(db, 101).choice.model_id, 'h3-standard');
  assert.equal(plan(db, 101).choice_revision, 1);
  assert.equal(plan(db, 102).choice.model_id, 'h3-drama');
  assert.match(plan(db, 102).recommendation.reason, /手动锁定/);
});

test('AI receives actual universal content, performance, space-time, camera and effective lock state', async t => {
  const db = fixture(t);
  choose(db, 101, 'h3-standard', true);
  db.prepare(`UPDATE storyboards SET creation_mode='universal',universal_segment_text=?,dialogue=?,movement=?,result=? WHERE id=101`)
    .run('人物在泥屋内低头落泪', '你终于回来了', '缓推', '她放下手中的碗');
  await planning.recommendEpisodeVideoPlans(db, {}, {}, 10, { strategy: 'ai', storyboard_ids: [101] }, {
    generateText: async (_db, _log, _kind, prompt, system) => {
      const row = JSON.parse(prompt).storyboards[0];
      assert.equal(row.universal_segment_text, '人物在泥屋内低头落泪');
      assert.equal(row.dialogue, '你终于回来了');
      assert.equal(row.location, '泥屋');
      assert.equal(row.time, '黄昏');
      assert.equal(row.movement, '缓推');
      assert.equal(row.result, '她放下手中的碗');
      assert.equal(row.current_choice.manual_locked, true);
      assert.equal(row.current_choice.model_id, 'h3-standard');
      assert.equal(row.current_choice.validation_state, 'stale');
      assert.ok(system.includes('duration 不决定 first/continue'));
      assert.ok(system.includes('普通走路'));
      assert.ok(system.includes('手动锁定选择不变'));
      assert.ok(system.includes('不得为了分布均匀'));
      return JSON.stringify({ storyboards: [rec(1, 'h3-drama')] });
    },
  });
  assert.equal(plan(db, 101).choice.model_id, 'h3-standard');
});

test('AI batch excludes stale source keys and supports unordered draft chains at future revisions', async t => {
  const db = fixture(t);
  planning.applyStoryboardRecommendations(db, 10, [{ ...rec(1, 'h3-long-drama-first'), id: 101 }], { phase: 'final' });
  choose(db, 111, 'h3-long-drama-first', true);
  const context = planning.getPlanningPromptContext(db, 10, { target_storyboard_ids: [101, 102, 103] });
  assert.ok(Object.values(context.source_keys).every(ref => ref.storyboard_id !== 101));
  assert.ok(Object.values(context.source_keys).some(ref => ref.storyboard_id === 111));
  assert.match(context.allowed_sources[0].execution_requirement, /同集执行计划/);
  await planning.recommendEpisodeVideoPlans(db, {}, {}, 10, { strategy: 'ai' }, {
    generateText: async (_db, _log, _kind, _prompt, system) => {
      const allowed = JSON.parse(system.split('允许的既有来源：')[1].split('\n')[0]);
      assert.ok(allowed.every(source => !(source.episode_id === 10 && source.storyboard_number === 1)));
      return JSON.stringify({ storyboards: [rec(3, 'h3-long-drama-continue', { kind: 'draft_shot', shot_number: 2 }),
        rec(2, 'h3-long-drama-continue', { kind: 'draft_shot', shot_number: 1 }), rec(1, 'h3-drama')] });
    },
  });
  assert.equal(plan(db, 101).choice_revision, 2);
  assert.equal(plan(db, 101).choice.model_id, 'h3-long-drama-first');
  assert.equal(plan(db, 102).choice.source_ref.choice_revision, 2);
  assert.equal(plan(db, 103).validation.state, 'waiting_dependency');
});

test('reverse upgrades preserve dramatic/action treatment and define standard-to-first explicitly', t => {
  const db = fixture(t);
  for (const [parent, child] of [['h3-action', 'h3-long-drama-continue'], ['h3-drama', 'h3-long-action-continue']]) {
    planning.applyStoryboardRecommendations(db, 10, [rec(1, parent), rec(2, child, { kind: 'draft_shot', shot_number: 1 })],
      { phase: 'final', saved_storyboards: [{ id: 101, storyboard_number: 1 }, { id: 102, storyboard_number: 2 }] });
    assert.equal(plan(db, 101).choice.model_id, parent);
    assert.equal(plan(db, 102).choice, null);
    assert.ok(plan(db, 102).validation.blocking_reasons.includes('source_model_incompatible'));
  }
  for (const family of ['drama', 'action']) {
    planning.applyStoryboardRecommendations(db, 10, [rec(1, 'h3-standard'), rec(2, `h3-long-${family}-continue`, { kind: 'draft_shot', shot_number: 1 })],
      { phase: 'final', saved_storyboards: [{ id: 101, storyboard_number: 1 }, { id: 102, storyboard_number: 2 }] });
    assert.equal(plan(db, 101).choice.model_id, `h3-long-${family}-first`);
    assert.equal(plan(db, 102).validation.state, 'waiting_dependency');
  }
});

test('completed sources describe historical frozen prompts, never edited storyboard content as historical truth', t => {
  const db = fixture(t);
  db.exec(`CREATE TABLE video_plan_versions(id TEXT PRIMARY KEY,storyboard_id INTEGER,model_id TEXT,tail_segment_id TEXT,status TEXT,video_url TEXT,deleted_at TEXT);
    CREATE TABLE video_execution_nodes(version_id TEXT,inputs TEXT);
    INSERT INTO video_plan_versions VALUES('v1',101,'h3-long-drama-first','tail1','completed','/old.mp4',NULL);
    INSERT INTO video_execution_nodes VALUES('v1','{"prompt":"历史镜头在木门前结束"}');`);
  const options = { versionEligibility: () => ({ continuable: true, blocking_reasons: [] }) };
  const before = planning.getPlanningPromptContext(db, 10, options).allowed_sources[0];
  db.prepare('UPDATE storyboards SET video_prompt=? WHERE id=101').run('现在的分镜已经改成城楼');
  const after = planning.getPlanningPromptContext(db, 10, options).allowed_sources[0];
  assert.equal(after.frozen_prompt, before.frozen_prompt);
  assert.equal(after.frozen_prompt, '历史镜头在木门前结束');
  assert.equal(after.current_storyboard_context, undefined);
  assert.match(after.context_note, /不代表末帧视觉已验收/);
  db.prepare('DELETE FROM video_execution_nodes').run();
  const unknown = planning.getPlanningPromptContext(db, 10, options).allowed_sources[0];
  assert.equal(unknown.frozen_prompt, '');
  assert.match(unknown.context_note, /未知/);
});

test('a recommendation for a locked single child cannot unnecessarily upgrade the unlocked parent', async t => {
  const db = fixture(t);
  choose(db, 102, 'h3-drama', true);
  await planning.recommendEpisodeVideoPlans(db, {}, {}, 10, { storyboard_ids: [101, 102] });
  assert.equal(plan(db, 101).choice.model_id, 'h3-drama');
  assert.equal(plan(db, 102).choice.model_id, 'h3-drama');
  planning.applyStoryboardRecommendations(db, 10, [rec(1, 'h3-drama'), rec(2, 'h3-long-drama-continue', { kind: 'draft_shot', shot_number: 1 })],
    { phase: 'final', saved_storyboards: [{ id: 101, storyboard_number: 1 }, { id: 102, storyboard_number: 2 }] });
  assert.equal(plan(db, 101).choice.model_id, 'h3-drama');
  assert.equal(plan(db, 102).choice.model_id, 'h3-drama');
  assert.equal(plan(db, 102).choice_revision, 1);
});

test('AI candidates use maintained config names and omit disabled models, URLs and secrets', async t => {
  const db = fixture(t);
  db.exec("UPDATE ai_service_configs SET is_active=0 WHERE model LIKE '%h3-action%'");
  await planning.recommendEpisodeVideoPlans(db, {}, {}, 10, { strategy: 'ai', storyboard_ids: [101] }, {
    generateText: async (_db, _log, _kind, _prompt, system) => {
      const models = JSON.parse(system.split('工作流：')[1].split('\n')[0]);
      assert.equal(models.length, 6);
      assert.ok(!models.some(model => model.model_id === 'h3-action'));
      assert.equal(models.find(model => model.model_id === 'h3-drama').configured_connections[0].name, 'Configured h3-drama');
      assert.ok(!system.includes('test-secret'));
      assert.ok(!system.includes('comfy-test:8188'));
      assert.match(system, /优先级仅用于同一模型/);
      return JSON.stringify({ storyboards: [rec(1, 'h3-drama')] });
    },
  });
  assert.equal(plan(db, 101).choice.model_id, 'h3-drama');
});

test('rules fall back explicitly to configured standard and cannot create an unconfigured continuation pair', async t => {
  const db = fixture(t);
  db.exec("UPDATE ai_service_configs SET is_active=0 WHERE model LIKE '%h3-long-drama-first%'");
  await planning.recommendEpisodeVideoPlans(db, {}, {}, 10);
  assert.deepEqual([101, 102, 103].map(id => plan(db, id).choice.model_id), ['h3-drama', 'h3-drama', 'h3-drama']);
  assert.match(plan(db, 102).recommendation.reason, /未配置或未启用/);
  db.exec("UPDATE ai_service_configs SET is_active=0 WHERE model LIKE '%h3-drama%'");
  await planning.recommendEpisodeVideoPlans(db, {}, {}, 10, { storyboard_ids: [101] });
  assert.equal(plan(db, 101).choice.model_id, 'h3-standard');
  assert.match(plan(db, 101).recommendation.reason, /降级/);
});

test('unconfigured AI output, a disabled config during AI, and missing paired first preserve previous plans atomically', async t => {
  for (const scenario of ['outside_candidates', 'disabled_during_ai', 'paired_first_missing']) {
    const db = fixture(t);
    await planning.recommendEpisodeVideoPlans(db, {}, {}, 10);
    const before = db.prepare('SELECT * FROM storyboard_video_plans ORDER BY storyboard_id').all();
    if (scenario === 'outside_candidates') db.exec("UPDATE ai_service_configs SET is_active=0 WHERE model LIKE '%h3-action%'");
    if (scenario === 'paired_first_missing') db.exec("UPDATE ai_service_configs SET is_active=0 WHERE model LIKE '%h3-long-drama-first%'");
    await assert.rejects(planning.recommendEpisodeVideoPlans(db, {}, {}, 10, { strategy: 'ai', storyboard_ids: [101, 102] }, {
      generateText: async () => {
        if (scenario === 'disabled_during_ai') db.exec("UPDATE ai_service_configs SET is_active=0 WHERE model LIKE '%h3-drama%'");
        return JSON.stringify({ storyboards: [rec(1, scenario === 'outside_candidates' ? 'h3-action' : 'h3-drama'),
          rec(2, scenario === 'paired_first_missing' ? 'h3-long-drama-continue' : 'h3-standard',
            scenario === 'paired_first_missing' ? { kind: 'draft_shot', shot_number: 1 } : null)] });
      },
    }), { code: 'VIDEO_MODEL_NOT_CONFIGURED' }, scenario);
    assert.deepEqual(db.prepare('SELECT * FROM storyboard_video_plans ORDER BY storyboard_id').all(), before, scenario);
  }
});

test('no enabled video models fail before AI calls and leave existing choices unchanged', async t => {
  const db = fixture(t);
  choose(db, 101, 'h3-drama', true);
  const before = db.prepare('SELECT * FROM storyboard_video_plans').all();
  db.exec('UPDATE ai_service_configs SET is_active=0');
  assert.deepEqual(planning.getPlanningPromptContext(db, 10).allowed_model_ids, []);
  for (const strategy of ['ai', 'heuristic']) {
    await assert.rejects(planning.recommendEpisodeVideoPlans(db, {}, {}, 10, { strategy }, {
      generateText() { assert.fail('unconfigured requests must not call AI'); },
    }), { code: 'NO_CONFIGURED_VIDEO_MODELS' });
  }
  assert.deepEqual(db.prepare('SELECT * FROM storyboard_video_plans').all(), before);
});

test('only first/continue configurations do not force independent shots into latent workflows', async t => {
  const db = fixture(t);
  choose(db, 101, 'h3-drama', true);
  const before = db.prepare('SELECT * FROM storyboard_video_plans').all();
  db.exec("UPDATE ai_service_configs SET is_active=0 WHERE model NOT LIKE '%h3-long-%'");
  await assert.rejects(planning.recommendEpisodeVideoPlans(db, {}, {}, 10), { code: 'VIDEO_MODEL_NOT_CONFIGURED' });
  assert.deepEqual(db.prepare('SELECT * FROM storyboard_video_plans').all(), before);
});
