const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { generateSceneSingleImage } = require('../src/services/sceneService');

const log = { info() {}, warn() {}, error() {} };

function createDb(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  t.mock.method(console, 'log', () => {});
  return db;
}

test('a fresh database supports the scene single-image query', async (t) => {
  const db = createDb(t);
  runMigrationsAndEnsure(db);

  const result = await generateSceneSingleImage(db, log, {}, 999);
  assert.deepEqual(result, { ok: false, error: 'scene not found' });

  const column = db.prepare('PRAGMA table_info(scenes)').all()
    .find((item) => item.name === 'polished_prompt_single');
  assert.equal(column.type, 'TEXT');
});

test('upgrading a legacy database preserves scenes and keeps single and four-view prompts separate', (t) => {
  const db = createDb(t);
  db.exec(fs.readFileSync(path.join(__dirname, '../migrations/01_init.sql'), 'utf8'));
  db.exec('ALTER TABLE scenes ADD COLUMN polished_prompt TEXT');
  db.prepare('INSERT INTO dramas (id, title) VALUES (1, ?)').run('旧项目');
  db.prepare(`
    INSERT INTO scenes (id, drama_id, location, prompt, polished_prompt, image_url, local_path)
    VALUES (1, 1, ?, ?, ?, ?, ?)
  `).run('旧场景', '原始场景描述', '原有四视图提示词', '/static/scene.png', 'scene.png');
  const selectOriginal = db.prepare(`
    SELECT id, drama_id, location, prompt, polished_prompt, image_url, local_path
    FROM scenes WHERE id = 1
  `);
  const original = selectOriginal.get();

  runMigrationsAndEnsure(db);
  assert.deepEqual(selectOriginal.get(), original);
  assert.equal(db.prepare('SELECT polished_prompt_single FROM scenes WHERE id = 1').get().polished_prompt_single, null);

  db.prepare('UPDATE scenes SET polished_prompt_single = ? WHERE id = 1').run('新的单图提示词');
  runMigrationsAndEnsure(db);

  assert.equal(db.prepare('SELECT polished_prompt_single FROM scenes WHERE id = 1').get().polished_prompt_single, '新的单图提示词');
  assert.deepEqual(selectOriginal.get(), original);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM scenes').get().count, 1);
});
