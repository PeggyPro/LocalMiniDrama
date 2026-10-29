'use strict';

const { createHash, randomUUID } = require('node:crypto');
const catalog = require('./videoWorkflowCatalog');

function planningError(statusCode, code, message, details) {
  const error = new Error(message);
  Object.assign(error, { statusCode, code, details });
  return error;
}
function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}
function json(value, fallback = null) {
  try { return value == null ? fallback : JSON.parse(value); } catch (_) { return fallback; }
}
function positiveId(value) {
  const id = typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)) ? Number(value) : NaN;
  if (!Number.isSafeInteger(id) || id < 1) throw planningError(400, 'INVALID_ID', '无效的分镜、集或项目 ID');
  return id;
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw planningError(400, 'INVALID_REVISION', '必须提供非负整数 expected_revision');
  return value;
}
function active(row) { return row && !row.deleted_at; }
function getEpisode(db, id) {
  const row = hasTable(db, 'episodes') && db.prepare('SELECT * FROM episodes WHERE id = ?').get(positiveId(id));
  if (!active(row)) throw planningError(404, 'EPISODE_NOT_FOUND', '集不存在');
  if (hasTable(db, 'dramas')) {
    const drama = db.prepare('SELECT * FROM dramas WHERE id = ?').get(row.drama_id);
    if (!active(drama)) throw planningError(404, 'DRAMA_NOT_FOUND', '项目不存在');
  }
  return row;
}
function getStoryboard(db, id) {
  const row = hasTable(db, 'storyboards') && db.prepare('SELECT * FROM storyboards WHERE id = ?').get(positiveId(id));
  if (!active(row)) throw planningError(404, 'STORYBOARD_NOT_FOUND', '分镜不存在');
  const episode = getEpisode(db, row.episode_id);
  return { ...row, drama_id: episode.drama_id };
}
function episodeStoryboards(db, episodeId) {
  getEpisode(db, episodeId);
  if (!hasTable(db, 'storyboards')) return [];
  return db.prepare('SELECT * FROM storyboards WHERE episode_id = ?').all(Number(episodeId))
    .filter(active).sort((a, b) => (a.storyboard_number || 0) - (b.storyboard_number || 0) || a.id - b.id);
}
function planRow(db, id) {
  return hasTable(db, 'storyboard_video_plans') ? db.prepare('SELECT * FROM storyboard_video_plans WHERE storyboard_id = ?').get(id) : null;
}
function requireSchema(db) {
  if (!hasTable(db, 'storyboard_video_plans') || !hasTable(db, 'storyboard_video_dependencies')) {
    throw planningError(409, 'VIDEO_PLANNING_SCHEMA_REQUIRED', '视频规划 schema 尚未迁移');
  }
}

