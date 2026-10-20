const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const bridgeProcess = require('../src/services/comfyUIBridgeProcess');
const comfy = require('../src/services/comfyUIVideoClient');
const videoClient = require('../src/services/videoClient');
const videoService = require('../src/services/videoService');
const aiConfigService = require('../src/services/aiConfigService');
const aiConfigRoutes = require('../src/routes/aiConfig');
const runtimeConfig = require('../src/config');
const storageLayout = require('../src/services/storageLayout');

const H3 = 'huobao_minimax_h3_reference_turbo_api';
const WAN = 'huobao_wan22_5b_t2v_32gb_api';
const BRIDGE = 'http://127.0.0.1:15681';
const BRIDGE_TOKEN = 'bridge-test-secret';
const COMFY_TOKEN = 'comfy-test-secret';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFZkAAAAASUVORK5CYII=', 'base64');
const PNG_B = Buffer.concat([PNG, Buffer.from('second-fixture')]);
const dataUrl = (bytes) => `data:image/png;base64,${bytes.toString('base64')}`;
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const nativeConfig = () => ({ id: 5, service_type: 'video', name: 'Comfyui', provider: 'ComfuUI', base_url: 'http://127.0.0.1:8188', api_key: COMFY_TOKEN, endpoint: '', query_endpoint: '', api_protocol: '', model: [H3, WAN], default_model: H3 });

