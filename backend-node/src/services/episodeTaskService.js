// A read-only view over existing work. It does not enqueue, resume, cancel or repair tasks.
const { hasExecutionSchema } = require('./videoExecutionSchema');

const EPISODE_TYPES = new Set([
  'storyboard_generation', 'background_extraction', 'prop_extraction',
  'character_extraction', 'video_merge', 'episode_story_generation',
]);
const PROJECT_TYPES = new Set(['character_generation', 'story_generation']);
const LABELS = {
  storyboard_generation: '分镜生成', background_extraction: '场景提取',
  prop_extraction: '道具提取', character_extraction: '角色提取',
  character_generation: '角色提取', story_generation: '剧情生成', episode_story_generation: '本集剧情生成',
  video_merge: '视频合成', frame_prompt_generation: '帧提示词生成',
  image_generation: '图片生成', character_image: '角色图片生成',
  prop_image_generation: '道具图片生成', video_generation: '视频生成',
};

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}

function positiveInteger(value, name, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!['string', 'number'].includes(typeof value) || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    badRequest(`${name} 必须为正整数`);
  }
  return Number(value);
}

function parseJSON(value) {
  if (typeof value !== 'string') return value || null;
  try { return JSON.parse(value); } catch (_) { return null; }
}

function publicUrl(value) {
  if (!value) return null;
  const text = String(value).replace(/\\/g, '/');
  if (/^(https?:|data:|\/)/i.test(text)) return text;
  return '/static/' + text;
}

function bucket(status) {
  if (['completed', 'succeeded', 'success'].includes(status)) return 'completed';
  // The existing failed filter includes work needing attention, not just terminal failures.
  // An uncertain submission is paused for inspection; it must not look actively running.
  if (['failed', 'cancelled', 'canceled', 'blocked', 'error', 'media_failed', 'submitted_unknown'].includes(status)) return 'failed';
  return 'active';
}

function time(value) {
  let text = String(value || '');
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)) {
    text = text.replace(' ', 'T') + 'Z';
  }
  return Date.parse(text) || 0;
}

function newestFirst(a, b) {
  return time(b.created_at) - time(a.created_at) || String(b.id).localeCompare(String(a.id), 'en', { numeric: true });
}