// Migration calls this explicitly. Neither reads nor writes silently migrate old databases.
function ensureVideoPlanningSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS storyboard_video_plans (
    storyboard_id INTEGER PRIMARY KEY,
    recommendation_json TEXT,
    recommendation_revision INTEGER NOT NULL DEFAULT 0,
    recommendation_fingerprint TEXT,
    choice_json TEXT,
    choice_revision INTEGER NOT NULL DEFAULT 0,
    choice_fingerprint TEXT,
    manual_locked INTEGER NOT NULL DEFAULT 0,
    phase TEXT NOT NULL DEFAULT 'draft',
    choice_phase TEXT,
    generation_run_id TEXT,
    invalidated_reason TEXT,
    selected_version_id TEXT,
    adoption_revision INTEGER NOT NULL DEFAULT 0,
    last_execution_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS storyboard_video_dependencies (
    storyboard_id INTEGER PRIMARY KEY,
    source_storyboard_id INTEGER,
    source_version_id TEXT,
    source_choice_revision INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_video_dependency_storyboard ON storyboard_video_dependencies(source_storyboard_id);
  CREATE INDEX IF NOT EXISTS idx_video_dependency_version ON storyboard_video_dependencies(source_version_id);
  CREATE INDEX IF NOT EXISTS idx_video_planning_selection ON storyboard_video_plans(selected_version_id);`);
}

const CONTENT_FIELDS = ['episode_id', 'scene_id', 'storyboard_number', 'title', 'description', 'layout_description',
  'location', 'time', 'duration', 'dialogue', 'narration', 'action', 'atmosphere', 'image_prompt', 'video_prompt',
  'characters', 'shot_type', 'angle', 'movement', 'image_url', 'local_path', 'main_panel_idx', 'composed_image',
  'result', 'emotion', 'emotion_intensity', 'segment_index', 'segment_title', 'angle_h', 'angle_v', 'angle_s',
  'lighting_style', 'depth_of_field', 'polished_prompt', 'continuity_snapshot', 'audio_local_path',
  'narration_audio_local_path', 'creation_mode', 'universal_segment_text', 'first_frame_image_id',
  'last_frame_image_id', 'last_frame_image_url', 'last_frame_local_path'];
function getStoryboardContentFingerprint(db, id) {
  const row = getStoryboard(db, id);
  const content = Object.fromEntries(CONTENT_FIELDS.map((key) => [key, row[key] ?? null]));
  // Legacy local_path stores either an image input or an adopted video output.
  // Output selection is independent of input content. Losing a real image path
  // still changes the fingerprint; do not hide that by refreshing a saved lock.
  if (/\.(?:mp4|webm|mov|mkv|avi|m4v)(?:[?#].*)?$/i.test(String(content.local_path || '').trim())) {
    content.local_path = null;
  }
  if (hasTable(db, 'storyboard_characters')) {
    content.character_ids = db.prepare('SELECT character_id FROM storyboard_characters WHERE storyboard_id = ? ORDER BY character_id').all(row.id).map((r) => r.character_id);
  }
  if (hasTable(db, 'storyboard_props')) {
    content.prop_ids = db.prepare('SELECT prop_id FROM storyboard_props WHERE storyboard_id = ? ORDER BY prop_id').all(row.id).map((r) => r.prop_id);
  }
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}
function normalizeSourceRef(source) {
  if (source == null) return null;
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw planningError(400, 'INVALID_SOURCE', '来源必须为版本或计划分镜');
  if (source.kind === 'version') {
    if (Object.keys(source).some((key) => !['kind', 'version_id', 'tail_segment_id'].includes(key)) ||
        typeof source.version_id !== 'string' || !source.version_id.trim() || source.version_id.length > 200 ||
        (source.tail_segment_id != null && (typeof source.tail_segment_id !== 'string' || !source.tail_segment_id))) {
      throw planningError(400, 'INVALID_SOURCE', '来源版本字段无效');
    }
    return { kind: 'version', version_id: source.version_id, ...(source.tail_segment_id != null ? { tail_segment_id: source.tail_segment_id } : {}) };
  }
  if (source.kind === 'storyboard') {
    if (Object.keys(source).some((key) => !['kind', 'storyboard_id', 'choice_revision'].includes(key))) throw planningError(400, 'INVALID_SOURCE', '计划分镜来源字段无效');
    return { kind: 'storyboard', storyboard_id: positiveId(source.storyboard_id), choice_revision: revision(source.choice_revision) };
  }
  throw planningError(400, 'INVALID_SOURCE', '不支持此来源类型');
}
function versionRow(db, id) {
  return hasTable(db, 'video_plan_versions') ? db.prepare('SELECT * FROM video_plan_versions WHERE id = ?').get(id) : null;
}
function versionEligibility(db, row, options = {}) {
  // Execution owns artifact provenance. Do not infer latent readiness from a model or video URL.
  if (options.versionEligibility) return options.versionEligibility(db, row);
  try {
    const service = require('./videoPlanExecutionService');
    const result = service.listVersions(db, row.storyboard_id);
    const found = (Array.isArray(result) ? result : result.items || []).find((item) => item.id === row.id);
    return found || { continuable: false, blocking_reasons: ['version_provenance_unverified'] };
  } catch (_) {
    return { continuable: false, blocking_reasons: ['version_provenance_unverified'] };
  }
}
function validation(state, reasons = []) { return { state, blocking_reasons: [...new Set(reasons)] }; }
function hasCutInstructions(row) {
  const prompt = [row.video_prompt, row.universal_segment_text].filter(Boolean).join(' ')
    .replace(/(?:不得|不要|不能|禁止|避免|没有|无|不)(?:任何)?(?:切镜|切换镜头|镜头切换|剪辑|转场|跳切)/g, '')
    .replace(/\b(?:no|without|avoid)\s+(?:cuts?|cutting|montage|jump cuts?|transitions?)\b/gi, '');
  return /切镜|切换镜头|镜头切换|多镜头|蒙太奇|剪辑|转场|跳切|切至|\bcut\s+to\b|\bjump\s+cut\b|\bmontage\b|\bscene\s+cuts?\b|<cut>|\[cut\]/i.test(prompt);
}

function validateVideoChoice(db, id, choice, options = {}) {
  const target = getStoryboard(db, id);
  if (!choice) return validation('unplanned');
  const model = catalog.getVideoWorkflow(choice.model_id);
  if (!model) return validation('blocked', ['unknown_model']);
  if (model.blocking_reasons.length) return validation('blocked', model.blocking_reasons);
  let source;
  try { source = normalizeSourceRef(choice.source_ref); }
  catch (_) { return validation('blocked', ['invalid_source_ref']); }
  if (!model.requires_latent) return source ? validation('blocked', ['source_not_allowed']) : validation('ready');
  if (!source) return validation('blocked', ['continuation_source_required']);
  if (hasCutInstructions(target)) return validation('blocked', ['continuation_prompt_contains_cuts']);
  if (source.kind === 'version') {
    const row = versionRow(db, source.version_id);
    if (!row || row.status !== 'completed' || row.deleted_at) return validation('blocked', ['source_version_not_completed']);
    let producer;
    try { producer = getStoryboard(db, row.storyboard_id); }
    catch (_) { return validation('blocked', ['source_storyboard_missing']); }
    if (producer.drama_id !== target.drama_id) return validation('blocked', ['source_cross_drama']);
    if (!row.tail_segment_id || (source.tail_segment_id && row.tail_segment_id !== source.tail_segment_id)) return validation('blocked', ['source_tail_mismatch']);
    if (!catalog.isContinuationCompatible(row.model_id, model.model_id)) return validation('blocked', ['source_model_incompatible']);
    const eligible = versionEligibility(db, row, options);
    if (eligible.continuable !== true) return validation('blocked', eligible.blocking_reasons?.length ? eligible.blocking_reasons : ['source_latent_unavailable']);
    return validation('ready');
  }
  const seen = new Set(options.visited || []);
  seen.add(target.id);
  if (seen.has(source.storyboard_id)) return validation('blocked', ['dependency_cycle']);
  let producer;
  try { producer = getStoryboard(db, source.storyboard_id); }
  catch (_) { return validation('blocked', ['source_storyboard_missing']); }
  if (producer.drama_id !== target.drama_id) return validation('blocked', ['source_cross_drama']);
  const row = planRow(db, producer.id);
  if (!row?.choice_json) return validation('blocked', ['source_choice_missing']);
  if (row.choice_revision !== source.choice_revision) return validation('stale', ['source_choice_revision_changed']);
  if (row.choice_phase !== 'final') return validation('blocked', ['source_is_draft']);
  if (row.invalidated_reason || row.choice_fingerprint !== getStoryboardContentFingerprint(db, producer.id)) return validation('stale', ['source_content_changed']);
  const parent = json(row.choice_json);
  if (!catalog.isContinuationCompatible(parent?.model_id, model.model_id)) return validation('blocked', ['source_model_incompatible']);
  const parentValidation = validateVideoChoice(db, producer.id, parent, { ...options, visited: [...seen] });
  if (!['ready', 'waiting_dependency'].includes(parentValidation.state)) return parentValidation;
  return validation('waiting_dependency', ['source_requires_explicit_plan_binding']);
}

function getStoryboardVideoPlan(db, id, options = {}) {
  const storyboard = getStoryboard(db, id);
  const row = planRow(db, storyboard.id);
  const rec = json(row?.recommendation_json);
  const stored = json(row?.choice_json);
  const choice = stored ? { ...stored, manual_locked: !!row.manual_locked, revision: row.choice_revision } : null;
  let result = validation('unplanned');
  if (row) {
    const fingerprint = getStoryboardContentFingerprint(db, storyboard.id);
    if (choice) {
      result = row.invalidated_reason || row.choice_fingerprint !== fingerprint
        ? validation('stale', [row.invalidated_reason || 'content_changed'])
        : row.choice_phase !== 'final' ? validation('draft', ['draft_not_executable']) : validateVideoChoice(db, storyboard.id, choice, options);
    } else if (rec) {
      result = row.invalidated_reason || row.recommendation_fingerprint !== fingerprint
        ? validation('stale', [row.invalidated_reason || 'content_changed'])
        : row.phase !== 'final' ? validation('draft', ['draft_not_executable'])
          : validation('blocked', rec.blocking_reasons?.length ? rec.blocking_reasons : ['recommendation_not_activated']);
    }
  }
  return {
    storyboard_id: storyboard.id,
    recommendation: rec ? { ...rec, revision: row.recommendation_revision, phase: row.phase, stale: row.recommendation_fingerprint !== getStoryboardContentFingerprint(db, storyboard.id) } : null,
    choice,
    choice_revision: row?.choice_revision || 0,
    validation: result,
    selected_version_id: row?.selected_version_id || null,
    adoption_revision: row?.adoption_revision || 0,
    last_execution: json(row?.last_execution_json),
    content_fingerprint: getStoryboardContentFingerprint(db, storyboard.id),
  };
}
function getEpisodeVideoPlans(db, episodeId, options = {}) {
  return { items: episodeStoryboards(db, episodeId).map((row) => getStoryboardVideoPlan(db, row.id, options)), capabilities_version: catalog.getVideoWorkflowCatalog().version };
}
function syncDependency(db, id, source) {
  db.prepare('DELETE FROM storyboard_video_dependencies WHERE storyboard_id = ?').run(id);
  if (!source) return;
  const sourceStoryboard = source.kind === 'storyboard' ? source.storyboard_id : versionRow(db, source.version_id)?.storyboard_id;
  db.prepare('INSERT INTO storyboard_video_dependencies (storyboard_id, source_storyboard_id, source_version_id, source_choice_revision) VALUES (?, ?, ?, ?)')
    .run(id, sourceStoryboard || null, source.version_id || null, source.choice_revision ?? null);
}
function insertPlanRow(db, id) {
  db.prepare('INSERT OR IGNORE INTO storyboard_video_plans (storyboard_id) VALUES (?)').run(id);
}
function setVideoChoice(db, id, body, options = {}) {
  const target = getStoryboard(db, id);
  requireSchema(db);
  const expected = revision(body?.expected_revision);
  if (typeof body.manual_locked !== 'boolean') throw planningError(400, 'MANUAL_LOCK_REQUIRED', 'manual_locked 必须明确为 true 或 false');
  return db.transaction(() => {
    let row = planRow(db, target.id);
    if ((row?.choice_revision || 0) !== expected) throw planningError(409, 'CHOICE_REVISION_CONFLICT', '视频选择已改变，请刷新后重试');
    const fingerprint = getStoryboardContentFingerprint(db, target.id);
    if (row?.phase === 'draft' && row.recommendation_json && row.choice_phase !== 'final') {
      throw planningError(409, 'DRAFT_PLAN_NOT_FINAL', '分镜规划仍是草稿，最终保存后才能激活视频选择');
    }
    let selected;
    if (!body.manual_locked) {
      const rec = json(row?.recommendation_json);
      if (!rec || row.phase !== 'final' || row.recommendation_fingerprint !== fingerprint || rec.blocking_reasons?.length) {
        throw planningError(409, 'RECOMMENDATION_UNAVAILABLE', '当前没有可跟随的最终推荐，请先重新推荐');
      }
      selected = { model_id: rec.model_id, source_ref: rec.source_ref || null };
      if ((body.model_id != null && catalog.getVideoWorkflow(body.model_id)?.model_id !== selected.model_id) ||
          (body.source_ref != null && JSON.stringify(normalizeSourceRef(body.source_ref)) !== JSON.stringify(selected.source_ref))) {
        throw planningError(400, 'FOLLOW_RECOMMENDATION_MISMATCH', '解除手动锁定应跟随当前推荐');
      }
    } else {
      const model = catalog.getVideoWorkflow(body.model_id);
      if (!model) throw planningError(400, 'UNKNOWN_MODEL', '所选视频工作流未注册');
      selected = { model_id: model.model_id, source_ref: normalizeSourceRef(body.source_ref) };
    }
    const checked = validateVideoChoice(db, target.id, selected, options);
    if (!['ready', 'waiting_dependency'].includes(checked.state)) throw planningError(400, 'INVALID_VIDEO_CHOICE', '视频工作流或来源无效', checked);
    insertPlanRow(db, target.id);
    const changed = db.prepare(`UPDATE storyboard_video_plans SET choice_json = ?, choice_revision = choice_revision + 1,
      choice_fingerprint = ?, manual_locked = ?, choice_phase = 'final', invalidated_reason = NULL, updated_at = datetime('now')
      WHERE storyboard_id = ? AND choice_revision = ?`).run(JSON.stringify(selected), fingerprint, body.manual_locked ? 1 : 0, target.id, expected);
    if (changed.changes !== 1) throw planningError(409, 'CHOICE_REVISION_CONFLICT', '视频选择已改变');
    syncDependency(db, target.id, selected.source_ref);
    return getStoryboardVideoPlan(db, target.id, options);
  })();
}
function invalidateStoryboardVideoPlan(db, id, reason = 'content_changed') {
  // Hooks may run against legacy fixture databases. Invalidation is a no-op there.
  if (!hasTable(db, 'storyboard_video_plans')) return false;
  const result = db.prepare("UPDATE storyboard_video_plans SET invalidated_reason = ?, updated_at = datetime('now') WHERE storyboard_id = ?")
    .run(String(reason).slice(0, 200), positiveId(id));
  return result.changes > 0;
}

function listPlanningSources(db, dramaId, options = {}) {
  const id = positiveId(dramaId);
  const boards = hasTable(db, 'storyboards') ? db.prepare('SELECT * FROM storyboards').all().filter(active) : [];
  const storyboards = [];
  const versions = [];
  for (const board of boards) {
    let current;
    try { current = getStoryboard(db, board.id); } catch (_) { continue; }
    if (current.drama_id !== id) continue;
    const dto = getStoryboardVideoPlan(db, current.id, options);
    const model = catalog.getVideoWorkflow(dto.choice?.model_id);
    const reasons = [];
    if (!dto.choice) reasons.push('source_choice_missing');
    else if (!['ready', 'waiting_dependency'].includes(dto.validation.state)) reasons.push(...dto.validation.blocking_reasons);
    if (!model?.produces_latent) reasons.push('source_does_not_produce_latent');
    storyboards.push({ storyboard_id: current.id, episode_id: current.episode_id, drama_id: id,
      storyboard_number: current.storyboard_number, title: current.title || '', model_id: dto.choice?.model_id || null,
      choice_revision: dto.choice_revision, content_fingerprint: dto.content_fingerprint,
      source_ref: { kind: 'storyboard', storyboard_id: current.id, choice_revision: dto.choice_revision },
      eligible: reasons.length === 0, blocking_reasons: [...new Set(reasons)] });
    if (hasTable(db, 'video_plan_versions')) {
      for (const row of db.prepare('SELECT * FROM video_plan_versions WHERE storyboard_id = ? ORDER BY id').all(current.id)) {
        const eligible = versionEligibility(db, row, options);
        const reasons = [];
        if (row.status !== 'completed' || row.deleted_at) reasons.push('source_version_not_completed');
        if (!row.tail_segment_id) reasons.push('source_tail_missing');
        if (!catalog.getVideoWorkflow(row.model_id)?.produces_latent) reasons.push('source_does_not_produce_latent');
        if (eligible.continuable !== true) reasons.push(...(eligible.blocking_reasons?.length ? eligible.blocking_reasons : ['source_latent_unavailable']));
        versions.push({ id: row.id, version_id: row.id, storyboard_id: current.id, episode_id: current.episode_id, drama_id: id,
          model_id: row.model_id, tail_segment_id: row.tail_segment_id, status: row.status,
          source_ref: { kind: 'version', version_id: row.id, ...(row.tail_segment_id ? { tail_segment_id: row.tail_segment_id } : {}) },
          eligible: reasons.length === 0, continuable: reasons.length === 0, blocking_reasons: [...new Set(reasons)] });
      }
    }
  }
  return { storyboards, versions };
}
function getPlanningPromptContext(db, episodeId, options = {}) {
  const episode = getEpisode(db, episodeId);
  const all = listPlanningSources(db, episode.drama_id, options);
  const maxSources = Math.min(64, Math.max(0, Number.isFinite(options.max_sources) ? Math.floor(options.max_sources) : 32));
  const candidates = [...all.versions, ...all.storyboards].filter((item) => item.eligible).slice(0, maxSources);
  const source_keys = Object.create(null);
  const source_fingerprints = Object.create(null);
  const allowed_sources = candidates.map((item) => {
    const key = 'source_' + createHash('sha256').update(JSON.stringify(item.source_ref)).digest('hex').slice(0, 20);
    source_keys[key] = item.source_ref;
    if (item.content_fingerprint) source_fingerprints[key] = item.content_fingerprint;
    return { key, model_id: item.model_id, episode_id: item.episode_id, storyboard_number: item.storyboard_number,
      label: String(item.title || item.version_id || '').slice(0, 100), kind: item.source_ref.kind };
  });
  const capabilities = catalog.getVideoWorkflowCatalog();
  const allowedModels = capabilities.items.filter((item) => item.recommendable).map((item) => ({
    model_id: item.model_id, label: item.label, stage: item.stage, continuation_model: item.continuation_model,
  }));
  const instruction = [
    '视频规划：在每个分镜对象内添加 video_recommendation:{model_id,reason,continuous_shot?:boolean,predecessor?}，不要另建独立推荐数组。每一镜都必须有推荐。',
    'model_id 只能选下面目录的规范 ID。single/first 不填 predecessor。continue 必须指定 predecessor 且 continuous_shot:true。',
    '续集、同角色、同地点、相近剧情或长时长不等于连续镜头；只有本镜明确从来源末帧连续拍摄、无切镜时才可选 continue。切镜、转场、蒙太奇应选独立 single/first。',
    'continue 的 video_prompt 必须描述连续动作，不得同时要求切镜/剪辑/镜头切换。引用本次较早分镜作为来源时，来源应使用与续接模型配对的 first，以保存 latent。',
    '来源仅可为 {kind:"source_key",key:"下列允许key"}，或本次完整分镜列表中严格较早镜号 {kind:"draft_shot",shot_number:1}。',
    '不得输出数据库 ID、版本 ID、视频 URL、latent 路径、iteration 或执行参数。目录只代表注册，未证明 GPU 可用。',
    `工作流：${JSON.stringify(allowedModels)}`,
    `允许的既有来源：${JSON.stringify(allowed_sources)}`,
  ].join('\n');
  return { instruction, source_keys, source_fingerprints, allowed_sources, episode_id: episode.id, drama_id: episode.drama_id,
    capabilities_version: capabilities.version, generation_run_id: options.generation_run_id || null };
}

function shotNumber(raw) {
  const value = Number(raw?.shot_number ?? raw?.storyboard_number);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
function mapSavedStoryboards(db, episodeId, raw, options) {
  // Explicit saved IDs supplied by the generation run, never a query for the latest shot number.
  const saved = options.saved_storyboards || raw.filter((item) => item.id != null || item.storyboard_id != null);
  const byNumber = new Map();
  const byId = new Map();
  for (const item of saved) {
    const row = getStoryboard(db, item.id ?? item.storyboard_id);
    if (row.episode_id !== Number(episodeId)) throw planningError(400, 'STORYBOARD_EPISODE_MISMATCH', '分镜不属于本集');
    const number = shotNumber(item) ?? shotNumber(row);
    if (byId.has(row.id) || (number != null && byNumber.has(number))) throw planningError(400, 'AMBIGUOUS_SAVED_MAPPING', '本次保存的分镜映射重复');
    byId.set(row.id, row);
    if (number != null) byNumber.set(number, row);
  }
  const used = new Set();
  const mapped = raw.map((item) => {
    const number = shotNumber(item);
    const row = options.saved_storyboards ? byNumber.get(number) : byId.get(Number(item.id ?? item.storyboard_id));
    if (!row || used.has(row.id)) throw planningError(400, 'MISSING_SAVED_MAPPING', '需要本次保存的完整且唯一的分镜 ID 映射');
    used.add(row.id);
    return { raw: item, row, number: number ?? shotNumber(row) };
  });
  return { mapped, byNumber };
}
function resolveRecommendation(db, item, context, byNumber, plannedRevisions, options) {
  const raw = item.raw.video_recommendation;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {
    model_id: null, reason: '本次生成未提供视频推荐', predecessor: null, source_ref: null,
    continuous_shot: false, origin: options.origin || 'ai', blocking_reasons: ['missing_recommendation'],
  };
  const model = catalog.getVideoWorkflow(raw.model_id);
  const reasons = [];
  if (!model || raw.model_id !== model.model_id) reasons.push('unknown_model');
  if (Object.keys(raw).some((key) => !['model_id', 'reason', 'predecessor', 'continuous_shot'].includes(key))) reasons.push('untrusted_recommendation_fields');
  if (model?.requires_latent && raw.continuous_shot !== true) reasons.push('continuation_intent_required');
  if (model?.requires_latent && hasCutInstructions(item.row)) reasons.push('continuation_prompt_contains_cuts');
  let source = null;
  const predecessor = raw.predecessor;
  if (predecessor != null) {
    if (predecessor.kind === 'draft_shot' && Object.keys(predecessor).every((key) => ['kind', 'shot_number'].includes(key))) {
      const number = shotNumber(predecessor);
      const parent = byNumber.get(number);
      if (!parent || number >= item.number || !plannedRevisions.has(parent.id)) reasons.push('invalid_draft_predecessor');
      else source = { kind: 'storyboard', storyboard_id: parent.id, choice_revision: plannedRevisions.get(parent.id) };
    } else if (predecessor.kind === 'source_key' && Object.keys(predecessor).every((key) => ['kind', 'key'].includes(key)) &&
        context && Object.hasOwn(context.source_keys || {}, predecessor.key)) {
      try {
        source = normalizeSourceRef(context.source_keys[predecessor.key]);
        if (source.kind === 'storyboard' && context.source_fingerprints?.[predecessor.key] !== getStoryboardContentFingerprint(db, source.storyboard_id)) reasons.push('source_content_changed');
      } catch (_) { reasons.push('invalid_source_key'); }
    } else reasons.push('untrusted_predecessor');
  }
  if (model?.requires_latent && !source) reasons.push('continuation_source_required');
  if (model && !model.requires_latent && source) reasons.push('source_not_allowed');
  if (model?.blocking_reasons?.length) reasons.push(...model.blocking_reasons);
  return { model_id: model?.model_id || String(raw.model_id || '').slice(0, 120), reason: String(raw.reason || '').slice(0, 1000),
    predecessor: predecessor?.kind === 'draft_shot' ? { kind: 'draft_shot', shot_number: shotNumber(predecessor) }
      : predecessor?.kind === 'source_key' ? { kind: 'source_key', key: String(predecessor.key || '').slice(0, 100) } : null,
    source_ref: source, continuous_shot: raw.continuous_shot === true, origin: options.origin || 'ai', blocking_reasons: [...new Set(reasons)] };
}
function upgradeDraftPredecessors(db, recommendations) {
  const dependents = new Map();
  for (const [id, rec] of recommendations) {
    if (rec.predecessor?.kind !== 'draft_shot' || rec.source_ref?.kind !== 'storyboard' || rec.blocking_reasons.length) continue;
    const sourceId = rec.source_ref.storyboard_id;
    if (!dependents.has(sourceId)) dependents.set(sourceId, []);
    dependents.get(sourceId).push({ id, rec });
  }
  for (const [sourceId, children] of dependents) {
    const parentRec = recommendations.get(sourceId);
    const existing = planRow(db, sourceId);
    if (existing?.manual_locked) {
      const locked = json(existing.choice_json);
      for (const { rec } of children) {
        if (!catalog.isContinuationCompatible(locked?.model_id, rec.model_id)) rec.blocking_reasons.push('source_manual_lock_incompatible');
      }
      continue;
    }
    if (!parentRec || parentRec.blocking_reasons.length || catalog.getVideoWorkflow(parentRec.model_id)?.stage !== 'single') continue;
    const requested = [...new Set(children.map(({ rec }) => rec.model_id))];
    if (requested.length !== 1) {
      for (const { rec } of children) rec.blocking_reasons.push('conflicting_continuation_models');
      continue;
    }
    const first = catalog.getVideoWorkflowCatalog().items.find((model) => model.stage === 'first' && model.input_supported &&
      !model.blocking_reasons.length && model.continuation_model === requested[0]);
    if (!first) continue;
    parentRec.upgraded_from_model_id = parentRec.model_id;
    parentRec.model_id = first.model_id;
    parentRec.reason = `${parentRec.reason}；为后续明确连续镜头升级为可保存 latent 的配对首段`.slice(0, 1000);
  }
}
function applyStoryboardRecommendations(db, episodeId, rawStoryboards, options = {}) {
  getEpisode(db, episodeId);
  requireSchema(db);
  const phase = options.phase ?? (options.final === true ? 'final' : options.draft === true ? 'draft' : null);
  if (!['draft', 'final'].includes(phase)) throw planningError(400, 'PLANNING_PHASE_REQUIRED', '推荐必须明确 draft/final 阶段');
  if (phase === 'final' && (options.partial || options.truncated || options.complete === false)) throw planningError(400, 'INCOMPLETE_RECOMMENDATIONS', '部分或截断的推荐不能激活');
  if (!Array.isArray(rawStoryboards)) throw planningError(400, 'INVALID_RECOMMENDATIONS', '推荐应嵌套在分镜数组内');
  if (rawStoryboards.length > 500) throw planningError(400, 'TOO_MANY_RECOMMENDATIONS', '单次推荐分镜过多');
  const sourceContext = options.source_context || null;
  const episode = getEpisode(db, episodeId);
  if (sourceContext && (sourceContext.episode_id !== episode.id || sourceContext.drama_id !== episode.drama_id)) throw planningError(400, 'SOURCE_CONTEXT_MISMATCH', '来源上下文不属于本集');
  return db.transaction(() => {
    const { mapped, byNumber } = mapSavedStoryboards(db, episodeId, rawStoryboards, options);
    // Future reference revisions are captured before writing any member. Final IDs are already known.
    const plannedRevisions = new Map(mapped.map(({ row }) => {
      const existing = planRow(db, row.id);
      return [row.id, (existing?.choice_revision || 0) + (existing?.manual_locked ? 0 : 1)];
    }));
    for (const item of mapped) {
      const existing = planRow(db, item.row.id);
      const expected = options.expected_fingerprints?.[item.row.id];
      if (expected && expected !== getStoryboardContentFingerprint(db, item.row.id)) throw planningError(409, 'CONTENT_CHANGED', '推荐期间分镜内容已改变');
      if (options.expected_choice_revisions && existing?.choice_revision !== options.expected_choice_revisions[item.row.id] &&
          (existing?.choice_revision || 0) !== options.expected_choice_revisions[item.row.id]) throw planningError(409, 'CHOICE_REVISION_CONFLICT', '推荐期间视频选择已改变');
      if (options.expected_recommendation_revisions && (existing?.recommendation_revision || 0) !== options.expected_recommendation_revisions[item.row.id]) {
        throw planningError(409, 'RECOMMENDATION_REVISION_CONFLICT', '推荐期间已有更新的推荐，请刷新后重试');
      }
      if (phase === 'draft' && existing?.phase === 'final' && existing.generation_run_id === options.generation_run_id && options.generation_run_id) {
        throw planningError(409, 'GENERATION_ALREADY_FINAL', '本次生成已完成，不能应用较晚到达的草稿');
      }
    }
    // Sorting only controls dependency validation; the ID mapping above never depends on ordering.
    mapped.sort((a, b) => (a.number || 0) - (b.number || 0));
    const recommendations = new Map(mapped.map((item) => [item.row.id, resolveRecommendation(db, item, sourceContext, byNumber, plannedRevisions, options)]));
    upgradeDraftPredecessors(db, recommendations);
    for (const item of mapped) {
      const recommendation = recommendations.get(item.row.id);
      const existing = planRow(db, item.row.id);
      const fingerprint = getStoryboardContentFingerprint(db, item.row.id);
      let checked;
      if (!recommendation.blocking_reasons.length && phase === 'final') {
        checked = validateVideoChoice(db, item.row.id, recommendation, options);
        if (!['ready', 'waiting_dependency'].includes(checked.state)) recommendation.blocking_reasons.push(...checked.blocking_reasons);
      }
      insertPlanRow(db, item.row.id);
      db.prepare(`UPDATE storyboard_video_plans SET recommendation_json = ?, recommendation_revision = recommendation_revision + 1,
        recommendation_fingerprint = ?, phase = ?, generation_run_id = ?, updated_at = datetime('now') WHERE storyboard_id = ?`)
        .run(JSON.stringify(recommendation), fingerprint, phase, options.generation_run_id || null, item.row.id);
      if (!existing?.manual_locked) {
        const choice = phase === 'final' && !recommendation.blocking_reasons.length ? { model_id: recommendation.model_id, source_ref: recommendation.source_ref } : null;
        db.prepare(`UPDATE storyboard_video_plans SET choice_json = ?, choice_revision = choice_revision + 1,
          choice_fingerprint = ?, choice_phase = ?, invalidated_reason = NULL, updated_at = datetime('now') WHERE storyboard_id = ?`)
          .run(choice ? JSON.stringify(choice) : null, fingerprint, phase, item.row.id);
        syncDependency(db, item.row.id, choice?.source_ref);
      }
    }
    return getEpisodeVideoPlans(db, episodeId, options);
  })();
}

function heuristicRecommendation(row) {
  const text = [row.title, row.description, row.action, row.video_prompt, row.universal_segment_text].filter(Boolean).join(' ');
  const action = /打斗|追逐|武打|战斗|搏斗|fight|combat|chase/i.test(text);
  const long = Number(row.duration) > 12;
  return { model_id: long ? (action ? 'h3-long-action-first' : 'h3-long-drama-first') : (action ? 'h3-action' : 'h3-drama'),
    reason: `规则推荐（非 AI）：${action ? '动作场景' : '叙事场景'}${long ? '，长镜使用可续接首段' : '，使用单段工作流'}；未执行 GPU 验证` };
}
async function recommendEpisodeVideoPlans(db, cfg, log, episodeId, body = {}, options = {}) {
  requireSchema(db);
  const all = episodeStoryboards(db, episodeId);
  let rows = all;
  if (body.storyboard_ids != null) {
    if (!Array.isArray(body.storyboard_ids) || !body.storyboard_ids.length) throw planningError(400, 'INVALID_STORYBOARD_IDS', 'storyboard_ids 需为非空数组');
    const ids = body.storyboard_ids.map(positiveId);
    if (new Set(ids).size !== ids.length || ids.some((id) => !all.some((row) => row.id === id))) throw planningError(400, 'INVALID_STORYBOARD_IDS', '重推荐只能指定本集唯一的现有分镜');
    rows = all.filter((row) => ids.includes(row.id));
  }
  if (!rows.length) return getEpisodeVideoPlans(db, episodeId);
  if (rows.length > 100) throw planningError(400, 'RECOMMENDATION_LIMIT', '请分批重推荐，每次最多 100 镜');
  const strategy = body.strategy || 'heuristic';
  if (!['ai', 'heuristic'].includes(strategy)) throw planningError(400, 'INVALID_STRATEGY', 'strategy 必须为 ai 或 heuristic');
  const context = getPlanningPromptContext(db, episodeId, options);
  const expected_fingerprints = Object.fromEntries(rows.map((row) => [row.id, getStoryboardContentFingerprint(db, row.id)]));
  const expected_choice_revisions = Object.fromEntries(rows.map((row) => [row.id, planRow(db, row.id)?.choice_revision || 0]));
  const expected_recommendation_revisions = Object.fromEntries(rows.map((row) => [row.id, planRow(db, row.id)?.recommendation_revision || 0]));
  let raw = rows.map((row) => ({ id: row.id, shot_number: row.storyboard_number, video_recommendation: heuristicRecommendation(row) }));
  if (strategy === 'ai') {
    // The only network entry in this module is this explicit user endpoint path. Hooks and reads are pure local operations.
    const generate = options.generateText || require('./aiClient').generateText;
    const prompt = JSON.stringify({ storyboards: rows.map((row) => ({ shot_number: row.storyboard_number,
      title: String(row.title || '').slice(0, 200), description: String(row.description || '').slice(0, 1800),
      action: String(row.action || '').slice(0, 1000), video_prompt: String(row.video_prompt || '').slice(0, 1800), duration: row.duration })) });
    const output = await generate(db, log, 'text', prompt, context.instruction + '\n仅返回完整 JSON 对象 {"storyboards":[{"shot_number":1,"video_recommendation":{...}}]}，不修改镜号。',
      { model: body.model || undefined, temperature: 0.2, max_tokens: 8192, scene_key: 'storyboard_extraction' });
    const text = typeof output === 'string' ? output : output?.content;
    let parsed;
    try { parsed = JSON.parse(String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
    catch (_) { throw planningError(400, 'INCOMPLETE_RECOMMENDATIONS', 'AI 未返回完整推荐 JSON；保留原推荐和选择'); }
    if (!Array.isArray(parsed?.storyboards) || parsed.storyboards.length !== rows.length || parsed.storyboards.some((item) => !item.video_recommendation)) {
      throw planningError(400, 'INCOMPLETE_RECOMMENDATIONS', 'AI 推荐必须完整覆盖所选分镜');
    }
    raw = parsed.storyboards;
  }
  return applyStoryboardRecommendations(db, episodeId, raw, { ...options, phase: 'final', origin: strategy,
    source_context: context, saved_storyboards: rows, generation_run_id: randomUUID(), expected_fingerprints, expected_choice_revisions, expected_recommendation_revisions });
}

module.exports = { ensureVideoPlanningSchema, getStoryboardVideoPlan, getEpisodeVideoPlans, setVideoChoice,
  invalidateStoryboardVideoPlan, getPlanningPromptContext, applyStoryboardRecommendations,
  getStoryboardContentFingerprint, validateVideoChoice, listPlanningSources, recommendEpisodeVideoPlans, hasCutInstructions, planningError };
