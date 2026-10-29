const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createWriteStream } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { getFfmpegPath, getFfprobePath } = require('../utils/ffmpegPath');
const { canonicalFile, within } = require('./videoExecutionLatent');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('media_process_timeout')); }, 300000);
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-1048576); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`media_process_failed_${code}: ${stderr.slice(-300)}`)); });
  });
}
async function preparePath(snapshot, id) {
  if (!snapshot.storage_local_path) throw new Error('video_storage_not_configured');
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('invalid_media_id');
  const root = await fs.realpath(snapshot.storage_local_path);
  const dir = path.join(root, 'video-plans');
  await fs.mkdir(dir, { recursive: true });
  const realDir = await fs.realpath(dir);
  if (!within(root, realDir) || path.relative(dir, realDir) !== '') throw new Error('video_storage_outside_root');
  const relative = `video-plans/${id}.mp4`;
  return { absolute: path.join(realDir, `${id}.mp4`), relative,
    video_url: `${String(snapshot.files_base_url || '/static').replace(/\/+$/, '')}/${relative}` };
}
function createExecutionMedia({ fetch: fetcher = (...args) => fetch(...args), runProcess = run } = {}) {
  async function probe(filename) {
    const raw = await runProcess(getFfprobePath(), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filename]);
    const data = JSON.parse(raw);
    const video = data.streams?.find(s => s.codec_type === 'video');
    const duration = Number(data.format?.duration || video?.duration);
    if (!video || !Number.isFinite(duration) || duration <= 0 || !(Number(video.width) > 0) || !(Number(video.height) > 0)) throw new Error('output_not_playable_video');
    return { duration, width: Number(video.width), height: Number(video.height), audio: data.streams.some(s => s.codec_type === 'audio') };
  }
  async function existing(snapshot, target) {
    try { await fs.lstat(target.absolute); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const metadata = await probe(canonicalFile(snapshot.storage_local_path, target.relative));
    return { video_url: target.video_url, local_path: target.relative, duration: metadata.duration };
  }
  return {
    async materialize(snapshot, node, result, segmentId) {
      const target = await preparePath(snapshot, segmentId);
      // Retries after a media-only crash reuse a verified local result, never submit GPU work again.
      const cached = await existing(snapshot, target);
      if (cached) return cached;
      const url = new URL(String(result.video_url || ''));
      const base = new URL(snapshot.base_url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== base.origin ||
          url.pathname !== base.pathname.replace(/\/+$/, '') + '/view') throw new Error('video_output_origin_mismatch');
      const response = await fetcher(url.toString(), {
        redirect: 'error', signal: AbortSignal.timeout(300000),
        headers: snapshot.api_key ? { Authorization: snapshot.api_key.startsWith('Bearer ') ? snapshot.api_key : `Bearer ${snapshot.api_key}` } : {},
      });
      if (!response.ok || !response.body) throw new Error('video_download_failed');
      const temp = target.absolute + '.' + randomUUID() + '.part';
      let size = 0;
      const limit = new Transform({ transform(chunk, encoding, callback) {
        size += chunk.length; callback(size > 1024 * 1024 * 1024 ? new Error('video_download_too_large') : null, chunk);
      } });
      try {
        await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(temp, { flags: 'wx' }));
        const metadata = await probe(temp);
        await fs.link(temp, target.absolute); // Atomic publish; never replace an existing immutable result.
        return { video_url: target.video_url, local_path: target.relative, duration: metadata.duration };
      } finally { await fs.rm(temp, { force: true }); }
    },
    async compose(snapshot, segments, versionId) {
      if (!segments.length) throw new Error('empty_version');
      if (segments.length === 1) return { video_url: segments[0].video_url, local_path: segments[0].local_path, duration: segments[0].duration };
      const target = await preparePath(snapshot, versionId);
      const cached = await existing(snapshot, target);
      if (cached) return cached;
      const files = segments.map(segment => canonicalFile(snapshot.storage_local_path, segment.local_path));
      const metadata = await Promise.all(files.map(probe));
      const width = Math.ceil(metadata[0].width / 2) * 2, height = Math.ceil(metadata[0].height / 2) * 2;
      const args = ['-nostdin', '-v', 'error', '-n'];
      files.forEach(file => args.push('-i', file));
      const filters = metadata.flatMap((m, i) => [
        `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,setpts=PTS-STARTPTS[v${i}]`,
        m.audio ? `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${m.duration},asetpts=PTS-STARTPTS[a${i}]`
          : `anullsrc=r=48000:cl=stereo,atrim=duration=${m.duration},asetpts=PTS-STARTPTS[a${i}]`,
      ]);
      filters.push(metadata.map((_, i) => `[v${i}][a${i}]`).join('') + `concat=n=${metadata.length}:v=1:a=1[v][a]`);
      const temp = target.absolute + '.' + randomUUID() + '.part.mp4';
      args.push('-filter_complex', filters.join(';'), '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', temp);
      try {
        await runProcess(getFfmpegPath(), args);
        const output = await probe(temp);
        const expected = metadata.reduce((sum, m) => sum + m.duration, 0);
        if (Math.abs(expected - output.duration) > Math.max(1, expected * .05)) throw new Error('composed_duration_mismatch');
        await fs.link(temp, target.absolute); // Atomic publish; never replace an existing immutable result.
        return { video_url: target.video_url, local_path: target.relative, duration: output.duration };
      } finally { await fs.rm(temp, { force: true }); }
    },
  };
}
module.exports = { createExecutionMedia };
