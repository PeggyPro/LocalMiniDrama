'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { seedVideoConfigs, commonModels } = require('./helpers/videoConfigs');
const { getConfiguredVideoWorkflows, chooseVideoConnection } = require('../src/services/videoConfiguredWorkflows');
function fixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  seedVideoConfigs(db);
  return db;
}

test('all seven maintained configurations are candidates, with only safe connection metadata', t => {
  const db = fixture(t);
  const items = getConfiguredVideoWorkflows(db);
  assert.deepEqual(items.map(item => item.model_id).sort(), [...commonModels].sort());
  for (const item of items) {
    const config = item.configured_connections[0];
    assert.equal(config.name, `Configured ${item.model_id}`);
    assert.equal(chooseVideoConnection(db, item.model_id).id, config.id);
    assert.equal(item.runtime_verified, false);
  }
  assert.ok(!JSON.stringify(items).includes('test-secret'));
  assert.ok(!JSON.stringify(items).includes('comfy-test:8188'));
});

test('disabled, deleted, text, proxy, unsupported and invalid URL configurations cannot be recommended', t => {
  const db = fixture(t);
  db.exec(`UPDATE ai_service_configs SET is_active=0 WHERE id=1;
    UPDATE ai_service_configs SET deleted_at='deleted' WHERE id=2;
    UPDATE ai_service_configs SET service_type='text' WHERE id=3;
    UPDATE ai_service_configs SET api_protocol='openai' WHERE id=4;
    UPDATE ai_service_configs SET base_url='not-a-url' WHERE id=5;
    UPDATE ai_service_configs SET base_url='http://user:secret@host:8188' WHERE id=6;
    UPDATE ai_service_configs SET model='["h3-digital-human","unknown-model"]' WHERE id=7;`);
  assert.deepEqual(getConfiguredVideoWorkflows(db), []);
  assert.equal(chooseVideoConnection(db, 'h3-standard'), null);
});

test('canonical model matching handles aliases, JSON arrays, default_model and never falls back across models', t => {
  const db = fixture(t);
  db.prepare('UPDATE ai_service_configs SET model=? WHERE id=1').run('["huobao_minimax_h3_reference_turbo_api"]');
  assert.equal(chooseVideoConnection(db, 'h3-standard').id, 1);
  assert.equal(chooseVideoConnection(db, 'huobao_minimax_h3_reference_turbo_api').id, 1);
  db.exec("UPDATE ai_service_configs SET model='[]',default_model='h3-drama' WHERE id=2");
  assert.equal(chooseVideoConnection(db, 'h3-drama').id, 2);
  assert.equal(chooseVideoConnection(db, 'h3-drama', 1), null);
  db.exec('UPDATE ai_service_configs SET is_active=0 WHERE id=2');
  assert.equal(chooseVideoConnection(db, 'h3-drama'), null);
  assert.equal(chooseVideoConnection(db, 'h3-standard').id, 1);
});

test('defaults and priorities only rank connections that support the requested model', t => {
  const db = fixture(t);
  assert.equal(chooseVideoConnection(db, 'h3-drama').id, 2);
  assert.equal(chooseVideoConnection(db, 'h3-action').id, 3);
  db.exec(`INSERT INTO ai_service_configs(id,name,service_type,provider,base_url,model,is_active,is_default,priority)
    VALUES(8,'Other drama','video','comfyui','http://another:8188','["h3-drama"]',1,0,100);`);
  assert.equal(chooseVideoConnection(db, 'h3-drama').id, 8);
  db.exec('UPDATE ai_service_configs SET is_default=1 WHERE id=2');
  assert.equal(chooseVideoConnection(db, 'h3-drama').id, 2);
  assert.equal(chooseVideoConnection(db, 'h3-drama', 8).id, 8);
});

test('missing configuration tables do not invent candidates or write a schema', t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  assert.deepEqual(getConfiguredVideoWorkflows(db), []);
  assert.equal(chooseVideoConnection(db, 'h3-drama'), null);
  assert.deepEqual(db.prepare('SELECT name FROM sqlite_master').all(), []);
});
