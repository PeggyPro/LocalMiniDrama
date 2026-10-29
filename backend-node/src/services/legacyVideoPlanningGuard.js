'use strict';

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function getPlanRow(db, storyboardId) {
  return hasTable(db, 'storyboard_video_plans')
    ? db.prepare('SELECT * FROM storyboard_video_plans WHERE storyboard_id=?').get(Number(storyboardId)) : null;
}
function conflict(code, message) {
  const error = new Error(message);
  Object.assign(error, { statusCode: 409, code });
  throw error;
}
function assertLegacyGenerationAllowed(db, storyboardId, model, dramaId) {
  if (storyboardId != null) {
    const row = hasTable(db, 'storyboards') && db.prepare('SELECT * FROM storyboards WHERE id=?').get(Number(storyboardId));
    if (!row || row.deleted_at) conflict('STORYBOARD_NOT_ACTIVE', '分镜不存在或已归档');
    if (hasTable(db, 'episodes')) {
      const episode = db.prepare('SELECT * FROM episodes WHERE id=?').get(row.episode_id);
      if (!episode || episode.deleted_at || (dramaId != null && Number(episode.drama_id) !== Number(dramaId))) {
        conflict('STORYBOARD_OWNERSHIP_MISMATCH', '分镜与请求剧集不匹配或剧集已归档');
      }
      if (hasTable(db, 'dramas')) {
        const drama = db.prepare('SELECT * FROM dramas WHERE id=?').get(episode.drama_id);
        if (!drama || drama.deleted_at) conflict('STORYBOARD_NOT_ACTIVE', '所属短剧不存在或已归档');
      }
    }
  }
  if (storyboardId != null && getPlanRow(db, storyboardId)) {
    conflict('VIDEO_PLAN_REQUIRED', '此分镜已有视频规划，请先预览有限计划再执行；旧生成入口不能绕过工作流与来源选择');
  }
  const workflow = require('./videoWorkflowCatalog').getVideoWorkflow(model);
  if (workflow?.requires_latent || workflow?.stage === 'first') {
    conflict('VIDEO_PLAN_REQUIRED', '长视频首段或续接工作流需要持久化计划，请先为分镜选择工作流并预览计划');
  }
}
function isVideoPath(value) { return /\.(mp4|webm|mov|mkv|avi|m4v)(?:[?#].*)?$/i.test(String(value || '')); }
function legacyVideoSelectionUrl(video) {
  if (video.video_url) return video.video_url;
  const local = String(video.local_path || '').replace(/\\/g, '/');
  if (!local) return null;
  if (require('node:path').isAbsolute(local) || /^[a-z]:\//i.test(local)) return local;
  return `/static/${local.replace(/^\/+/, '')}`;
}
function canAutoAdoptLegacyVideo(db, storyboardId) {
  if (getPlanRow(db, storyboardId)) return false;
  const row = db.prepare('SELECT * FROM storyboards WHERE id=?').get(Number(storyboardId));
  return !!row && !row.deleted_at && !row.video_url && !isVideoPath(row.local_path);
}
// Run inside the same SQLite transaction as the storyboard media update.
function adoptLegacyMedia(db, storyboard, body) {
  const plan = getPlanRow(db, storyboard.id);
  const explicit = Object.hasOwn(body, 'expected_adoption_revision');
  if (!plan && !explicit) return;
  const videoWrite = body.video_url !== undefined || (body.local_path !== undefined && isVideoPath(body.local_path));
  if (!videoWrite) return;
  if (!explicit) {
    // Harmless round trips of unchanged legacy media do not clear a selected immutable version.
    if (!plan.selected_version_id && (body.video_url === undefined || body.video_url === storyboard.video_url) &&
        (body.local_path === undefined || body.local_path === storyboard.local_path)) return;
    conflict('ADOPTION_REVISION_REQUIRED', '采用历史视频须明确提交当前采用修订号，请刷新后点击采用');
  }
  if (!Number.isSafeInteger(body.expected_adoption_revision) || body.expected_adoption_revision !== (plan?.adoption_revision ?? 0)) {
    conflict('ADOPTION_REVISION_CONFLICT', '采用的视频已改变，请刷新后重新选择');
  }
  const videos = hasTable(db, 'video_generations')
    ? db.prepare('SELECT * FROM video_generations WHERE storyboard_id=?').all(storyboard.id) : [];
  const match = videos.find(video => video.status === 'completed' && !video.deleted_at &&
    (body.video_url ? body.video_url === legacyVideoSelectionUrl(video) : (body.local_path && body.local_path === video.local_path)) &&
    (body.local_path == null || body.local_path === video.local_path));
  if (!match) conflict('LEGACY_VIDEO_NOT_OWNED', '只能采用当前分镜已完成的历史视频');
  // URL and local cache form one selection; never retain the previous video's path.
  body.video_url = legacyVideoSelectionUrl(match);
  // This legacy column also holds image input. Keep that input; selected video cache is resolved from its exact history row.
  body.local_path = storyboard.local_path && !isVideoPath(storyboard.local_path)
    ? storyboard.local_path : match.local_path || null;
  if (!plan) return;
  const changed = db.prepare(`UPDATE storyboard_video_plans SET selected_version_id=NULL,
    adoption_revision=adoption_revision+1, updated_at=datetime('now') WHERE storyboard_id=? AND adoption_revision=?`)
    .run(storyboard.id, body.expected_adoption_revision);
  if (changed.changes !== 1) conflict('ADOPTION_REVISION_CONFLICT', '采用的视频已改变，请刷新后重新选择');
}
module.exports = { assertLegacyGenerationAllowed, canAutoAdoptLegacyVideo, adoptLegacyMedia, legacyVideoSelectionUrl };
