const test = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../src/services/aiClient');
const story = require('../src/services/storyGenerationService');
const tasks = require('../src/services/taskService');
const revisions = require('../src/services/episodeRevisionService');
const { listEpisodeTasks } = require('../src/services/episodeTaskService');
const dramaRoutes = require('../src/routes/drama');
const { createEpisodeTestDb, contentSnapshot, log, makeResponse } = require('./helpers/episodeTestDb');

const valid = JSON.stringify([{ episode: 900, id: 1, drama_id: 2, title: '生成标题', content: '生成的完整正文' }]);
const row = (db, id) => db.prepare('SELECT * FROM episodes WHERE id = ?').get(id);
const result = (db, id) => JSON.parse(tasks.getTask(db, id).result);
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function pendingEpisode(db, input = {}, episodeId = 11) {
  const req = story.prepareEpisodeRequest(db, 1, episodeId, { premise: '本集独立梗概', expected_revision: 1, ...input });
  const task = tasks.createTask(db, log, 'episode_story_generation', String(episodeId));
  return { req, task };
}
function pendingBulk(db, input = {}) {
  const task = tasks.createTask(db, log, 'story_generation', '1');
  return { task, req: { drama_id: 1, premise: '整剧梗概', episode_count: 1, mode: 'replace', expected_collection_revision: 0, ...input } };
}

test('single generation atomically updates only selected IDs, uses premise/context, and ignores model numbering', async (t) => {
  const db = createEpisodeTestDb(t);
  const first = row(db, 10);
  const other = row(db, 1);
  const beforeDrama = db.prepare('SELECT * FROM dramas WHERE id = 1').get();
  let call;
  t.mock.method(ai, 'generateText', async (...args) => { call = args; return valid; });
  const { req, task } = pendingEpisode(db, { title: '用户标题', reference_previous: true, model: 'mock-model' });
  await story.processEpisodeStoryGeneration(db, log, task.id, req);
  assert.equal(tasks.getTask(db, task.id).status, 'completed');
  assert.deepEqual(result(db, task.id), { applied: true, drama_id: 1, episode_id: 11, revision: 2, episode_count: 1 });
  assert.equal(row(db, 11).title, '用户标题');
  assert.equal(row(db, 11).description, '本集独立梗概');
  assert.equal(row(db, 11).script_content, '生成的完整正文');
  assert.equal(row(db, 11).episode_number, 2);
  assert.equal(row(db, 11).revision, 2);
  assert.equal(db.prepare('SELECT episodes_revision FROM dramas WHERE id = 1').get().episodes_revision, 1);
  assert.equal(db.prepare('SELECT description FROM dramas WHERE id = 1').get().description, beforeDrama.description);
  assert.equal(db.prepare('SELECT title FROM dramas WHERE id = 1').get().title, beforeDrama.title);
  assert.deepEqual(row(db, 10), first);
  assert.deepEqual(row(db, 1), other);
  assert.match(call[3], /本集独立梗概/);
  assert.match(call[3], /项目世界背景/);
  assert.match(call[3], /第一集正文/);
  assert.match(call[3], /"episode_number":2/);
  assert.equal(call[5].model, 'mock-model');
});

test('previous episode is opt-in and model title is used without mutating shared project title', async (t) => {
  const db = createEpisodeTestDb(t);
  let userPrompt;
  t.mock.method(ai, 'generateText', async (...args) => { userPrompt = args[3]; return valid; });
  const { req, task } = pendingEpisode(db);
  await story.processEpisodeStoryGeneration(db, log, task.id, req);
  assert.equal(row(db, 11).title, '生成标题');
  assert.doesNotMatch(userPrompt, /第一集正文/);
  assert.equal(db.prepare('SELECT title FROM dramas WHERE id = 1').get().title, '共享项目');
});

