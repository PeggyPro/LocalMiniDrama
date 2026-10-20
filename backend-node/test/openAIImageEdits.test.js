const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { callImageApi } = require('../src/services/imageClient');

const log = { info() {}, warn() {}, error() {} };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nDDcAAAAASUVORK5CYII=', 'base64');
const otherPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const dataImage = 'data:image/png;base64,' + png.toString('base64');

async function fixture(t, config = {}, response = {}) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE ai_service_configs (
    id INTEGER PRIMARY KEY, service_type TEXT, provider TEXT, api_protocol TEXT,
    name TEXT, base_url TEXT, api_key TEXT, model TEXT, default_model TEXT,
    endpoint TEXT, query_endpoint TEXT, priority INTEGER, is_default INTEGER,
    is_active INTEGER, settings TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT
  )`);
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'image-edit-request-'));
  fs.mkdirSync(path.join(storage, 'characters'));
  fs.writeFileSync(path.join(storage, 'characters', 'main.png'), png);
  t.after(() => fs.rmSync(storage, { recursive: true, force: true }));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET') {
        if (req.url === '/redirect.png') {
          res.writeHead(302, { Location: '/reference.png' });
          return res.end();
        }
        if (req.url === '/reference.png') {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          return res.end(otherPng);
        }
        res.writeHead(404);
        return res.end('missing');
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const record = { path: req.url, headers: req.headers, bytes: raw.length, fields: {}, files: [] };
      if (String(req.headers['content-type']).startsWith('multipart/form-data;')) {
        const form = await new Request('http://127.0.0.1/parse-only', {
          method: 'POST', headers: { 'Content-Type': req.headers['content-type'] }, body: raw,
        }).formData();
        for (const [key, value] of form.entries()) {
          if (typeof value === 'string') record.fields[key] = value;
          else record.files.push({ key, name: value.name, type: value.type, bytes: Buffer.from(await value.arrayBuffer()) });
        }
      } else {
        record.fields = JSON.parse(raw.toString('utf8'));
      }
      requests.push(record);
      res.writeHead(response.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response.body || { data: [{ b64_json: png.toString('base64') }] }));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const model = config.model || 'gpt-image-2.5-sunburst';
  db.prepare(`INSERT INTO ai_service_configs (id,service_type,provider,api_protocol,name,base_url,api_key,model,default_model,endpoint,priority,is_default,is_active,settings,created_at)
    VALUES (1,'storyboard_image',?,?,?,?,'test-key',?,?,?,0,1,1,'{}','2026-01-01')`).run(
    config.provider || 'openai', config.protocol || 'openai', 'isolated test', base + '/v1',
    JSON.stringify([model]), model, config.endpoint || '/images/generations');
  const generate = (options = {}) => callImageApi(db, log, {
    imageServiceType: 'storyboard_image', prompt: 'A continuous storyboard shot.',
    size: '1024x1024', storage_local_path: storage, files_base_url: base + '/static', ...options,
  });
  return { generate, requests, base, storage };
}

test('GPT Image without references keeps JSON text-to-image and parses b64 output', async t => {
  const { generate, requests } = await fixture(t);
  assert.equal((await generate()).image_url, dataImage);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/v1/images/generations');
  assert.equal(requests[0].headers['content-type'], 'application/json');
  assert.equal(requests[0].fields.n, 1);
  assert.equal('image' in requests[0].fields, false);
  assert.equal('input_fidelity' in requests[0].fields, false);
});

test('actual local character bytes reach edits multipart with identity and negative aliases', async t => {
  const { generate, requests } = await fixture(t, { endpoint: '/images/generations?region=kept' });
  const result = await generate({
    reference_image_urls: ['characters/main.png'],
    system_prompt: 'Image 1: character appearance (Xu Mu), use the same face and costume',
    frame_identity_lock: true, negative_prompt: 'wrong person', user_negative_prompt: 'different costume',
  });
  assert.equal(result.image_url, dataImage);
  assert.equal(requests.length, 1);
  const req = requests[0];
  assert.equal(req.path, '/v1/images/edits?region=kept');
  assert.match(req.headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.equal(Number(req.headers['content-length']), req.bytes);
  assert.equal(req.headers.authorization, 'Bearer test-key');
  assert.deepEqual(req.files.map(file => file.key), ['image']);
  assert.deepEqual(req.files[0].bytes, png);
  assert.equal(req.files[0].type, 'image/png');
  assert.equal(req.fields.input_fidelity, 'high');
  assert.equal(req.fields.n, '1');
  assert.equal(req.fields.size, '1024x1024');
  assert.match(req.fields.prompt, /CHARACTER IDENTITY LOCK/);
  assert.match(req.fields.prompt, /reference images take priority/);
  assert.match(req.fields.prompt, /Avoid:.*different costume.*wrong person/);
  assert.equal('negative_prompt' in req.fields, false); // unsupported edit field is represented as instructions
});

test('multiple actual files preserve layout/scene/character order and distinct guidance', async t => {
  const { generate, requests, base } = await fixture(t);
  const result = await generate({
    reference_image_urls: [dataImage, base + '/reference.png', '/static/characters/main.png'],
    frame_identity_lock: true,
    system_prompt: 'Image 1: LAYOUT_LOCK: first frame composition\nImage 2: scene background\nImage 3: character appearance (Xu Mu)',
  });
  assert.equal(result.image_url, dataImage);
  const req = requests[0];
  assert.deepEqual(req.files.map(file => file.key), ['image[]', 'image[]', 'image[]']);
  assert.deepEqual(req.files.map(file => file.bytes), [png, otherPng, png]);
  assert.deepEqual(req.files.map(file => file.name), ['reference-1.png', 'reference-2.png', 'reference-3.png']);
  const layoutLine = req.fields.prompt.split('\n').find(line => line.includes('Image 1:'));
  assert.match(layoutLine, /PRESERVE its camera, composition, character positions/);
  assert.doesNotMatch(layoutLine, /DO NOT copy/);
  assert.match(req.fields.prompt, /Image 3:.*use its depicted appearance, DO NOT copy its layout/);
});

test('unreadable local reference returns an error without sending any generation request', async t => {
  const { generate, requests } = await fixture(t);
  const result = await generate({ reference_image_urls: ['characters/missing.png'] });
  assert.match(result.error, /第 1 张参考图无法上传.*HTTP 404/);
  assert.equal(requests.length, 0);
});

test('a malformed second reference fails the whole request instead of silently dropping identity', async t => {
  const { generate, requests } = await fixture(t);
  const result = await generate({ reference_image_urls: [dataImage, 'data:image/png;base64,bm90IGFuIGltYWdl'] });
  assert.match(result.error, /第 2 张参考图无法上传.*格式无效/);
  assert.equal(requests.length, 0);
});

test('public reference redirects download bytes before the edit request', async t => {
  const { generate, requests, base } = await fixture(t);
  assert.equal((await generate({ reference_image_urls: [base + '/redirect.png'] })).image_url, dataImage);
  assert.deepEqual(requests[0].files[0].bytes, otherPng);
});

test('edits upstream failure is reported once without paid text-only fallback', async t => {
  const { generate, requests } = await fixture(t, {}, { status: 400, body: { error: { message: 'unsupported image' } } });
  const result = await generate({ reference_image_urls: [dataImage] });
  assert.match(result.error, /400 - unsupported image/);
  assert.deepEqual(requests.map(req => req.path), ['/v1/images/edits']);
});

for (const entry of [
  { name: 'custom GPT endpoint', config: { endpoint: '/custom/render' }, expectedPath: '/v1/custom/render' },
  { name: 'non-GPT compatible model', config: { model: 'custom-flux-model' }, expectedPath: '/v1/images/generations' },
  { name: 'Agnes provider', config: { provider: 'agnes', model: 'agnes-image-2.5-flash' }, agnes: true, expectedPath: '/v1/images/generations' },
  { name: 'Seedream provider', config: { provider: 'volcengine', protocol: 'volcengine', model: 'doubao-seedream-4-5' }, seedream: true, expectedPath: '/v1/images/generations' },
]) {
  test(`${entry.name} retains its existing JSON contract`, async t => {
    const { generate, requests } = await fixture(t, entry.config);
    assert.equal((await generate({ reference_image_urls: [dataImage] })).image_url, dataImage);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, entry.expectedPath);
    assert.equal(requests[0].headers['content-type'], 'application/json');
    assert.deepEqual(entry.agnes ? requests[0].fields.extra_body.image : requests[0].fields.image, [dataImage]);
    if (entry.agnes || entry.seedream) assert.equal('n' in requests[0].fields, false);
    if (entry.seedream) assert.equal(requests[0].fields.watermark, false);
  });
}

test('an explicitly configured edits endpoint uses multipart too', async t => {
  const { generate, requests } = await fixture(t, { endpoint: '/images/edits' });
  assert.equal((await generate({ reference_image_urls: [dataImage] })).image_url, dataImage);
  assert.equal(requests[0].path, '/v1/images/edits');
  assert.deepEqual(requests[0].files[0].bytes, png);
});
