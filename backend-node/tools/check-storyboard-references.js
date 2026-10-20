#!/usr/bin/env node
'use strict';

// Read-only database inspection by default. --capture-only makes zero upstream requests.
// --run makes up to three image requests; --case <id> limits it to one business-path case.
// --run --edits-only probes one multipart edit directly.
// --reuse-control <image> reduces the normal run to its two reference-image cases.
// No application records are inserted or updated; credentials stay in memory.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { once } = require('node:events');
const Database = require('better-sqlite3');
const sharp = require('sharp');
const { loadConfig } = require('../src/config');
const imageClient = require('../src/services/imageClient');
const { postBodyWithTimeout } = require('../src/services/aiClient');

const backendRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
function option(name, fallback) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
}
const run = args.includes('--run');
const captureOnly = args.includes('--capture-only');
const editsOnly = args.includes('--edits-only');
const reuseControl = option('--reuse-control', null);
const caseId = option('--case', null);
if (caseId && !['01-text-only', '02-character-reference', '03-marker-reference'].includes(caseId)) throw new Error('Unknown diagnostic case');
const requestLimit = caseId ? 1 : reuseControl ? 2 : 3;
const dramaId = Number(option('--drama', '1'));
const characterName = option('--character', '徐牧');
const outputDir = path.resolve(option('--output', path.join(backendRoot, 'node_modules', '.cache', 'image-reference-check', new Date().toISOString().replace(/[:.]/g, '-'))));
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const writeJson = (name, value) => fs.writeFileSync(path.join(outputDir, name), JSON.stringify(value, null, 2) + '\n');
const configuration = loadConfig();
const databasePath = path.resolve(backendRoot, configuration.database?.path || 'data/drama_generator.db');
const storagePath = path.resolve(backendRoot, configuration.storage?.local_path || 'data/storage');
const filesBaseUrl = String(configuration.storage?.base_url || '').replace(/\/$/, '');

