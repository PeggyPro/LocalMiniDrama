const http = require('http');
const https = require('https');

const MAX_REFERENCE_BYTES = 50 * 1024 * 1024;
const REFERENCE_TIMEOUT_MS = 60000;

/** Only standard GPT Image routes are changed automatically; custom APIs retain their contract. */
function getOpenAIImageEditUrl(url, model) {
  const target = new URL(url);
  if (/\/images\/edits\/?$/.test(target.pathname)) return target.toString();
  if (!/^gpt-image(?:[-_.]|$)/i.test(String(model || ''))) return null;
  if (!/\/images\/generations\/?$/.test(target.pathname)) return null;
  target.pathname = target.pathname.replace(/\/images\/generations\/?$/, '/images/edits');
  return target.toString();
}

function identifyImage(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { mimeType: 'image/webp', extension: 'webp' };
  }
  throw new Error('参考图格式无效，请使用 PNG、JPEG 或 WebP 图片');
}

function downloadReference(url, redirects = 3) {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('参考图地址必须为 HTTP 或 HTTPS');
  return new Promise((resolve, reject) => {
    const request = (target.protocol === 'https:' ? https : http).get(target, { family: 4 }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        clearTimeout(timer);
        response.resume();
        if (!response.headers.location || redirects <= 0) return reject(new Error('参考图重定向次数过多或地址无效'));
        try {
          resolve(downloadReference(new URL(response.headers.location, target).toString(), redirects - 1));
        } catch (error) { reject(error); }
        return;
      }
      if (response.statusCode !== 200) {
        clearTimeout(timer);
        response.resume();
        reject(new Error('参考图下载失败，HTTP ' + response.statusCode));
        return;
      }
      const chunks = [];
      let length = 0;
      response.on('data', (chunk) => {
        length += chunk.length;
        if (length > MAX_REFERENCE_BYTES) response.destroy(new Error('单张参考图不能超过 50MB'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks));
      });
      response.on('error', (error) => { clearTimeout(timer); reject(error); });
    });
    const timer = setTimeout(() => request.destroy(new Error('参考图下载超时，请检查图片地址')), REFERENCE_TIMEOUT_MS);
    request.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

async function referenceBytes(ref) {
  const value = String(ref || '').trim();
  const inline = value.match(/^data:image\/[^;,]+;base64,([\s\S]+)$/i);
  let buffer;
  if (inline) {
    const encoded = inline[1].replace(/\s/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('参考图 Base64 编码无效');
    if (encoded.length > Math.ceil(MAX_REFERENCE_BYTES / 3) * 4) throw new Error('单张参考图不能超过 50MB');
    buffer = Buffer.from(encoded, 'base64');
  } else if (/^https?:\/\//i.test(value)) {
    buffer = await downloadReference(value);
  } else {
    throw new Error('无法读取参考图，请检查本地图片文件或图片地址');
  }
  if (!buffer.length) throw new Error('参考图内容为空');
  if (buffer.length > MAX_REFERENCE_BYTES) throw new Error('单张参考图不能超过 50MB');
  return { buffer, ...identifyImage(buffer) };
}

/** Prepare exact multipart bytes before submitting; a failed reference never becomes a text-only request. */
async function buildOpenAIImageEditRequest(fields, references) {
  if (!references.length) throw new Error('图片编辑需要至少一张参考图');
  const form = new FormData();
  for (const key of ['model', 'prompt', 'n', 'size', 'quality']) {
    if (fields[key] != null && fields[key] !== '') form.set(key, String(fields[key]));
  }
  // GPT Image uses the image's identity/details rather than only its broad visual style.
  if (/^gpt-image(?:[-_.]|$)/i.test(String(fields.model || '')) && !/mini/i.test(String(fields.model))) {
    form.set('input_fidelity', 'high');
  }
  if (fields.negative_prompt) {
    form.set('prompt', String(fields.prompt || '') + '\n\nAvoid: ' + fields.negative_prompt);
  }
  for (let index = 0; index < references.length; index++) {
    let image;
    try { image = await referenceBytes(references[index]); }
    catch (error) { throw new Error(`第 ${index + 1} 张参考图无法上传：${error.message}`); }
    // Single file follows standard image; multiple files retain their numbered reference order.
    form.append(references.length === 1 ? 'image' : 'image[]',
      new Blob([image.buffer], { type: image.mimeType }), `reference-${index + 1}.${image.extension}`);
  }
  // Request only serializes FormData here. Network I/O uses Node http(s), like other image APIs.
  const encoded = new Request('http://127.0.0.1/encode-only', { method: 'POST', body: form });
  return {
    body: Buffer.from(await encoded.arrayBuffer()),
    contentType: encoded.headers.get('content-type'),
  };
}

module.exports = { getOpenAIImageEditUrl, buildOpenAIImageEditRequest };
