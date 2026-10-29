const path = require('path');
const fs = require('fs');
const { getFfmpegPath, getFfprobePath, hasLocalFfmpeg } = require('../utils/ffmpegPath');
const storageLayout = require('./storageLayout');

function list(db, query) {
  let sql = 'FROM video_merges WHERE deleted_at IS NULL';
  const params = [];
  if (query.episode_id) {
    sql += ' AND episode_id = ?';
    params.push(query.episode_id);
  }
  if (query.drama_id) {
    sql += ' AND drama_id = ?';
    params.push(query.drama_id);
  }
  const rows = db.prepare('SELECT * ' + sql + ' ORDER BY created_at DESC').all(...params);
  return rows.map(rowToItem);
}

function rowToItem(r) {
  return {
    id: r.id,
    episode_id: r.episode_id,
    drama_id: r.drama_id,
    title: r.title,
    provider: r.provider,
    status: r.status,
    merged_url: r.merged_url,
    duration: r.duration ?? undefined,
    task_id: r.task_id,
    error_msg: r.error_msg ?? undefined,
    created_at: r.created_at,
    completed_at: r.completed_at,
  };
}

function getById(db, id) {
  const r = db.prepare('SELECT * FROM video_merges WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  return r ? rowToItem(r) : null;
}

function create(db, log, req) {
  const now = new Date().toISOString();
  const taskService = require('./taskService');
  const task = taskService.createTask(db, log, 'video_merge', String(req.episode_id || ''));
  const mergeOptionsJson = (() => {
    const o = req.merge_options;
    if (o && typeof o === 'object') return JSON.stringify(o);
    return '{}';
  })();
  const info = db.prepare(
    `INSERT INTO video_merges (episode_id, drama_id, title, provider, model, status, scenes, merge_options, task_id, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
  ).run(
    Number(req.episode_id) || 0,
    Number(req.drama_id) || 0,
    req.title ?? null,
    req.provider || 'ffmpeg',
    req.model ?? null,
    req.scenes ? JSON.stringify(req.scenes) : '[]',
    mergeOptionsJson,
    task.id,
    now
  );
  return { merge_id: info.lastInsertRowid, task_id: task.id, ...getById(db, info.lastInsertRowid) };
}

function deleteById(db, log, id) {
  const now = new Date().toISOString();
  const result = db.prepare('UPDATE video_merges SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, Number(id));
  return result.changes > 0;
}

/** 获取 storage 根目录（绝对路径） */
function getStorageRoot() {
  const loadConfig = require('../config').loadConfig;
  const cfg = loadConfig();
  const p = cfg.storage?.local_path || './data/storage';
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

/** Resolve only the frozen selected media; a failed clip aborts the whole merge. */
async function resolveVideoToLocalPath(scene, baseUrl, storageRoot, tempDir, index) {
  try {
    return await require('./adoptedVideoService').materializeAdoptedVideo(scene, {
      storageRoot, baseUrl, tempDir, filename: `clip_${index}.mp4`,
    });
  } catch (error) {
    throw new Error(`分镜 ${scene.scene_id ?? index}：${error.message}`);
  }
}

/** Decode-count the video stream as well as measuring duration; corrupt/audio-only files fail. */
function probeVideoInfo(filePath) {
  const { spawnSync } = require('child_process');
  const result = spawnSync(getFfprobePath(), [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=nb_read_frames,duration:format=duration', '-of', 'json', filePath,
  ], { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0 || String(result.stderr || '').trim()) return null;
  try {
    const data = JSON.parse(result.stdout);
    const stream = data.streams?.[0];
    const frames = Number(stream?.nb_read_frames);
    const duration = Number(stream?.duration || data.format?.duration);
    if (!Number.isSafeInteger(frames) || frames < 1 || !Number.isFinite(duration) || duration <= 0) return null;
    return { duration, frames };
  } catch (_) { return null; }
}

/**
 * ffmpeg concat 参数构造：
 * - 默认 `-c copy` 流拷贝：快且无损，但要求各片段编码参数一致；
 * - transcode：重编码兜底。AI 分镜片段常出现编码/分辨率/采样率不一致，
 *   流拷贝 concat 会直接失败，整集退化成只有首段（issue #21 / #14）。
 */
function buildConcatArgs(listFile, outputPath, transcode = false) {
  if (!transcode) {
    return ['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-y', outputPath];
  }
  return [
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-fps_mode', 'passthrough',
    '-c:a', 'aac', '-ar', '44100', '-ac', '2',
    '-movflags', '+faststart',
    '-y', outputPath,
  ];
}

function runFfmpegConcatOnce(listFile, outputPath, transcode, log) {
  const ffmpegBin = getFfmpegPath();
  const { spawnSync } = require('child_process');
  const result = spawnSync(ffmpegBin, ['-xerror', ...buildConcatArgs(listFile, outputPath, transcode)], {
    encoding: 'utf8',
    timeout: 300000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) {
    log.warn('Video merge: ffmpeg spawn error', { error: result.error.message, transcode: !!transcode });
    return false;
  }
  if (result.status !== 0) {
    log.warn('Video merge: ffmpeg failed', {
      transcode: !!transcode,
      stderr: result.stderr?.slice(-500),
    });
    return false;
  }
  return true;
}

/** 使用 ffmpeg concat 合并多个视频文件：先流拷贝，失败再重编码兜底 */
function runFfmpegConcat(localPaths, outputPath, log) {
  if (!localPaths.length || localPaths.some((p) => !fs.existsSync(p))) return false;
  const listFile = path.join(path.dirname(outputPath), `concat_list_${require('crypto').randomUUID()}.txt`);
  let success = false;
  try {
    const lines = localPaths.map((p) => {
      const normalized = path.resolve(p).replace(/\\/g, '/');
      return `file '${normalized.replace(/'/g, "'\\''")}'`;
    });
    fs.writeFileSync(listFile, lines.join('\n'), 'utf8');
    success = runFfmpegConcatOnce(listFile, outputPath, false, log);
    if (!success) {
      log.warn('Video merge: stream copy concat failed, retrying with re-encode', { clip_count: localPaths.length });
      success = runFfmpegConcatOnce(listFile, outputPath, true, log);
    }
    return success;
  } finally {
    try { if (fs.existsSync(listFile)) fs.unlinkSync(listFile); } catch (_) {}
    if (!success) {
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
    }
  }
}