function safeError(error) {
  // Avoid returning gateway response bodies or credential-bearing URLs.
  return String(error?.message || error).replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]').replace(/https?:\/\/[^\s]+/g, '[URL]').slice(0, 300);
}
function localFile(value) {
  if (!value) return null;
  let relative = String(value);
  if (/^https?:\/\//i.test(relative)) {
    const at = relative.indexOf('/static/');
    if (at < 0) return null;
    relative = relative.slice(at + '/static/'.length).split('?')[0];
  }
  relative = relative.replace(/^\/?static\//, '').replace(/^[/\\]+/, '');
  const absolute = path.resolve(storagePath, relative);
  if (!absolute.startsWith(storagePath + path.sep)) return null;
  return fs.existsSync(absolute) ? absolute : null;
}
async function downloadImage(value) {
  if (value.startsWith('data:')) {
    const match = value.match(/^data:([^;,]+);base64,([\s\S]+)$/);
    if (!match) throw new Error('Unexpected inline image format');
    return Buffer.from(match[2], 'base64');
  }
  const target = new URL(value);
  return new Promise((resolve, reject) => {
    const request = (target.protocol === 'https:' ? https : http).get(target, { family: 4, timeout: 90000 }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        resolve(downloadImage(new URL(response.headers.location, target).toString()));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error('Image download HTTP ' + response.statusCode));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 40 * 1024 * 1024) response.destroy(new Error('Image exceeds 40MB'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    request.on('timeout', () => request.destroy(new Error('Image download timed out')));
    request.on('error', reject);
  });
}

async function probeEdits({ selected, upstreamUrl, model, markerFile, marker }) {
  const target = new URL(upstreamUrl);
  if (!/\/images\/generations\/?$/.test(target.pathname)) throw new Error('Cannot infer a standard image edits endpoint');
  target.pathname = target.pathname.replace(/\/images\/generations\/?$/, '/images/edits');
  const image = fs.readFileSync(markerFile);
  const prompt = 'Recreate the attached reference image as faithfully as possible. Preserve its exact arrangement of shapes, fill colors, printed text and background. Flat geometric test card, no new objects or decorative details. Do not invent any details. If no reference image is attached, render one plain gray square on a white background.';
  if (prompt.includes(marker)) throw new Error('Marker leaked into the prompt');
  const form = new FormData();
  form.set('model', model);
  form.set('prompt', prompt);
  form.set('n', '1');
  form.set('size', '1024x1024');
  form.set('image', new Blob([image], { type: 'image/png' }), 'reference.png');
  const encoded = new Request('http://127.0.0.1/encode-only', { method: 'POST', body: form });
  const bytes = Buffer.from(await encoded.arrayBuffer());
  if (!bytes.includes(image)) throw new Error('Multipart body does not contain the original reference bytes');
  const audit = {
    case: '04-standard-image-edits', endpoint: target.pathname, model,
    encoding: 'multipart/form-data', fields: ['model', 'prompt', 'n', 'size', 'image'],
    prompt, referenceCount: 1, referenceBytesVerified: true,
    references: [{ bytes: image.length, sha256: sha256(image), mimeType: 'image/png' }],
    requestBytes: bytes.length,
  };
  writeJson('requests.redacted.json', [audit]);
  console.log('START standard multipart image edits: one upstream request, no retries');
  const started = Date.now();
  const reply = await new Promise((resolve, reject) => {
    const request = (target.protocol === 'https:' ? https : http).request(target, {
      method: 'POST', family: 4, timeout: 420000,
      headers: { Authorization: 'Bearer ' + selected.api_key, 'Content-Type': encoded.headers.get('content-type'), 'Content-Length': bytes.length },
    }, (response) => {
      const chunks = [];
      let received = 0;
      response.on('data', (chunk) => {
        received += chunk.length;
        if (received > 40 * 1024 * 1024) response.destroy(new Error('Edit response exceeds 40MB'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('timeout', () => request.destroy(new Error('Edit request timed out')));
    request.on('error', reject);
    request.end(bytes);
  });
  audit.httpStatus = reply.status;
  audit.elapsedMs = Date.now() - started;
  let payload;
  try { payload = JSON.parse(reply.text); } catch { throw new Error('Edit response is not JSON, HTTP ' + reply.status); }
  audit.responseFields = Object.keys(payload);
  audit.usage = payload.usage || null;
  if (reply.status < 200 || reply.status >= 300) audit.error = safeError(payload.error?.message || 'HTTP ' + reply.status);
  writeJson('requests.redacted.json', [audit]);
  if (audit.error) throw new Error('Image edits failed: ' + audit.error);
  const item = payload.data?.[0];
  const output = item?.b64_json ? 'data:image/png;base64,' + item.b64_json : item?.url;
  if (!output) throw new Error('Image edits returned no image');
  const result = await downloadImage(output);
  const filename = '04-standard-image-edits.png';
  await sharp(result).png().toFile(path.join(outputDir, filename));
  const metadata = await sharp(result).metadata();
  writeJson('results.json', { results: [{ id: audit.case, status: 'generated', filename, width: metadata.width, height: metadata.height, sha256: sha256(result) }] });
  console.log('DONE standard image edits: ' + filename + ', ' + metadata.width + 'x' + metadata.height);
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  let selected;
  let rawConfig;
  let schema;
  let character;
  try {
    db.pragma('query_only = ON');
    selected = imageClient.getDefaultImageConfig(db, undefined, undefined, 'storyboard_image', { readOnly: true });
    if (!selected) throw new Error('No active storyboard image configuration');
    rawConfig = db.prepare('SELECT * FROM ai_service_configs WHERE id = ?').get(selected.id);
    schema = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'ai_service_configs'").get().sql;
    character = db.prepare('SELECT id, name, image_url, local_path FROM characters WHERE drama_id = ? AND name = ? AND deleted_at IS NULL ORDER BY id LIMIT 1').get(dramaId, characterName);
    if (!character) throw new Error('Requested character was not found');
  } finally {
    db.close();
  }
  const characterFile = localFile(character.local_path) || localFile(character.image_url);
  if (!characterFile) throw new Error('The selected character has no readable local reference image');
  const originalEndpoint = selected.endpoint || '/images/generations';
  const upstreamUrl = selected.base_url.replace(/\/$/, '') + (originalEndpoint.startsWith('/') ? originalEndpoint : '/' + originalEndpoint);
  if (!selected.api_protocol && !['openai', 'sub2api', 'chatfire'].includes(String(selected.provider).toLowerCase())) {
    throw new Error('Set an explicit OpenAI-compatible api_protocol before using this diagnostic');
  }
  const protocol = selected.api_protocol || 'openai';
  if (protocol !== 'openai') throw new Error('This diagnostic is scoped to the OpenAI-compatible path; selected protocol is ' + protocol);
  const model = imageClient.getModelFromConfig(selected);
  const marker = crypto.randomBytes(3).toString('hex').toUpperCase();
  const referenceBytes = fs.readFileSync(characterFile);
  const referenceMeta = await sharp(referenceBytes).metadata();
  const referenceCopy = 'reference-character' + ({ jpeg: '.jpg', png: '.png', webp: '.webp' }[referenceMeta.format] || '.png');
  fs.writeFileSync(path.join(outputDir, referenceCopy), referenceBytes);
  const markerSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="#ffffff"/><rect x="80" y="80" width="380" height="380" rx="12" fill="#fb00bb"/><circle cx="745" cy="270" r="190" fill="#00bce8"/><path d="M270 535 L75 910 L465 910 Z" fill="#f5c400"/><rect x="560" y="570" width="390" height="340" fill="#1845ca"/><text x="512" y="995" text-anchor="middle" fill="#111111" font-family="Arial" font-size="72" font-weight="bold">${marker}</text></svg>`;
  const markerFile = path.join(outputDir, 'reference-marker.png');
  await sharp(Buffer.from(markerSvg)).png().toFile(markerFile);
  const description = {
    configuration: selected.name,
    provider: selected.provider,
    protocol,
    endpoint: editsOnly ? new URL(upstreamUrl).pathname.replace(/\/images\/generations\/?$/, '/images/edits') : new URL(upstreamUrl).pathname,
    model,
    character: { id: character.id, name: character.name, width: referenceMeta.width, height: referenceMeta.height, sha256: sha256(referenceBytes) },
    referenceMarker: marker,
    maximumGenerationRequests: run ? (editsOnly ? 1 : requestLimit) : 0,
    liveGenerationEnabled: run,
    captureOnly,
    editsOnly,
    caseId,
    usesBusinessImageClient: !editsOnly,
    databaseReadOnly: true,
    credentialsSaved: false,
  };
  writeJson('plan.json', description);
  console.log(JSON.stringify({ ...description, outputDir }, null, 2));
  if (!run && !captureOnly) {
    console.log('Inspection only. --capture-only validates request bytes locally; --run enables up to three real requests.');
    return;
  }
  if (run && captureOnly) throw new Error('Choose either --run or --capture-only');
  if (editsOnly) {
    if (!run) throw new Error('Use inspection mode without capture-only for the edit probe');
    await probeEdits({ selected, upstreamUrl, model, markerFile, marker });
    return;
  }

  const placeholder = (await sharp({ create: { width: 2, height: 2, channels: 3, background: '#cccccc' } }).png().toBuffer()).toString('base64');
  const memoryDb = new Database(':memory:');
  memoryDb.exec(schema);
  const requests = [];
  let activeCase = '';
  let totalRequests = 0;
  const relay = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      let received = 0;
      for await (const chunk of request) {
        received += chunk.length;
        if (received > 40 * 1024 * 1024) throw new Error('Test request exceeds 40MB');
        chunks.push(chunk);
      }
      totalRequests++;
      if (totalRequests > requestLimit) throw new Error('Configured request limit reached');
      const rawBody = Buffer.concat(chunks);
      const contentType = String(request.headers['content-type'] || 'application/json');
      const multipart = contentType.startsWith('multipart/form-data;');
      let body;
      let refs;
      let fields;
      if (multipart) {
        const form = await new Request('http://127.0.0.1/parse-only', {
          method: 'POST', headers: { 'Content-Type': contentType }, body: rawBody,
        }).formData();
        body = {};
        refs = [];
        fields = [...new Set(form.keys())];
        for (const [key, value] of form.entries()) {
          if (typeof value === 'string') body[key] = value;
          else if (key === 'image' || key === 'image[]') {
            refs.push({ bytes: Buffer.from(await value.arrayBuffer()), mimeType: value.type });
          }
        }
      } else {
        body = JSON.parse(rawBody.toString('utf8'));
        fields = Object.keys(body);
        refs = (Array.isArray(body.image) ? body.image : []).map(ref => {
          const match = String(ref).match(/^data:([^;,]+);base64,([\s\S]+)$/);
          if (!match) throw new Error('Reference is not embedded as original image bytes');
          return { bytes: Buffer.from(match[2], 'base64'), mimeType: match[1] };
        });
      }
      const expectedReference = activeCase === '02-character-reference' ? referenceBytes : activeCase === '03-marker-reference' ? fs.readFileSync(markerFile) : null;
      if (refs.length !== (expectedReference ? 1 : 0)) throw new Error('Reference count differs from the planned case');
      for (const ref of refs) {
        if (sha256(ref.bytes) !== sha256(expectedReference)) {
          throw new Error('Reference bytes are missing or changed: upstream request blocked');
        }
      }
      if (activeCase === '03-marker-reference' && body.prompt.includes(marker)) throw new Error('Marker leaked into the text prompt');
      const target = new URL(upstreamUrl);
      if (/\/images\/edits\/?$/.test(new URL(request.url, 'http://127.0.0.1').pathname)) {
        target.pathname = target.pathname.replace(/\/images\/generations\/?$/, '/images/edits');
      }
      const record = {
        case: activeCase,
        endpoint: target.pathname,
        encoding: multipart ? 'multipart/form-data' : 'application/json',
        fields,
        model: body.model,
        inputFidelity: body.input_fidelity || null,
        requestBytes: received,
        referenceCount: refs.length,
        references: refs.map(ref => ({ encoding: multipart ? 'file' : 'base64', mimeType: ref.mimeType, bytes: ref.bytes.length, sha256: sha256(ref.bytes) })),
        prompt: body.prompt,
      };
      requests.push(record);
      writeJson('requests.redacted.json', requests);
      if (captureOnly) {
        record.captureOnly = true;
        record.referenceBytesVerified = true;
        writeJson('requests.redacted.json', requests);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ b64_json: placeholder }] }));
        return;
      }
      record.referenceBytesVerified = true;
      const started = Date.now();
      const upstream = await postBodyWithTimeout(target.toString(), {
        Authorization: 'Bearer ' + selected.api_key, 'Content-Type': contentType,
      }, rawBody, 420000);
      record.httpStatus = upstream.statusCode;
      record.elapsedMs = Date.now() - started;
      // Save only status and shape; never persist response bodies containing signed URLs.
      try {
        const value = JSON.parse(upstream.raw);
        record.responseFields = Object.keys(value);
        record.outputCount = Array.isArray(value.data) ? value.data.length : 0;
        record.usage = value.usage || null;
        if (upstream.statusCode >= 400) record.error = safeError(value.error?.message || value.message || 'Upstream rejected request');
      } catch { record.responseFormat = 'non-json'; }
      writeJson('requests.redacted.json', requests);
      response.writeHead(upstream.statusCode, { 'Content-Type': 'application/json' });
      response.end(upstream.raw);
    } catch (error) {
      response.writeHead(502, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: safeError(error) } }));
    }
  });
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  const clonedRow = { ...rawConfig, base_url: `http://127.0.0.1:${relay.address().port}`, is_default: 1 };
  const columns = Object.keys(clonedRow);
  memoryDb.prepare(`INSERT INTO ai_service_configs (${columns.map((key) => '"' + key + '"').join(',')}) VALUES (${columns.map((key) => '@' + key).join(',')})`).run(clonedRow);
  const log = { info() {}, warn() {}, error() {} };
  const portraitPrompt = 'Generate one cinematic photorealistic movie frame of the same main character shown in the supplied reference, crouching inside a rustic wooden cattle shed. He raises his right hand near his face and looks closely at his fingertips. Preserve the reference character\'s face, headwear, hairstyle, clothing, fabric, and accessories. Single continuous scene, natural cinematic light, 16:9 composition, no collage, no split panels, no reference sheet. If no reference image is attached, still draw the scene.';
  const cases = [
    { id: '01-text-only', title: 'Same prompt, no reference', prompt: portraitPrompt, size: '1536x1024', references: [] },
    { id: '02-character-reference', title: 'Same prompt, actual character reference', prompt: portraitPrompt, size: '1536x1024', references: [characterFile] },
    { id: '03-marker-reference', title: 'Image-only colors and random code', prompt: 'Recreate the attached reference image as faithfully as possible. Preserve its exact arrangement of shapes, fill colors, printed text and background. Flat geometric test card, no new objects or decorative details. Do not invent any details. If no reference image is attached, render one plain gray square on a white background.', size: '1024x1024', references: [markerFile] },
  ];
  const results = [];
  if (reuseControl) {
    const controlBytes = fs.readFileSync(path.resolve(reuseControl));
    const metadata = await sharp(controlBytes).metadata();
    const filename = '01-text-only.png';
    await sharp(controlBytes).png().toFile(path.join(outputDir, filename));
    results.push({ id: '01-text-only', status: 'reused', filename, width: metadata.width, height: metadata.height, sha256: sha256(controlBytes) });
  }
  try {
    for (const item of cases.filter(item => (!reuseControl || item.id !== '01-text-only') && (!caseId || item.id === caseId))) {
      activeCase = item.id;
      console.log('START ' + item.id + ': ' + item.title);
      const started = Date.now();
      try {
        const result = await imageClient.callImageApi(memoryDb, log, {
          prompt: item.prompt,
          model,
          size: item.size,
          image_gen_id: item.id,
          imageServiceType: selected.service_type,
          ...(item.id === '02-character-reference' ? {
            system_prompt: `Image 1: character appearance (${character.name}), the same face, hair, headwear and costume`,
            frame_identity_lock: true,
          } : {}),
          reference_image_urls: item.references.map((absolute) => path.relative(storagePath, absolute).split(path.sep).join('/')),
          files_base_url: filesBaseUrl,
          storage_local_path: storagePath,
        });
        if (result.error) throw new Error(result.error);
        if (!result.image_url) throw new Error('No generated image returned');
        const bytes = await downloadImage(result.image_url);
        const metadata = await sharp(bytes).metadata();
        const filename = item.id + '.png';
        await sharp(bytes).png().toFile(path.join(outputDir, filename));
        results.push({ id: item.id, status: captureOnly ? 'captured' : 'generated', filename, elapsedMs: Date.now() - started, width: metadata.width, height: metadata.height, sha256: sha256(bytes) });
        console.log('DONE ' + item.id + ': ' + filename + ', ' + metadata.width + 'x' + metadata.height);
      } catch (error) {
        results.push({ id: item.id, status: 'failed', elapsedMs: Date.now() - started, error: safeError(error) });
        console.log('FAILED ' + item.id + ': ' + safeError(error));
      }
      writeJson('results.json', { ...description, results });
    }
  } finally {
    relay.closeAllConnections();
    await new Promise((resolve) => relay.close(resolve));
    memoryDb.close();
  }
  const frames = [
    { file: referenceCopy, label: 'ACTUAL CHARACTER REFERENCE' },
    ...results.filter((r) => r.status === 'generated' || r.status === 'reused').map((r) => ({ file: r.filename, label: r.id.toUpperCase() })),
    ...(!caseId || caseId === '03-marker-reference' ? [{ file: 'reference-marker.png', label: 'MARKER REFERENCE (IMAGE ONLY)' }] : []),
  ];
  const cellWidth = 640;
  const cellHeight = 450;
  const composites = [];
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    const x = (index % 2) * cellWidth;
    const y = Math.floor(index / 2) * cellHeight;
    composites.push({ input: await sharp(path.join(outputDir, frame.file)).resize(cellWidth - 20, cellHeight - 55, { fit: 'contain', background: '#f0f0f0' }).png().toBuffer(), left: x + 10, top: y + 45 });
    const label = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="40"><text x="12" y="27" font-family="Arial" font-size="20" fill="#111111">${frame.label}</text></svg>`;
    composites.push({ input: Buffer.from(label), left: x, top: y });
  }
  await sharp({ create: { width: cellWidth * 2, height: cellHeight * Math.ceil(frames.length / 2), channels: 3, background: '#ffffff' } }).composite(composites).jpeg({ quality: 92 }).toFile(path.join(outputDir, 'comparison.jpg'));
  console.log('Completed ' + totalRequests + (captureOnly ? ' local captures; zero upstream requests.' : ' bounded upstream requests.') + ' Review comparison.jpg and requests.redacted.json.');
  if (results.some((r) => r.status === 'failed')) process.exitCode = 1;
}
main().catch((error) => { console.error(safeError(error)); process.exitCode = 1; });
