const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const revisions = require('../src/services/episodeRevisionService');
const dramaService = require('../src/services/dramaService');
const dramaRoutes = require('../src/routes/drama');
const { runMigrationsAndEnsure, ensureEpisodeNumberIndex } = require('../src/db/migrate');
const { createEpisodeTestDb, contentSnapshot, log, makeResponse } = require('./helpers/episodeTestDb');

const episode = (db, id) => db.prepare('SELECT * FROM episodes WHERE id = ?').get(id);
const drama = (db) => db.prepare('SELECT * FROM dramas WHERE id = 1').get();

test('episode CRUD preserves unrelated content, checks ownership/revisions, and never resurrects history', (t) => {
  const db = createEpisodeTestDb(t);
  const otherEpisode = episode(db, 1);
  const untouched = episode(db, 11);
  const saved = dramaService.updateEpisode(db, log, 1, 10, { title: '改标题', expected_revision: 1 });
  assert.equal(saved.revision, 2);
  assert.equal(saved.episodes_revision, 1);
  assert.equal(saved.description, '第一集梗概');
  assert.equal(saved.script_content, '第一集正文');
  assert.equal(drama(db).description, '项目世界背景');
  assert.deepEqual(episode(db, 11), untouched);
  assert.deepEqual(episode(db, 1), otherEpisode);

  const before = contentSnapshot(db);
  assert.throws(() => revisions.updateEpisode(db, 1, 10, { script_content: '过期', expected_revision: 1 }), { statusCode: 409 });
  assert.throws(() => revisions.updateEpisode(db, 1, 10, { title: '缺少版本' }), { statusCode: 400 });
  assert.throws(() => revisions.deleteEpisode(db, 2, 10, { expected_revision: 2 }), { statusCode: 404 });
  assert.throws(() => revisions.updateEpisode(db, 1, 1, { expected_revision: 1, title: '跨项目' }), { statusCode: 404 });
  assert.deepEqual(contentSnapshot(db), before);

  const deleted = dramaService.deleteEpisode(db, log, 1, 10, { expected_revision: 2 });
  assert.equal(deleted.revision, 3);
  assert.equal(deleted.episodes_revision, 2);
  assert.ok(episode(db, 10).deleted_at);
  const created = dramaService.createEpisode(db, log, 1, { description: '新梗概', episode_number: 1 });
  assert.equal(created.episode_number, 3);
  assert.notEqual(created.id, 10);
  assert.equal(created.revision, 1);
  assert.equal(created.episodes_revision, 3);
  assert.ok(episode(db, 10).deleted_at);
  assert.equal(drama(db).total_episodes, 2);
  const fetched = dramaService.getDrama(db, 1);
  assert.equal(fetched.episodes_revision, 3);
  assert.deepEqual(fetched.episodes.map((row) => [row.id, row.revision]), [[11, 1], [created.id, 1]]);
});

test('append adds only; replace retains IDs and omitted fields; legacy mode-less replacement stays supported', (t) => {
  const db = createEpisodeTestDb(t);
  const old = episode(db, 10);
  const appended = dramaService.saveEpisodes(db, log, 1, {
    mode: 'append', expected_collection_revision: 0,
    episodes: [{ episode_number: '003', title: '追加', description: '第三集梗概', script_content: '第三集正文' }],
  });
  assert.equal(appended.episodes_revision, 1);
  assert.equal(appended.episodes.length, 3);
  assert.deepEqual(episode(db, 10), old);
  const third = appended.episodes[2];
  assert.equal(third.episode_number, 3);
  assert.equal(third.revision, 1);
  const before = contentSnapshot(db);
  assert.throws(() => dramaService.saveEpisodes(db, log, 1, {
    mode: 'append', expected_collection_revision: 1, episodes: [{ episode_number: 1, title: '不能覆盖' }],
  }), { statusCode: 409 });
  assert.deepEqual(contentSnapshot(db), before);

  const replaced = dramaService.saveEpisodes(db, log, 1, {
    mode: 'replace', expected_collection_revision: 1,
    episodes: [{ id: 10, episode_number: 1, title: '保留第一集' }, { id: third.id, episode_number: 3, description: '改梗概' }],
  });
  assert.equal(replaced.episodes_revision, 2);
  assert.equal(episode(db, 10).id, 10);
  assert.equal(episode(db, 10).script_content, '第一集正文');
  assert.equal(episode(db, 10).description, '第一集梗概');
  assert.equal(episode(db, 10).revision, 2);
  assert.ok(episode(db, 11).deleted_at);
  assert.equal(episode(db, 11).revision, 2);
  assert.equal(episode(db, third.id).title, '追加');
  assert.equal(episode(db, third.id).script_content, '第三集正文');

  const legacy = dramaService.saveEpisodes(db, log, 1, { episodes: [{ episode_number: 2, title: '新第二集' }] });
  assert.equal(legacy.episodes_revision, 3);
  assert.equal(legacy.episodes.length, 1);
  assert.notEqual(legacy.episodes[0].id, 11);
  assert.ok(episode(db, 11).deleted_at);
  assert.equal(drama(db).total_episodes, 1);
});

