const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const timers = require('node:timers/promises');
const Database = require('better-sqlite3');
const bridgeProcess = require('../src/services/comfyUIBridgeProcess');
const comfy = require('../src/services/comfyUIImageClient');
const imageClient = require('../src/services/imageClient');
const aiConfigService = require('../src/services/aiConfigService');
const aiConfigRoutes = require('../src/routes/aiConfig');

const MODEL = 'huobao_qwen_image_2_1_reference_api';
const TASK = 'lmd-comfy-' + 'a'.repeat(32);
const BRIDGE = 'http://127.0.0.1:15681';
const NATIVE = 'http://127.0.0.1:8188';
const OUTPUT = NATIVE + '/view?filename=result.png&type=output&subfolder=images';
const BRIDGE_TOKEN = 'bridge-image-test-secret';
const NATIVE_TOKEN = 'native-image-test-secret';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFZkAAAAASUVORK5CYII=', 'base64');
const DATA = 'data:image/png;base64,' + PNG.toString('base64');
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const config = (extra = {}) => ({ service_type: 'storyboard_image', provider: 'comfyui', api_protocol: 'comfyui', base_url: NATIVE, api_key: '', model: [MODEL], default_model: MODEL, endpoint: '', query_endpoint: '', ...extra });
const log = { info() {}, warn() {}, error() {} };

function bridge(t, handler) {
  const calls = [];
  t.mock.method(bridgeProcess, 'getComfyUIBridgeConnection', async (opts) => {
    assert.equal(opts.config, undefined);
    return { baseUrl: BRIDGE, token: BRIDGE_TOKEN };
  });
  t.mock.method(global, 'fetch', async (url, opts) => {
    calls.push({ url, opts });
    if (url.startsWith(BRIDGE)) {
      assert.equal(opts.headers.Authorization, 'Bearer ' + BRIDGE_TOKEN);
      assert.ok(opts.signal instanceof AbortSignal);
    }
    return handler(url, opts, calls);
  });
  return calls;
}

async function route(body) {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(payload) { this.payload = payload; return this; } };
  await aiConfigRoutes(null, log, {}).testConnection({ body }, res);
  return res;
}

