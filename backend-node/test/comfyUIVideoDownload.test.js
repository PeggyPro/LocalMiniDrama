const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const runtimeConfig = require('../src/config');
const videoClient = require('../src/services/videoClient');
const bridgeProcess = require('../src/services/comfyUIBridgeProcess');

// videoService captures this helper on load; download tests must not launch ffmpeg.
const ffmpegTools = require('../src/utils/ffmpegPath');
const originalHasLocalFfmpeg = ffmpegTools.hasLocalFfmpeg;
let videoService;
try {
  ffmpegTools.hasLocalFfmpeg = () => false;
  videoService = require('../src/services/videoService');
} finally {
  ffmpegTools.hasLocalFfmpeg = originalHasLocalFfmpeg;
}

const H3 = 'huobao_minimax_h3_reference_turbo_api';
const NATIVE_TOKEN = 'native-download-test-secret';
const OTHER_TOKEN = 'other-config-test-secret';
const BRIDGE_TOKEN = 'bridge-download-test-secret';
const VIDEO_BYTES = Buffer.from('local ComfyUI video download fixture');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ai_service_configs (
      id INTEGER PRIMARY KEY, service_type TEXT, provider TEXT, api_protocol TEXT, name TEXT,
      base_url TEXT, api_key TEXT, model TEXT, default_model TEXT, endpoint TEXT, query_endpoint TEXT,
      settings TEXT, priority INTEGER DEFAULT 0, is_default INTEGER DEFAULT 1, is_active INTEGER DEFAULT 1,
      created_at TEXT, updated_at TEXT, deleted_at TEXT
    );
    CREATE TABLE async_tasks (
      id TEXT PRIMARY KEY, type TEXT, status TEXT, progress INTEGER DEFAULT 0, message TEXT, error TEXT,
      result TEXT, resource_id TEXT, created_at TEXT, updated_at TEXT, completed_at TEXT, deleted_at TEXT
    );
    CREATE TABLE video_generations (
      id INTEGER PRIMARY KEY, drama_id INTEGER, storyboard_id INTEGER, provider TEXT, prompt TEXT,
      model TEXT, duration INTEGER, aspect_ratio TEXT, resolution TEXT, seed INTEGER, camera_fixed INTEGER,
      watermark INTEGER, image_gen_id INTEGER, image_url TEXT, first_frame_url TEXT, last_frame_url TEXT,
      reference_image_urls TEXT, task_id TEXT, provider_task_id TEXT, status TEXT, error_msg TEXT,
      video_url TEXT, local_path TEXT, created_at TEXT, updated_at TEXT, completed_at TEXT, deleted_at TEXT
    );
    CREATE TABLE storyboards (id INTEGER PRIMARY KEY, duration INTEGER, video_url TEXT, local_path TEXT, updated_at TEXT);
  `);
  return db;
}

function addConfig(db, values = {}) {
  const row = {
    id: 1, service_type: 'video', provider: 'ComfuUI', api_protocol: 'comfyui', name: 'Native ComfyUI',
    base_url: '', api_key: NATIVE_TOKEN, model: JSON.stringify([H3]), default_model: H3,
    endpoint: '', query_endpoint: '', priority: 0, is_default: 1, is_active: 1, ...values,
  };
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO ai_service_configs (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((key) => row[key]));
}

function addVideo(db, values = {}) {
  const row = {
    id: 1, drama_id: null, storyboard_id: 1, provider: 'ComfuUI', model: H3, prompt: 'download fixture',
    aspect_ratio: '16:9', task_id: 'async-download-1', status: 'pending', ...values,
  };
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO video_generations (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((key) => row[key]));
  db.prepare("INSERT INTO async_tasks (id,type,status,message) VALUES (?, 'video_generation', 'processing', '')")
    .run(row.task_id);
  db.prepare('INSERT INTO storyboards (id,duration) VALUES (1,3)').run();
}

function sendVideo(res, status = 200, bytes = VIDEO_BYTES) {
  res.writeHead(status, { 'Content-Type': 'video/mp4' });
  res.end(bytes);
}

describe('native ComfyUI final video download', () => {
  let db, tempDir, log, entries, servers;
  beforeEach(() => {
    db = createDb();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-comfy-download-'));
    entries = [];
    servers = [];
    log = Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (...args) => entries.push([level, ...args])]));
    mock.method(runtimeConfig, 'loadConfig', () => ({ storage: { local_path: tempDir } }));
  });
  afterEach(async () => {
    mock.restoreAll();
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    db.close();
    assert.equal(path.dirname(path.resolve(tempDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(tempDir).startsWith('lmd-comfy-download-'));
    fs.rmSync(tempDir, { recursive: true, force: true });
    const emitted = JSON.stringify(entries);
    for (const token of [NATIVE_TOKEN, OTHER_TOKEN, BRIDGE_TOKEN]) assert.ok(!emitted.includes(token), 'logs must not contain credentials');
  });

  async function listen(handler) {
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push({ url: req.url, headers: { ...req.headers }, method: req.method });
      handler(req, res);
    });
    servers.push(server);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    return { origin: `http://127.0.0.1:${server.address().port}`, requests };
  }

  function directResult(videoUrl) {
    mock.method(videoClient, 'callVideoApi', async () => ({ video_url: videoUrl }));
  }

  function assertCompleted(videoUrl) {
    const row = db.prepare('SELECT * FROM video_generations WHERE id = 1').get();
    assert.equal(row.status, 'completed');
    assert.equal(row.video_url, videoUrl);
    assert.match(row.local_path, /^library\/videos\/vg_1_[a-z0-9-]+\.mp4$/i);
    assert.deepEqual(fs.readFileSync(path.join(tempDir, row.local_path)), VIDEO_BYTES);
    assert.ok(row.completed_at);
    const task = db.prepare('SELECT * FROM async_tasks').get();
    assert.equal(task.status, 'completed');
    assert.equal(JSON.parse(task.result).status, 'completed');
    const storyboard = db.prepare('SELECT * FROM storyboards WHERE id = 1').get();
    assert.equal(storyboard.local_path, row.local_path);
    assert.equal(storyboard.video_url, videoUrl);
    return row;
  }

  function assertNativeFailure() {
    const row = db.prepare('SELECT * FROM video_generations WHERE id = 1').get();
    assert.equal(row.status, 'failed');
    assert.equal(row.local_path, null);
    assert.equal(row.completed_at, null);
    assert.match(row.error_msg, /ComfyUI.*下载.*本地保存失败.*服务地址.*访问令牌.*存储写入权限.*继续查询/);
    const task = db.prepare('SELECT * FROM async_tasks').get();
    assert.equal(task.status, 'failed');
    assert.equal(task.error, row.error_msg);
    assert.equal(task.result, null);
    assert.equal(db.prepare('SELECT local_path FROM storyboards WHERE id = 1').get().local_path, null);
    for (const token of [NATIVE_TOKEN, OTHER_TOKEN, BRIDGE_TOKEN]) {
      assert.ok(!JSON.stringify({ row, task }).includes(token), 'task data must not contain credentials');
    }
    return row;
  }

  it('resumes and downloads a protected native /view with the selected token, distinct from bridge and other config tokens', async () => {
    let videoUrl;
    const local = await listen((req, res) => {
      if (req.url === '/bridge/video/task/lmd-comfy-download') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'completed', video_url: videoUrl }));
      } else if (req.headers.authorization !== `Bearer ${NATIVE_TOKEN}`) {
        res.writeHead(401);
        res.end('unauthorized');
      } else sendVideo(res);
    });
    videoUrl = local.origin + '/native/comfy/view?filename=result.mp4&type=output';
    addConfig(db, { base_url: local.origin + '/native/comfy/' });
    addConfig(db, { id: 2, provider: 'openai', api_protocol: 'openai', base_url: local.origin + '/other', api_key: OTHER_TOKEN, model: '["unrelated-model"]', priority: 99 });
    addVideo(db, { status: 'processing', provider_task_id: 'lmd-comfy-download' });
    mock.method(bridgeProcess, 'getComfyUIBridgeConnection', async () => ({ baseUrl: local.origin + '/bridge', token: BRIDGE_TOKEN }));
    await videoService.resumePollForVideoGeneration(db, log, 1);
    assertCompleted(videoUrl);
    assert.equal(local.requests.length, 2);
    assert.equal(local.requests[0].headers.authorization, `Bearer ${BRIDGE_TOKEN}`);
    assert.equal(local.requests[0].headers['x-comfyui-token'], NATIVE_TOKEN);
    assert.equal(local.requests[1].headers.authorization, `Bearer ${NATIVE_TOKEN}`);
    assert.equal(local.requests[1].headers['x-comfyui-token'], undefined);
    assert.ok(local.requests.every((req) => !req.url.includes(NATIVE_TOKEN) && !req.url.includes(BRIDGE_TOKEN)));
  });

  it('saves unauthenticated native output through public processing', async () => {
    const local = await listen((req, res) => sendVideo(res));
    const videoUrl = local.origin + '/view?filename=result.mp4';
    addConfig(db, { base_url: local.origin, api_key: '' });
    addVideo(db);
    directResult(videoUrl);
    await videoService.processVideoGeneration(db, log, 1);
    assertCompleted(videoUrl);
    assert.equal(local.requests[0].headers.authorization, undefined);
  });

  for (const [label, apiKey, status] of [['protected HTTP401', NATIVE_TOKEN, 401], ['unauthenticated HTTP503', '', 503]]) {
    it(`marks native ${label} download failure and its task terminally failed`, async () => {
      const local = await listen((req, res) => sendVideo(res, status));
      addConfig(db, { base_url: local.origin, api_key: apiKey });
      addVideo(db);
      directResult(local.origin + '/view?filename=result.mp4');
      await videoService.processVideoGeneration(db, log, 1);
      assertNativeFailure();
      assert.equal(local.requests[0].headers.authorization, apiKey ? `Bearer ${apiKey}` : undefined);
    });
  }

  it('rejects an empty native response rather than marking an empty local file completed', async () => {
    const local = await listen((req, res) => sendVideo(res, 200, Buffer.alloc(0)));
    addConfig(db, { base_url: local.origin });
    addVideo(db);
    directResult(local.origin + '/view?filename=empty.mp4');
    await videoService.processVideoGeneration(db, log, 1);
    assertNativeFailure();
    assert.deepEqual(fs.readdirSync(path.join(tempDir, 'library', 'videos')), []);
  });

  it('reports local write failures without exposing the configured token in error messages', async () => {
    const local = await listen((req, res) => sendVideo(res));
    addConfig(db, { base_url: local.origin });
    addVideo(db);
    directResult(local.origin + '/view?filename=result.mp4');
    mock.method(fs, 'writeFileSync', () => { throw new Error('disk write failure ' + NATIVE_TOKEN); });
    await videoService.processVideoGeneration(db, log, 1);
    assertNativeFailure();
    assert.equal(local.requests.length, 1);
  });

  it('redacts transport exceptions that contain a token', async () => {
    addConfig(db, { base_url: 'http://127.0.0.1:1' });
    addVideo(db);
    directResult('http://127.0.0.1:1/view?filename=result.mp4');
    mock.method(global, 'fetch', async () => { throw new Error('request failed Bearer ' + NATIVE_TOKEN); });
    await videoService.processVideoGeneration(db, log, 1);
    assertNativeFailure();
  });

  it('downloads an off-origin native result without sending any selected config credentials', async () => {
    const owner = await listen((req, res) => sendVideo(res));
    const output = await listen((req, res) => sendVideo(res));
    const videoUrl = output.origin + '/view?filename=result.mp4';
    addConfig(db, { base_url: owner.origin });
    addVideo(db);
    directResult(videoUrl);
    await videoService.processVideoGeneration(db, log, 1);
    assertCompleted(videoUrl);
    assert.equal(owner.requests.length, 0);
    assert.equal(output.requests[0].headers.authorization, undefined);
    assert.equal(output.requests[0].headers['x-comfyui-token'], undefined);
  });

  for (const outputPath of ['/view', '/native/comfy/view-extra', '/native/comfy-other/view']) {
    it(`withholds the native token from same-origin output outside its exact configured /view path: ${outputPath}`, async () => {
      const local = await listen((req, res) => sendVideo(res));
      const videoUrl = local.origin + outputPath + '?filename=result.mp4';
      addConfig(db, { base_url: local.origin + '/native/comfy' });
      addVideo(db);
      directResult(videoUrl);
      await videoService.processVideoGeneration(db, log, 1);
      assertCompleted(videoUrl);
      assert.equal(local.requests[0].headers.authorization, undefined);
    });
  }

  it('retains native authentication across a redirect to the same configured /view endpoint', async () => {
    const local = await listen((req, res) => {
      if (req.url.includes('redirect=1')) {
        res.writeHead(302, { Location: '/native/comfy/view?filename=result.mp4' });
        res.end();
      } else sendVideo(res);
    });
    const videoUrl = local.origin + '/native/comfy/view?redirect=1';
    addConfig(db, { base_url: local.origin + '/native/comfy' });
    addVideo(db);
    directResult(videoUrl);
    await videoService.processVideoGeneration(db, log, 1);
    assertCompleted(videoUrl);
    assert.equal(local.requests.length, 2);
    assert.ok(local.requests.every((req) => req.headers.authorization === `Bearer ${NATIVE_TOKEN}`));
  });

  for (const offOrigin of [false, true]) {
    it(`removes native authentication before an ${offOrigin ? 'off-origin' : 'off-path'} redirect`, async () => {
      let targetUrl;
      const target = offOrigin ? await listen((req, res) => sendVideo(res)) : null;
      const owner = await listen((req, res) => {
        if (req.url.startsWith('/native/comfy/view')) {
          res.writeHead(302, { Location: targetUrl });
          res.end();
        } else sendVideo(res);
      });
      targetUrl = (target?.origin || owner.origin) + '/other/video.mp4';
      const videoUrl = owner.origin + '/native/comfy/view?filename=result.mp4';
      addConfig(db, { base_url: owner.origin + '/native/comfy' });
      addVideo(db);
      directResult(videoUrl);
      await videoService.processVideoGeneration(db, log, 1);
      assertCompleted(videoUrl);
      assert.equal(owner.requests[0].headers.authorization, `Bearer ${NATIVE_TOKEN}`);
      const redirected = offOrigin ? target.requests[0] : owner.requests[1];
      assert.equal(redirected.headers.authorization, undefined);
      assert.equal(redirected.headers['x-comfyui-token'], undefined);
    });
  }

  it('bounds native redirect loops and reports a failed download', async () => {
    const local = await listen((req, res) => {
      res.writeHead(302, { Location: '/view?filename=result.mp4' });
      res.end();
    });
    addConfig(db, { base_url: local.origin });
    addVideo(db);
    directResult(local.origin + '/view?filename=result.mp4');
    await videoService.processVideoGeneration(db, log, 1);
    assertNativeFailure();
    assert.equal(local.requests.length, 6);
  });

  for (const changedConfig of [false, true]) {
    it(`requires a saved file when resuming native output after config ${changedConfig ? 'changed to an external provider' : 'removal'}`, async () => {
      const local = await listen((req, res) => sendVideo(res, 401));
      if (changedConfig) addConfig(db, { provider: 'openai', api_protocol: 'openai', base_url: local.origin, api_key: OTHER_TOKEN });
      addVideo(db, { status: 'processing', provider_task_id: 'lmd-comfy-old-config' });
      mock.method(videoClient, 'pollVideoTask', async () => ({ video_url: local.origin + '/view?filename=result.mp4' }));
      await videoService.resumePollForVideoGeneration(db, log, 1);
      assertNativeFailure();
      assert.equal(local.requests[0].headers.authorization, undefined);
    });
  }

  it('preserves other providers completing with a remote URL when optional local download fails', async () => {
    const local = await listen((req, res) => sendVideo(res, 503));
    const videoUrl = local.origin + '/view?filename=external.mp4';
    addConfig(db, { provider: 'openai', api_protocol: 'openai', base_url: local.origin, api_key: OTHER_TOKEN, model: '["external-model"]' });
    addVideo(db, { provider: 'openai', model: 'external-model' });
    directResult(videoUrl);
    await videoService.processVideoGeneration(db, log, 1);
    const row = db.prepare('SELECT status,video_url,local_path FROM video_generations').get();
    assert.deepEqual(row, { status: 'completed', video_url: videoUrl, local_path: null });
    assert.equal(db.prepare('SELECT status FROM async_tasks').get().status, 'completed');
    assert.equal(local.requests[0].headers.authorization, undefined);
  });

  for (const status of [200, 401]) {
    it(`preserves cheap_seedance2 authenticated-download behavior for HTTP${status}`, async () => {
      const local = await listen((req, res) => sendVideo(res, status));
      const videoUrl = local.origin + '/v1/videos/existing/content';
      addConfig(db, { provider: 'cheap_seedance2', api_protocol: 'sora', base_url: local.origin, api_key: OTHER_TOKEN, model: '["wb-seedance-2-fast"]' });
      addVideo(db, { provider: 'cheap_seedance2', model: 'wb-seedance-2-fast' });
      directResult(videoUrl);
      await videoService.processVideoGeneration(db, log, 1);
      assert.equal(local.requests[0].headers.authorization, `Bearer ${OTHER_TOKEN}`);
      if (status === 200) assertCompleted(videoUrl);
      else {
        const row = db.prepare('SELECT status,error_msg,local_path FROM video_generations').get();
        assert.equal(row.status, 'failed');
        assert.equal(row.local_path, null);
        assert.match(row.error_msg, /成片鉴权下载失败/);
        assert.equal(db.prepare('SELECT status FROM async_tasks').get().status, 'failed');
      }
    });
  }
});