function readContext(db, episode) {
  const dramaId = episode.drama_id;
  const episodeId = episode.id;
  const episodes = new Set(db.prepare(
    'SELECT id FROM episodes WHERE drama_id = ? AND deleted_at IS NULL'
  ).all(dramaId).map((row) => row.id));
  const storyboards = db.prepare(`
    SELECT sb.id, sb.episode_id, sb.storyboard_number, sb.scene_id, sb.characters, sb.local_path, sb.image_url
    FROM storyboards sb JOIN episodes e ON e.id = sb.episode_id
    WHERE e.drama_id = ? AND e.deleted_at IS NULL AND sb.deleted_at IS NULL
  `).all(dramaId);
  const characters = db.prepare('SELECT id, name, local_path, image_url FROM characters WHERE drama_id = ? AND deleted_at IS NULL').all(dramaId);
  const scenes = db.prepare('SELECT id, episode_id, location, local_path, image_url FROM scenes WHERE drama_id = ? AND deleted_at IS NULL').all(dramaId);
  const props = db.prepare('SELECT id, episode_id, name, local_path, image_url FROM props WHERE drama_id = ? AND deleted_at IS NULL').all(dramaId);
  const characterRefs = new Map(characters.map((row) => [row.id, new Set()]));
  const sceneRefs = new Map(scenes.map((row) => [row.id, new Set(episodes.has(row.episode_id) ? [row.episode_id] : [])]));
  const propRefs = new Map(props.map((row) => [row.id, new Set(episodes.has(row.episode_id) ? [row.episode_id] : [])]));
  const addRef = (refs, id, eid) => refs.get(Number(id))?.add(eid);
  for (const row of db.prepare(`
    SELECT ec.character_id, ec.episode_id FROM episode_characters ec
    JOIN episodes e ON e.id = ec.episode_id
    WHERE e.drama_id = ? AND e.deleted_at IS NULL
  `).all(dramaId)) addRef(characterRefs, row.character_id, row.episode_id);
  for (const sb of storyboards) {
    addRef(sceneRefs, sb.scene_id, sb.episode_id);
    // storyboards.characters contains drama character IDs. storyboard_characters
    // instead contains character-library IDs and must not be joined to characters.
    const selected = parseJSON(sb.characters);
    if (Array.isArray(selected)) {
      for (const value of selected) addRef(characterRefs, value && typeof value === 'object' ? value.id : value, sb.episode_id);
    }
  }
  for (const row of db.prepare(`
    SELECT sp.prop_id, sb.episode_id FROM storyboard_props sp
    JOIN storyboards sb ON sb.id = sp.storyboard_id AND sb.deleted_at IS NULL
    JOIN episodes e ON e.id = sb.episode_id AND e.deleted_at IS NULL
    WHERE e.drama_id = ?
  `).all(dramaId)) addRef(propRefs, row.prop_id, row.episode_id);

  function assetContexts(rows, refs, resourceType, prefix) {
    return new Map(rows.filter((row) => refs.get(row.id).has(episodeId)).map((row) => [row.id, {
      resource_type: resourceType, resource_id: String(row.id),
      detail: `${prefix} ${row.name || row.location || row.id}`,
      scope: row.episode_id === episodeId && refs.get(row.id).size === 1 ? 'episode' : 'shared',
      thumbnail_url: publicUrl(row.local_path || row.image_url),
    }]));
  }
  return {
    episode: { resource_type: 'episode', resource_id: String(episodeId), detail: '', scope: 'episode' },
    project: { resource_type: 'drama', resource_id: String(dramaId), detail: '项目共享', scope: 'project' },
    storyboards: new Map(storyboards.filter((sb) => sb.episode_id === episodeId).map((sb) => [sb.id, {
      resource_type: 'storyboard', resource_id: String(sb.id), detail: `分镜 ${sb.storyboard_number || sb.id}`,
      scope: 'episode', thumbnail_url: publicUrl(sb.local_path || sb.image_url),
    }])),
    characters: assetContexts(characters, characterRefs, 'character', '角色'),
    scenes: assetContexts(scenes, sceneRefs, 'scene', '场景'),
    props: assetContexts(props, propRefs, 'prop', '道具'),
  };
}

function mediaContext(row, context, episode) {
  // An explicit storyboard/episode association takes priority over shared assets.
  // A media row belonging to another episode must not leak through a shared scene.
  if (row.storyboard_id != null) return context.storyboards.get(Number(row.storyboard_id));
  if (row.episode_id != null) return Number(row.episode_id) === episode.id ? context.episode : null;
  if (row.character_id != null) return context.characters.get(Number(row.character_id));
  if (row.scene_id != null) return context.scenes.get(Number(row.scene_id));
  return null;
}

function toItem(task, media, context, source, type) {
  const result = source === 'text' ? null : parseJSON(task?.result);
  const taskStatus = task?.status;
  // Some image workers only update the generation row while running. Preserve
  // terminal async-task states (including cancellation) when the two disagree.
  const status = taskStatus && bucket(taskStatus) !== 'active' ? taskStatus : media?.status || taskStatus || 'pending';
  const resultUrl = source === 'video'
    ? publicUrl(media?.local_path || media?.video_url || media?.merged_url || result?.local_path || result?.video_url || result?.merged_url)
    : publicUrl(media?.local_path || media?.image_url || result?.local_path || result?.image_url);
  const thumbnail = source === 'image' ? resultUrl : publicUrl(media?.image_url || media?.first_frame_url);
  return {
    id: task?.id || `${type === 'video_merge' ? 'merge' : source}:${media.id}`,
    type, source, status,
    progress: task?.progress != null && Number.isFinite(Number(task.progress)) ? Number(task.progress) : null,
    message: task?.message || null,
    error: task?.error || media?.error_msg || null,
    resource_id: context.resource_id,
    task_resource_id: task?.resource_id ?? null,
    resource_type: context.resource_type,
    label: [LABELS[type] || type, context.detail].filter(Boolean).join(' · '),
    provider: media?.provider || null,
    model: media?.model || null,
    generation_id: media?.id ?? null,
    thumbnail_url: thumbnail || context.thumbnail_url || null,
    result_url: resultUrl,
    created_at: task?.created_at || media?.created_at || null,
    updated_at: time(media?.updated_at) > time(task?.updated_at) ? media.updated_at : task?.updated_at || media?.updated_at || null,
    finished_at: task?.completed_at || media?.completed_at || null,
    scope: context.scope,
  };
}