test('edit during AI preserves edited data and completes with retained conflict candidate', async (t) => {
  const db = createEpisodeTestDb(t);
  const entered = deferred(), answer = deferred();
  t.mock.method(ai, 'generateText', () => { entered.resolve(); return answer.promise; });
  const { req, task } = pendingEpisode(db);
  const running = story.processEpisodeStoryGeneration(db, log, task.id, req);
  await entered.promise;
  revisions.updateEpisode(db, 1, 11, { script_content: '人类编辑', expected_revision: 1 });
  const edited = contentSnapshot(db);
  answer.resolve(valid);
  await running;
  assert.equal(tasks.getTask(db, task.id).status, 'completed');
  assert.deepEqual(result(db, task.id), { applied: false, conflict: true,
    candidate: { title: '生成标题', description: '本集独立梗概', script_content: '生成的完整正文' }, drama_id: 1, episode_id: 11 });
  assert.deepEqual(contentSnapshot(db), edited);
});

test('delete during AI retains candidate and never resurrects the removed target or rewrites another row', async (t) => {
  const db = createEpisodeTestDb(t);
  const entered = deferred(), answer = deferred();
  t.mock.method(ai, 'generateText', () => { entered.resolve(); return answer.promise; });
  const { req, task } = pendingEpisode(db);
  const running = story.processEpisodeStoryGeneration(db, log, task.id, req);
  await entered.promise;
  revisions.deleteEpisode(db, 1, 11, { expected_revision: 1 });
  revisions.createEpisode(db, 1, { title: '新的分集' });
  const removed = contentSnapshot(db);
  answer.resolve(valid);
  await running;
  assert.equal(result(db, task.id).conflict, true);
  assert.equal(result(db, task.id).candidate.script_content, '生成的完整正文');
  assert.deepEqual(contentSnapshot(db), removed);
});

test('cancel during AI prevents late writes, late task completion, progress revival, and late failure changes', async (t) => {
  const db = createEpisodeTestDb(t);
  const entered = deferred(), answer = deferred();
  t.mock.method(ai, 'generateText', () => { entered.resolve(); return answer.promise; });
  const { req, task } = pendingEpisode(db);
  const before = contentSnapshot(db);
  const running = story.processEpisodeStoryGeneration(db, log, task.id, req);
  await entered.promise;
  tasks.cancelTask(db, log, task.id);
  const cancelled = tasks.getTask(db, task.id);
  assert.equal(cancelled.status, 'failed');
  answer.resolve(valid);
  await running;
  assert.deepEqual(contentSnapshot(db), before);
  assert.deepEqual(tasks.getTask(db, task.id), cancelled);
  assert.equal(tasks.updateTaskStatus(db, task.id, 'processing', 80, 'late'), false);
  assert.equal(tasks.updateTaskError(db, task.id, 'late error'), false);
  assert.equal(tasks.updateTaskResult(db, task.id, { applied: true }), false);
  assert.deepEqual(tasks.getTask(db, task.id), cancelled);
});

test('cancel before generation skips AI; a late AI exception cannot replace cancellation', async (t) => {
  const db = createEpisodeTestDb(t);
  const aiMock = t.mock.method(ai, 'generateText', async () => { throw new Error('should not call'); });
  const first = pendingEpisode(db);
  tasks.cancelTask(db, log, first.task.id);
  await story.processEpisodeStoryGeneration(db, log, first.task.id, first.req);
  assert.equal(aiMock.mock.callCount(), 0);
  const entered = deferred(), answer = deferred();
  aiMock.mock.mockImplementation(() => { entered.resolve(); return answer.promise; });
  const second = pendingEpisode(db);
  const running = story.processEpisodeStoryGeneration(db, log, second.task.id, second.req);
  await entered.promise;
  tasks.cancelTask(db, log, second.task.id);
  const cancelled = tasks.getTask(db, second.task.id);
  answer.reject(new Error('late mock network error'));
  await running;
  assert.deepEqual(tasks.getTask(db, second.task.id), cancelled);
});

test('invalid JSON, count, missing/empty content and title never alter any episode data', async (t) => {
  const db = createEpisodeTestDb(t);
  const responses = [
    'plain prose that must never become script_content',
    '[{"title":"不完整","content":"截断',
    '[]',
    '[{"title":"A","content":"one"},{"title":"B","content":"two"}]',
    '[{"title":"","content":"body"}]',
    '[{"title":"title","content":"  "}]',
    '[{"title":"title","script_content":"wrong field"}]',
    '[{"title":32,"content":"body"}]',
    '[null]',
  ];
  const aiMock = t.mock.method(ai, 'generateText', async () => '');
  for (const raw of responses) {
    aiMock.mock.mockImplementation(async () => raw);
    const { req, task } = pendingEpisode(db);
    const before = contentSnapshot(db);
    await story.processEpisodeStoryGeneration(db, log, task.id, req);
    assert.equal(tasks.getTask(db, task.id).status, 'failed', raw);
    assert.equal(tasks.getTask(db, task.id).result, null);
    assert.deepEqual(contentSnapshot(db), before, raw);
  }
});

