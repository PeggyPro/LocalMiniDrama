// AI runs outside SQLite transactions. Candidate application and task completion are atomic.
const aiClient = require('./aiClient');
const promptI18n = require('./promptI18n');
const taskService = require('./taskService');
const dramaService = require('./dramaService');
const revisions = require('./episodeRevisionService');
const { loadConfig } = require('../config');

function premiseText(body, fallback = '') {
  const value = body.premise ?? body.prompt ?? body.text ?? fallback;
  if (typeof value !== 'string' || !value.trim()) throw revisions.apiError(400, 'BAD_REQUEST', '请提供故事梗概');
  return value.trim();
}

function episodeCount(value) {
  return value === undefined ? 1 : revisions.positiveInteger(value, 'episode_count');
}

function parseStoryResponse(raw, count, { single = false } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('AI 返回的剧本为空');
  // Permit a whole JSON code fence, but never repair/truncate JSON or use prose as a script.
  let text = raw.trim();
  const fence = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
  if (fence) text = fence[1].trim();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { throw new Error('AI 返回的剧本不是有效 JSON'); }
  let list = Array.isArray(parsed) ? parsed : parsed?.episodes ?? parsed?.data;
  if (!Array.isArray(list) && count === 1 && parsed && typeof parsed === 'object' && typeof parsed.content === 'string') list = [parsed];
  if (!Array.isArray(list) || list.length !== count) throw new Error(`AI 返回的分集数量必须为 ${count}`);
  const numbers = new Set();
  return list.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
        || typeof item.content !== 'string' || !item.content.trim()) {
      throw new Error('AI 返回的每集 content 必须为非空字符串');
    }
    // Single-episode generation has no authority over human titles, numbers or IDs.
    if (single) return { episode: 1, content: item.content.trim() };
    if (typeof item.title !== 'string' || !item.title.trim()) throw new Error('AI 返回的每集 title 必须为非空字符串');
    const number = revisions.positiveInteger(item.episode ?? index + 1, 'AI episode');
    if (number > count || numbers.has(number)) throw new Error('AI 返回的分集编号必须唯一且处于请求范围内');
    numbers.add(number);
    return { episode: number, title: item.title.trim(), content: item.content.trim() };
  });
}

async function generateStory(db, log, body) {
  const premise = premiseText(body);
  const count = episodeCount(body.episode_count);
  const cfg = loadConfig();
  const system = promptI18n.getStoryExpansionSystemPrompt(cfg, count);
  const user = promptI18n.buildStoryExpansionUserPrompt(cfg, premise, body.style || body.genre, body.type, count);
  const raw = await aiClient.generateText(db, log, 'text', user, system, {
    scene_key: 'story_generation', model: body.model || undefined,
    temperature: 0.8, min_max_tokens: Math.max(2000, count * 2200),
  });
  return { episodes: parseStoryResponse(raw, count) };
}

function findActiveTask(db, type, resourceId) {
  return db.prepare(`SELECT id FROM async_tasks WHERE type = ? AND resource_id = ?
    AND status IN ('pending', 'processing') AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`)
    .get(type, String(resourceId));
}

function completeTask(db, taskId, result) {
  if (!taskService.updateTaskResult(db, taskId, result)) throw new Error('任务已结束，无法保存剧本');
  return result;
}

async function processStoryGeneration(db, log, taskId, req) {
  const active = () => taskService.isTaskActive(db, taskId, 'story_generation', req.drama_id);
  if (!active()) return;
  taskService.updateTaskStatus(db, taskId, 'processing', 10, '正在生成剧本...');
  try {
    const { episodes } = await generateStory(db, log, req);
    return db.transaction(() => {
      if (!active()) return;
      const drama = db.prepare('SELECT episodes_revision FROM dramas WHERE id = ? AND deleted_at IS NULL').get(req.drama_id);
      const candidate = { episodes: episodes.map((ep) => ({
        episode_number: req.mode === 'append' ? req.append_start + ep.episode - 1 : ep.episode,
        title: ep.title, script_content: ep.content,
      })) };
      if (!drama || drama.episodes_revision !== req.expected_collection_revision) {
        return completeTask(db, taskId, { applied: false, conflict: true, candidate, drama_id: req.drama_id });
      }
      const saved = dramaService.saveEpisodes(db, log, req.drama_id, {
        ...candidate, mode: req.mode, expected_collection_revision: req.expected_collection_revision,
      });
      if (req.summary !== undefined || req.genre !== undefined || req.drama_style !== undefined || req.metadata !== undefined || req.title !== undefined) {
        dramaService.saveOutline(db, log, req.drama_id, {
          title: req.title, summary: req.summary, genre: req.genre, style: req.drama_style, metadata: req.metadata,
        });
      }
      return completeTask(db, taskId, {
        applied: true, drama_id: req.drama_id, episode_count: episodes.length, episodes_revision: saved.episodes_revision,
      });
    })();
  } catch (err) {
    log.error('processStoryGeneration failed', { task_id: taskId, error: err.message });
    taskService.updateTaskError(db, taskId, err.message || '故事生成失败');
  }
}

