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

const imageExtension = /\.(?:jpe?g|png|webp|gif|svg|avif|bmp|tiff?)(?:[?#]|$)/i;
const videoExtension = /\.(?:mp4|webm|mov|mkv|m4v|avi|m3u8)(?:[?#]|$)/i;

function playableMedia(videoUrl, localPath) {
  const url = text(videoUrl);
  const local = text(localPath);
  if (local && !imageExtension.test(local) && videoExtension.test(local)) return true;
  if (url && !imageExtension.test(url) && (/^https?:\/\//i.test(url) || /^\/static\//.test(url) || videoExtension.test(url))) return true;
  return false;
}

function latestPlayablePlanVersion(db, storyboardId) {
  if (!hasTable(db, 'video_plan_versions')) return null;
  const row = db.prepare("SELECT * FROM video_plan_versions WHERE storyboard_id = ? AND status = 'completed' ORDER BY created_at DESC, id DESC")
    .all(Number(storyboardId)).find((item) => playableMedia(item.video_url, item.local_path));
  return row ? { ...row, __planned: true } : null;
}

function latestPlayableLegacyVideo(db, storyboardId) {
  if (!hasTable(db, 'video_generations')) return null;
  return db.prepare("SELECT * FROM video_generations WHERE storyboard_id = ? AND status = 'completed' AND deleted_at IS NULL ORDER BY created_at DESC, id DESC")
    .all(Number(storyboardId)).find((row) => playableMedia(row.video_url, row.local_path)) || null;
}

function recency(row) {
  for (const value of [row?.created_at, row?.completed_at, row?.updated_at]) {
    const timestamp = Date.parse(text(value));
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function latestPlayableVideo(db, storyboardId) {
  const planned = latestPlayablePlanVersion(db, storyboardId);
  const legacy = latestPlayableLegacyVideo(db, storyboardId);
  if (!planned) return legacy;
  if (!legacy) return planned;
  if (recency(legacy) > recency(planned)) return legacy;
  if (recency(planned) > recency(legacy)) return planned;
  // Keep deterministic behavior for equal timestamps. Planned records have
  // string IDs, while legacy generation IDs are numeric, so prefer the plan
  // only when its timestamp is exactly tied with the legacy result.
  return planned;
}

/**
 * Read only: an explicit adoption wins. When no adoption exists, the newest
 * completed playable plan version or legacy generation is used as a default.
 * The fallback never writes adoption history or increments its revision.
 */
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
    if (!playableMedia(videoUrl, localPath) || !Number.isFinite(duration) || duration <= 0) {
      throw selectionError('采用的视频版本缺少完整媒体或实测时长');
    }
    return {
      source: 'planned', storyboard_id: sb.id, version_id: version.id,
      adoption_revision: plan.adoption_revision, tail_segment_id: version.tail_segment_id,
      video_url: videoUrl || null, local_path: localPath || null, duration,
      url: mediaUrl(videoUrl, localPath, baseUrl),
    };
  }

  // These legacy columns are shared with storyboard images. Never export an image as video.
  // A compatibility cache written by the old first-generation auto-adopter is
  // explicitly non-authoritative; manual selections remain authoritative.
  if (sb.video_selection_source !== 'automatic') {
    let videoUrl = text(sb.video_url);
    if (imageExtension.test(videoUrl)) videoUrl = '';
    let localPath = text(sb.local_path);
    if (imageExtension.test(localPath)) localPath = '';
    if (!localPath && videoUrl && hasTable(db, 'video_generations')) {
      // Match the exact selection identity, including local-only legacy videos' /static/ URL.
      const { legacyVideoSelectionUrl } = require('./legacyVideoPlanningGuard');
      const selected = db.prepare("SELECT * FROM video_generations WHERE storyboard_id = ? AND status = 'completed'")
        .all(sb.id).find((row) => !row.deleted_at && text(row.local_path) && text(legacyVideoSelectionUrl(row)) === videoUrl);
      localPath = text(selected?.local_path);
    }
    if (videoUrl || localPath) {
      return {
        source: 'legacy', storyboard_id: sb.id, version_id: null,
        adoption_revision: plan?.adoption_revision ?? 0,
        video_url: videoUrl || null, local_path: localPath || null,
        // storyboard.duration is planned, not measured. The merge probes the selected media.
        duration: null, url: mediaUrl(videoUrl, localPath, baseUrl),
      };
    }
  }

  // Compare both generation stores by creation time. A newly completed result
  // becomes current regardless of whether it came from the planned or legacy
  // workflow, without changing the explicit legacy selection above.
  const latest = latestPlayableVideo(db, sb.id);
  if (!latest) return null;
  const planned = latest.__planned === true;
  const latestVideoUrl = text(latest.video_url);
  const latestLocalPath = text(latest.local_path);
  const latestDuration = Number(latest.duration);
  return {
    source: planned ? 'planned' : 'legacy_latest', storyboard_id: sb.id,
    version_id: planned ? latest.id : null,
    adoption_revision: plan?.adoption_revision ?? 0,
    ...(planned ? { tail_segment_id: latest.tail_segment_id } : {}),
    video_url: latestVideoUrl || null, local_path: latestLocalPath || null,
    duration: planned && Number.isFinite(latestDuration) && latestDuration > 0 ? latestDuration : null,
    url: mediaUrl(latestVideoUrl, latestLocalPath, baseUrl),
  };
}

/** Resolve a selected or automatically chosen media path without changing it. */
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