function createDb(config = nativeConfig()) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ai_service_configs (
      id INTEGER PRIMARY KEY, service_type TEXT, provider TEXT, api_protocol TEXT, name TEXT,
      base_url TEXT, api_key TEXT, model TEXT, default_model TEXT, endpoint TEXT, query_endpoint TEXT,
      settings TEXT, priority INTEGER DEFAULT 0, is_default INTEGER DEFAULT 1, is_active INTEGER DEFAULT 1,
      created_at TEXT, updated_at TEXT, deleted_at TEXT
    );
    CREATE TABLE async_tasks (
      id TEXT PRIMARY KEY, type TEXT, status TEXT, progress INTEGER, message TEXT, error TEXT,
      result TEXT, resource_id TEXT, created_at TEXT, updated_at TEXT, completed_at TEXT, deleted_at TEXT
    );
    CREATE TABLE video_generations (
      id INTEGER PRIMARY KEY, drama_id INTEGER, storyboard_id INTEGER, provider TEXT, prompt TEXT,
      model TEXT, duration INTEGER, aspect_ratio TEXT, resolution TEXT, seed INTEGER,
      camera_fixed INTEGER, watermark INTEGER, image_gen_id INTEGER, image_url TEXT,
      first_frame_url TEXT, last_frame_url TEXT, reference_image_urls TEXT,
      task_id TEXT, provider_task_id TEXT, status TEXT, error_msg TEXT, video_url TEXT, local_path TEXT,
      created_at TEXT, updated_at TEXT, completed_at TEXT, deleted_at TEXT
    );
  `);
  if (config) {
    const values = { ...nativeConfig(), ...config };
    db.prepare(`INSERT INTO ai_service_configs
      (id, service_type, provider, api_protocol, name, base_url, api_key, model, default_model, endpoint, query_endpoint)
      VALUES (@id, @service_type, @provider, @api_protocol, @name, @base_url, @api_key, @model, @default_model, @endpoint, @query_endpoint)`)
      .run({ ...values, model: JSON.stringify(values.model) });
  }
  return db;
}

function addVideo(db, values = {}) {
  const row = { id: 1, model: H3, prompt: '按图片编号生成视频', provider: 'ComfuUI', task_id: 'async-1', status: 'pending', aspect_ratio: '16:9', ...values };
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO video_generations (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((key) => row[key]));
  db.prepare("INSERT INTO async_tasks (id,type,status,progress,message) VALUES (?, 'video_generation', 'pending', 0, '')").run(row.task_id);
}

describe('native ComfyUI read-only connection validation', () => {
  let log, entries, managerCalls;
  beforeEach(() => {
    entries = [];
    log = Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (...args) => entries.push([level, ...args])]));
    managerCalls = [];
    mock.method(bridgeProcess, 'getComfyUIBridgeConnection', async (options) => {
      managerCalls.push(options);
      assert.equal(options.config, undefined);
      return { baseUrl: BRIDGE, token: BRIDGE_TOKEN };
    });
    mock.method(global, 'fetch', async (url) => { throw new Error(`Unexpected network request: ${url}`); });
  });
  afterEach(() => mock.restoreAll());

  async function callRoute(body) {
    const res = {
      statusCode: null, payload: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; return this; },
    };
    await aiConfigRoutes(null, log, {}).testConnection({ body }, res);
    return res;
  }

  it('previews both models with fixed parameters, bridge auth and optional native token, without generation or image fields', async () => {
    const packets = [];
    mock.method(global, 'fetch', async (url, options) => {
      assert.equal(url, BRIDGE + '/video/validate');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer ' + BRIDGE_TOKEN);
      assert.ok(options.signal instanceof AbortSignal);
      const body = JSON.parse(options.body);
      packets.push(body);
      return response({ valid: true, model: body.model, capabilities: comfy.getComfyUIVideoCapabilities(body.model), reference_count: 0, guide_count: 0, workflow: { '1': { class_type: 'VerifiedNode' } } });
    });
    for (const [model, api_key] of [[H3, ''], [WAN, COMFY_TOKEN]]) {
      const result = await comfy.validateComfyUIVideoConnection({ ...nativeConfig(), api_key, image_url: 'must-not-upload.png', reference_urls: ['must-not-upload.png'] }, log, model);
      assert.deepEqual(result, { valid: true, model, capabilities: comfy.getComfyUIVideoCapabilities(model) });
    }
    assert.deepEqual(packets, [
      { model: H3, comfyui_url: 'http://127.0.0.1:8188', prompt: 'Connection dependency check', duration: 1, seed: 42 },
      { model: WAN, comfyui_url: 'http://127.0.0.1:8188', comfyui_token: COMFY_TOKEN, prompt: 'Connection dependency check', duration: 1, seed: 42 },
    ]);
    assert.equal(global.fetch.mock.callCount(), 2);
    assert.equal(managerCalls.length, 2);
    assert.equal(managerCalls[0].log, log);
    assert.deepEqual(entries, []);
  });

  it('service accepts missing native keys, explicit protocol and selected default models before external handling', async () => {
    const models = [];
    mock.method(global, 'fetch', async (url, options) => {
      assert.equal(url, BRIDGE + '/video/validate');
      const body = JSON.parse(options.body);
      assert.equal(body.comfyui_token, undefined);
      models.push(body.model);
      return response({ valid: true, model: body.model });
    });
    await aiConfigService.testConnection({ ...nativeConfig(), api_key: '', model: JSON.stringify([H3, WAN]), default_model: WAN });
    await aiConfigService.testConnection({ base_url: 'http://127.0.0.1:8188', api_protocol: 'comfyui', provider: 'custom', service_type: 'video', model: H3, endpoint: '/ignored-explicit-protocol' });
    await aiConfigService.testConnection({ base_url: 'http://127.0.0.1:8188', provider: 'openai', model: WAN });
    assert.deepEqual(models, [WAN, H3, WAN]);
    assert.equal(managerCalls.length, 3);
  });

  it('rejects dependency, upstream and HTTP405 failures rather than accepting a reachable wrong endpoint', async () => {
    for (const [status, error, expected] of [
      [422, '缺少节点 MiniMaxH3VideoGeneration', /HTTP 422.*缺少节点/],
      [422, '缺少模型 wan2.2_ti2v_5B_fp16.safetensors', /HTTP 422.*缺少模型/],
      [503, '无法连接原生 ComfyUI', /HTTP 503.*无法连接/],
      [502, 'ComfyUI 拒绝读取 object_info', /HTTP 502.*object_info/],
      [405, 'Method Not Allowed', /HTTP 405.*Method Not Allowed/],
    ]) {
      mock.method(global, 'fetch', async (url) => {
        assert.equal(url, BRIDGE + '/video/validate');
        return response({ error }, status);
      });
      await assert.rejects(aiConfigService.testConnection(nativeConfig()), expected);
    }
  });

  it('requires exact valid:true and the requested model, and rejects non-JSON validation replies', async () => {
    for (const data of [{ valid: false, model: H3 }, { valid: 'true', model: H3 }, { valid: true, model: WAN }, { valid: true }, { ok: true, model: H3 }]) {
      mock.method(global, 'fetch', async () => response(data));
      await assert.rejects(comfy.validateComfyUIVideoConnection(nativeConfig(), log, H3), /未确认所选工作流依赖可用/);
    }
    mock.method(global, 'fetch', async () => new Response('<html>wrong endpoint</html>', { status: 405 }));
    await assert.rejects(aiConfigService.testConnection(nativeConfig()), /非 JSON 响应.*HTTP 405/);
  });

  it('rejects unsupported models or invalid native URLs before startup and propagates startup or request failures safely', async () => {
    await assert.rejects(comfy.validateComfyUIVideoConnection({ ...nativeConfig(), default_model: 'unknown', model: ['unknown'] }, log), /请选择已适配/);
    await assert.rejects(comfy.validateComfyUIVideoConnection({ ...nativeConfig(), base_url: 'file:///not-comfy' }, log, H3), /ComfyUI 地址无效/);
    assert.equal(managerCalls.length, 0);
    assert.equal(global.fetch.mock.callCount(), 0);
    mock.method(bridgeProcess, 'getComfyUIBridgeConnection', async () => { throw new Error('Python 启动失败 ' + COMFY_TOKEN); });
    await assert.rejects(aiConfigService.testConnection(nativeConfig()), (error) => /Python 启动失败/.test(error.message) && !error.message.includes(COMFY_TOKEN));
    mock.method(bridgeProcess, 'getComfyUIBridgeConnection', async () => ({ baseUrl: BRIDGE, token: BRIDGE_TOKEN }));
    mock.method(global, 'fetch', async () => { throw new Error('连接超时 ' + COMFY_TOKEN + ' Bearer ' + BRIDGE_TOKEN); });
    await assert.rejects(aiConfigService.testConnection(nativeConfig()), (error) => /连接超时/.test(error.message) && !error.message.includes(COMFY_TOKEN) && !error.message.includes(BRIDGE_TOKEN));
  });

  it('route allows an empty native key and forwards protocol, name and selected-model fields', async () => {
    const packets = [];
    mock.method(global, 'fetch', async (url, options) => {
      assert.equal(url, BRIDGE + '/video/validate');
      const body = JSON.parse(options.body);
      packets.push(body);
      return response({ valid: true, model: body.model });
    });
    for (const body of [
      { ...nativeConfig(), api_key: '', default_model: WAN },
      { ...nativeConfig(), api_key: '', provider: 'custom', name: '', api_protocol: 'comfyui', endpoint: '/unused-proxy' },
      { ...nativeConfig(), api_key: '', provider: 'openai', name: '本地 ComfyUI', model: [H3] },
    ]) {
      const res = await callRoute(body);
      assert.equal(res.statusCode, 200);
      assert.equal(res.payload.success, true);
      assert.equal(res.payload.data.message, '连接测试成功');
    }
    assert.deepEqual(packets.map((packet) => packet.model), [WAN, H3, H3]);
    assert.ok(packets.every((packet) => packet.comfyui_token === undefined));
    assert.equal(managerCalls[0].log, log);
  });

  it('route retains required-key checks for external providers, explicit proxies and non-video services', async () => {
    for (const body of [
      { base_url: 'https://example.test', provider: 'openai', model: 'gpt-4o', service_type: 'text' },
      { ...nativeConfig(), api_key: '', endpoint: '/proxy/video/generations' },
      { ...nativeConfig(), api_key: '', query_endpoint: '/proxy/task/{id}' },
      { ...nativeConfig(), api_key: '', api_protocol: 'openai' },
      { ...nativeConfig(), api_key: '', service_type: 'image' },
      { ...nativeConfig(), api_key: '', base_url: '' },
    ]) {
      const res = await callRoute(body);
      assert.equal(res.statusCode, 400);
      assert.match(res.payload.error.message, /缺少 base_url 或 api_key/);
    }
    assert.equal(managerCalls.length, 0);
    assert.equal(global.fetch.mock.callCount(), 0);
  });

  it('route reports actual missing dependencies with secrets redacted from response and logs', async () => {
    mock.method(global, 'fetch', async (url) => {
      assert.equal(url, BRIDGE + '/video/validate');
      return response({ error: '缺少节点 ' + COMFY_TOKEN + ' Bearer ' + BRIDGE_TOKEN }, 422);
    });
    const res = await callRoute(nativeConfig());
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.success, false);
    assert.match(res.payload.error.message, /HTTP 422.*缺少节点/);
    const emitted = JSON.stringify({ response: res.payload, logs: entries });
    assert.ok(!emitted.includes(COMFY_TOKEN));
    assert.ok(!emitted.includes(BRIDGE_TOKEN));
    assert.equal(global.fetch.mock.callCount(), 1);
  });

  it('preserves external missing-key rules and existing video connectivity probes', async () => {
    await assert.rejects(aiConfigService.testConnection({ base_url: 'https://api.example.test', provider: 'openai', model: 'gpt-4o' }), /api_key 必填/);
    await assert.rejects(aiConfigService.testConnection({ ...nativeConfig(), api_key: '', api_protocol: 'openai' }), /api_key 必填/);
    await assert.rejects(aiConfigService.testConnection({ ...nativeConfig(), api_key: '', service_type: 'text' }), /api_key 必填/);
    assert.equal(managerCalls.length, 0);
    mock.method(global, 'fetch', async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:8188/chat/completions');
      assert.equal(options.headers.Authorization, 'Bearer external-proxy-key');
      assert.equal(JSON.parse(options.body).model, H3);
      return response({ error: 'Method Not Allowed' }, 405);
    });
    const res = await callRoute({ ...nativeConfig(), api_key: 'external-proxy-key', endpoint: '/proxy/video/check', query_endpoint: '/proxy/task/{id}' });
    assert.equal(res.statusCode, 200, 'existing external proxy connectivity semantics stay unchanged');
    assert.equal(managerCalls.length, 0);
    assert.equal(global.fetch.mock.callCount(), 1);
  });
});

describe('managed native ComfyUI video client', () => {
  let db, tempDir, log, entries, managerCalls;
  beforeEach(() => {
    db = createDb();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-comfy-client-'));
    fs.mkdirSync(path.join(tempDir, 'images'));
    fs.writeFileSync(path.join(tempDir, 'images', 'one.png'), PNG);
    fs.writeFileSync(path.join(tempDir, 'images', 'two.png'), PNG_B);
    entries = [];
    log = Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (...args) => entries.push([level, ...args])]));
    managerCalls = [];
    mock.method(bridgeProcess, 'getComfyUIBridgeConnection', async (options) => {
      managerCalls.push(options);
      assert.equal(options.config, undefined, 'manager loads backend runtime settings itself');
      return { baseUrl: BRIDGE, token: BRIDGE_TOKEN };
    });
    mock.method(runtimeConfig, 'loadConfig', () => ({ storage: { base_url: 'http://127.0.0.1:5680/static', local_path: tempDir } }));
    mock.method(global, 'fetch', async (url) => { throw new Error(`Unexpected network request: ${url}`); });
  });
  afterEach(() => {
    mock.restoreAll();
    db.close();
    assert.equal(path.dirname(path.resolve(tempDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(tempDir).startsWith('lmd-comfy-client-'));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const imageOptions = () => ({ files_base_url: 'http://127.0.0.1:5680/static', storage_local_path: tempDir });

  it('recognizes the stored provider typo, exact aliases and explicit protocol while preserving custom proxy routing', () => {
    assert.equal(comfy.isNativeComfyUIConfig(nativeConfig(), H3), true);
    assert.equal(comfy.isNativeComfyUIConfig(nativeConfig(), WAN), true);
    assert.equal(comfy.isNativeComfyUIConfig({ provider: 'other', model: [WAN] }), true);
    assert.equal(comfy.isNativeComfyUIConfig({ api_protocol: ' ComfyUI ', endpoint: '/custom' }), true);
    assert.equal(comfy.isNativeComfyUIConfig({ ...nativeConfig(), endpoint: '/proxy/video/generations' }, H3), false);
    assert.equal(comfy.isNativeComfyUIConfig({ ...nativeConfig(), query_endpoint: '/proxy/task/{id}' }, H3), false);
    assert.equal(comfy.isNativeComfyUIConfig({ ...nativeConfig(), api_protocol: 'openai' }, H3), false);
    assert.equal(comfy.isNativeComfyUIConfig({ provider: 'volces', name: 'Comfyui', model: ['doubao-seedance-1-0-pro'] }), false);
    assert.equal(comfy.isNativeComfyUIConfig({ provider: 'openai', name: '本地 ComfyUI', model: [] }), true);
    assert.equal(videoClient.isNativeComfyUIConfig, comfy.isNativeComfyUIConfig);
    assert.equal(comfy.isComfyUITaskId('lmd-comfy-saved'), true);
    assert.equal(comfy.isComfyUITaskId('other-task'), false);
    assert.deepEqual(comfy.getComfyUIVideoCapabilities(H3), { supports_first_frame: true, supports_last_frame: true, supports_references: true, max_reference_images: 9 });
    assert.deepEqual(comfy.getComfyUIVideoCapabilities(WAN), { supports_first_frame: true, supports_last_frame: false, supports_references: false, max_reference_images: 1, reference_mode: 'single_first_frame' });
  });

  it('dispatches both configured models through the managed authenticated bridge without rewriting AI config', async () => {
    const before = db.prepare('SELECT * FROM ai_service_configs').all();
    const bodies = [];
    mock.method(global, 'fetch', async (url, options) => {
      assert.equal(url, BRIDGE + '/video/generations');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer ' + BRIDGE_TOKEN);
      assert.ok(options.signal instanceof AbortSignal);
      bodies.push(JSON.parse(options.body));
      return response({ task_id: 'lmd-comfy-created', status: 'processing', prompt_id: 'prompt-id' });
    });
    for (const model of [H3, WAN]) {
      const result = await videoClient.callVideoApi(db, log, { model, prompt: '镜头向前移动', duration: 6, aspect_ratio: '9:16', resolution: '720p', seed: 0 });
      assert.deepEqual(result, { task_id: 'lmd-comfy-created', status: 'processing', prompt_id: 'prompt-id' });
    }
    assert.deepEqual(bodies.map((body) => body.model), [H3, WAN]);
    assert.deepEqual(bodies[0], { model: H3, prompt: '镜头向前移动', duration: 6, aspect_ratio: '9:16', resolution: '720p', seed: 0, reference_urls: [], comfyui_url: 'http://127.0.0.1:8188', comfyui_token: COMFY_TOKEN });
    assert.equal(managerCalls.length, 2);
    assert.deepEqual(db.prepare('SELECT * FROM ai_service_configs').all(), before);
    assert.ok(!JSON.stringify(entries).includes(BRIDGE_TOKEN));
    assert.ok(!JSON.stringify(entries).includes(COMFY_TOKEN));
  });

  it('reads relative, static, loopback, configured-storage and data images byte-exactly in order and keeps equal first/last roles', async () => {
    let body;
    mock.method(global, 'fetch', async (url, options) => {
      assert.equal(url, BRIDGE + '/video/generations');
      body = JSON.parse(options.body);
      return response({ task_id: 'lmd-comfy-images', status: 'processing' });
    });
    const result = await videoClient.callVideoApi(db, log, {
      model: H3, prompt: '@图片1 与 @图片2 同框', ...imageOptions(),
      reference_urls: ['images/one.png', '/static/images/two.png', 'http://localhost:3013/static/images/one.png?cache=1', 'http://127.0.0.1:5680/static/images/two.png', dataUrl(PNG)],
      first_frame_url: '/static/images/one.png', last_frame_url: 'http://[::1]:5680/static/images/one.png',
    });
    assert.equal(result.error, undefined);
    assert.deepEqual(body.reference_urls, [PNG, PNG_B, PNG, PNG_B, PNG].map(dataUrl));
    assert.equal(body.first_frame_url, dataUrl(PNG));
    assert.equal(body.last_frame_url, dataUrl(PNG));
    assert.equal(body.prompt, '@图片1 与 @图片2 同框');
    assert.ok(!JSON.stringify(entries).includes(PNG.toString('base64')));
    assert.equal(await comfy.resolveComfyUIImage('https://cdn.example/remote.png', imageOptions()), 'https://cdn.example/remote.png');
    assert.equal(await comfy.resolveComfyUIImage('http://storage.example/static/images/one.png', { ...imageOptions(), files_base_url: 'http://storage.example/static' }), dataUrl(PNG));
    const percentEncoded = [...PNG].map((byte) => '%' + byte.toString(16).padStart(2, '0')).join('');
    assert.equal(await comfy.resolveComfyUIImage('data:image/png,' + percentEncoded), dataUrl(PNG));
    assert.equal(await comfy.resolveComfyUIImage('data:image/png;charset=utf-8;base64,' + PNG.toString('base64')), dataUrl(PNG));
  });

  it('uses H3 image_url as a fallback reference and refuses to lose an unlisted primary image', async () => {
    const bodies = [];
    mock.method(global, 'fetch', async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return response({ task_id: 'lmd-comfy-primary', status: 'processing' });
    });
    const first = await videoClient.callVideoApi(db, log, { model: H3, image_url: 'images/one.png', first_frame_url: 'images/two.png', ...imageOptions() });
    assert.equal(first.error, undefined);
    assert.deepEqual(bodies[0].reference_urls, [dataUrl(PNG)]);
    assert.equal(bodies[0].image_url, dataUrl(PNG));
    assert.equal(bodies[0].first_frame_url, dataUrl(PNG_B));
    const mismatch = await videoClient.callVideoApi(db, log, { model: H3, image_url: 'images/one.png', reference_urls: ['images/two.png'], ...imageOptions() });
    assert.match(mismatch.error, /按提示词编号.*参考图列表/);
    assert.equal(bodies.length, 1);
  });

  it('allows nine ordered H3 references and rejects a tenth before bridge startup', async () => {
    mock.method(global, 'fetch', async (_url, options) => {
      assert.equal(JSON.parse(options.body).reference_urls.length, 9);
      return response({ task_id: 'lmd-comfy-nine', status: 'processing' });
    });
    assert.equal((await videoClient.callVideoApi(db, log, { model: H3, reference_urls: Array(9).fill(dataUrl(PNG)) })).error, undefined);
    const result = await videoClient.callVideoApi(db, log, { model: H3, reference_urls: Array(10).fill(dataUrl(PNG)) });
    assert.match(result.error, /最多支持 9 张/);
    assert.equal(result.capabilities.max_reference_images, 9);
    assert.equal(managerCalls.length, 1);
  });

  it('allows Wan one image in any first-frame source and rejects distinct multiple images or a last frame', async () => {
    const bodies = [];
    mock.method(global, 'fetch', async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return response({ task_id: 'lmd-comfy-wan', status: 'processing' });
    });
    for (const inputs of [
      { first_frame_url: 'images/one.png' },
      { image_url: '/static/images/one.png' },
      { reference_urls: ['images/one.png'] },
      { first_frame_url: '/static/images/one.png', image_url: 'images/one.png', reference_urls: [dataUrl(PNG)] },
    ]) {
      assert.equal((await videoClient.callVideoApi(db, log, { model: WAN, ...imageOptions(), ...inputs })).error, undefined);
    }
    assert.equal(bodies[0].first_frame_url, dataUrl(PNG));
    assert.equal(bodies[1].image_url, dataUrl(PNG));
    assert.equal(bodies[1].first_frame_url, undefined);
    assert.deepEqual(bodies[2].reference_urls, [dataUrl(PNG)]);
    assert.deepEqual(bodies[3].reference_urls, [dataUrl(PNG)]);
    const multiple = await videoClient.callVideoApi(db, log, { model: WAN, reference_urls: [dataUrl(PNG), dataUrl(PNG_B)] });
    assert.match(multiple.error, /只支持一张首帧图.*2 张不同图片/);
    assert.equal(multiple.capabilities.supports_references, false);
    const tail = await videoClient.callVideoApi(db, log, { model: WAN, first_frame_url: dataUrl(PNG), last_frame_url: dataUrl(PNG) });
    assert.match(tail.error, /不支持尾帧约束.*MiniMax H3/);
    assert.equal(managerCalls.length, 4);
  });

  it('fails missing, unreadable, escaped, empty and invalid image references without submitting or renumbering', async () => {
    fs.writeFileSync(path.join(tempDir, 'images', 'empty.png'), '');
    for (const reference of ['images/missing.png', '../outside.png', 'images/empty.png', 'data:image/png;base64,%%%%', 'data:image/png;base64,', '']) {
      const result = await videoClient.callVideoApi(db, log, { model: H3, ...imageOptions(), reference_urls: [dataUrl(PNG), reference] });
      assert.match(result.error, /第 2 张参考图/);
    }
    assert.equal(managerCalls.length, 0);
    assert.equal(global.fetch.mock.callCount(), 0);
    const unknown = await comfy.callComfyUIVideoApi(nativeConfig(), log, { model: 'unsupported-workflow' });
    assert.match(unknown.error, /尚未适配模型/);
    assert.match((await videoClient.callVideoApi(db, log, { model: H3, reference_urls: 'invalid' })).error, /列表格式无效/);
  });

  it('preserves explicit generic proxy endpoints and ordered reference_image parts, without rerouting or hosting', async () => {
    db.prepare('UPDATE ai_service_configs SET endpoint = ?, query_endpoint = ?').run('/custom/create', '/custom/query/{taskId}');
    let body;
    mock.method(global, 'fetch', async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:8188/custom/create');
      assert.equal(options.headers.Authorization, 'Bearer ' + COMFY_TOKEN);
      body = JSON.parse(options.body);
      return response({ task_id: 'proxy-task', status: 'processing' });
    });
    const result = await videoClient.callVideoApi(db, log, { model: H3, prompt: 'proxy', reference_urls: ['https://cdn.example/two.png', 'https://cdn.example/one.png'], first_frame_url: 'https://cdn.example/first.png', last_frame_url: 'https://cdn.example/last.png' });
    assert.equal(result.task_id, 'proxy-task');
    assert.deepEqual(body.content, [
      { type: 'text', text: 'proxy' },
      { type: 'image_url', image_url: { url: 'https://cdn.example/first.png' }, role: 'first_frame' },
      { type: 'image_url', image_url: { url: 'https://cdn.example/last.png' }, role: 'last_frame' },
      { type: 'image_url', image_url: { url: 'https://cdn.example/two.png' }, role: 'reference_image' },
      { type: 'image_url', image_url: { url: 'https://cdn.example/one.png' }, role: 'reference_image' },
    ]);
    assert.equal(managerCalls.length, 0);
  });

  it('keeps an ordinary Volcengine text-video request on its existing endpoint and payload contract', async () => {
    db.prepare('UPDATE ai_service_configs SET provider = ?, base_url = ?, model = ?, default_model = ?').run('volces', 'https://ark.example/api/v3', JSON.stringify(['doubao-seedance-1-0-pro']), 'doubao-seedance-1-0-pro');
    mock.method(global, 'fetch', async (url, options) => {
      assert.equal(url, 'https://ark.example/api/v3/contents/generations/tasks');
      const body = JSON.parse(options.body);
      assert.equal(body.task_type, 't2v');
      assert.deepEqual(body.content, [{ type: 'text', text: 'existing provider' }]);
      return response({ id: 'volc-task' });
    });
    assert.equal((await videoClient.callVideoApi(db, log, { model: 'doubao-seedance-1-0-pro', prompt: 'existing provider', duration: 5 })).task_id, 'volc-task');
    assert.equal(managerCalls.length, 0);
  });

  it('polls processing to completed with progress, managed auth and restored ComfyUI auth even after provider changes', async () => {
    addVideo(db, { status: 'processing', provider_task_id: 'lmd-comfy-restored' });
    const replies = [{ status: 'processing', progress: 37 }, { status: 'completed', video_url: 'http://127.0.0.1:8188/view?filename=result.mp4', prompt_id: 'saved-prompt' }];
    mock.method(global, 'fetch', async (url, options) => {
      assert.equal(url, BRIDGE + '/video/task/lmd-comfy-restored');
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.Authorization, 'Bearer ' + BRIDGE_TOKEN);
      assert.equal(options.headers['X-ComfyUI-Token'], COMFY_TOKEN);
      return response(replies.shift());
    });
    const result = await videoClient.pollVideoTask(db, log, 1, 'lmd-comfy-restored', { ...nativeConfig(), provider: 'volces', base_url: 'https://changed.example', endpoint: '/changed/create', api_protocol: 'volcengine' }, 2, 0);
    assert.equal(result.video_url, 'http://127.0.0.1:8188/view?filename=result.mp4');
    assert.equal(result.prompt_id, 'saved-prompt');
    assert.equal(global.fetch.mock.callCount(), 2);
    const task = db.prepare('SELECT progress, message FROM async_tasks').get();
    assert.equal(task.progress, 37);
    assert.match(task.message, /本地 ComfyUI/);
    assert.doesNotMatch(task.message, /图床/);
    assert.ok(!JSON.stringify(entries).includes(COMFY_TOKEN));
    assert.ok(!JSON.stringify(entries).includes(BRIDGE_TOKEN));
  });

  it('enforces a finite poll attempt bound and preserves the id for later resume', async () => {
    mock.method(global, 'fetch', async () => response({ status: 'processing' }));
    const result = await videoClient.pollVideoTask(null, log, 1, 'lmd-comfy-timeout', nativeConfig(), 3, 0);
    assert.match(result.error, /本地 ComfyUI.*查询超时.*继续查询/);
    assert.equal(global.fetch.mock.callCount(), 3);
    mock.method(global, 'fetch', async () => response({ status: 'completed', video_url: 'https://cdn.example/recovered.mp4' }));
    assert.equal((await videoClient.pollVideoTask(null, log, 1, 'lmd-comfy-timeout', null, 1, 0)).video_url, 'https://cdn.example/recovered.mp4');
  });

  it('propagates bridge failures, malformed responses, missing video and startup errors with secrets redacted', async () => {
    for (const data of [
      { status: 'failed', error: `节点错误 ${COMFY_TOKEN} Bearer ${BRIDGE_TOKEN}` },
      { status: 'completed' },
      { status: 'unexpected-status' },
    ]) {
      mock.method(global, 'fetch', async () => response(data));
      const result = await videoClient.pollVideoTask(null, log, 1, 'lmd-comfy-failure', nativeConfig(), 1, 0);
      assert.ok(result.error);
      assert.ok(!result.error.includes(COMFY_TOKEN));
      assert.ok(!result.error.includes(BRIDGE_TOKEN));
    }
    mock.method(global, 'fetch', async () => response({ error: '鉴权失败' }, 401));
    assert.match((await videoClient.pollVideoTask(null, log, 1, 'lmd-comfy-http', nativeConfig(), 1, 0)).error, /HTTP 401.*鉴权失败/);
    mock.method(global, 'fetch', async () => new Response('<html>not JSON</html>', { status: 502 }));
    assert.match((await videoClient.pollVideoTask(null, log, 1, 'lmd-comfy-json', nativeConfig(), 1, 0)).error, /非 JSON.*502/);
    mock.method(bridgeProcess, 'getComfyUIBridgeConnection', async () => { throw new Error('Python 3.10+ unavailable'); });
    const before = global.fetch.mock.callCount();
    assert.match((await videoClient.callVideoApi(db, log, { model: H3 })).error, /Python 3.10\+/);
    assert.match((await videoClient.pollVideoTask(null, log, 1, 'lmd-comfy-startup', nativeConfig(), 1, 0)).error, /Python 3.10\+/);
    assert.equal(global.fetch.mock.callCount(), before);
    assert.ok(!JSON.stringify(entries).includes(COMFY_TOKEN));
    assert.ok(!JSON.stringify(entries).includes(BRIDGE_TOKEN));
  });

  it('rejects failed, invalid and unauthenticated bridge submission responses', async () => {
    for (const [data, status, expected] of [
      [{ status: 'failed', error: '工作流执行失败' }, 200, /工作流执行失败/],
      [{ status: 'processing', task_id: 'wrong-prefix' }, 200, /有效的本地任务 ID/],
      [{ status: 'completed' }, 200, /未返回可下载的视频地址/],
      [{ error: '令牌验证失败' }, 401, /HTTP 401.*令牌验证失败/],
    ]) {
      mock.method(global, 'fetch', async () => response(data, status));
      assert.match((await videoClient.callVideoApi(db, log, { model: H3 })).error, expected);
    }
  });

  it('videoService retains references with first/last and reports local preparation and explicit task failures', async () => {
    addVideo(db, { reference_image_urls: JSON.stringify(['images/one.png', 'images/two.png']), first_frame_url: '/static/images/two.png', last_frame_url: '/static/images/two.png' });
    const progress = [];
    mock.method(global, 'fetch', async (url, options) => {
      progress.push(db.prepare('SELECT message FROM async_tasks').get().message);
      if (options.method === 'POST') {
        const body = JSON.parse(options.body);
        assert.deepEqual(body.reference_urls, [dataUrl(PNG), dataUrl(PNG_B)]);
        assert.equal(body.first_frame_url, dataUrl(PNG_B));
        assert.equal(body.last_frame_url, dataUrl(PNG_B));
        return response({ task_id: 'lmd-comfy-service', status: 'processing' });
      }
      assert.equal(url, BRIDGE + '/video/task/lmd-comfy-service');
      return response({ status: 'failed', error: '节点缺少模型文件，请安装对应模型' });
    });
    await videoService.processVideoGeneration(db, log, 1);
    assert.ok(progress.some((message) => /本地 ComfyUI/.test(message)));
    assert.ok(progress.every((message) => !message.includes('图床')));
    const row = db.prepare('SELECT status, error_msg, provider_task_id FROM video_generations').get();
    assert.equal(row.status, 'failed');
    assert.equal(row.provider_task_id, 'lmd-comfy-service');
    assert.match(row.error_msg, /缺少模型文件/);
    assert.equal(db.prepare('SELECT status FROM async_tasks').get().status, 'failed');
  });

  it('videoService resumes a persisted native task with its config removed and finalizes without a new submission', async () => {
    addVideo(db, { status: 'processing', provider_task_id: 'lmd-comfy-disk-restored' });
    db.prepare('DELETE FROM ai_service_configs').run();
    mock.method(storageLayout, 'getProjectStorageSubdir', () => { throw new Error('Skip download in isolated status test'); });
    mock.method(global, 'fetch', async (url, options) => {
      assert.equal(options.method, 'GET');
      assert.equal(url, BRIDGE + '/video/task/lmd-comfy-disk-restored');
      return response({ status: 'completed', video_url: 'http://127.0.0.1:8188/view?filename=saved.mp4' });
    });
    await videoService.resumePollForVideoGeneration(db, log, 1);
    const row = db.prepare('SELECT status, video_url FROM video_generations').get();
    assert.equal(row.status, 'completed');
    assert.equal(row.video_url, 'http://127.0.0.1:8188/view?filename=saved.mp4');
    assert.equal(db.prepare('SELECT status FROM async_tasks').get().status, 'completed');
    assert.equal(global.fetch.mock.callCount(), 1);
  });

  it('videoService rejects malformed stored references rather than silently submitting text-only', async () => {
    addVideo(db, { reference_image_urls: '{broken-json' });
    await videoService.processVideoGeneration(db, log, 1);
    const row = db.prepare('SELECT status, error_msg FROM video_generations').get();
    assert.equal(row.status, 'failed');
    assert.match(row.error_msg, /ComfyUI 参考图列表格式无效/);
    assert.equal(managerCalls.length, 0);
    assert.equal(global.fetch.mock.callCount(), 0);
  });
});
