const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { listEpisodeTasks } = require('../src/services/episodeTaskService');
const taskRoutes = require('../src/routes/task');

const CREATED = '2026-05-01T10:00:00.000Z';

function insert(db, table, row) {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...columns.map((key) => row[key]));
}

function createDb(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  t.mock.method(console, 'log', () => {});
  runMigrationsAndEnsure(db);
  insert(db, 'dramas', { id: 1, title: '项目一' });
  insert(db, 'dramas', { id: 2, title: '项目二' });
  insert(db, 'episodes', { id: 10, drama_id: 1, episode_number: 1, title: '第一集' });
  insert(db, 'episodes', { id: 11, drama_id: 1, episode_number: 2, title: '第二集' });
  // An episode ID can equal another project's ID.
  insert(db, 'episodes', { id: 1, drama_id: 2, episode_number: 1, title: '别的项目' });
  insert(db, 'storyboards', { id: 100, episode_id: 10, storyboard_number: 1 });
  insert(db, 'storyboards', { id: 101, episode_id: 11, storyboard_number: 1 });
  insert(db, 'storyboards', { id: 10, episode_id: 11, storyboard_number: 2 });
  insert(db, 'storyboards', { id: 200, episode_id: 1, storyboard_number: 1 });
  return db;
}

function addTask(db, id, type, resourceId, extra = {}) {
  insert(db, 'async_tasks', {
    id, type, resource_id: String(resourceId), status: 'processing', progress: 27,
    message: '真实任务消息', created_at: CREATED, updated_at: CREATED, ...extra,
  });
}

function addImage(db, id, extra = {}) {
  insert(db, 'image_generations', {
    id, drama_id: 1, storyboard_id: 100, status: 'processing',
    provider: 'existing-provider', model: 'existing-model',
    created_at: CREATED, updated_at: CREATED, ...extra,
  });
}

function addVideo(db, id, extra = {}) {
  insert(db, 'video_generations', {
    id, drama_id: 1, storyboard_id: 100, status: 'processing',
    provider: 'existing-video-provider', model: 'existing-video-model',
    created_at: CREATED, updated_at: CREATED, ...extra,
  });
}

function allItems(db, episodeId = 10) {
  return listEpisodeTasks(db, episodeId, { limit: 100 }).items;
}

function makeResponse() {
  return {
    statusCode: null, payload: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.payload = value; return this; },
  };
}

test('episode task selection checks resource types, media links and project boundaries', (t) => {
  const db = createDb(t);
  addTask(db, 'episode-text', 'storyboard_generation', 10);
  addTask(db, 'episode-scene', 'background_extraction', 10);
  addTask(db, 'episode-prop', 'prop_extraction', 10);
  addTask(db, 'other-episode', 'storyboard_generation', 11);
  addTask(db, 'project-character', 'character_generation', 1);
  addTask(db, 'project-story', 'story_generation', 1);
  addTask(db, 'foreign-project', 'character_generation', 2);
  addTask(db, 'project-id-collision', 'story_generation', 10);
  addTask(db, 'foreign-episode-id-collision', 'background_extraction', 1);
  addTask(db, 'own-frame', 'frame_prompt_generation', 100);
  addTask(db, 'frame-id-collision', 'frame_prompt_generation', 10);
  addTask(db, 'own-image', 'image_generation', 1);
  addImage(db, 51, { task_id: 'own-image' });
  addTask(db, 'foreign-image-resource-collision', 'image_generation', 10);
  addImage(db, 52, { storyboard_id: 101, task_id: 'foreign-image-resource-collision' });
  addTask(db, 'own-video', 'video_generation', 1);
  addVideo(db, 61, { task_id: 'own-video' });
  addTask(db, 'foreign-video', 'video_generation', 1);
  addVideo(db, 62, { storyboard_id: 101, task_id: 'foreign-video' });
  addTask(db, 'foreign-project-image', 'image_generation', 2);
  addImage(db, 53, { drama_id: 2, storyboard_id: 200, task_id: 'foreign-project-image' });
  addTask(db, 'own-merge', 'video_merge', 10, { status: 'completed', progress: 100 });
  insert(db, 'video_merges', {
    id: 71, episode_id: 10, drama_id: 1, task_id: 'own-merge', status: 'completed',
    merged_url: '/static/merged.mp4', created_at: CREATED,
  });
  addTask(db, 'foreign-merge', 'video_merge', 11);
  addTask(db, 'deleted-task', 'background_extraction', 10, { deleted_at: CREATED });
  addImage(db, 54, { deleted_at: CREATED });

  const data = listEpisodeTasks(db, 10, { limit: 100 });
  assert.equal(data.drama_id, 1);
  assert.equal(data.episode_id, 10);
  assert.deepEqual(new Set(data.items.map((item) => item.id)), new Set([
    'episode-text', 'episode-scene', 'episode-prop', 'project-character', 'project-story',
    'own-frame', 'own-image', 'own-video', 'own-merge',
  ]));
  assert.equal(data.total, 9);
  for (const id of ['project-character', 'project-story']) {
    const item = data.items.find((row) => row.id === id);
    assert.equal(item.scope, 'project');
    assert.equal(item.resource_type, 'drama');
  }
  const image = data.items.find((item) => item.id === 'own-image');
  assert.equal(image.resource_type, 'storyboard');
  assert.equal(image.resource_id, '100');
  assert.equal(image.task_resource_id, '1');
  assert.equal(image.progress, 27);
  assert.equal(image.generation_id, 51);
  assert.equal(image.model, 'existing-model');
  assert.equal(image.provider, 'existing-provider');
  assert.equal(data.items.find((item) => item.id === 'own-merge').result_url, '/static/merged.mp4');
  assert.deepEqual(allItems(db, 1).map((item) => item.id).sort(), ['foreign-episode-id-collision', 'foreign-project', 'foreign-project-image'].sort());
});