function imageDb(t, nativeConfig) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE ai_service_configs (
    id INTEGER PRIMARY KEY, service_type TEXT, provider TEXT, api_protocol TEXT, name TEXT,
    base_url TEXT, api_key TEXT, model TEXT, default_model TEXT, endpoint TEXT, query_endpoint TEXT,
    settings TEXT, priority INTEGER DEFAULT 0, is_default INTEGER DEFAULT 1, is_active INTEGER DEFAULT 1,
    created_at TEXT, updated_at TEXT, deleted_at TEXT
  );`);
  const row = { name: 'Native image', ...nativeConfig, model: JSON.stringify(nativeConfig.model) };
  db.prepare(`INSERT INTO ai_service_configs
    (service_type,provider,api_protocol,name,base_url,api_key,model,default_model,endpoint,query_endpoint)
    VALUES (@service_type,@provider,@api_protocol,@name,@base_url,@api_key,@model,@default_model,@endpoint,@query_endpoint)`).run(row);
  return db;
}

test('native image detection isolates image services, exact reference alias and explicit proxy overrides', () => {
  assert.equal(comfy.isNativeComfyUIImageConfig(config()), true);
  assert.equal(comfy.isNativeComfyUIImageConfig(config({ service_type: 'image' })), true);
  assert.equal(comfy.isNativeComfyUIImageConfig(config({ api_protocol: '', provider: 'custom' })), true);
  assert.equal(comfy.isNativeComfyUIImageConfig({ model: MODEL }), true);
  assert.equal(comfy.isNativeComfyUIImageConfig(config({ api_protocol: 'openai' })), false);
  assert.equal(comfy.isNativeComfyUIImageConfig(config({ api_protocol: '', endpoint: '/proxy/images' })), false);
  assert.equal(comfy.isNativeComfyUIImageConfig(config({ api_protocol: '', query_endpoint: '/proxy/tasks/{id}' })), false);
  assert.equal(comfy.isNativeComfyUIImageConfig(config({ service_type: 'video' })), false);
  assert.equal(comfy.isNativeComfyUIImageConfig(config({ service_type: 'text' })), false);
  assert.equal(comfy.isNativeComfyUIImageConfig({ api_protocol: '', model: 'huobao_qwen_image_2_1_api' }), false);
  assert.deepEqual(comfy.getComfyUIImageCapabilities(MODEL), { supports_references: true, supports_text_to_image: true, max_reference_images: 16 });
  assert.equal(comfy.getComfyUIImageCapabilities('huobao_qwen_image_2_1_api'), null);
  assert.deepEqual(imageClient.getStoryboardReferenceLimits(config(), MODEL), { total: 16, maxCharacters: 16, maxObjects: 16 });
  assert.equal(imageClient.getStoryboardReferenceLimits(config(), MODEL, { preserveOverflow: true }).total, Infinity);
  assert.deepEqual(imageClient.getStoryboardReferenceLimits({ api_protocol: 'kling' }), { total: 1, maxCharacters: 1, maxObjects: 1 });
  assert.deepEqual(imageClient.getStoryboardReferenceLimits({ api_protocol: 'openai' }), { total: 4, maxCharacters: 3, maxObjects: 4 });
});

test('image connection checks use metadata validation only, with optional native token and no reference reads', async (t) => {
  const packets = [];
  const calls = bridge(t, async (url, opts) => {
    assert.equal(url, BRIDGE + '/image/validate');
    assert.equal(opts.method, 'POST');
    const body = JSON.parse(opts.body);
    packets.push(body);
    return response({ valid: true, model: MODEL, capabilities: comfy.getComfyUIImageCapabilities(MODEL) });
  });
  for (const service_type of ['image', 'storyboard_image']) {
    const res = await route(config({ service_type, reference_urls: ['/missing/must-not-be-read.png'] }));
    assert.equal(res.statusCode, 200);
  }
  await aiConfigService.testConnection(config({ api_key: NATIVE_TOKEN }));
  await aiConfigService.testConnection({ base_url: NATIVE, model: JSON.stringify([MODEL]), api_key: '' });
  assert.equal(calls.length, 4);
  assert.deepEqual(packets[0], { model: MODEL, comfyui_url: NATIVE, prompt: 'Connection dependency check', reference_urls: [], size: '1664x928', seed: 42 });
  assert.equal(packets[2].comfyui_token, NATIVE_TOKEN);
  assert.equal(packets[3].model, MODEL);
  assert.equal(calls.every(({ opts }) => opts.headers['X-ComfyUI-Token'] === undefined), true);
});

test('external image proxies still require keys and never start the native bridge', async (t) => {
  const calls = bridge(t, async () => assert.fail('Unexpected network request'));
  for (const extra of [{ api_protocol: 'openai' }, { api_protocol: '', endpoint: '/proxy/images' }, { api_protocol: '', query_endpoint: '/proxy/tasks/{id}' }, { service_type: 'text' }]) {
    const opts = config(extra);
    await assert.rejects(aiConfigService.testConnection(opts), /api_key 必填/);
    assert.equal((await route(opts)).statusCode, 400);
  }
  assert.equal(calls.length, 0);
  assert.equal(bridgeProcess.getComfyUIBridgeConnection.mock.callCount(), 0);
});

test('metadata validation rejects missing dependencies, malformed success and wrong HTTP endpoints', async (t) => {
  let reply = response({ error: '缺少 TextEncodeQwenImage21 节点 ' + NATIVE_TOKEN }, 422);
  bridge(t, async () => reply);
  await assert.rejects(comfy.validateComfyUIImageConnection(config({ api_key: NATIVE_TOKEN }), log), error => /HTTP 422.*TextEncodeQwenImage21/.test(error.message) && !error.message.includes(NATIVE_TOKEN));
  for (const data of [{ valid: 'true', model: MODEL }, { valid: true, model: 'wrong' }, { valid: true }, null]) {
    reply = response(data);
    await assert.rejects(comfy.validateComfyUIImageConnection(config(), log), /未确认|无效响应/);
  }
  reply = new Response('<html>wrong endpoint</html>', { status: 405 });
  await assert.rejects(comfy.validateComfyUIImageConnection(config(), log), /非 JSON 响应.*HTTP 405/);
});

test('unsupported image models and invalid native URLs fail before bridge startup', async (t) => {
  bridge(t, async () => assert.fail('Unexpected request'));
  await assert.rejects(comfy.validateComfyUIImageConnection(config({ model: ['unknown'], default_model: 'unknown' }), log), /请选择已适配/);
  await assert.rejects(comfy.validateComfyUIImageConnection(config({ base_url: 'file:///tmp/comfy' }), log), /ComfyUI 地址无效/);
  assert.equal(bridgeProcess.getComfyUIBridgeConnection.mock.callCount(), 0);
});

test('generation preserves local, data and remote reference order, task identity, size, prompt and negatives', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-comfy-image-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'scene.png'), PNG);
  const remote = 'https://reference.example/prop.png';
  t.mock.method(timers, 'setTimeout', async () => {});
  let polls = 0;
  const calls = bridge(t, async (url, opts) => {
    if (opts.method === 'POST') {
      assert.equal(url, BRIDGE + '/image/generations');
      const body = JSON.parse(opts.body);
      assert.deepEqual(body, { model: MODEL, comfyui_url: NATIVE, prompt: 'Image 1: layout; Image 2: scene; Image 3: prop', negative_prompt: 'no collage', reference_urls: [DATA, DATA, remote], size: '928x1664', seed: 7 });
      return response({ task_id: TASK, status: 'processing', model: MODEL });
    }
    assert.equal(url, BRIDGE + '/image/task/' + TASK);
    assert.equal(opts.headers['X-ComfyUI-Token'], undefined);
    polls++;
    return response(polls === 1 ? { status: 'processing' } : { status: 'completed', image_url: OUTPUT });
  });
  const result = await comfy.callComfyUIImageApi(config(), log, { model: MODEL, prompt: 'Image 1: layout; Image 2: scene; Image 3: prop', negative_prompt: 'no collage', reference_image_urls: [DATA, '/static/scene.png', remote], storage_local_path: root, size: '928x1664', seed: 7 });
  assert.deepEqual(result, { image_url: OUTPUT });
  assert.equal(calls.filter(({ opts }) => opts.method === 'POST').length, 1);
  assert.equal(polls, 2);
});

test('zero references supports text-to-image and sixteen references reach the bridge without truncation', async (t) => {
  let expectedCount = 0;
  bridge(t, async (url, opts) => {
    if (opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      assert.equal(body.reference_urls.length, expectedCount);
      assert.equal(body.size, '1664x928');
      return response({ task_id: TASK, status: 'processing' });
    }
    return response({ status: 'completed', image_url: OUTPUT });
  });
  assert.deepEqual(await comfy.callComfyUIImageApi(config(), log, { prompt: 'text only' }), { image_url: OUTPUT });
  expectedCount = 16;
  assert.deepEqual(await comfy.callComfyUIImageApi(config(), log, { reference_image_urls: Array(16).fill(DATA) }), { image_url: OUTPUT });
});

test('reference overflow, malformed lists and missing local inputs fail before submission', async (t) => {
  const calls = bridge(t, async () => assert.fail('Unexpected request'));
  const tooMany = await comfy.callComfyUIImageApi(config(), log, { reference_image_urls: Array(17).fill('/missing.png') });
  assert.match(tooMany.error, /16.*17.*不会截断/);
  assert.match((await comfy.callComfyUIImageApi(config(), log, { reference_image_urls: 'not-an-array' })).error, /列表格式无效/);
  assert.match((await comfy.callComfyUIImageApi(config(), log, { reference_image_urls: ['/static/missing.png'] })).error, /未配置本地图片存储/);
  assert.equal(calls.length, 0);
  assert.equal(bridgeProcess.getComfyUIBridgeConnection.mock.callCount(), 0);
});

test('poll failures, malformed task IDs, unknown states and deadlines never submit a second generation', async (t) => {
  for (const [initial, polled, expected] of [
    [{ task_id: '../unsafe', status: 'processing' }, null, /任务 ID/],
    [{ task_id: TASK, status: 'processing' }, { status: 'failed', error: 'GPU out of memory ' + NATIVE_TOKEN }, /GPU out of memory/],
    [{ task_id: TASK, status: 'processing' }, { status: 'unrecognized' }, /未知图片任务状态/],
    [{ task_id: TASK, status: 'processing' }, null, /连接中断/],
  ]) {
    let submissions = 0;
    bridge(t, async (_url, opts) => {
      if (opts.method === 'POST') { submissions++; return response(initial); }
      assert.equal(opts.headers['X-ComfyUI-Token'], NATIVE_TOKEN);
      if (!polled) throw new Error('连接中断 ' + NATIVE_TOKEN + ' Bearer ' + BRIDGE_TOKEN + ' ' + DATA);
      return response(polled);
    });
    const result = await comfy.callComfyUIImageApi(config({ api_key: NATIVE_TOKEN }), log);
    assert.match(result.error, expected);
    assert.equal(result.error.includes(NATIVE_TOKEN), false);
    assert.equal(result.error.includes(BRIDGE_TOKEN), false);
    assert.equal(result.error.includes(DATA), false);
    assert.equal(submissions, 1);
  }
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const calls = bridge(t, async (_url, opts) => {
    if (opts.method === 'POST') return response({ task_id: TASK, status: 'processing' });
    now += 600001;
    return response({ status: 'processing' });
  });
  const timedOut = await comfy.callComfyUIImageApi(config(), log);
  assert.match(timedOut.error, /查询超时.*队列/);
  assert.equal(timedOut.task_id, TASK);
  assert.equal(calls.length, 2);
});

test('native token downloads only the configured /view origin, without following redirects, for existing image persistence', async (t) => {
  let output = OUTPUT;
  let downloadCalls = 0;
  bridge(t, async (url, opts) => {
    if (opts.method === 'POST') {
      assert.equal(JSON.parse(opts.body).comfyui_token, NATIVE_TOKEN);
      return response({ task_id: TASK, status: 'processing' });
    }
    if (url.startsWith(BRIDGE)) return response({ status: 'completed', image_url: output });
    downloadCalls++;
    assert.equal(url, OUTPUT);
    assert.equal(opts.headers.Authorization, 'Bearer ' + NATIVE_TOKEN);
    assert.equal(opts.redirect, 'error');
    return new Response(PNG, { headers: { 'Content-Type': 'image/png' } });
  });
  assert.deepEqual(await comfy.callComfyUIImageApi(config({ api_key: NATIVE_TOKEN }), log), { image_url: DATA });
  assert.equal(downloadCalls, 1);
  for (const url of ['https://other.example/view?filename=result.png', NATIVE + '/not-view', 'file:///tmp/result.png']) {
    output = url;
    assert.match((await comfy.callComfyUIImageApi(config({ api_key: NATIVE_TOKEN }), log)).error, /有效的原生 \/view/);
  }
  assert.equal(downloadCalls, 1, 'native token must not be sent to an unexpected URL');
});

test('image creation stores all native references for explicit validation, while preserving the external input cap', (t) => {
  const db = imageDb(t, config());
  db.exec(`CREATE TABLE image_generations (
    id INTEGER PRIMARY KEY, storyboard_id INTEGER, drama_id INTEGER, scene_id INTEGER, provider TEXT,
    prompt TEXT, negative_prompt TEXT, model TEXT, frame_type TEXT, reference_images TEXT,
    use_first_frame_layout_lock INTEGER, size TEXT, status TEXT, task_id TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT
  );`);
  t.mock.method(require('../src/services/taskService'), 'createTask', () => ({ id: 'test-image-task' }));
  t.mock.method(global, 'setImmediate', () => null);
  const imageService = require('../src/services/imageService');
  const refs = Array.from({ length: 17 }, (_, index) => `https://ref.example/${index}.png`);
  const row = imageService.create(db, log, { storyboard_id: 7, reference_images: refs, prompt: 'scene' });
  assert.deepEqual(JSON.parse(db.prepare('SELECT reference_images FROM image_generations WHERE id = ?').get(row.id).reference_images), refs);
  db.prepare("UPDATE ai_service_configs SET api_protocol = 'openai'").run();
  const external = imageService.create(db, log, { storyboard_id: 7, reference_images: refs, prompt: 'scene' });
  assert.deepEqual(JSON.parse(db.prepare('SELECT reference_images FROM image_generations WHERE id = ?').get(external.id).reference_images), refs.slice(0, 10));
});