function executionItems(db, episode, context) {
  if (!hasExecutionSchema(db)) return [];
  // Select display fields only: connection credentials, frozen inputs and provider
  // responses never enter this view. The node and plan must both belong to this episode.
  const rows = db.prepare(`
    SELECT n.id, n.plan_id, n.storyboard_id, n.model_id, n.status, n.blocking_reasons,
      n.version_id, n.updated_at, p.status AS plan_status, p.started_at,
      a.id AS attempt_id, a.status AS attempt_status, a.task_id, a.prompt_id, a.error,
      v.video_url, v.local_path
    FROM video_execution_nodes n
    JOIN video_execution_plans p ON p.id = n.plan_id
    JOIN storyboards sb ON sb.id = n.storyboard_id AND sb.episode_id = p.episode_id AND sb.deleted_at IS NULL
    LEFT JOIN video_execution_attempts a ON a.node_id = n.id
    LEFT JOIN video_plan_versions v ON v.id = n.version_id AND v.storyboard_id = n.storyboard_id AND v.status = 'completed'
    WHERE p.episode_id = ? AND p.drama_id = ? AND p.started_at IS NOT NULL AND p.status <> 'preview'
  `).all(episode.id, episode.drama_id);
  const messages = {
    ready: '等待执行', queued: '已加入执行队列', waiting_dependency: '等待上游镜头完成',
    preflighting: '正在检查执行条件', submitting: '正在提交任务，请勿重复提交',
    processing: '任务已提交，正在查询生成状态', materializing: '生成已完成，正在保存视频',
    completed: '视频已生成，可在执行计划中查看版本', blocked: '执行被阻挡，请查看执行计划',
    failed: '生成失败，请查看执行计划', media_failed: '视频保存失败，请查看执行计划',
    submitted_unknown: '提交结果未知，请勿重复提交；请查看执行计划核查',
  };
  return rows.filter((row) => context.storyboards.has(row.storyboard_id)).map((row) => {
    const target = context.storyboards.get(row.storyboard_id);
    const reasons = parseJSON(row.blocking_reasons);
    const blockingReasons = Array.isArray(reasons) ? reasons.filter((reason) => typeof reason === 'string') : [];
    const status = row.status === 'processing' && row.attempt_status === 'materializing' ? 'materializing' : row.status;
    return {
      id: `video-execution:${row.id}`, type: 'video_execution', source: 'video', status,
      // Provider polling does not supply a percentage. Do not infer one from lifecycle stages.
      progress: null, message: messages[status] || null,
      error: row.error || (bucket(status) === 'failed' ? blockingReasons.join('；') || null : null),
      blocking_reasons: blockingReasons,
      resource_id: target.resource_id, resource_type: target.resource_type, task_resource_id: null,
      label: `视频执行 · ${target.detail}`, provider: 'comfyui', model: row.model_id, generation_id: null,
      thumbnail_url: target.thumbnail_url || null,
      result_url: status === 'completed' ? publicUrl(row.local_path || row.video_url) : null,
      // Submission, not preview creation, is when this task enters the task center.
      created_at: row.started_at, updated_at: row.updated_at,
      finished_at: ['completed', 'failed', 'media_failed', 'blocked', 'cancelled'].includes(status) ? row.updated_at : null,
      scope: 'episode', execution_plan_id: row.plan_id, execution_node_id: row.id,
      execution_plan_status: row.plan_status, execution_attempt_id: row.attempt_id || null,
      provider_task_id: row.task_id || null, prompt_id: row.prompt_id || null, version_id: row.version_id,
    };
  });
}