test('shared assets use episode references without confusing character-library IDs', (t) => {
  const db = createDb(t);
  insert(db, 'characters', { id: 501, drama_id: 1, name: '共享角色' });
  insert(db, 'characters', { id: 502, drama_id: 1, name: '分镜引用角色' });
  insert(db, 'characters', { id: 503, drama_id: 1, name: '别集角色' });
  for (const episodeId of [10, 11]) insert(db, 'episode_characters', { episode_id: episodeId, character_id: 501 });
  insert(db, 'episode_characters', { episode_id: 11, character_id: 502 });
  insert(db, 'episode_characters', { episode_id: 11, character_id: 503 });
  db.prepare('UPDATE storyboards SET characters = ? WHERE id = 100').run(JSON.stringify([{ id: 502 }]));
  db.exec('CREATE TABLE IF NOT EXISTS storyboard_characters (storyboard_id INTEGER, character_id INTEGER)');
  insert(db, 'storyboard_characters', { storyboard_id: 100, character_id: 503 });
  addImage(db, 501, { storyboard_id: null, character_id: 501 });
  addImage(db, 502, { storyboard_id: null, character_id: 502 });
  addImage(db, 503, { storyboard_id: null, character_id: 503 });
  insert(db, 'scenes', { id: 601, drama_id: 1, episode_id: 11, location: '共享客厅' });
  insert(db, 'scenes', { id: 602, drama_id: 1, episode_id: 10, location: '本集场景' });
  db.prepare('UPDATE storyboards SET scene_id = 601 WHERE id IN (100, 101)').run();
  addImage(db, 601, { storyboard_id: null, scene_id: 601 });
  addImage(db, 602, { storyboard_id: null, scene_id: 602 });
  // A shared scene must not pull in another episode's storyboard work.
  addTask(db, 'shared-prefix-other-episode', 'image_generation', 'scene_601');
  addImage(db, 603, { storyboard_id: 101, scene_id: 601, task_id: 'shared-prefix-other-episode' });
  insert(db, 'props', { id: 701, drama_id: 1, episode_id: 11, name: '共享钥匙' });
  insert(db, 'props', { id: 702, drama_id: 1, episode_id: 10, name: '本集道具' });
  insert(db, 'storyboard_props', { storyboard_id: 100, prop_id: 701 });
  insert(db, 'storyboard_props', { storyboard_id: 101, prop_id: 701 });
  addTask(db, 'shared-prop', 'prop_image_generation', 701);
  addTask(db, 'own-prop', 'prop_image_generation', 702);

  const first = allItems(db);
  const second = allItems(db, 11);
  for (const id of ['image:501', 'image:502', 'image:601', 'shared-prop']) {
    assert.equal(first.find((item) => item.id === id)?.scope, 'shared', id);
    assert.equal(second.find((item) => item.id === id)?.scope, 'shared', id);
    assert.equal(first.filter((item) => item.id === id).length, 1);
  }
  assert.equal(first.find((item) => item.id === 'image:602').scope, 'episode');
  assert.equal(first.find((item) => item.id === 'own-prop').scope, 'episode');
  assert.ok(!first.some((item) => item.id === 'image:503' || item.id === 'shared-prefix-other-episode'));
  assert.ok(second.some((item) => item.id === 'shared-prefix-other-episode'));
  assert.ok(!second.some((item) => item.id === 'image:602' || item.id === 'own-prop'));
});

