const fs = require('node:fs');
const MAX_HEADER = 16 * 1024 * 1024;
function headerLength(prefix, totalSize) {
  if (!Buffer.isBuffer(prefix) || prefix.length !== 8 || !Number.isSafeInteger(totalSize) || totalSize < 10) throw new Error('latent_invalid_safetensors');
  const length = Number(prefix.readBigUInt64LE());
  if (!Number.isSafeInteger(length) || length < 2 || length > MAX_HEADER || 8 + length > totalSize) throw new Error('latent_invalid_safetensors');
  return length;
}
function validateHeader(header, totalSize) {
  let value;
  try { value = JSON.parse(header.toString('utf8')); } catch (_) { throw new Error('latent_invalid_safetensors'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('latent_invalid_safetensors');
  const sizes = { BOOL: 1, U8: 1, I8: 1, U16: 2, I16: 2, F16: 2, BF16: 2, U32: 4, I32: 4, F32: 4, U64: 8, I64: 8, F64: 8, F8_E4M3: 1, F8_E5M2: 1, F8_E8M0: 1 };
  const tensors = Object.entries(value).filter(([name]) => name !== '__metadata__');
  if (!tensors.length) throw new Error('latent_invalid_safetensors');
  const ranges = [];
  for (const [, tensor] of tensors) {
    if (!tensor || !Array.isArray(tensor.shape) || tensor.shape.length > 64 || tensor.shape.some(n => !Number.isSafeInteger(n) || n < 0) || !sizes[tensor.dtype]) throw new Error('latent_invalid_safetensors');
    const bytes = tensor.shape.reduce((n, size) => n * size, sizes[tensor.dtype]);
    const offsets = tensor.data_offsets;
    if (!Number.isSafeInteger(bytes) || !Array.isArray(offsets) || offsets.length !== 2 || offsets.some(n => !Number.isSafeInteger(n) || n < 0) || offsets[1] - offsets[0] !== bytes) throw new Error('latent_invalid_safetensors');
    ranges.push(offsets);
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let end = 0;
  for (const range of ranges) { if (range[0] !== end) throw new Error('latent_invalid_safetensors'); end = range[1]; }
  if (8 + header.length + end !== totalSize) throw new Error('latent_invalid_safetensors');
  return { structure_verified: true, loadability_verified: false,
    verification_note: 'Safetensors header, offsets and task provenance verified; tensor semantics and GPU loader execution are unverified.' };
}
function inspectFile(filename) {
  const fd = fs.openSync(filename, 'r');
  try {
    const total = fs.fstatSync(fd).size, prefix = Buffer.alloc(8);
    if (fs.readSync(fd, prefix, 0, 8, 0) !== 8) throw new Error('latent_invalid_safetensors');
    const length = headerLength(prefix, total), header = Buffer.alloc(length);
    if (fs.readSync(fd, header, 0, length, 8) !== length) throw new Error('latent_invalid_safetensors');
    return validateHeader(header, total);
  } finally { fs.closeSync(fd); }
}
async function readResponseBytes(response, count) {
  if (!response.ok || !response.body || /json|html/i.test(response.headers.get('content-type') || '')) throw new Error('latent_invalid_response');
  const reader = response.body.getReader(), chunks = [];
  let remaining = count;
  try {
    while (remaining > 0) {
      const { value, done } = await reader.read();
      if (done) throw new Error('latent_truncated_response');
      const part = Buffer.from(value).subarray(0, remaining);
      chunks.push(part); remaining -= part.length;
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel(); }
}
async function inspectRemote(request) {
  const first = await request('bytes=0-7');
  const range = /^bytes\s+0-\d+\/(\d+)$/i.exec(first.headers.get('content-range') || '');
  const total = range ? Number(range[1]) : first.status === 200 ? Number(first.headers.get('content-length')) : NaN;
  const prefix = await readResponseBytes(first, 8);
  const length = headerLength(prefix, total);
  // Request a bounded prefix; a server ignoring Range is streamed only until this boundary.
  const second = await request(`bytes=0-${7 + length}`);
  const bytes = await readResponseBytes(second, 8 + length);
  if (!bytes.subarray(0, 8).equals(prefix)) throw new Error('latent_changed_during_verification');
  return validateHeader(bytes.subarray(8), total);
}
module.exports = { inspectFile, inspectRemote, headerLength, validateHeader };