function listEpisodeTasks(db, episodeIdValue, query = {}) {
  const episodeId = positiveInteger(episodeIdValue, 'episodeId');
  const page = positiveInteger(query.page, 'page', 1);
  const limit = Math.min(positiveInteger(query.limit, 'limit', 30), 100);
  if (!Number.isSafeInteger((page - 1) * limit)) badRequest('page 超出有效范围');
  const status = query.status === undefined ? 'all' : query.status;
  if (!['all', 'active', 'completed', 'failed'].includes(status)) badRequest('status 必须为 all、active、completed 或 failed');
  const episode = db.prepare(`
    SELECT e.id, e.drama_id FROM episodes e JOIN dramas d ON d.id = e.drama_id
    WHERE e.id = ? AND e.deleted_at IS NULL AND d.deleted_at IS NULL
  `).get(episodeId);
  if (!episode) return null;
  const context = readContext(db, episode);
  const images = db.prepare(`
    SELECT id, drama_id, storyboard_id, episode_id, character_id, scene_id, task_id,
      status, provider, model, image_url, local_path, error_msg, created_at, updated_at, completed_at
    FROM image_generations WHERE drama_id = ? AND deleted_at IS NULL
  `).all(episode.drama_id);
  const videos = db.prepare(`
    SELECT id, drama_id, storyboard_id, scene_id, task_id, status, provider, model,
      image_url, first_frame_url, video_url, local_path, error_msg, created_at, updated_at, completed_at
    FROM video_generations WHERE drama_id = ? AND deleted_at IS NULL
  `).all(episode.drama_id);
  const merges = db.prepare(`
    SELECT id, episode_id, drama_id, task_id, status, provider, model,
      merged_url, error_msg, created_at, completed_at
    FROM video_merges WHERE episode_id = ? AND drama_id = ? AND deleted_at IS NULL
  `).all(episodeId, episode.drama_id);
  const media = [
    ...images.map((row) => ({ row, context: mediaContext(row, context, episode), source: 'image', type: 'image_generation' })),
    ...videos.map((row) => ({ row, context: mediaContext(row, context, episode), source: 'video', type: 'video_generation' })),
  ].filter((entry) => entry.context).sort((a, b) => newestFirst(a.row, b.row));
  const mediaTaskIds = new Set([...images, ...videos].map((row) => row.task_id).filter(Boolean));
  const mediaByTask = new Map();
  for (const entry of media) {
    const key = `${entry.type}:${entry.row.task_id}`;
    if (entry.row.task_id && !mediaByTask.has(key)) mediaByTask.set(key, entry);
  }
  const mergeByTask = new Map();
  for (const row of merges.sort(newestFirst)) if (row.task_id && !mergeByTask.has(row.task_id)) mergeByTask.set(row.task_id, row);

  // Bound the candidate query to this project. resource_id is polymorphic and
  // non-unique across resource types, so it is never sufficient on its own.
  const tasks = db.prepare(`
    SELECT t.id, t.type, t.status, t.progress, t.message, t.error, t.resource_id,
      t.created_at, t.updated_at, t.completed_at,
      CASE WHEN t.type IN ('image_generation', 'character_image', 'prop_image_generation', 'video_generation', 'video_merge')
        THEN t.result ELSE NULL END AS result
    FROM async_tasks t WHERE t.deleted_at IS NULL AND (
      t.resource_id IN (@episodeId, @dramaId)
      OR t.id IN (SELECT task_id FROM image_generations WHERE drama_id = @dramaId AND deleted_at IS NULL)
      OR t.id IN (SELECT task_id FROM video_generations WHERE drama_id = @dramaId AND deleted_at IS NULL)
      OR t.id IN (SELECT task_id FROM video_merges WHERE drama_id = @dramaId AND deleted_at IS NULL)
      OR (t.type = 'frame_prompt_generation' AND t.resource_id IN (
        SELECT CAST(sb.id AS TEXT) FROM storyboards sb JOIN episodes e ON e.id = sb.episode_id WHERE e.drama_id = @dramaId))
      OR (t.type = 'prop_image_generation' AND t.resource_id IN (SELECT CAST(id AS TEXT) FROM props WHERE drama_id = @dramaId))
      OR (t.type = 'character_image' AND t.resource_id IN (SELECT CAST(id AS TEXT) FROM characters WHERE drama_id = @dramaId))
      OR (t.type = 'image_generation' AND t.resource_id IN (
        SELECT 'character_' || id FROM characters WHERE drama_id = @dramaId
        UNION SELECT 'scene_' || id FROM scenes WHERE drama_id = @dramaId))
    )
  `).all({ episodeId: String(episodeId), dramaId: String(episode.drama_id) });
  const items = new Map();
  for (const task of tasks) {
    let target;
    let generation;
    let source = 'text';
    const linked = mediaByTask.get(`${task.type}:${task.id}`);
    if (linked) {
      target = linked.context;
      generation = linked.row;
      source = linked.source;
    } else if (PROJECT_TYPES.has(task.type) && task.resource_id === String(episode.drama_id)) {
      target = context.project;
    } else if (EPISODE_TYPES.has(task.type) && task.resource_id === String(episodeId)) {
      target = context.episode;
      if (task.type === 'video_merge') {
        source = 'video';
        generation = mergeByTask.get(task.id);
      }
    } else if (task.type === 'frame_prompt_generation') {
      target = context.storyboards.get(Number(task.resource_id));
    } else if (task.type === 'prop_image_generation') {
      target = context.props.get(Number(task.resource_id));
      source = 'image';
    } else if (task.type === 'character_image') {
      target = context.characters.get(Number(task.resource_id));
      source = 'image';
    } else if (task.type === 'image_generation' && !mediaTaskIds.has(task.id)) {
      const match = /^(character|scene)_(\d+)$/.exec(task.resource_id || '');
      if (match) target = context[match[1] === 'character' ? 'characters' : 'scenes'].get(Number(match[2]));
      source = 'image';
    }
    if (target) items.set(task.id, toItem(task, generation, target, source, task.type));
  }
  // Imported/cropped media can predate async_tasks. Show the persisted media
  // with a namespaced ID, without inventing a task or a progress percentage.
  for (const entry of media) {
    if (entry.row.task_id && items.get(entry.row.task_id)?.type === entry.type) continue;
    const item = toItem(null, entry.row, entry.context, entry.source, entry.type);
    items.set(item.id, item);
  }
  for (const row of merges) {
    if (row.task_id && items.get(row.task_id)?.type === 'video_merge') continue;
    const item = toItem(null, row, context.episode, 'video', 'video_merge');
    items.set(item.id, item);
  }
  // Execution records remain owned by the plan runner. Reading the task center
  // never mirrors them into async_tasks or creates another executable task.
  for (const item of executionItems(db, episode, context)) items.set(item.id, item);
  const all = [...items.values()].sort(newestFirst);
  const stats = { active: 0, completed: 0, failed: 0 };
  for (const item of all) stats[bucket(item.status)] += 1;
  const filtered = status === 'all' ? all : all.filter((item) => bucket(item.status) === status);
  return {
    drama_id: episode.drama_id, episode_id: episodeId,
    items: filtered.slice((page - 1) * limit, page * limit),
    total: all.length, filtered_total: filtered.length, stats,
  };
}

module.exports = { listEpisodeTasks };
