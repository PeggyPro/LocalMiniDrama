const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getFfmpegPath, getFfprobePath, hasLocalFfmpeg } = require('../utils/ffmpegPath');
const { resolveAdoptedVideo, resolveLocalMediaPath, materializeAdoptedVideo } = require('./adoptedVideoService');

/** Count decoded display frames and retain the final PTS as auditable extraction evidence. */
function probeLastFrame(videoPath) {
  const result = spawnSync(getFfprobePath(), [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_frames',
    '-show_entries', 'stream=nb_read_frames,width,height:frame=best_effort_timestamp_time',
    '-of', 'json', videoPath,
  ], { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0 || String(result.stderr || '').trim()) throw new Error('无法探测已选视频的完整帧序列');
  let data;
  try { data = JSON.parse(result.stdout); } catch (_) { throw new Error('视频帧探测结果无效'); }
  const stream = data.streams?.[0];
  const frameCount = Number(stream?.nb_read_frames);
  const last = data.frames?.[frameCount - 1];
  const lastPts = last?.best_effort_timestamp_time == null ? NaN : Number(last.best_effort_timestamp_time);
  if (!Number.isSafeInteger(frameCount) || frameCount < 1 || data.frames?.length !== frameCount || !Number.isFinite(lastPts)) {
    throw new Error('无法确认已选视频的最后一帧');
  }
  return { frame_count: frameCount, frame_index: frameCount - 1, last_pts: lastPts, width: stream.width, height: stream.height };
}

function extractLastFrame(videoPath, outputPath) {
  const evidence = probeLastFrame(videoPath);
  // Decode from the start: selecting the last display index works for short and VFR clips too.
  const result = spawnSync(getFfmpegPath(), [
    '-v', 'error', '-xerror', '-i', videoPath, '-map', '0:v:0',
    '-vf', `select=eq(n\\,${evidence.frame_index})`, '-fps_mode', 'vfr',
    '-frames:v', '1', '-update', '1', '-q:v', '2', '-y', outputPath,
  ], { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0 || !fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
    throw new Error('ffmpeg 提取最后一帧失败');
  }
  return evidence;
}

/** Extract the adopted version's true final frame and link it to the next storyboard. */
function routes(db, cfg, log) {
  return {
    linkTailFrame: async (req, res) => {
      let outputAbsPath;
      let tempDir;
      let committed = false;
      try {
        const storyboardId = Number(req.params.id);
        const dramaId = Number(req.body?.drama_id);
        if (!Number.isSafeInteger(storyboardId) || storyboardId <= 0 || !Number.isSafeInteger(dramaId) || dramaId <= 0) {
          return res.status(400).json({ error: '缺少必要参数' });
        }
        const currentSb = db.prepare('SELECT * FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(storyboardId);
        if (!currentSb) return res.status(404).json({ error: '分镜不存在' });
        const ep = db.prepare('SELECT * FROM episodes WHERE id = ?').get(currentSb.episode_id);
        if (!ep || ep.deleted_at || Number(ep.drama_id) !== dramaId) return res.status(400).json({ error: '分镜不属于指定项目' });
        const video = resolveAdoptedVideo(db, storyboardId);
        if (!video) return res.status(400).json({ error: '当前分镜尚未选择视频' });
        const nextSb = db.prepare(`
          SELECT id, storyboard_number FROM storyboards
          WHERE episode_id = ? AND storyboard_number > ? AND deleted_at IS NULL
          ORDER BY storyboard_number ASC, id ASC LIMIT 1
        `).get(currentSb.episode_id, currentSb.storyboard_number || 0);
        if (!nextSb) return res.status(400).json({ error: '没有下一个分镜可供衔接' });
        if (!hasLocalFfmpeg()) return res.status(500).json({ error: '服务器未安装 ffmpeg，无法提取视频帧' });

        const storageBase = path.resolve(cfg?.storage?.local_path || './data/storage');
        const filesBase = cfg?.storage?.base_url || cfg?.files?.base_url || '';
        let videoAbsPath = resolveLocalMediaPath(video, storageBase, filesBase);
        if (!videoAbsPath) {
          tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'drama-tail-frame-'));
          videoAbsPath = await materializeAdoptedVideo(video, { storageRoot: storageBase, baseUrl: filesBase, tempDir });
        }
        // Downloading yields to other requests. Do not link a frame after the user changes adoption.
        const currentVideo = resolveAdoptedVideo(db, storyboardId);
        if (!currentVideo || currentVideo.version_id !== video.version_id || currentVideo.adoption_revision !== video.adoption_revision
          || currentVideo.video_url !== video.video_url || currentVideo.local_path !== video.local_path) {
          return res.status(409).json({ error: '下载期间已选视频发生变化，请重试尾帧衔接' });
        }
        const outputFileName = `tailframe_${storyboardId}_to_${nextSb.id}_${require('crypto').randomUUID()}.jpg`;
        const imagesDir = path.join(storageBase, 'media', 'images');
        fs.mkdirSync(imagesDir, { recursive: true });
        outputAbsPath = path.join(imagesDir, outputFileName);
        const outputRelPath = `media/images/${outputFileName}`;
        const evidence = extractLastFrame(videoAbsPath, outputAbsPath);
        const source = {
          storyboard_id: storyboardId, version_id: video.version_id,
          adoption_revision: video.adoption_revision, ...evidence,
        };
        const now = new Date().toISOString();
        const prompt = `尾帧衔接：分镜 #${currentSb.storyboard_number ?? storyboardId} 最后一帧；${JSON.stringify(source)}`;
        const imageUrl = filesBase ? `${filesBase.replace(/\/$/, '')}/${outputRelPath}` : null;
        const newImageId = db.transaction(() => {
          const info = db.prepare(`
            INSERT INTO image_generations (
              drama_id, episode_id, storyboard_id, prompt, provider, model, status,
              image_url, local_path, width, height, created_at, updated_at, completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(dramaId, currentSb.episode_id, nextSb.id, prompt, 'tail-frame', 'tail-frame-extract',
            'completed', imageUrl, outputRelPath, evidence.width, evidence.height, now, now, now);
          db.prepare(`UPDATE storyboards SET first_frame_image_id = ?, image_url = ?, local_path = ?, updated_at = ? WHERE id = ?`)
            .run(info.lastInsertRowid, imageUrl, outputRelPath, now, nextSb.id);
          return info.lastInsertRowid;
        })();
        committed = true;
        log.info('[尾帧衔接] 完成', { from_storyboard: storyboardId, to_storyboard: nextSb.id, source });
        res.json({ success: true, message: '尾帧衔接成功', next_storyboard_id: nextSb.id,
          new_first_frame_image_id: newImageId, image_url: imageUrl, local_path: outputRelPath, source });
      } catch (err) {
        log.error('storyboards link-tail-frame', { error: err.message });
        res.status(err.statusCode || 500).json({ error: err.message || '尾帧衔接失败', code: err.code });
      } finally {
        if (outputAbsPath && !committed) { try { fs.unlinkSync(outputAbsPath); } catch (_) {} }
        if (tempDir) { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {} }
      }
    },
  };
}

module.exports = routes;
module.exports.probeLastFrame = probeLastFrame;
module.exports.extractLastFrame = extractLastFrame;