test('task completion failure rolls back the script and revisions in the same transaction', async (t) => {
  const db = createEpisodeTestDb(t);
  t.mock.method(ai, 'generateText', async () => valid);
  t.mock.method(tasks, 'updateTaskResult', () => false);
  const { req, task } = pendingEpisode(db);
  const before = contentSnapshot(db);
  await story.processEpisodeStoryGeneration(db, log, task.id, req);
  assert.deepEqual(contentSnapshot(db), before);
  assert.equal(tasks.getTask(db, task.id).status, 'failed');
});

test('stale edit before the queued worker starts skips AI and does not write', async (t) => {
  const db = createEpisodeTestDb(t);
  const mock = t.mock.method(ai, 'generateText', async () => valid);
  const { req, task } = pendingEpisode(db);
  revisions.updateEpisode(db, 1, 11, { title: '新标题', expected_revision: 1 });
  const before = contentSnapshot(db);
  await story.processEpisodeStoryGeneration(db, log, task.id, req);
  assert.equal(mock.mock.callCount(), 0);
  assert.equal(tasks.getTask(db, task.id).status, 'failed');
  assert.deepEqual(contentSnapshot(db), before);
});

test('single POST fixes route target, deduplicates active work, and validates before enqueueing', async (t) => {
  const db = createEpisodeTestDb(t);
  const routes = dramaRoutes(db, {}, log);
  const aiMock = t.mock.method(ai, 'generateText', async () => valid);
  for (const [episodeId, body, expectedStatus] of [
    ['11', { premise: 'test' }, 400],
    ['11', { premise: 'test', expected_revision: 0 }, 409],
    ['1', { premise: 'test', expected_revision: 1 }, 404],
    ['11', { premise: '', expected_revision: 1 }, 400],
    ['11', { premise: 'test', expected_revision: 1, reference_previous: 'yes' }, 400],
  ]) {
    const res = makeResponse();
    routes.generateEpisodeStory({ params: { id: '1', episodeId }, body }, res);
    assert.equal(res.statusCode, expectedStatus);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM async_tasks').get().n, 0);
  const res = makeResponse();
  const body = { premise: 'route premise', expected_revision: 1, drama_id: 2, episode_id: 1, episode_number: 999 };
  routes.generateEpisodeStory({ params: { id: '1', episodeId: '11' }, body }, res);
  assert.equal(res.statusCode, 200);
  const taskId = res.payload.data.task_id;
  const duplicate = story.startEpisodeStoryGeneration(db, log, 1, 11, body);
  assert.equal(duplicate, taskId);
  assert.equal(tasks.getTask(db, taskId).type, 'episode_story_generation');
  assert.equal(tasks.getTask(db, taskId).resource_id, '11');
  await new Promise(setImmediate); // process the explicit enqueue, never start an HTTP service
  assert.equal(aiMock.mock.callCount(), 1);
  assert.equal(result(db, taskId).episode_id, 11);
  assert.equal(row(db, 1).script_content, '其他正文');
  assert.equal(row(db, 11).episode_number, 2);
});

test('bulk replacement strictly validates count/content and does not apply malformed AI fallback', async (t) => {
  const db = createEpisodeTestDb(t);
  const mock = t.mock.method(ai, 'generateText', async () => '');
  const raws = [
    'prose',
    '[{"episode":1,"title":"A","content":"one"}]', // wrong count
    '[{"episode":1,"title":"A","content":"one"},{"episode":"01","title":"B","content":"two"}]',
    '[{"episode":1,"title":"A","content":"one"},{"episode":3,"title":"B","content":"two"}]',
    '[{"episode":1,"title":"A","content":"one"},{"episode":2,"title":"B","content":""}]',
  ];
  for (const raw of raws) {
    mock.mock.mockImplementation(async () => raw);
    const { req, task } = pendingBulk(db, { episode_count: 2 });
    const before = contentSnapshot(db);
    await story.processStoryGeneration(db, log, task.id, req);
    assert.equal(tasks.getTask(db, task.id).status, 'failed', raw);
    assert.deepEqual(contentSnapshot(db), before);
  }
});

test('bulk append uses server snapshot numbering and leaves existing IDs/content/premises intact', async (t) => {
  const db = createEpisodeTestDb(t);
  const first = row(db, 10), second = row(db, 11);
  t.mock.method(ai, 'generateText', async () => '[{"episode":1,"title":"第三集","content":"新增正文"}]');
  const taskId = story.startStoryGeneration(db, log, { drama_id: 1, premise: '追加故事', mode: 'append', expected_collection_revision: 0 });
  await new Promise(setImmediate);
  assert.deepEqual(row(db, 10), first);
  assert.deepEqual(row(db, 11), second);
  const episodes = db.prepare('SELECT * FROM episodes WHERE drama_id = 1 AND deleted_at IS NULL ORDER BY episode_number').all();
  assert.equal(episodes.length, 3);
  assert.equal(episodes[2].episode_number, 3);
  assert.equal(episodes[2].script_content, '新增正文');
  assert.deepEqual(result(db, taskId), { applied: true, drama_id: 1, episode_count: 1, episodes_revision: 1 });
});

test('bulk edit/cancel during AI prevent replacement and candidate remains available on edit conflict', async (t) => {
  const db = createEpisodeTestDb(t);
  const entered = deferred(), answer = deferred();
  const mock = t.mock.method(ai, 'generateText', () => { entered.resolve(); return answer.promise; });
  const first = pendingBulk(db);
  const running = story.processStoryGeneration(db, log, first.task.id, first.req);
  await entered.promise;
  revisions.updateEpisode(db, 1, 10, { description: '人类梗概', expected_revision: 1 });
  const edited = contentSnapshot(db);
  answer.resolve('[{"episode":1,"title":"AI标题","content":"AI正文"}]');
  await running;
  assert.deepEqual(contentSnapshot(db), edited);
  assert.equal(result(db, first.task.id).conflict, true);
  assert.equal(result(db, first.task.id).candidate.episodes[0].script_content, 'AI正文');

  const entered2 = deferred(), answer2 = deferred();
  mock.mock.mockImplementation(() => { entered2.resolve(); return answer2.promise; });
  const second = pendingBulk(db, { expected_collection_revision: 1 });
  const running2 = story.processStoryGeneration(db, log, second.task.id, second.req);
  await entered2.promise;
  tasks.cancelTask(db, log, second.task.id);
  const cancelled = tasks.getTask(db, second.task.id);
  answer2.resolve('[{"episode":1,"title":"AI标题","content":"AI正文"}]');
  await running2;
  assert.deepEqual(contentSnapshot(db), edited);
  assert.deepEqual(tasks.getTask(db, second.task.id), cancelled);
});

test('episode task reader and agent task ownership distinguish new episode scope from colliding project IDs', async (t) => {
  const db = createEpisodeTestDb(t);
  const selected = tasks.createTask(db, log, 'episode_story_generation', '11');
  const shared = tasks.createTask(db, log, 'story_generation', '1');
  const foreign = tasks.createTask(db, log, 'episode_story_generation', '1');
  const listed = listEpisodeTasks(db, 11);
  assert.equal(listed.items.find((item) => item.id === selected.id).scope, 'episode');
  assert.equal(listed.items.find((item) => item.id === selected.id).label, '本集剧情生成');
  assert.equal(listed.items.find((item) => item.id === shared.id).scope, 'project');
  assert.equal(listed.items.some((item) => item.id === foreign.id), false);
  assert.deepEqual(tasks.getTasksByResource(db, '1', { type: 'episode_story_generation' }).map((item) => item.id), [foreign.id]);
  const { executeGetTask } = await import('../src/mastra/tools.mjs');
  assert.equal(executeGetTask(db, 1, { taskId: selected.id }).ok, true);
  assert.equal(executeGetTask(db, 1, { taskId: shared.id }).ok, true);
  assert.equal(executeGetTask(db, 1, { taskId: foreign.id }).ok, false);
});
