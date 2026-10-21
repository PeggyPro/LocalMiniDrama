const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../../src/db/migrate');

function createEpisodeTestDb(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  t.mock.method(console, 'log', () => {});
  runMigrationsAndEnsure(db);
  db.prepare(`INSERT INTO dramas (id, title, description, genre, tags, metadata) VALUES (?, ?, ?, ?, ?, ?)`).run(
    1, '共享项目', '项目世界背景', '冒险', '["保留标签"]', '{"aspect_ratio":"16:9","custom":"keep"}'
  );
  db.prepare('INSERT INTO dramas (id, title, description) VALUES (2, ?, ?)').run('另一个项目', '别处背景');
  const insert = db.prepare(`INSERT INTO episodes (id, drama_id, episode_number, title, description, script_content)
    VALUES (?, ?, ?, ?, ?, ?)`);
  insert.run(10, 1, 1, '第一集', '第一集梗概', '第一集正文');
  insert.run(11, 1, 2, '第二集', '第二集梗概', '第二集正文');
  // Numeric resource IDs overlap across episode/project namespaces.
  insert.run(1, 2, 1, '其他项目第一集', '其他梗概', '其他正文');
  return db;
}

function contentSnapshot(db) {
  return {
    dramas: db.prepare('SELECT * FROM dramas ORDER BY id').all(),
    episodes: db.prepare('SELECT * FROM episodes ORDER BY id').all(),
  };
}

const log = { info() {}, warn() {}, error() {}, errorw() {} };
function makeResponse() {
  return {
    statusCode: null, payload: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.payload = value; return this; },
  };
}

module.exports = { createEpisodeTestDb, contentSnapshot, log, makeResponse };
