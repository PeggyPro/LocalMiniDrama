const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Database = require('better-sqlite3');
const aiClient = require('../src/services/aiClient');
const aiConfigService = require('../src/services/aiConfigService');

const log = { info() {}, warn() {}, error() {} };
const imageSource = { imageUrl: 'data:image/png;base64,dGVzdA==' };
const resultText = 'first second';

async function createFixture(t) {
  // Use the real config service and scene routing, with an isolated in-memory DB.
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
  `);

  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ path: req.url, authorization: req.headers.authorization, body });
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const content of ['first ', 'second']) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
        }
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: resultText } }] }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((err) => err ? reject(err) : resolve());
  }));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

  function createConfig(settings, overrides = {}) {
    return aiConfigService.createConfig(db, log, {
      service_type: 'text', provider: 'openai', name: 'test config',
      base_url: baseUrl, api_key: 'test-key', model: ['default-model'],
      default_model: 'default-model', is_default: true,
      settings: typeof settings === 'string' ? settings : JSON.stringify(settings),
      ...overrides,
    });
  }

  function routeScene(configId, modelOverride = null) {
    db.prepare('INSERT INTO ai_model_map (key, service_type, config_id, model_override) VALUES (?, ?, ?, ?)')
      .run('storyboard_generation', 'text', configId, modelOverride);
  }

  return { db, requests, baseUrl, createConfig, routeScene };
}

const textCalls = [
  {
    name: 'generateText',
    async send(db, options) {
      const accumulated = [];
      const text = await aiClient.generateText(db, log, 'text', 'prompt', 'system', {
        ...options, streamCallback: (value) => accumulated.push(value),
      });
      assert.equal(accumulated.at(-1), resultText);
      return text;
    },
    stream: true,
  },
  {
    name: 'streamGenerateText',
    async send(db, options) {
      const deltas = [];
      const text = await aiClient.streamGenerateText(db, log, 'text', 'prompt', 'system', options,
        (delta) => deltas.push(delta));
      assert.deepEqual(deltas, ['first ', 'second']);
      return text;
    },
    stream: true,
  },
  {
    name: 'generateTextWithVision',
    send(db, options) {
      return aiClient.generateTextWithVision(db, log, 'text', 'prompt', 'system', imageSource, options);
    },
    stream: false,
  },
];

function assertMetadataOmitted(body) {
  assert.equal(Object.hasOwn(body, 'reasoning_efforts'), false);
  assert.equal(Object.hasOwn(body, 'settings'), false);
}

const omittedSettings = [
  undefined,
  null,
  '{invalid json',
  'null',
  { reasoning_efforts: ['low', 'high'] },
  { reasoning_effort: '' },
  { reasoning_effort: '  ' },
  { reasoning_effort: ' AUTO ' },
  { reasoning_effort: ' Default ' },
  { reasoning_effort: null },
  { reasoning_effort: 123 },
  { reasoning_effort: ['high'] },
];

for (const call of textCalls) {
  test(`${call.name} sends the default config reasoning effort on the HTTP request`, async (t) => {
    const { db, requests, createConfig } = await createFixture(t);
    createConfig({ reasoning_efforts: ['low', 'high'], reasoning_effort: ' HIGH ', max_tokens: 900 });
    createConfig({ reasoning_effort: 'low' }, { is_default: false, priority: 100 });

    assert.equal(await call.send(db, {}), resultText);
    assert.equal(requests.length, 1);
    const { path, authorization, body } = requests[0];
    assert.equal(path, '/v1/chat/completions');
    assert.equal(authorization, 'Bearer test-key');
    assert.equal(body.model, 'default-model');
    assert.equal(body.reasoning_effort, 'high');
    assert.equal(body.stream === true, call.stream);
    assertMetadataOmitted(body);
  });

  test(`${call.name} inherits scene_key config effort and model override`, async (t) => {
    const { db, requests, createConfig, routeScene } = await createFixture(t);
    createConfig({ reasoning_effort: 'low' });
    const routed = createConfig({ reasoning_efforts: ['low', 'high'], reasoning_effort: ' CUSTOM_EFFORT ' }, {
      is_default: false, model: ['scene-model', 'scene-override'], default_model: 'scene-model',
      api_key: 'scene-key', endpoint: '/scene/chat/completions',
    });
    routeScene(routed.id, 'scene-override');

    assert.equal(await call.send(db, { scene_key: 'storyboard_generation', model: 'default-model' }), resultText);
    assert.equal(requests.length, 1);
    const { path, authorization, body } = requests[0];
    assert.equal(path, '/v1/scene/chat/completions');
    assert.equal(authorization, 'Bearer scene-key');
    assert.equal(body.model, 'scene-override');
    assert.equal(body.reasoning_effort, 'custom_effort');
    assert.equal(body.stream === true, call.stream);
    assertMetadataOmitted(body);
  });

  test(`${call.name} omits effort when no usable default is configured`, async (t) => {
    const { db, requests, createConfig } = await createFixture(t);
    for (const settings of omittedSettings) {
      // Persist each case through the config service; never select the first metadata option.
      createConfig(settings);
      assert.equal(await call.send(db, {}), resultText);
      const body = requests.at(-1).body;
      assert.equal(Object.hasOwn(body, 'reasoning_effort'), false, JSON.stringify(settings));
      assertMetadataOmitted(body);
    }
    assert.equal(requests.length, omittedSettings.length);
  });

  test(`${call.name} keeps official DeepSeek native thinking and high/max semantics`, async (t) => {
    const { db, requests, createConfig } = await createFixture(t);
    const cases = [
      { settings: { deepseek_thinking: 'enabled', reasoning_effort: 'low' }, effort: 'high', thinking: 'enabled' },
      { settings: { deepseek_thinking: 'enabled', reasoning_effort: 'xhigh' }, effort: 'max', thinking: 'enabled' },
      { settings: { deepseek_thinking: 'enabled', deepseek_reasoning_effort: 'max', reasoning_effort: 'low' }, effort: 'max', thinking: 'enabled' },
      { settings: { deepseek_thinking: 'disabled', reasoning_effort: 'max' }, thinking: 'disabled' },
      { settings: { reasoning_effort: 'high' } },
      { settings: { reasoning_effort: 'low' }, model: 'deepseek-reasoner', effort: 'high', thinking: 'enabled' },
    ];
    for (const entry of cases) {
      const model = entry.model || 'deepseek-v4-pro';
      createConfig(entry.settings, { provider: 'deepseek', model: [model], default_model: model });
      assert.equal(await call.send(db, {}), resultText);
      const body = requests.at(-1).body;
      assert.equal(body.reasoning_effort, entry.effort);
      assert.equal(body.thinking?.type, entry.thinking);
      assert.equal(body.model, entry.model ? 'deepseek-v4-flash' : model);
      if (entry.thinking === 'enabled') assert.equal(Object.hasOwn(body, 'temperature'), false);
      assertMetadataOmitted(body);
    }
    assert.equal(requests.length, cases.length);
  });
}

test('unavailable scene configs fall back to the active default and inherit its effort', async (t) => {
  const { db, requests, createConfig, routeScene } = await createFixture(t);
  createConfig({ reasoning_effort: 'medium' });
  const inactive = createConfig({ reasoning_effort: 'high' }, { is_default: false });
  aiConfigService.updateConfig(db, log, inactive.id, { is_active: false });
  routeScene(inactive.id);
  for (const call of textCalls) {
    assert.equal(await call.send(db, { scene_key: 'storyboard_generation' }), resultText);
    assert.equal(requests.at(-1).body.reasoning_effort, 'medium');
  }
});

test('missing AI configs still fail before sending a request', async (t) => {
  const { db, requests } = await createFixture(t);
  for (const call of textCalls) {
    await assert.rejects(call.send(db, {}), /未配置文本模型/);
  }
  assert.equal(requests.length, 0);
});

test('text connectivity sends the selected default for JSON and object settings', async (t) => {
  const { requests, baseUrl } = await createFixture(t);
  for (const settings of [
    { reasoning_efforts: ['low', 'xhigh'], reasoning_effort: ' XHIGH ' },
    JSON.stringify({ reasoning_effort: 'minimal' }),
  ]) {
    await aiConfigService.testConnection({
      base_url: baseUrl, api_key: 'test-key', service_type: 'text', provider: 'openai',
      model: ['o3'], settings,
    });
    const body = requests.at(-1).body;
    assert.equal(body.reasoning_effort, typeof settings === 'string' ? 'minimal' : 'xhigh');
    assertMetadataOmitted(body);
  }
});

test('text connectivity omits unspecified and placeholder effort values', async (t) => {
  const { requests, baseUrl } = await createFixture(t);
  for (const settings of omittedSettings) {
    await aiConfigService.testConnection({
      base_url: baseUrl, api_key: 'test-key', service_type: 'text', model: ['o3'], settings,
    });
    const body = requests.at(-1).body;
    assert.equal(Object.hasOwn(body, 'reasoning_effort'), false, JSON.stringify(settings));
    assertMetadataOmitted(body);
  }
  assert.equal(requests.length, omittedSettings.length);
});

test('official DeepSeek connectivity preserves native thinking and suppresses effort', async (t) => {
  const { requests, baseUrl } = await createFixture(t);
  for (const thinking of [undefined, 'enabled']) {
    await aiConfigService.testConnection({
      base_url: baseUrl, api_key: 'test-key', service_type: 'text', provider: 'deepseek',
      model: ['deepseek-v4-pro'], settings: {
        deepseek_thinking: thinking, deepseek_reasoning_effort: 'max', reasoning_effort: 'low',
      },
    });
    const body = requests.at(-1).body;
    assert.equal(body.thinking.type, thinking || 'disabled');
    assert.equal(Object.hasOwn(body, 'reasoning_effort'), false);
    assertMetadataOmitted(body);
  }
});
