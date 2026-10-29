const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const aiClient = require('../src/services/aiClient');
const config = require('../src/config');
const cfg = { app: { name: 'test' }, style: { default_style: '', default_video_ratio: '16:9' } };
const originalLoad = config.loadConfig;
config.loadConfig = () => cfg;
const generation = require('../src/services/episodeStoryboardService');
config.loadConfig = originalLoad;
const planning = require('../src/services/videoPlanningService');
const storyboard = require('../src/services/storyboardService');
const guard = require('../src/services/legacyVideoPlanningGuard');
const tasks = require('../src/services/taskService');
const videoRoutes = require('../src/routes/videos');
const log = { info() {}, warn() {}, error() {} };

function fixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE dramas(id INTEGER PRIMARY KEY, title TEXT, style TEXT, metadata TEXT, deleted_at TEXT);
    CREATE TABLE episodes(id INTEGER PRIMARY KEY, drama_id INTEGER, title TEXT, script_content TEXT, description TEXT, duration INTEGER, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE characters(id INTEGER PRIMARY KEY, drama_id INTEGER, name TEXT, appearance TEXT, deleted_at TEXT);
    CREATE TABLE character_libraries(id INTEGER PRIMARY KEY, drama_id INTEGER, name TEXT, deleted_at TEXT);
    CREATE TABLE episode_characters(episode_id INTEGER, character_id INTEGER);
    CREATE TABLE scenes(id INTEGER PRIMARY KEY, drama_id INTEGER, episode_id INTEGER, location TEXT, time TEXT, prompt TEXT, image_url TEXT, local_path TEXT, deleted_at TEXT);
    CREATE TABLE props(id INTEGER PRIMARY KEY, drama_id INTEGER, episode_id INTEGER, name TEXT, deleted_at TEXT);
    CREATE TABLE storyboards(id INTEGER PRIMARY KEY AUTOINCREMENT, episode_id INTEGER, scene_id INTEGER, storyboard_number INTEGER,
      title TEXT, description TEXT, location TEXT, time TEXT, duration INTEGER, dialogue TEXT, narration TEXT, action TEXT, result TEXT, atmosphere TEXT,
      image_prompt TEXT, video_prompt TEXT, characters TEXT, shot_type TEXT, angle TEXT, angle_h TEXT, angle_v TEXT, angle_s TEXT, movement TEXT,
      lighting_style TEXT, depth_of_field TEXT, segment_index INTEGER, segment_title TEXT, creation_mode TEXT, universal_segment_text TEXT,
      video_url TEXT, local_path TEXT, status TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE storyboard_characters(storyboard_id INTEGER, character_id INTEGER);
    CREATE TABLE storyboard_props(storyboard_id INTEGER, prop_id INTEGER, UNIQUE(storyboard_id,prop_id));
    CREATE TABLE video_generations(id INTEGER PRIMARY KEY, storyboard_id INTEGER, video_url TEXT, local_path TEXT, status TEXT, deleted_at TEXT);
    CREATE TABLE async_tasks(id TEXT PRIMARY KEY, type TEXT, status TEXT, progress INTEGER DEFAULT 0, message TEXT, error TEXT, result TEXT,
      resource_id TEXT, created_at TEXT, updated_at TEXT, completed_at TEXT, deleted_at TEXT);
    INSERT INTO dramas(id,title) VALUES(1,'本剧');
    INSERT INTO episodes(id,drama_id,title,script_content) VALUES(1,1,'本集','人在门口等待。'),(2,1,'下一集','人在门口继续等待。');
  `);
  planning.ensureVideoPlanningSchema(db);
  return db;
}
function shot(number = 1) {
  return { shot_number: number, title: '等待', action: '人在门口等待', duration: 5, video_prompt: '固定镜头，人在门口等待。',
    video_recommendation: { model_id: 'h3-drama', reason: '独立镜头。' + '完整且稳定的静态动作。'.repeat(60) } };
}
function seed(db, id = 10, episode = 1) {
  db.prepare('INSERT INTO storyboards(id,episode_id,storyboard_number,title,video_prompt,duration,characters) VALUES(?,?,1,?,?,5,?)')
    .run(id, episode, '既有分镜', '固定镜头，人在门口等待。', '[]');
  planning.applyStoryboardRecommendations(db, episode, [{ ...shot(), id }], { phase: 'final', generation_run_id: 'seed' });
  return planning.getStoryboardVideoPlan(db, id);
}
async function generate(t, db, output, hook, universal = false, timedContinuation = false) {
  if (timedContinuation) t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(aiClient, 'generateText', async (...args) => {
    assert.match(args[4], /video_recommendation/);
    assert.equal(args[5].model, 'text-only-model');
    if (hook) await hook(args);
    return typeof output === 'function' ? output() : output;
  });
  const run = generation.generateStoryboard(db, log, 1, 'text-only-model', null, null, 5, '16:9', false, universal, true);
  await new Promise(setImmediate);
  for (let i = 0; timedContinuation && i < 4 && tasks.getTask(db, run.task_id).status === 'processing'; i++) {
    t.mock.timers.tick(3000);
    await new Promise(setImmediate);
  }
  const task = tasks.getTask(db, run.task_id);
  assert.ok(['completed', 'failed'].includes(task.status), 'mock generation must settle');
  return task;
}

for (const universal of [false, true]) test(`stream draft promotes exact saved IDs to final (${universal ? 'universal' : 'classic'})`, async t => {
  const db = fixture(t);
  const raw = JSON.stringify([shot(1), shot(2)]);
  let draftIds;
  const task = await generate(t, db, raw, args => {
    args[5].streamCallback(raw);
    draftIds = db.prepare('SELECT id FROM storyboards WHERE deleted_at IS NULL ORDER BY id').all().map(r => r.id);
    assert.equal(draftIds.length, 2);
    for (const id of draftIds) {
      const plan = planning.getStoryboardVideoPlan(db, id);
      assert.equal(plan.recommendation.phase, 'draft');
      assert.notEqual(plan.validation.state, 'ready');
      assert.throws(() => guard.assertLegacyGenerationAllowed(db, id, 'h3-drama', 1), { code: 'VIDEO_PLAN_REQUIRED' });
    }
  }, universal);
  assert.equal(task.status, 'completed', task.error);
  const result = JSON.parse(task.result);
  assert.deepEqual(result.storyboards.map(s => s.id), draftIds);
  for (const row of result.storyboards) {
    assert.equal(row.video_plan.recommendation.phase, 'final');
    assert.equal(row.video_plan.validation.state, 'ready');
    assert.equal(row.video_plan.choice.model_id, 'h3-drama');
    assert.equal(row.creation_mode, universal ? 'universal' : 'classic');
  }
});

test('regeneration does not transfer a lock or selected media by shot number', async t => {
  const db = fixture(t);
  const old = seed(db);
  planning.setVideoChoice(db, 10, { model_id: 'h3-action', manual_locked: true, expected_revision: old.choice_revision });
  db.prepare('UPDATE storyboards SET video_url=? WHERE id=10').run('https://example.invalid/old.mp4');
  const task = await generate(t, db, JSON.stringify([shot()]));
  assert.equal(task.status, 'completed', task.error);
  const [fresh] = generation.getStoryboardsForEpisode(db, 1);
  assert.notEqual(fresh.id, 10);
  assert.equal(fresh.video_plan.choice.manual_locked, false);
  assert.equal(fresh.video_plan.choice.model_id, 'h3-drama');
  assert.equal(fresh.video_url, null);
  assert.ok(db.prepare('SELECT deleted_at FROM storyboards WHERE id=10').get().deleted_at);
  assert.equal(db.prepare('SELECT manual_locked FROM storyboard_video_plans WHERE storyboard_id=10').get().manual_locked, 1);
});

test('missing nested recommendation remains blocked and cannot create a legacy task', async t => {
  const db = fixture(t);
  const raw = shot(); delete raw.video_recommendation;
  const task = await generate(t, db, JSON.stringify([raw]));
  assert.equal(task.status, 'completed', task.error);
  const [row] = generation.getStoryboardsForEpisode(db, 1);
  assert.equal(row.video_plan.validation.state, 'blocked');
  assert.ok(row.video_plan.validation.blocking_reasons.includes('missing_recommendation'));
  const count = db.prepare('SELECT COUNT(*) n FROM async_tasks').get().n;
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  videoRoutes(db, log).create({ body: { storyboard_id: row.id, drama_id: 1, model: 'h3-drama' } }, res);
  assert.equal(res.code, 409);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM async_tasks').get().n, count);
});

test('interrupted stream keeps saved draft non-executable', async t => {
  const db = fixture(t);
  const raw = JSON.stringify([shot()]);
  const task = await generate(t, db, raw, args => {
    args[5].streamCallback(raw);
    throw new Error('mock connection interrupted');
  });
  assert.equal(task.status, 'completed');
  assert.equal(JSON.parse(task.result).truncated, true);
  const [row] = generation.getStoryboardsForEpisode(db, 1);
  assert.ok(row);
  assert.equal(row.video_plan.recommendation.phase, 'draft');
  assert.notEqual(row.video_plan.validation.state, 'ready');
});

test('history adoption is atomic, owned and compare-and-swap; it clears stale local media', t => {
  const db = fixture(t);
  seed(db); seed(db, 20, 2);
  db.exec(`UPDATE storyboard_video_plans SET selected_version_id='selected-version' WHERE storyboard_id=10;
    UPDATE storyboards SET video_url='https://example.invalid/old.mp4',local_path='old.mp4' WHERE id=10;
    INSERT INTO video_generations VALUES(1,10,'https://example.invalid/history.mp4',NULL,'completed',NULL);
    INSERT INTO video_generations VALUES(2,20,'https://example.invalid/foreign.mp4',NULL,'completed',NULL);`);
  assert.throws(() => storyboard.updateStoryboard(db, log, 10, { video_url: 'https://example.invalid/history.mp4' }), { code: 'ADOPTION_REVISION_REQUIRED' });
  assert.throws(() => storyboard.updateStoryboard(db, log, 10, { video_url: 'https://example.invalid/foreign.mp4', expected_adoption_revision: 0 }), { code: 'LEGACY_VIDEO_NOT_OWNED' });
  const changed = storyboard.updateStoryboard(db, log, 10, { video_url: 'https://example.invalid/history.mp4', expected_adoption_revision: 0 });
  assert.equal(changed.video_plan.selected_version_id, null);
  assert.equal(changed.video_plan.adoption_revision, 1);
  assert.equal(changed.local_path, null);
  assert.equal(changed.video_url, 'https://example.invalid/history.mp4');
  assert.throws(() => storyboard.updateStoryboard(db, log, 10, { video_url: 'https://example.invalid/history.mp4', expected_adoption_revision: 0 }), { code: 'ADOPTION_REVISION_CONFLICT' });
  assert.equal(guard.canAutoAdoptLegacyVideo(db, 10), false);
});

test('content edits invalidate consumers and archiving sources does not erase selection history', t => {
  const db = fixture(t);
  seed(db); seed(db, 20, 2);
  let source = planning.getStoryboardVideoPlan(db, 10);
  source = planning.setVideoChoice(db, 10, { model_id: 'h3-long-drama-first', manual_locked: true, expected_revision: source.choice_revision });
  const target = planning.getStoryboardVideoPlan(db, 20);
  planning.setVideoChoice(db, 20, { model_id: 'h3-long-drama-continue', source_ref: { kind: 'storyboard', storyboard_id: 10, choice_revision: source.choice_revision }, manual_locked: true, expected_revision: target.choice_revision });
  storyboard.updateStoryboard(db, log, 10, { video_prompt: '角色沿走廊一直向前走。' });
  assert.equal(planning.getStoryboardVideoPlan(db, 10).validation.state, 'stale');
  assert.equal(planning.getStoryboardVideoPlan(db, 20).validation.state, 'stale');
  storyboard.deleteStoryboard(db, log, 10);
  assert.notEqual(planning.getStoryboardVideoPlan(db, 20).validation.state, 'ready');
});

test('duplicate shot numbers share one saved ID and recommendation', async t => {
  const db = fixture(t);
  const duplicate = { ...shot(1), title: '应忽略的重复行', video_recommendation: { model_id: 'h3-action' } };
  const task = await generate(t, db, JSON.stringify([shot(1), duplicate, shot(2)]));
  assert.equal(task.status, 'completed', task.error);
  const result = JSON.parse(task.result);
  assert.equal(result.total, 2);
  assert.equal(result.total_duration, 10);
  const rows = generation.getStoryboardsForEpisode(db, 1);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.video_plan.choice.model_id, 'h3-drama');
    assert.equal(row.video_plan.validation.state, 'ready');
  }
});

test('failure committing recommendations rolls back replacement and retirement', async t => {
  const db = fixture(t);
  seed(db);
  t.mock.method(planning, 'applyStoryboardRecommendations', () => { throw new Error('mock planning write failed'); });
  const task = await generate(t, db, JSON.stringify([shot()]));
  assert.equal(task.status, 'failed');
  const rows = db.prepare('SELECT id FROM storyboards WHERE deleted_at IS NULL').all();
  assert.deepEqual(rows, [{ id: 10 }]);
  assert.equal(planning.getStoryboardVideoPlan(db, 10).validation.state, 'ready');
});

test('default long-stage workflow cannot bypass the legacy route with missing model', t => {
  const db = fixture(t);
  const client = require('../src/services/videoClient');
  t.mock.method(client, 'getDefaultVideoConfig', () => ({ model: ['h3-long-drama-first'], default_model: 'h3-long-drama-first' }));
  db.exec('INSERT INTO storyboards(id,episode_id,storyboard_number) VALUES(9,1,1)');
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  videoRoutes(db, log).create({ body: { storyboard_id: 9, drama_id: 1 } }, res);
  assert.equal(res.code, 409);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM async_tasks').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM video_generations').get().n, 0);
});

test('adopting history preserves an existing image input', t => {
  const db = fixture(t);
  db.exec("INSERT INTO storyboards(id,episode_id,storyboard_number,local_path) VALUES(9,1,1,'images/input.png')");
  planning.applyStoryboardRecommendations(db, 1, [{ ...shot(), id: 9 }], { phase: 'final', generation_run_id: 'seed' });
  db.exec("INSERT INTO video_generations VALUES(1,9,'https://example.invalid/history.mp4','videos/history.mp4','completed',NULL)");
  const result = storyboard.updateStoryboard(db, log, 9, { video_url: 'https://example.invalid/history.mp4', expected_adoption_revision: 0 });
  assert.equal(result.local_path, 'images/input.png');
  assert.equal(result.video_plan.validation.state, 'ready');
});

test('local-only history adoption retains selection identity without losing image input', t => {
  const db = fixture(t);
  db.exec("INSERT INTO storyboards(id,episode_id,storyboard_number,local_path) VALUES(9,1,1,'images/input.png')");
  planning.applyStoryboardRecommendations(db, 1, [{ ...shot(), id: 9 }], { phase: 'final', generation_run_id: 'seed' });
  db.exec("INSERT INTO video_generations VALUES(1,9,NULL,'videos/local-only.mp4','completed',NULL)");
  const result = storyboard.updateStoryboard(db, log, 9, { video_url: null, local_path: 'videos/local-only.mp4', expected_adoption_revision: 0 });
  assert.equal(result.video_url, '/static/videos/local-only.mp4');
  assert.equal(result.local_path, 'images/input.png');
  assert.equal(result.video_plan.validation.state, 'ready');
});

test('deep repair of truncated first recommendation cannot activate a final choice', async t => {
  const db = fixture(t);
  const raw = JSON.stringify([shot()]).slice(0, -4);
  const task = await generate(t, db, raw, null, false, true);
  assert.equal(task.status, 'completed', task.error);
  const result = JSON.parse(task.result);
  assert.equal(result.truncated, true);
  const [row] = generation.getStoryboardsForEpisode(db, 1);
  assert.ok(row);
  assert.equal(row.video_plan.recommendation.phase, 'draft');
  assert.notEqual(row.video_plan.validation.state, 'ready');
  assert.throws(() => guard.assertLegacyGenerationAllowed(db, row.id, 'h3-drama', 1), { code: 'VIDEO_PLAN_REQUIRED' });
});

for (const where of ['initial', 'continuation']) test(`complete later shots do not promote a repaired ${where} fragment to final`, async t => {
  const db = fixture(t);
  const outputs = where === 'initial'
    ? [JSON.stringify([shot(1)]).slice(0, -4), JSON.stringify([shot(2)])]
    : [`[${JSON.stringify(shot(1))}, {`, JSON.stringify([shot(2)]).slice(0, -4), JSON.stringify([shot(3)])];
  let index = 0;
  const task = await generate(t, db, () => outputs[index++], null, false, true);
  assert.equal(task.status, 'completed', task.error);
  const result = JSON.parse(task.result);
  assert.equal(result.truncated, true);
  assert.equal(result.storyboards.length, where === 'initial' ? 2 : 3);
  for (const row of result.storyboards) {
    assert.equal(row.video_plan.recommendation.phase, 'draft');
    assert.notEqual(row.video_plan.validation.state, 'ready');
  }
});

test('legacy route rejects long-stage aliases and wrong-drama targets before any task', t => {
  const db = fixture(t);
  db.exec("INSERT INTO storyboards(id,episode_id,storyboard_number) VALUES(9,1,1)");
  assert.throws(() => guard.assertLegacyGenerationAllowed(db, 9, 'h3-long-drama-first', 1), { code: 'VIDEO_PLAN_REQUIRED' });
  assert.throws(() => guard.assertLegacyGenerationAllowed(db, 9, 'h3-drama', 2), { code: 'STORYBOARD_OWNERSHIP_MISMATCH' });
  assert.throws(() => guard.assertLegacyGenerationAllowed(db, 999, 'h3-drama', 1), { code: 'STORYBOARD_NOT_ACTIVE' });
});
