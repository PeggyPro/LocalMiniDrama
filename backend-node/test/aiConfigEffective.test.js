const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const aiConfigRoutes = require('../src/routes/aiConfig');
const aiClient = require('../src/services/aiClient');
const imageClient = require('../src/services/imageClient');
const videoClient = require('../src/services/videoClient');

const log = { info() {}, warn() {}, error() {}, errorw() {} };
const dataKeys = [
  'configured', 'config_id', 'config_name', 'provider', 'service_type', 'model',
  'reasoning_effort', 'thinking', 'source', 'scene_key',
].sort();

function fixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE ai_service_configs (
      id INTEGER PRIMARY KEY, service_type TEXT, provider TEXT, api_protocol TEXT,
      name TEXT, base_url TEXT, api_key TEXT, model TEXT, default_model TEXT,
      endpoint TEXT, query_endpoint TEXT, priority INTEGER, is_default INTEGER,
      is_active INTEGER, settings TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT
    );
    CREATE TABLE ai_model_map (
      key TEXT PRIMARY KEY, service_type TEXT, config_id INTEGER, model_override TEXT
    );
    CREATE TABLE prompt_overrides (key TEXT PRIMARY KEY, content TEXT, updated_at TEXT);
  `);

  function config(overrides = {}) {
    const row = {
      service_type: 'text', provider: 'openai', api_protocol: '', name: 'Sub2Api',
      base_url: 'https://secret-host.invalid/private', api_key: 'sk-secret-do-not-expose',
      model: ['first-model', 'default-model', 'scene-model'], default_model: 'default-model',
      endpoint: '/private/chat', query_endpoint: '/private/query', priority: 0,
      is_default: 0, is_active: 1,
      settings: { reasoning_effort: ' HIGH ', prompt: 'private-prompt', token: 'private-token' },
      created_at: '2026-01-01', updated_at: '2026-01-01', deleted_at: null,
      ...overrides,
    };
    if (typeof row.model !== 'string') row.model = JSON.stringify(row.model);
    if (typeof row.settings !== 'string') row.settings = JSON.stringify(row.settings);
    const columns = Object.keys(row);
    return Number(db.prepare(`INSERT INTO ai_service_configs (${columns.join(',')})
      VALUES (${columns.map((key) => `@${key}`).join(',')})`).run(row).lastInsertRowid);
  }

  function scene(configId, modelOverride = null, key = 'story_generation', serviceType = 'text') {
    db.prepare('INSERT INTO ai_model_map (key, service_type, config_id, model_override) VALUES (?, ?, ?, ?)')
      .run(key, serviceType, configId, modelOverride);
  }

  const routes = aiConfigRoutes(db, log, {});
  function preview(query = {}) {
    const result = {};
    const res = {
      status(value) { result.status = value; return this; },
      json(value) { result.body = value; return this; },
    };
    routes.effective({ query }, res);
    return result;
  }
  function effective(query = {}) {
    const { status, body } = preview(query);
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.deepEqual(Object.keys(body.data).sort(), dataKeys);
    return body.data;
  }
  return { db, config, scene, preview, effective };
}

function assertEmpty(data, sceneKey = null) {
  assert.deepEqual(data, {
    configured: false, config_id: null, config_name: '', provider: '', service_type: '',
    model: '', reasoning_effort: null, thinking: null, source: 'default', scene_key: sceneKey,
  });
}

test('unconfigured services succeed with safe empty values', (t) => {
  const { effective } = fixture(t);
  for (const service_type of ['text', 'image', 'storyboard_image', 'video']) {
    assertEmpty(effective({ service_type }));
  }
  assertEmpty(effective({ scene_key: 'story_generation' }), 'story_generation');
});

test('text preview uses the active default, model default and normalized effort without secrets', (t) => {
  const { config, effective } = fixture(t);
  config({ priority: 100 });
  const chosen = config({ is_default: 1, priority: 1 });
  config({ is_default: 1, priority: 200, deleted_at: 'deleted' });
  const data = effective();
  assert.deepEqual(data, {
    configured: true, config_id: chosen, config_name: 'Sub2Api', provider: 'openai',
    service_type: 'text', model: 'default-model', reasoning_effort: 'high', thinking: null,
    source: 'default', scene_key: null,
  });
  const serialized = JSON.stringify(data);
  for (const secret of ['sk-secret-do-not-expose', 'secret-host', '/private', 'private-prompt', 'private-token']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('scene mapping selects its configuration and valid model override', (t) => {
  const { config, scene, effective } = fixture(t);
  config({ is_default: 1 });
  const selected = config({ name: 'Scene config', priority: -1, settings: { reasoning_effort: ' CUSTOM ' } });
  scene(selected, 'scene-model');
  const data = effective({ scene_key: 'story_generation' });
  assert.equal(data.config_id, selected);
  assert.equal(data.config_name, 'Scene config');
  assert.equal(data.model, 'scene-model');
  assert.equal(data.reasoning_effort, 'custom');
  assert.equal(data.source, 'scene');
});

for (const [label, override, defaultModel, models, expected] of [
  ['invalid override', 'not-in-list', 'default-model', ['first-model', 'default-model'], 'default-model'],
  ['invalid model default', 'not-in-list', 'also-missing', ['first-model', 'second-model'], 'first-model'],
  ['JSON model override', '["scene-model"]', 'default-model', [['first-model'], 'scene-model'], 'scene-model'],
  ['empty model list', 'not-in-list', 'also-missing', [], 'gpt-3.5-turbo'],
]) {
  test(`text model selection handles ${label}`, (t) => {
    const { config, scene, effective } = fixture(t);
    scene(config({ model: models, default_model: defaultModel }), override);
    assert.equal(effective({ scene_key: 'story_generation' }).model, expected);
  });
}

for (const state of ['missing', 'deleted', 'inactive']) {
  test(`a ${state} mapped config falls back exactly as generation does, including the scene override`, (t) => {
    const { db, config, scene, effective } = fixture(t);
    const fallback = config({ is_default: 1 });
    const unavailable = state === 'missing' ? 999 : config({
      is_active: state === 'inactive' ? 0 : 1,
      deleted_at: state === 'deleted' ? 'deleted' : null,
    });
    scene(unavailable, 'scene-model');
    const data = effective({ scene_key: 'story_generation' });
    const actual = aiClient.getConfigFromModelMap(db, 'story_generation', { readOnly: true });
    assert.equal(data.config_id, fallback);
    assert.equal(data.config_id, actual.config.id);
    assert.equal(data.model, 'scene-model');
    assert.equal(data.source, 'scene');
  });
}

test('missing scene entries or an unavailable map table use the text default', (t) => {
  const { db, config, effective } = fixture(t);
  const selected = config();
  assert.equal(effective({ scene_key: 'missing' }).config_id, selected);
  assert.equal(effective({ scene_key: 'missing' }).source, 'default');
  db.exec('DROP TABLE ai_model_map');
  assert.equal(effective({ scene_key: 'story_generation' }).config_id, selected);
});

test('deleted and inactive configurations alone remain unconfigured', (t) => {
  const { config, scene, effective } = fixture(t);
  scene(config({ is_active: 0 }));
  config({ deleted_at: 'deleted' });
  assertEmpty(effective({ scene_key: 'story_generation' }), 'story_generation');
});

for (const settings of [null, 'null', '{invalid', { reasoning_efforts: ['high'] }, { reasoning_effort: ' auto ' },
  { reasoning_effort: ' Default ' }, { reasoning_effort: 123 }, { reasoning_effort: '' }]) {
  test(`unset reasoning effort is null for ${JSON.stringify(settings)}`, (t) => {
    const { config, effective } = fixture(t);
    config({ settings });
    assert.equal(effective().reasoning_effort, null);
  });
}

for (const [model, settings, expectedEffort, expectedThinking] of [
  ['deepseek-chat', { reasoning_effort: 'max' }, null, 'disabled'],
  ['deepseek-reasoner', { reasoning_effort: 'low' }, 'high', 'enabled'],
  ['deepseek-reasoner', { reasoning_effort: 'xhigh' }, 'max', 'enabled'],
  ['deepseek-reasoner', { deepseek_thinking: false, reasoning_effort: 'max' }, null, 'disabled'],
  ['deepseek-v4-pro', { deepseek: { thinking: 'on', effort: 'medium' } }, 'high', 'enabled'],
  ['deepseek-v4-pro', { reasoning_effort: 'max' }, null, null],
]) {
  test(`DeepSeek preview matches ${model} options ${JSON.stringify(settings)}`, (t) => {
    const { config, effective } = fixture(t);
    config({ provider: 'deepseek', model: [model], default_model: model, settings });
    const data = effective();
    assert.equal(data.model, model.startsWith('deepseek-v4') ? model : 'deepseek-v4-flash');
    assert.equal(data.thinking, expectedThinking);
    assert.equal(data.reasoning_effort, expectedEffort);
  });
}

test('official DeepSeek hostname also applies legacy model and thinking normalization', (t) => {
  const { config, effective } = fixture(t);
  config({ provider: 'openai', base_url: 'https://api.deepseek.com/v1',
    model: ['deepseek-reasoner'], default_model: '', settings: { reasoning_effort: 'max' } });
  assert.equal(effective().model, 'deepseek-v4-flash');
  assert.equal(effective().reasoning_effort, 'max');
  assert.equal(effective().thinking, 'enabled');
});

test('official Ark text models are remapped with generation thinking defaults', (t) => {
  const { config, scene, effective } = fixture(t);
  scene(config({ base_url: 'https://ark.cn-beijing.volces.com/api/v3',
    model: ['deepseek-v4-flash-ga-260731'], default_model: '', settings: {} }), 'deepseek-v3-2-251201');
  const data = effective({ scene_key: 'story_generation' });
  assert.equal(data.model, 'deepseek-v4-flash-ga-260731');
  assert.equal(data.thinking, 'disabled');
  assert.equal(data.reasoning_effort, null);
});

test('image selection is independent of text scenes and uses the image service model picker', (t) => {
  const { db, config, scene, effective } = fixture(t);
  scene(config({ is_default: 1 }), 'scene-model');
  config({ service_type: 'image', priority: 100, model: ['first-image'] });
  const selected = config({ service_type: 'image', is_default: 1,
    model: ['first-image', 'chosen-image'], default_model: 'chosen-image' });
  const data = effective({ service_type: 'image', scene_key: 'story_generation' });
  assert.equal(data.config_id, selected);
  assert.equal(data.config_id, imageClient.getDefaultImageConfig(db, undefined, undefined, 'image', { readOnly: true }).id);
  assert.equal(data.model, 'chosen-image');
  assert.equal(data.service_type, 'image');
  assert.equal(data.source, 'default');
  assert.equal(data.reasoning_effort, null);
  assert.equal(data.thinking, null);
});

test('image preview includes official DashScope retired-model remapping', (t) => {
  const { config, effective } = fixture(t);
  config({ service_type: 'image', base_url: 'https://dashscope.aliyuncs.com',
    model: ['qwen-image-max'], default_model: 'qwen-image-max' });
  assert.equal(effective({ service_type: 'image' }).model, 'qwen-image-3.0');
});

test('image preview uses first model or generation default when its model default is invalid', (t) => {
  const { db, config, effective } = fixture(t);
  const id = config({ service_type: 'image', model: ['first-image'], default_model: 'not-in-list' });
  assert.equal(effective({ service_type: 'image' }).model, 'first-image');
  db.prepare('UPDATE ai_service_configs SET model = ? WHERE id = ?').run('[]', id);
  assert.equal(effective({ service_type: 'image' }).model, 'dall-e-3');
});

test('storyboard images fall back to image only when no nondeleted storyboard configuration exists', (t) => {
  const { db, config, effective } = fixture(t);
  const image = config({ service_type: 'image' });
  config({ service_type: 'storyboard_image', deleted_at: 'deleted' });
  const fallback = effective({ service_type: 'storyboard_image' });
  assert.equal(fallback.config_id, image);
  assert.equal(fallback.service_type, 'image');
  const storyboard = config({ service_type: 'storyboard_image', model: ['storyboard-model'], default_model: '' });
  const data = effective({ service_type: 'storyboard_image' });
  assert.equal(data.config_id, storyboard);
  assert.equal(data.service_type, 'storyboard_image');
  assert.equal(data.model, 'storyboard-model');
  db.prepare('UPDATE ai_service_configs SET is_active = 0 WHERE id = ?').run(storyboard);
  assertEmpty(effective({ service_type: 'storyboard_image' }));
});

test('video uses its own default and canonicalizes Seedance aliases and official retired models', (t) => {
  const { db, config, effective } = fixture(t);
  config({ service_type: 'video', priority: 100 });
  const selected = config({ service_type: 'video', is_default: 1, provider: 'volcengine',
    base_url: 'https://ark.cn-beijing.volces.com/api/v3',
    model: ['doubao-seedance-1.5-pro'], default_model: '' });
  let data = effective({ service_type: 'video' });
  assert.equal(data.config_id, selected);
  assert.equal(data.config_id, videoClient.getDefaultVideoConfig(db, undefined, { readOnly: true }).id);
  assert.equal(data.model, 'doubao-seedance-2-0-fast-260128');
  assert.equal(data.reasoning_effort, null);
  assert.equal(data.thinking, null);
  db.prepare('UPDATE ai_service_configs SET base_url = ? WHERE id = ?').run('https://proxy.invalid', selected);
  data = effective({ service_type: 'video' });
  assert.equal(data.model, 'doubao-seedance-1-5-pro-251215');
});

for (const [provider, model] of [
  ['gemini', 'veo-3.0-generate-preview'], ['kling', 'kling-video'], ['ffir', 'kling-video-o1'],
  ['vidu', 'viduq2'], ['agnes', 'agnes-video-v2.0'], ['xai', 'grok-imagine-video'],
  ['minimax_h3', 'MiniMax-H3'], ['cheap_seedance2', 'sora-2'], ['openai', ''],
]) {
  test(`empty video model lists use the ${provider} protocol fallback`, (t) => {
    const { config, effective } = fixture(t);
    config({ service_type: 'video', provider, model: [], default_model: 'not-in-list' });
    assert.equal(effective({ service_type: 'video' }).model, model);
  });
}

test('video protocol detection canonicalizes MiniMax and preserves jimeng model IDs', (t) => {
  const { db, config, effective } = fixture(t);
  const id = config({ service_type: 'video', model: ['minimax_h3'], default_model: '' });
  assert.equal(effective({ service_type: 'video' }).model, 'MiniMax-H3');
  db.prepare('UPDATE ai_service_configs SET provider = ?, model = ?, api_protocol = ? WHERE id = ?')
    .run('jimeng_ai_api', '["doubao-seedance-1.5-pro"]', 'jimeng_ai_api', id);
  assert.equal(effective({ service_type: 'video' }).model, 'doubao-seedance-1.5-pro');
});

for (const service_type of ['text', 'image', 'storyboard_image', 'video']) {
  test(`${service_type} preview is read-only even with duplicate defaults and preserves normalized selection`, (t) => {
    const { db, config, scene, effective } = fixture(t);
    // The inactive winner clears the other default before generation selects by priority.
    config({ service_type, is_default: 1, is_active: 0, priority: 100 });
    config({ service_type, is_default: 1, priority: 1 });
    const selected = config({ service_type, priority: 50 });
    if (service_type === 'text') scene(999, 'scene-model');
    const before = db.prepare('SELECT * FROM ai_service_configs ORDER BY id').all();
    const changes = db.prepare('SELECT total_changes() AS count').get().count;
    db.pragma('query_only = ON');
    assert.equal(effective({ service_type, scene_key: 'story_generation' }).config_id, selected);
    assert.deepEqual(db.prepare('SELECT * FROM ai_service_configs ORDER BY id').all(), before);
    assert.equal(db.prepare('SELECT total_changes() AS count').get().count, changes);
    db.pragma('query_only = OFF');
    const actual = service_type === 'video' ? videoClient.getDefaultVideoConfig(db)
      : service_type === 'text' ? aiClient.getDefaultConfig(db, 'text')
        : imageClient.getDefaultImageConfig(db, undefined, undefined, service_type);
    assert.equal(actual.id, selected);
  });
}

test('read-only duplicate-default ties retain the same smallest-ID winner as generation', (t) => {
  const { db, config, effective } = fixture(t);
  const selected = config({ is_default: 1, created_at: '2026-01-01' });
  config({ is_default: 1, created_at: '2026-02-01' });
  db.pragma('query_only = ON');
  assert.equal(effective().config_id, selected);
  db.pragma('query_only = OFF');
  assert.equal(aiClient.getDefaultConfig(db, 'text').id, selected);
});

test('read-only normalization also clears nullable or legacy default flags just like generation', (t) => {
  const { db, config, effective } = fixture(t);
  config({ is_default: 1, is_active: 0, priority: 100 });
  config({ is_default: 1, priority: 1 });
  config({ is_default: 2, priority: 20 });
  const selected = config({ is_default: null, priority: 50 });
  db.pragma('query_only = ON');
  assert.equal(effective().config_id, selected);
  db.pragma('query_only = OFF');
  assert.equal(aiClient.getDefaultConfig(db, 'text').id, selected);
});

test('invalid service and scene query shapes return a safe bad request', (t) => {
  const { preview } = fixture(t);
  for (const query of [{ service_type: 'tts' }, { service_type: ['text', 'video'] }, { scene_key: ['story_generation'] }]) {
    const { status, body } = preview(query);
    assert.equal(status, 400);
    assert.equal(body.success, false);
    assert.equal(Object.hasOwn(body, 'data'), false);
  }
});

test('real HTTP routing serves effective before the configuration ID route', async (t) => {
  const { db, config } = fixture(t);
  const selected = config();
  const { setupRouter } = require('../src/routes');
  const app = express();
  app.use('/api/v1', setupRouter({ storage: {} }, db, log));
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/ai-configs`;
  const result = await fetch(`${base}/effective?scene_key=story_generation`);
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.success, true);
  assert.equal(body.data.config_id, selected);
  assert.equal(body.data.source, 'default');
  assert.deepEqual(Object.keys(body.data).sort(), dataKeys);
  const oldRoute = await fetch(`${base}/${selected}`);
  assert.equal(oldRoute.status, 200);
  assert.equal((await oldRoute.json()).data.id, selected);
});