test('deduplicates UUID tasks, preserves real states and sorts by creation time', (t) => {
  const db = createDb(t);
  addTask(db, 'same-uuid', 'image_generation', 1, { status: 'pending', progress: 0, updated_at: '2099-01-01T00:00:00Z' });
  addImage(db, 1, { task_id: 'same-uuid', created_at: '2026-05-02T10:00:00Z', model: 'older' });
  addImage(db, 2, { task_id: 'same-uuid', created_at: '2026-05-03T10:00:00Z', model: 'newer' });
  addTask(db, 'cancelled-uuid', 'video_generation', 1, { status: 'cancelled', progress: 18, error: '用户取消' });
  addVideo(db, 2, { task_id: 'cancelled-uuid', status: 'processing' });
  addImage(db, 3, {
    status: 'completed', local_path: 'images/legacy.png',
    created_at: '2026-05-04T10:00:00Z', completed_at: '2026-05-04T10:01:00Z',
  });
  addVideo(db, 3, { task_id: 'missing-legacy-task', status: 'failed', error_msg: '上游失败', created_at: '2026-05-05T10:00:00Z' });

  const data = listEpisodeTasks(db, 10, { limit: 100 });
  assert.equal(data.total, 4);
  assert.deepEqual(data.items.map((item) => item.id), ['video:3', 'image:3', 'same-uuid', 'cancelled-uuid']);
  const canonical = data.items.find((item) => item.id === 'same-uuid');
  assert.equal(canonical.status, 'processing');
  assert.equal(canonical.progress, 0);
  assert.equal(canonical.generation_id, 2);
  assert.equal(canonical.model, 'newer');
  assert.equal(canonical.created_at, CREATED);
  const cancelled = data.items.find((item) => item.id === 'cancelled-uuid');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.progress, 18);
  assert.equal(cancelled.error, '用户取消');
  const historical = data.items.find((item) => item.id === 'image:3');
  assert.equal(historical.progress, null);
  assert.equal(historical.thumbnail_url, '/static/images/legacy.png');
  assert.equal(historical.finished_at, '2026-05-04T10:01:00Z');
  assert.equal(data.items.find((item) => item.id === 'video:3').progress, null);
  assert.deepEqual(data.stats, { active: 1, completed: 1, failed: 2 });
});

test('status filtering and paging keep totals and stats for the unfiltered episode', (t) => {
  const db = createDb(t);
  const statuses = ['pending', 'processing', 'completed', 'completed', 'failed', 'cancelled'];
  for (const [index, status] of statuses.entries()) {
    addTask(db, `task-${index}`, 'storyboard_generation', 10, {
      status, created_at: `2026-05-0${index + 1}T10:00:00Z`,
    });
  }
  const first = listEpisodeTasks(db, 10, { status: 'failed', limit: '1', page: '1' });
  const next = listEpisodeTasks(db, 10, { status: 'failed', limit: '1', page: '2' });
  assert.equal(first.total, 6);
  assert.equal(first.filtered_total, 2);
  assert.deepEqual(first.stats, { active: 2, completed: 2, failed: 2 });
  assert.deepEqual(next.stats, first.stats);
  assert.equal(first.items[0].id, 'task-5');
  assert.equal(first.items[0].status, 'cancelled');
  assert.equal(next.items[0].id, 'task-4');
  assert.equal(listEpisodeTasks(db, 10, { status: 'active' }).filtered_total, 2);
  assert.equal(listEpisodeTasks(db, 10, { status: 'completed' }).filtered_total, 2);
  assert.deepEqual(listEpisodeTasks(db, 10, { page: 99 }).items, []);
  for (let index = 6; index < 105; index += 1) addTask(db, `task-${index}`, 'storyboard_generation', 10);
  assert.equal(listEpisodeTasks(db, 10).items.length, 30);
  assert.equal(listEpisodeTasks(db, 10, { limit: 999 }).items.length, 100);
});

test('mixed SQLite UTC and ISO timestamps sort by creation and compare updates consistently', (t) => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
  t.after(() => {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  });
  const db = createDb(t);
  addTask(db, 'sqlite-time', 'image_generation', 1, {
    created_at: '2026-05-10 11:30:00', updated_at: '2026-05-10T09:30:00Z',
  });
  addImage(db, 9, { task_id: 'sqlite-time', updated_at: '2026-05-10 10:30:00' });
  addTask(db, 'iso-time', 'storyboard_generation', 10, { created_at: '2026-05-10T10:30:00Z' });
  addTask(db, 'offset-time', 'prop_extraction', 10, { created_at: '2026-05-10T20:00:00+08:00' });
  const items = allItems(db);
  assert.deepEqual(items.map((item) => item.id), ['offset-time', 'sqlite-time', 'iso-time']);
  assert.equal(items[1].updated_at, '2026-05-10 10:30:00');
});

