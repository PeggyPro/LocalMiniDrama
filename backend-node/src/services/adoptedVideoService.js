'use strict';

const fs = require('fs');
const path = require('path');

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function selectionError(message) {
  return Object.assign(new Error(message), { statusCode: 409, code: 'INVALID_VIDEO_ADOPTION' });
}
function mediaUrl(videoUrl, localPath, baseUrl = '') {
  if (localPath) {
    if (path.isAbsolute(localPath) || !baseUrl) return localPath;
    return `${baseUrl.replace(/\/$/, '')}/${localPath.replace(/^\/+/, '')}`;
  }
  return videoUrl || null;
}

/** Read only: an adopted immutable version wins; completion time never selects a video. */
function resolveAdoptedVideo(db, storyboardId, { baseUrl = '' } = {}) {
  const sb = db.prepare('SELECT * FROM storyboards WHERE id = ?').get(Number(storyboardId));
  if (!sb || sb.deleted_at) return null;
  // Minimal/legacy databases have no planning table. Do not create one in a getter.
  const plan = hasTable(db, 'storyboard_video_plans')
    ? require('./videoPlanningService').getStoryboardVideoPlan(db, sb.id)
    : null;
  const versionId = plan?.selected_version_id;
  if (versionId != null) {
    const version = hasTable(db, 'video_plan_versions')
      ? db.prepare('SELECT * FROM video_plan_versions WHERE id = ?').get(versionId)
      : null;
    if (!version || Number(version.storyboard_id) !== Number(sb.id) || version.status !== 'completed') {
      throw selectionError('采用的视频版本不存在、不属于当前分镜或尚未完成');
    }
    const duration = Number(version.duration);
    const videoUrl = text(version.video_url);
    const localPath = text(version.local_path);
    if ((!videoUrl && !localPath) || !Number.isFinite(duration) || duration <= 0) {
      throw selectionError('采用的视频版本缺少完整媒体或实测时长');
    }
    return {
      source: 'planned', storyboard_id: sb.id, version_id: version.id,
      adoption_revision: plan.adoption_revision, tail_segment_id: version.tail_segment_id,
      video_url: videoUrl || null, local_path: localPath || null, duration,
      url: mediaUrl(videoUrl, localPath, baseUrl),
    };
  }

  const videoUrl = text(sb.video_url);
  // This legacy column is shared with storyboard images. Never export an image as video.
  let localPath = text(sb.local_path);
  if (/\.(?:jpe?g|png|webp|gif|svg|avif|bmp|tiff?)(?:[?#]|$)/i.test(localPath)) localPath = '';
  if (!localPath && videoUrl && hasTable(db, 'video_generations')) {
    // Match the exact selection identity, including local-only legacy videos' /static/ URL.
    // Completion time never participates and foreign, deleted or unfinished rows cannot supply a cache.
    const { legacyVideoSelectionUrl } = require('./legacyVideoPlanningGuard');
    const selected = db.prepare("SELECT * FROM video_generations WHERE storyboard_id = ? AND status = 'completed'")
      .all(sb.id).find((row) => !row.deleted_at && text(row.local_path) && text(legacyVideoSelectionUrl(row)) === videoUrl);
    localPath = text(selected?.local_path);
  }
  if (!videoUrl && !localPath) return null;
  return {
    source: 'legacy', storyboard_id: sb.id, version_id: null,
    adoption_revision: plan?.adoption_revision ?? 0,
    video_url: videoUrl || null, local_path: localPath || null,
    // storyboard.duration is planned, not measured. The merge probes the selected media.
    duration: null, url: mediaUrl(videoUrl, localPath, baseUrl),
  };
}

/** Only resolve this selected media, never search for a substitute generation. */
function resolveLocalMediaPath(media, storageRoot, baseUrl = '') {
  for (const candidate of [media?.local_path, media?.video_url]) {
    let value = text(candidate);
    if (!value) continue;
    if (/^https?:\/\//i.test(value)) {
      const base = baseUrl.replace(/\/$/, '');
      if (!base || !value.startsWith(`${base}/`)) continue;
      try { value = decodeURIComponent(value.slice(base.length + 1).split(/[?#]/)[0]); } catch (_) { continue; }
    }
    const absolute = path.isAbsolute(value) ? value : path.resolve(storageRoot, value.replace(/^\/+/, ''));
    try { if (fs.statSync(absolute).isFile()) return absolute; } catch (_) {}
  }
  return null;
}

/** A missing local download may be recovered only from this same selected video's URL. */
async function materializeAdoptedVideo(media, { storageRoot, baseUrl = '', tempDir, filename = 'selected.mp4' }) {
  const local = resolveLocalMediaPath(media, storageRoot, baseUrl);
  if (local) return local;
  const url = text(media?.video_url);
  if (!/^https?:\/\//i.test(url)) throw new Error('已选视频的本地文件不存在且无可用下载地址');
  const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`已选视频下载失败：HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error('已选视频下载结果为空');
  const output = path.join(tempDir, filename);
  fs.writeFileSync(output, buffer);
  return output;
}

module.exports = { resolveAdoptedVideo, resolveLocalMediaPath, materializeAdoptedVideo };