function startStoryGeneration(db, log, input) {
  const drama = revisions.getDrama(db, input.drama_id);
  const mode = input.mode ?? 'replace';
  if (!['append', 'replace'].includes(mode)) throw revisions.apiError(400, 'BAD_REQUEST', 'mode 必须为 append 或 replace');
  const expected = input.expected_collection_revision === undefined
    ? drama.episodes_revision : revisions.revision(input.expected_collection_revision, 'expected_collection_revision');
  revisions.assertRevision(drama.episodes_revision, expected, true);
  const req = {
    ...input, drama_id: drama.id, premise: premiseText(input, drama.description || ''),
    episode_count: episodeCount(input.episode_count), mode, expected_collection_revision: expected,
    append_start: Number(db.prepare('SELECT MAX(episode_number) AS number FROM episodes WHERE drama_id = ?').get(drama.id).number || 0) + 1,
    ...(input.metadata !== undefined ? { metadata: JSON.parse(JSON.stringify(input.metadata)) } : {}),
  };
  const existing = findActiveTask(db, 'story_generation', drama.id);
  if (existing) return existing.id;
  const task = taskService.createTask(db, log, 'story_generation', String(drama.id));
  setImmediate(() => { processStoryGeneration(db, log, task.id, req).catch((err) => {
    log.error('processStoryGeneration fatal', { task_id: task.id, error: err.message });
    taskService.updateTaskError(db, task.id, err.message);
  }); });
  return task.id;
}

function prepareEpisodeRequest(db, dramaId, episodeId, input) {
  const episode = revisions.getEpisode(db, dramaId, episodeId);
  const expected = revisions.revision(input.expected_revision);
  revisions.assertRevision(episode.revision, expected);
  // Capture the stored source and optional instructions before queueing. A request
  // cannot replace the original, and an explicit empty premise disables fallback.
  const source = episode.source_text ?? '';
  const premise = input.premise === undefined ? episode.description ?? '' : input.premise;
  if (typeof premise !== 'string') throw revisions.apiError(400, 'BAD_REQUEST', 'premise（改编要求）必须为文本');
  if (!source.trim() && !premise.trim()) throw revisions.apiError(400, 'BAD_REQUEST', '请填写本集原文或改编要求后再生成剧本');
  if (input.reference_previous !== undefined && typeof input.reference_previous !== 'boolean') throw revisions.apiError(400, 'BAD_REQUEST', 'reference_previous 必须为布尔值');
  for (const key of ['style', 'type', 'model']) {
    if (input[key] != null && typeof input[key] !== 'string') throw revisions.apiError(400, 'BAD_REQUEST', `${key} 必须为文本`);
  }
  const drama = revisions.getDrama(db, dramaId);
  const previous = input.reference_previous ? db.prepare(`SELECT episode_number, title, description, script_content
    FROM episodes WHERE drama_id = ? AND episode_number < ? AND deleted_at IS NULL ORDER BY episode_number DESC, id DESC LIMIT 1`)
    .get(drama.id, episode.episode_number) : null;
  return {
    drama_id: drama.id, episode_id: episode.id, episode_number: episode.episode_number,
    expected_revision: expected, source_text: source, premise, title: episode.title,
    style: input.style, type: input.type, model: input.model,
    background: drama.description || '', previous,
  };
}

async function processEpisodeStoryGeneration(db, log, taskId, req) {
  const active = () => taskService.isTaskActive(db, taskId, 'episode_story_generation', req.episode_id);
  if (!active()) return;
  taskService.updateTaskStatus(db, taskId, 'processing', 10, '正在生成本集剧本...');
  try {
    // Detect an edit/delete before calling AI as well as after it returns.
    const before = revisions.getEpisode(db, req.drama_id, req.episode_id);
    revisions.assertRevision(before.revision, req.expected_revision);
    const prompts = promptI18n.buildEpisodeStoryPrompts(loadConfig(), req);
    const raw = await aiClient.generateText(db, log, 'text', prompts.user, prompts.system, {
      scene_key: 'story_generation', model: req.model || undefined, temperature: 0.8, min_max_tokens: 2200,
    });
    const [generated] = parseStoryResponse(raw, 1, { single: true });
    const candidate = { script_content: generated.content };
    return db.transaction(() => {
      if (!active()) return;
      const target = db.prepare(`SELECT e.revision FROM episodes e JOIN dramas d ON d.id = e.drama_id
        WHERE e.id = ? AND e.drama_id = ? AND e.deleted_at IS NULL AND d.deleted_at IS NULL`).get(req.episode_id, req.drama_id);
      if (!target || target.revision !== req.expected_revision) {
        return completeTask(db, taskId, { applied: false, conflict: true, candidate, drama_id: req.drama_id, episode_id: req.episode_id });
      }
      const saved = revisions.updateEpisode(db, req.drama_id, req.episode_id, { ...candidate, expected_revision: req.expected_revision });
      return completeTask(db, taskId, { applied: true, drama_id: req.drama_id, episode_id: req.episode_id, revision: saved.revision, episode_count: 1 });
    })();
  } catch (err) {
    log.error('processEpisodeStoryGeneration failed', { task_id: taskId, error: err.message });
    taskService.updateTaskError(db, taskId, err.message || '本集故事生成失败');
  }
}

function startEpisodeStoryGeneration(db, log, dramaId, episodeId, input) {
  const req = prepareEpisodeRequest(db, dramaId, episodeId, input);
  const existing = findActiveTask(db, 'episode_story_generation', req.episode_id);
  if (existing) return existing.id;
  const task = taskService.createTask(db, log, 'episode_story_generation', String(req.episode_id));
  setImmediate(() => { processEpisodeStoryGeneration(db, log, task.id, req).catch((err) => {
    log.error('processEpisodeStoryGeneration fatal', { task_id: task.id, error: err.message });
    taskService.updateTaskError(db, task.id, err.message);
  }); });
  return task.id;
}

module.exports = { generateStory, startStoryGeneration, startEpisodeStoryGeneration, parseStoryResponse, prepareEpisodeRequest, processStoryGeneration, processEpisodeStoryGeneration };