test('bulk validation rejects normalized duplicates, invalid numbers, stale/foreign IDs before changing data', (t) => {
  const db = createEpisodeTestDb(t);
  const cases = [
    { episodes: [{ episode_number: 3 }, { episode_number: '03' }] },
    ...[0, -1, 1.5, '2.5', '', true, null, '9007199254740992'].map((number) => ({ episodes: [{ episode_number: number }] })),
    { episodes: [{ episode_number: 3 }, { id: 1, episode_number: 4 }] },
    { episodes: [{ id: 10, episode_number: 2 }] },
    { episodes: [{ episode_number: 3, title: {} }] },
    { mode: 'bad', episodes: [] },
    { mode: 'append', episodes: [] },
    { mode: 'replace', expected_collection_revision: 8, episodes: [] },
  ];
  const before = contentSnapshot(db);
  for (const body of cases) {
    assert.throws(() => revisions.saveEpisodes(db, 1, body));
    assert.deepEqual(contentSnapshot(db), before);
  }
  revisions.deleteEpisode(db, 1, 10, { expected_revision: 1 });
  const afterDelete = contentSnapshot(db);
  assert.throws(() => revisions.saveEpisodes(db, 1, { episodes: [{ id: 10, episode_number: 1 }] }), { statusCode: 400 });
  assert.deepEqual(contentSnapshot(db), afterDelete);
});

test('a later SQL failure rolls back earlier bulk writes, soft deletion, and collection version', (t) => {
  const db = createEpisodeTestDb(t);
  db.exec(`CREATE TRIGGER fail_episode_four BEFORE INSERT ON episodes WHEN NEW.episode_number = 4
    BEGIN SELECT RAISE(ABORT, 'blocked episode four'); END`);
  const before = contentSnapshot(db);
  assert.throws(() => revisions.saveEpisodes(db, 1, {
    mode: 'replace', expected_collection_revision: 0,
    episodes: [{ episode_number: 1, title: '不应保留' }, { episode_number: 3 }, { episode_number: 4 }],
  }), /blocked episode four/);
  assert.deepEqual(contentSnapshot(db), before);
});

test('partial shared outline save retains absent tags and metadata without changing episode premises/revisions', (t) => {
  const db = createEpisodeTestDb(t);
  const before = db.prepare('SELECT * FROM episodes ORDER BY id').all();
  dramaService.saveOutline(db, log, 1, { summary: '新的共享背景', metadata: { added: true } });
  assert.equal(drama(db).description, '新的共享背景');
  assert.equal(drama(db).tags, '["保留标签"]');
  assert.deepEqual(JSON.parse(drama(db).metadata), { aspect_ratio: '16:9', custom: 'keep', added: true });
  assert.equal(drama(db).episodes_revision, 0);
  assert.deepEqual(db.prepare('SELECT * FROM episodes ORDER BY id').all(), before);
});

test('CRUD route responses expose versions and return typed errors for invalid/conflicting requests', (t) => {
  const db = createEpisodeTestDb(t);
  const routes = dramaRoutes(db, {}, log);
  const patch = makeResponse();
  routes.updateEpisode({ params: { id: '1', episodeId: '10' }, body: { description: '本集新梗概', expected_revision: 1 } }, patch);
  assert.equal(patch.statusCode, 200);
  assert.equal(patch.payload.data.revision, 2);
  assert.equal(patch.payload.data.episodes_revision, 1);
  const conflict = makeResponse();
  routes.deleteEpisode({ params: { id: '1', episodeId: '10' }, body: { expected_revision: 1 } }, conflict);
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.payload.error.details.current_revision, 2);
  const missing = makeResponse();
  routes.updateEpisode({ params: { id: '1', episodeId: '10' }, body: {} }, missing);
  assert.equal(missing.statusCode, 400);
  const foreign = makeResponse();
  routes.deleteEpisode({ params: { id: '1', episodeId: '1' }, body: { expected_revision: 1 } }, foreign);
  assert.equal(foreign.statusCode, 404);
  const create = makeResponse();
  routes.createEpisode({ params: { id: '1' }, body: { title: '新分集' } }, create);
  assert.equal(create.statusCode, 201);
  assert.equal(create.payload.data.revision, 1);
  const bulk = makeResponse();
  routes.saveEpisodes({ params: { id: '1' }, body: { mode: 'append', expected_collection_revision: 2, episodes: [{ episode_number: 4 }] } }, bulk);
  assert.equal(bulk.statusCode, 200);
  assert.equal(bulk.payload.data.episodes_revision, 3);
});