test('legacy episode merges use their own namespace and linked merges keep one UUID', (t) => {
  const db = createDb(t);
  addTask(db, 'merge-uuid', 'video_merge', 10, { status: 'completed', progress: 100 });
  for (const [id, createdAt] of [[21, '2026-05-01T10:00:00Z'], [22, '2026-05-02T10:00:00Z']]) {
    insert(db, 'video_merges', {
      id, episode_id: 10, drama_id: 1, task_id: 'merge-uuid', status: 'completed',
      merged_url: `/static/merge-${id}.mp4`, created_at: createdAt,
    });
  }
  insert(db, 'video_merges', {
    id: 3, episode_id: 10, drama_id: 1, status: 'completed',
    merged_url: '/static/legacy-merge.mp4', created_at: CREATED,
  });
  addVideo(db, 3, { status: 'completed', video_url: '/static/legacy-video.mp4' });
  addTask(db, 'blocked-task', 'storyboard_generation', 10, { status: 'blocked', progress: null });
  const data = listEpisodeTasks(db, 10, { limit: 100 });
  assert.equal(data.total, 4);
  assert.equal(data.items.filter((item) => item.id === 'merge-uuid').length, 1);
  assert.equal(data.items.find((item) => item.id === 'merge-uuid').generation_id, 22);
  const legacy = data.items.find((item) => item.id === 'merge:3');
  assert.equal(legacy.source, 'video');
  assert.equal(legacy.type, 'video_merge');
  assert.equal(legacy.result_url, '/static/legacy-merge.mp4');
  assert.equal(legacy.progress, null);
  assert.ok(data.items.some((item) => item.id === 'video:3'));
  const failed = listEpisodeTasks(db, 10, { status: 'failed' });
  assert.deepEqual(failed.items.map((item) => item.id), ['blocked-task']);
  assert.equal(failed.stats.failed, 1);
  assert.equal(failed.items[0].status, 'blocked');
});

test('query-only SQLite accepts repeated reads and no stored rows or schema change', (t) => {
  const db = createDb(t);
  addTask(db, 'still-running', 'storyboard_generation', 10, { progress: 45 });
  addImage(db, 10, { status: 'completed', image_url: 'https://example.invalid/result.png' });
  addVideo(db, 10, { status: 'processing' });
  const before = db.serialize();
  const changesBefore = db.prepare('SELECT total_changes() AS count').get().count;
  db.pragma('query_only = ON');
  const first = listEpisodeTasks(db, 10);
  listEpisodeTasks(db, 11);
  assert.deepEqual(listEpisodeTasks(db, 10), first);
  assert.deepEqual(db.serialize(), before);
  assert.equal(db.prepare('SELECT total_changes() AS count').get().count, changesBefore);
  assert.equal(db.prepare('SELECT status, progress FROM async_tasks WHERE id = ?').get('still-running').progress, 45);
});

test('route returns the existing success envelope, rejects bad input and hides deleted episodes', (t) => {
  const db = createDb(t);
  const route = taskRoutes(db, { errorw() {} }).getEpisodeTasks;
  const success = makeResponse();
  route({ params: { episodeId: '10' }, query: {} }, success);
  assert.equal(success.statusCode, 200);
  assert.equal(success.payload.success, true);
  assert.equal(success.payload.data.episode_id, 10);
  assert.ok(success.payload.timestamp);
  const invalid = [
    { episodeId: '1 OR 1=1', query: {} },
    { episodeId: undefined, query: {} },
    { episodeId: '10', query: { page: 0 } },
    { episodeId: '10', query: { page: '2x' } },
    { episodeId: '10', query: { limit: -1 } },
    { episodeId: '10', query: { limit: ['1'] } },
    { episodeId: '10', query: { status: 'processing' } },
  ];
  for (const input of invalid) {
    const res = makeResponse();
    route({ params: { episodeId: input.episodeId }, query: input.query }, res);
    assert.equal(res.statusCode, 400, JSON.stringify(input));
    assert.equal(res.payload.error.code, 'BAD_REQUEST');
  }
  const missing = makeResponse();
  route({ params: { episodeId: '999' }, query: {} }, missing);
  assert.equal(missing.statusCode, 404);
  db.prepare('UPDATE episodes SET deleted_at = ? WHERE id = 10').run(CREATED);
  const deleted = makeResponse();
  route({ params: { episodeId: '10' }, query: {} }, deleted);
  assert.equal(deleted.statusCode, 404);
});