test('imageClient native route preserves numbered labels, layout and character locks, merged negatives and service selection', async (t) => {
  const db = imageDb(t, config());
  let captured;
  t.mock.method(comfy, 'callComfyUIImageApi', async (cfg, _log, opts) => {
    assert.equal(cfg.service_type, 'storyboard_image');
    captured = opts;
    return { image_url: OUTPUT };
  });
  t.mock.method(global, 'fetch', async () => assert.fail('Unexpected direct provider request'));
  const result = await imageClient.callImageApi(db, log, {
    imageServiceType: 'storyboard_image', prompt: 'The person opens the door.',
    reference_image_urls: [DATA, DATA], system_prompt: 'Image 1: LAYOUT_LOCK: first frame layout lock\nImage 2: character appearance (XuMu)',
    negative_prompt: 'no blur', user_negative_prompt: 'no blur', frame_identity_lock: true, size: '1664x928',
  });
  assert.deepEqual(result, { image_url: OUTPUT });
  assert.match(captured.prompt, /Image 1: LAYOUT_LOCK.*PRESERVE/);
  assert.match(captured.prompt, /Image 2: character appearance/);
  assert.match(captured.prompt, /CHARACTER IDENTITY LOCK/);
  assert.match(captured.negative_prompt, /split panels/);
  assert.equal(captured.negative_prompt.match(/no blur/g).length, 1);
  assert.deepEqual(captured.reference_image_urls, [DATA, DATA]);
  assert.equal(captured.model, MODEL);
});