test('registered API routes preserve raw novel chapter limits and map input validation to 400', async (t) => {
  const db = createEpisodeTestDb(t);
  const { setupRouter } = require('../src/routes');
  const router = setupRouter({}, db, log);
  const route = (path, method) => router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]).route;
  assert.ok(route('/dramas/:id/episodes', 'post'));
  assert.ok(route('/dramas/:id/episodes/:episodeId', 'patch'));
  assert.ok(route('/dramas/:id/episodes/:episodeId', 'delete'));
  assert.ok(route('/dramas/:id/episodes/:episodeId/generation/story', 'post'));
  const importRoute = route('/dramas/import-novel', 'post');
  const handler = importRoute.stack.at(-1).handle;
  const before = contentSnapshot(db);
  for (const value of ['', '0', '2.5', 'nonsense', 0, 1.5, null, false, [], {}]) {
    const res = makeResponse();
    await handler({ body: { text: '第1章 开场\n完整原文。', max_chapters: value } }, res);
    assert.equal(res.statusCode, 400, JSON.stringify(value));
    assert.match(res.payload.error.message, /max_chapters/);
  }
  for (const text of [42, {}, ['bad text']]) {
    const res = makeResponse();
    await handler({ body: { text } }, res);
    assert.equal(res.statusCode, 400);
  }
  const success = makeResponse();
  await handler({ body: { text: '第1章 开场\n完整原文。' } }, success);
  assert.equal(success.statusCode, 200);
  assert.equal(success.payload.data.chapters[0].script, '完整原文。');
  assert.deepEqual(contentSnapshot(db), before);
});

test('revision migration initializes existing rows, is repeatable, and preserves duplicate history', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  // Legacy tables intentionally lack revision columns and contain active duplicates.
  db.exec(`CREATE TABLE dramas (id INTEGER PRIMARY KEY, title TEXT, deleted_at TEXT);
    CREATE TABLE episodes (id INTEGER PRIMARY KEY, drama_id INTEGER, episode_number INTEGER, title TEXT, deleted_at TEXT);
    INSERT INTO dramas (id, title) VALUES (1, '旧项目');
    INSERT INTO episodes VALUES (1, 1, 1, '旧第一集', NULL), (2, 1, 1, '重复旧集', NULL), (3, 1, 1, '历史集', '2020-01-01');`);
  runMigrationsAndEnsure(db);
  assert.equal(db.prepare('SELECT episodes_revision FROM dramas WHERE id = 1').get().episodes_revision, 0);
  assert.deepEqual(db.prepare('SELECT revision FROM episodes ORDER BY id').all(), [{ revision: 1 }, { revision: 1 }, { revision: 1 }]);
  const retained = db.prepare('SELECT id, title, deleted_at FROM episodes ORDER BY id').all();
  assert.equal(ensureEpisodeNumberIndex(db).created, false);
  assert.deepEqual(db.prepare('SELECT id, title, deleted_at FROM episodes ORDER BY id').all(), retained);
  runMigrationsAndEnsure(db);
  assert.deepEqual(db.prepare('SELECT id, title, deleted_at FROM episodes ORDER BY id').all(), retained);
  db.prepare('UPDATE episodes SET deleted_at = ? WHERE id = 2').run('resolved explicitly');
  assert.equal(ensureEpisodeNumberIndex(db).created, true);
  assert.throws(() => db.prepare('INSERT INTO episodes (drama_id, episode_number, title) VALUES (1, 1, ?)').run('duplicate'), /UNIQUE/);
  assert.doesNotThrow(() => db.prepare('INSERT INTO episodes (drama_id, episode_number, title, deleted_at) VALUES (1, 1, ?, ?)').run('more history', 'deleted'));
});