/** Publish only a complete episode. Every selected clip and requested post step must succeed. */
async function processVideoMerge(db, log, mergeId, baseUrl) {
  const r = db.prepare('SELECT * FROM video_merges WHERE id = ? AND deleted_at IS NULL').get(mergeId);
  if (!r || !['pending', 'processing'].includes(r.status)) return;
  const taskService = require('./taskService');
  const episodeId = r.episode_id;
  const taskId = r.task_id;
  let tempDir;
  const outputs = new Set();
  let completed = false;
  try {
    db.prepare('UPDATE video_merges SET status = ? WHERE id = ?').run('processing', mergeId);
    const scenes = JSON.parse(r.scenes || '[]');
    if (!Array.isArray(scenes) || !scenes.length || scenes.length > 100) throw new Error('整集合成需要 1 至 100 个完整片段');
    if (episodeId) {
      const expected = db.prepare('SELECT id FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number ASC, id ASC').all(episodeId);
      if (expected.length !== scenes.length || expected.some((sb, i) => Number(scenes[i]?.scene_id) !== sb.id)) {
        throw new Error('整集合成的分镜清单缺失、重复或顺序已变化，请重新创建合成任务');
      }
    }
    if (!hasLocalFfmpeg()) throw new Error('服务器未安装 ffmpeg，无法完成整集合成');
    const storageRoot = getStorageRoot();
    tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'drama-video-merge-'));
    const localPaths = [];
    for (let i = 0; i < scenes.length; i++) {
      const local = await resolveVideoToLocalPath(scenes[i], baseUrl, storageRoot, tempDir, i);
      const measured = probeVideoInfo(local);
      if (!measured) throw new Error(`无法探测分镜 ${scenes[i].scene_id ?? i} 的完整视频与实际时长`);
      localPaths.push(local);
      // Replace legacy planned durations before narration, subtitles or watermark processing.
      scenes[i] = { ...scenes[i], duration: measured.duration, duration_source: 'ffprobe', frame_count: measured.frames };
    }
    const totalDuration = scenes.reduce((sum, scene) => sum + scene.duration, 0);
    const totalFrames = scenes.reduce((sum, scene) => sum + scene.frame_count, 0);
    db.prepare('UPDATE video_merges SET scenes = ? WHERE id = ?').run(JSON.stringify(scenes), mergeId);
    const projectSubdir = storageLayout.getProjectStorageSubdir(db, r.drama_id);
    const mergedDir = path.join(storageRoot, projectSubdir || '', 'videos', 'merged');
    fs.mkdirSync(mergedDir, { recursive: true });
    const outputPath = path.join(mergedDir, `merged_${mergeId}_${require('crypto').randomUUID()}.mp4`);
    outputs.add(outputPath);
    outputs.add(outputPath.replace(/\.mp4$/, '_post.mp4'));
    outputs.add(outputPath.replace(/\.mp4$/, '_narration.srt'));
    if (!runFfmpegConcat(localPaths, outputPath, log)) throw new Error('ffmpeg 整集拼接失败');
    const mergedInfo = probeVideoInfo(outputPath);
    const tolerance = Math.max(0.12, totalDuration * 0.01);
    if (!mergedInfo || mergedInfo.frames !== totalFrames || Math.abs(mergedInfo.duration - totalDuration) > tolerance) {
      throw new Error('合成结果不完整或实际时长、帧数与全部分镜不符');
    }
    let finalPath = outputPath;
    const mergeOpts = JSON.parse(r.merge_options || '{}');
    const postNeed = !!mergeOpts.burn_narration_subtitles || !!mergeOpts.burn_dialogue_audio
      || !!String(mergeOpts.watermark_text || '').trim();
    if (postNeed) {
      const post = await require('./mergedEpisodePostProcess').runMergedEpisodePostProcess(db, log, {
        mergedAbsPath: outputPath, storageRoot, scenes, episodeId, mergeOpts,
      });
      if (!post.ok || !post.relativePath) throw new Error(post.error || '整集后处理失败');
      finalPath = path.resolve(storageRoot, post.relativePath);
      outputs.add(finalPath);
    }
    const finalInfo = postNeed ? probeVideoInfo(finalPath) : mergedInfo;
    if (!finalInfo || finalInfo.frames !== totalFrames || Math.abs(finalInfo.duration - totalDuration) > tolerance) {
      throw new Error(`最终成片不完整（预期 ${totalDuration} 秒/${totalFrames} 帧，实际 ${finalInfo?.duration ?? '无法探测'} 秒/${finalInfo?.frames ?? '?'} 帧）`);
    }
    const finalUrl = path.relative(storageRoot, finalPath).replace(/\\/g, '/');
    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare('UPDATE video_merges SET status = ?, merged_url = ?, duration = ?, completed_at = ?, error_msg = ? WHERE id = ?')
        .run('completed', finalUrl, finalInfo.duration, now, null, mergeId);
      db.prepare('UPDATE episodes SET video_url = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(finalUrl, 'completed', now, episodeId);
      if (taskId && !taskService.updateTaskResult(db, taskId, { merge_id: mergeId, video_url: finalUrl, duration: finalInfo.duration })) {
        throw new Error('合成任务已取消或结束，结果未发布');
      }
    })();
    completed = true;
    log.info('Video merge completed', { merge_id: mergeId, episode_id: episodeId, output: finalUrl });
  } catch (error) {
    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare('UPDATE video_merges SET status = ?, merged_url = NULL, duration = NULL, error_msg = ?, completed_at = ? WHERE id = ?')
        .run('failed', error.message || String(error), now, mergeId);
      // Keep an earlier complete export, but never publish a partial result from this attempt.
      db.prepare('UPDATE episodes SET status = ?, updated_at = ? WHERE id = ?').run('failed', now, episodeId);
      if (taskId) taskService.updateTaskError(db, taskId, error.message || String(error));
    })();
    log.error('Video merge failed', { merge_id: mergeId, error: error.message });
  } finally {
    if (!completed) {
      for (const output of outputs) { try { fs.unlinkSync(output); } catch (_) {} }
    }
    if (tempDir) { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {} }
  }
}

module.exports = {
  list,
  getById,
  create,
  deleteById,
  processVideoMerge,
  buildConcatArgs,
  runFfmpegConcat,
};
