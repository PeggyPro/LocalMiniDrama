const { randomUUID, randomBytes } = require('node:crypto');
const { ensureVideoExecutionSchema, hasExecutionSchema } = require('./videoExecutionSchema');
const { createExecutionProvider, snapshotConnection, safeError } = require('./videoExecutionProvider');
const { createExecutionMedia } = require('./videoExecutionMedia');
const { artifactEligibility } = require('./videoExecutionLatent');
const catalog = require('./videoWorkflowCatalog');
const planning = require('./videoPlanningService');
const { flattenModelIds } = require('./modelId');
const { isNativeComfyUIConfig } = require('./comfyUIVideoClient');

const json = (value, fallback = null) => { try { return value == null ? fallback : JSON.parse(value); } catch (_) { return fallback; } };
const now = () => new Date().toISOString();
function fail(status, code) { const error = new Error(code); Object.assign(error, { status, statusCode: status, code }); throw error; }
function table(db, name) { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); }
function storyboard(db, id) {
  const row = table(db, 'storyboards') && db.prepare('SELECT * FROM storyboards WHERE id=?').get(Number(id));
  const episode = row && table(db, 'episodes') && db.prepare('SELECT * FROM episodes WHERE id=?').get(row.episode_id);
  if (!row || row.deleted_at || !episode || episode.deleted_at) fail(404, 'storyboard_not_found');
  return { ...row, drama_id: episode.drama_id };
}
function planningRow(db, id) {
  return table(db, 'storyboard_video_plans') ? db.prepare('SELECT * FROM storyboard_video_plans WHERE storyboard_id=?').get(id) : null;
}
function requireSchema(db) { if (!hasExecutionSchema(db) || !table(db, 'storyboard_video_plans')) fail(409, 'video_execution_schema_required'); }
function segment(db, id) {
  const row = id && db.prepare('SELECT * FROM video_segments WHERE id=?').get(id);
  return row ? { ...row, latent_artifact: json(row.latent_artifact), workflow: json(row.workflow_snapshot) } : null;
}
function nodeValue(row) {
  return { ...row, choice: json(row.choice_snapshot), inputs: json(row.inputs, {}), workflow: json(row.workflow_snapshot, {}),
    connection: json(row.connection_snapshot, {}), source_ref: json(row.source_ref), blocking_reasons: json(row.blocking_reasons, []) };
}
function versionValue(db, row) {
  const tail = segment(db, row.tail_segment_id);
  const reasons = !tail || tail.status !== 'completed' ? ['tail_segment_not_completed'] : artifactEligibility(tail.latent_artifact, tail);
  if (row.status !== 'completed') reasons.push('version_not_completed');
  const segmentIds = json(row.segment_ids, []);
  if (!segmentIds.length || segmentIds.at(-1) !== row.tail_segment_id || segmentIds.some(id => segment(db, id)?.storyboard_id !== row.storyboard_id)) reasons.push('version_membership_invalid');
  return { ...row, segment_ids: segmentIds, continuable: reasons.length === 0, eligible: reasons.length === 0,
    blocking_reasons: [...new Set(reasons)], continuation_model: tail?.latent_artifact?.continuation_model || null,
    latent_structure_verified: tail?.latent_artifact?.structure_verified === true, latent_loadability_verified: false,
    latent_verification_note: '续接资格基于精确任务来源与 safetensors 结构；尚未验证 GPU 加载和张量语义。',
    source_ref: { kind: 'version', version_id: row.id, tail_segment_id: row.tail_segment_id } };
}
function listVersions(db, storyboardId) {
  if (!hasExecutionSchema(db)) return { items: [] };
  return { items: db.prepare('SELECT * FROM video_plan_versions WHERE storyboard_id=? ORDER BY created_at DESC, id').all(Number(storyboardId)).map(row => versionValue(db, row)) };
}
function listSources(db, dramaId) {
  const boards = table(db, 'storyboards') && table(db, 'episodes') ? db.prepare(`SELECT s.*, e.drama_id FROM storyboards s JOIN episodes e ON s.episode_id=e.id WHERE e.drama_id=?`).all(Number(dramaId)) : [];
  const active = boards.filter(row => !row.deleted_at).filter(row => !db.prepare('SELECT * FROM episodes WHERE id=?').get(row.episode_id)?.deleted_at);
  const sources = active.map(row => {
    const p = planningRow(db, row.id), choice = json(p?.choice_json), workflow = catalog.getVideoWorkflow(choice?.model_id);
    const validation = planning.getStoryboardVideoPlan(db, row.id).validation;
    const reasons = ['ready', 'waiting_dependency'].includes(validation.state) ? [] : [...validation.blocking_reasons];
    if (!choice || !workflow?.produces_latent) reasons.push('source_does_not_produce_latent');
    if (p?.choice_phase !== 'final') reasons.push('source_is_draft');
    if (p?.invalidated_reason || (p?.choice_fingerprint && p.choice_fingerprint !== planning.getStoryboardContentFingerprint(db, row.id))) reasons.push('source_stale');
    return { storyboard_id: row.id, episode_id: row.episode_id, drama_id: row.drama_id, title: row.title,
      model_id: choice?.model_id || null, choice_revision: p?.choice_revision || 0, eligible: !reasons.length, blocking_reasons: reasons,
      source_ref: { kind: 'storyboard', storyboard_id: row.id, choice_revision: p?.choice_revision || 0 } };
  });
  return { storyboards: sources, versions: active.flatMap(row => listVersions(db, row.id).items.map(version => ({ ...version, episode_id: row.episode_id, drama_id: row.drama_id }))) };
}
function getPlan(db, id) {
  if (!hasExecutionSchema(db)) return null;
  const plan = db.prepare('SELECT * FROM video_execution_plans WHERE id=?').get(id);
  if (!plan) return null;
  const nodes = db.prepare('SELECT * FROM video_execution_nodes WHERE plan_id=? ORDER BY position').all(id).map(row => {
    const node = nodeValue(row);
    const a = db.prepare('SELECT * FROM video_execution_attempts WHERE node_id=?').get(row.id);
    return { id: node.id, storyboard_id: node.storyboard_id, model_id: node.model_id, choice_revision: node.choice_revision,
      inputs: node.inputs, source_ref: node.source_ref, source_node_id: node.source_node_id,
      source_version_id: node.source_version_id, source_segment_id: node.source_segment_id,
      append_version_id: node.append_version_id, status: node.status, blocking_reasons: node.blocking_reasons,
      version_id: node.version_id, connection: { config_id: node.connection.config_id, identity: node.connection.identity },
      availability: node.workflow.availability || 'registered_unverified',
      attempt: a ? { id: a.id, status: a.status, task_id: a.task_id, prompt_id: a.prompt_id, error: a.error } : null };
  });
  return { ...plan, nodes };
}
function adoptVersion(db, storyboardId, body = {}) {
  requireSchema(db);
  storyboard(db, storyboardId);
  if (!Number.isSafeInteger(body.expected_revision) || body.expected_revision < 0) fail(400, 'adoption_revision_required');
  const row = db.prepare('SELECT * FROM video_plan_versions WHERE id=?').get(String(body.version_id || ''));
  if (!row || row.storyboard_id !== Number(storyboardId)) fail(400, 'version_not_owned_by_storyboard');
  if (row.status !== 'completed' || (!row.video_url && !row.local_path)) fail(400, 'version_not_playable');
  const result = db.prepare(`UPDATE storyboard_video_plans SET selected_version_id=?, adoption_revision=adoption_revision+1, updated_at=?
    WHERE storyboard_id=? AND adoption_revision=?`).run(row.id, now(), Number(storyboardId), body.expected_revision);
  if (!result.changes) fail(409, 'adoption_revision_conflict');
  return planning.getStoryboardVideoPlan(db, storyboardId);
}
const INPUTS = new Set(['prompt', 'duration', 'aspect_ratio', 'resolution', 'style', 'seed', 'steps', 'width', 'height', 'image_url', 'first_frame_url', 'last_frame_url', 'reference_image_urls']);
function freezeInputs(row, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !INPUTS.has(key))) fail(400, 'invalid_plan_inputs');
  const out = { prompt: row.video_prompt || row.description || '', duration: Number(row.duration) > 0 ? Number(row.duration) : 5, aspect_ratio: '16:9', ...input };
  if (typeof out.prompt !== 'string') fail(400, 'prompt_required');
  if (!Number.isFinite(out.duration) || out.duration <= 0 || out.duration > 120) fail(400, 'invalid_duration');
  for (const key of ['image_url', 'first_frame_url', 'last_frame_url', 'aspect_ratio', 'resolution', 'style']) {
    if (out[key] != null && typeof out[key] !== 'string') fail(400, 'invalid_' + key);
  }
  const style = (out.style || '').trim();
  if (style && !out.prompt.toLowerCase().includes(style.toLowerCase())) out.prompt = out.prompt ? `${out.prompt}. Style: ${style}` : `Style: ${style}`;
  if (!out.prompt.trim() || out.prompt.length > 100000) fail(400, 'prompt_required');
  if (out.seed == null || out.seed === -1) out.seed = randomBytes(6).readUIntBE(0, 6);
  for (const key of ['seed', 'steps', 'width', 'height']) {
    if (out[key] != null && (!Number.isSafeInteger(out[key]) || out[key] < 0)) fail(400, 'invalid_' + key);
  }
  if (out.reference_image_urls != null && (!Array.isArray(out.reference_image_urls) || out.reference_image_urls.length > 9 || out.reference_image_urls.some(url => typeof url !== 'string' || !url))) fail(400, 'invalid_reference_images');
  return JSON.parse(JSON.stringify(out));
}
function chooseConfig(db, configId, model) {
  if (!table(db, 'ai_service_configs')) return null;
  const rows = db.prepare("SELECT * FROM ai_service_configs WHERE service_type='video'").all().filter(c => !c.deleted_at && c.is_active && isNativeComfyUIConfig(c));
  if (configId != null) return rows.find(c => c.id === Number(configId)) || null;
  return rows.sort((a, b) => (Number(flattenModelIds(b.model).includes(model)) - Number(flattenModelIds(a.model).includes(model))) || (b.is_default - a.is_default) || (b.priority - a.priority) || (a.id - b.id))[0] || null;
}
function sourceReasons(source, target) {
  if (!source) return ['source_not_completed'];
  const reasons = artifactEligibility(source.latent_artifact, source);
  if (source.status !== 'completed') reasons.push('source_not_completed');
  if (source.connection_identity !== target.connection.identity) reasons.push('source_connection_mismatch');
  if (source.workflow?.family !== target.workflow.family || source.latent_artifact?.continuation_model !== target.model_id ||
      source.workflow?.continuation_model !== target.model_id || !target.workflow.requires_latent) reasons.push('source_continuation_incompatible');
  return [...new Set(reasons)];
}

function createVideoPlanExecutionService({ provider = createExecutionProvider(), media = createExecutionMedia(), autoSchedule = true, pollIntervalMs = 10000 } = {}) {
  const locks = new WeakMap();
  const timers = new WeakMap();
  function recordNode(db, id, status, reasons = []) {
    db.prepare('UPDATE video_execution_nodes SET status=?, blocking_reasons=?, updated_at=? WHERE id=?').run(status, JSON.stringify(reasons), now(), id);
  }
  function updateSummary(db, planId) {
    const nodes = db.prepare('SELECT * FROM video_execution_nodes WHERE plan_id=? ORDER BY position').all(planId);
    const states = nodes.map(n => n.status);
    let status = states.every(s => s === 'completed') ? 'completed'
      : states.some(s => ['queued', 'preflighting', 'submitting', 'processing'].includes(s)) ? 'running'
      : states.includes('submitted_unknown') ? 'submitted_unknown'
      : states.includes('completed') ? 'partial'
      : states.some(s => ['failed', 'media_failed'].includes(s)) ? 'failed' : 'blocked';
    db.prepare('UPDATE video_execution_plans SET status=?, updated_at=? WHERE id=?').run(status, now(), planId);
    for (const n of nodes) {
      db.prepare('UPDATE storyboard_video_plans SET last_execution_json=? WHERE storyboard_id=?').run(JSON.stringify({
        plan_id: planId, node_id: n.id, status: n.status, model_id: n.model_id, version_id: n.version_id,
        blocking_reasons: json(n.blocking_reasons, []), updated_at: n.updated_at,
      }), n.storyboard_id);
    }
  }
  async function previewPlan(db, cfg, log, body = {}) {
    requireSchema(db);
    const ids = body.storyboard_ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 200 || ids.some(id => !Number.isSafeInteger(Number(id)) || Number(id) <= 0) || new Set(ids.map(Number)).size !== ids.length) fail(400, 'finite_distinct_storyboard_ids_required');
    const boards = ids.map(id => storyboard(db, id));
    if (boards.some(row => row.episode_id !== Number(body.episode_id))) fail(400, 'targets_must_belong_to_episode');
    if (body.inputs != null && (typeof body.inputs !== 'object' || Array.isArray(body.inputs) || Object.keys(body.inputs).some(id => !ids.map(String).includes(id)))) fail(400, 'invalid_plan_input_targets');
    if (body.append_version_id != null && (typeof body.append_version_id !== 'string' || ids.length !== 1)) fail(400, 'append_requires_single_target');
    const planId = randomUUID(), created = now();
    const nodes = boards.map((row, position) => {
      const p = planningRow(db, row.id), choice = json(p?.choice_json), model = choice?.model_id || '';
      const workflow = { ...catalog.getVideoWorkflow(model), ...catalog.getVideoWorkflowDefinition(model) };
      // Registry uses `kind`, public catalogue uses `family`; preserve both in the frozen contract.
      const validation = planning.getStoryboardVideoPlan(db, row.id).validation;
      const reasons = ['unplanned', 'draft', 'blocked', 'stale'].includes(validation.state) ? [...validation.blocking_reasons] : [];
      if (!model || !workflow.model_id) reasons.push('workflow_not_selected');
      reasons.push(...(workflow.blocking_reasons || []));
      if (workflow.application_supported === false || workflow.input_supported === false) reasons.push('workflow_inputs_unsupported');
      let connection = {};
      try { connection = (provider.snapshotConnection || snapshotConnection)(chooseConfig(db, body.config_id, model), cfg); }
      catch (_) { reasons.push('native_connection_not_configured'); }
      return { id: randomUUID(), plan_id: planId, position, storyboard_id: row.id, model_id: model,
        choice_revision: p?.choice_revision || 0, content_fingerprint: planning.getStoryboardContentFingerprint(db, row.id),
        choice, inputs: freezeInputs(row, body.inputs?.[row.id]), workflow, connection,
        source_ref: choice?.source_ref || null, source_node_id: null, source_version_id: null, source_segment_id: null,
        append_version_id: body.append_version_id || null, status: 'ready', blocking_reasons: reasons, created_at: created, updated_at: created };
    });
    for (const node of nodes) {
      if (node.workflow.requires_latent && planning.hasCutInstructions({ video_prompt: node.inputs.prompt })) node.blocking_reasons.push('continuation_prompt_has_cut_instructions');
      const ref = node.source_ref;
      if (node.workflow.requires_latent) {
        if (ref?.kind === 'storyboard') {
          let parent;
          try { parent = storyboard(db, ref.storyboard_id); } catch (_) { node.blocking_reasons.push('source_storyboard_missing'); }
          const parentPlan = parent && planningRow(db, parent.id);
          if (parent && parent.drama_id !== boards[0].drama_id) node.blocking_reasons.push('source_outside_drama');
          if (!parentPlan || parentPlan.choice_revision !== ref.choice_revision) node.blocking_reasons.push('source_choice_revision_changed');
          const producer = nodes.find(n => n.storyboard_id === ref.storyboard_id);
          if (producer) {
            node.source_node_id = producer.id;
            if (producer.workflow.family !== node.workflow.family || producer.workflow.continuation_model !== node.model_id || !producer.workflow.produces_latent) node.blocking_reasons.push('source_continuation_incompatible');
            if (producer.connection.identity !== node.connection.identity) node.blocking_reasons.push('source_connection_mismatch');
          } else node.blocking_reasons.push('source_outside_frozen_plan_unbound');
          node.status = 'waiting_dependency';
        } else if (ref?.kind === 'version') {
          const version = db.prepare('SELECT * FROM video_plan_versions WHERE id=?').get(ref.version_id);
          if (!version) node.blocking_reasons.push('source_version_missing');
          else {
            let parent;
            try { parent = storyboard(db, version.storyboard_id); } catch (_) {}
            if (!parent || parent.drama_id !== boards[0].drama_id) node.blocking_reasons.push('source_outside_drama');
            if (ref.tail_segment_id && ref.tail_segment_id !== version.tail_segment_id) node.blocking_reasons.push('source_tail_mismatch');
            node.source_version_id = version.id;
            node.source_segment_id = version.tail_segment_id;
            node.blocking_reasons.push(...versionValue(db, version).blocking_reasons, ...sourceReasons(segment(db, version.tail_segment_id), node));
          }
        } else node.blocking_reasons.push('continuation_source_required');
      } else if (ref) node.blocking_reasons.push('source_not_allowed_for_workflow');
      if (node.append_version_id) {
        const version = db.prepare('SELECT * FROM video_plan_versions WHERE id=?').get(node.append_version_id);
        if (!version || version.storyboard_id !== node.storyboard_id || version.status !== 'completed' ||
            ref?.kind !== 'version' || ref.version_id !== node.append_version_id) fail(400, 'append_requires_same_storyboard_source_version');
      }
    }
    const cycle = (node, path = new Set()) => {
      if (path.has(node.id)) return true;
      const parent = nodes.find(n => n.id === node.source_node_id);
      return parent ? cycle(parent, new Set([...path, node.id])) : false;
    };
    for (const node of nodes) {
      if (cycle(node)) node.blocking_reasons.push('dependency_cycle');
      node.blocking_reasons = [...new Set(node.blocking_reasons)];
      if (node.blocking_reasons.some(r => r !== 'source_outside_frozen_plan_unbound')) node.status = 'blocked';
    }
    db.transaction(() => {
      db.prepare('INSERT INTO video_execution_plans(id,episode_id,drama_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(planId, Number(body.episode_id), boards[0].drama_id, 'preview', created, created);
      const insert = db.prepare(`INSERT INTO video_execution_nodes(id,plan_id,position,storyboard_id,model_id,choice_revision,content_fingerprint,
        choice_snapshot,inputs,workflow_snapshot,connection_snapshot,source_ref,source_node_id,source_version_id,source_segment_id,append_version_id,status,blocking_reasons,created_at,updated_at)
        VALUES(@id,@plan_id,@position,@storyboard_id,@model_id,@choice_revision,@content_fingerprint,@choice_snapshot,@inputs,@workflow_snapshot,@connection_snapshot,@source_ref,@source_node_id,@source_version_id,@source_segment_id,@append_version_id,@status,@blocking_reasons,@created_at,@updated_at)`);
      for (const node of nodes) insert.run({ ...node, choice_snapshot: JSON.stringify(node.choice), inputs: JSON.stringify(node.inputs),
        workflow_snapshot: JSON.stringify(node.workflow), connection_snapshot: JSON.stringify(node.connection), source_ref: JSON.stringify(node.source_ref), blocking_reasons: JSON.stringify(node.blocking_reasons) });
    })();
    return getPlan(db, planId);
  }
  function isCurrent(db, node) {
    try {
      const p = planningRow(db, node.storyboard_id);
      return !!p && p.choice_phase === 'final' && !p.invalidated_reason && p.choice_revision === node.choice_revision &&
        JSON.stringify(json(p.choice_json)) === JSON.stringify(node.choice) &&
        planning.getStoryboardContentFingerprint(db, node.storyboard_id) === node.content_fingerprint;
    } catch (_) { return false; }
  }
  function resolveSource(db, node) {
    if (!node.workflow.requires_latent) return { source: null, reasons: [] };
    if (node.source_node_id) {
      const producer = db.prepare('SELECT * FROM video_execution_nodes WHERE id=? AND plan_id=?').get(node.source_node_id, node.plan_id);
      if (!producer) return { source: null, reasons: ['source_producer_missing'] };
      if (['failed', 'blocked', 'submitted_unknown', 'media_failed'].includes(producer.status)) return { source: null, reasons: ['source_execution_failed'] };
      if (producer.status !== 'completed') return { source: null, reasons: ['source_not_completed'], waiting: true };
      const version = db.prepare('SELECT * FROM video_plan_versions WHERE id=?').get(producer.version_id);
      const source = version && segment(db, version.tail_segment_id);
      return { source, reasons: sourceReasons(source, node) };
    }
    if (!node.source_segment_id) return { source: null, reasons: ['source_outside_frozen_plan_unbound'], waiting: true };
    const source = segment(db, node.source_segment_id);
    return { source, reasons: sourceReasons(source, node) };
  }
  async function finish(db, node, attempt, result) {
    const source = node.source_segment_id ? segment(db, node.source_segment_id) : null;
    const iteration = source ? source.iteration + 1 : 0;
    const segmentId = 'segment-' + attempt.id;
    const versionId = 'version-' + attempt.id;
    try {
      let current = segment(db, segmentId);
      if (!current) {
        const playable = await media.materialize(node.connection, node, result, segmentId);
        if (!playable || (!playable.video_url && !playable.local_path) || !Number.isFinite(playable.duration) || playable.duration <= 0) throw new Error('media_not_verified');
        let latent;
        try { latent = await provider.resolveLatent(node.connection, node, attempt, result, iteration); }
        catch (_) { latent = { state: 'blocked', blocking_reasons: ['latent_verification_failed'] }; }
        db.prepare(`INSERT INTO video_segments(id,node_id,storyboard_id,model_id,attempt_id,parent_segment_id,connection_identity,workflow_snapshot,
          task_id,prompt_id,iteration,video_url,local_path,duration,latent_artifact,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          segmentId, node.id, node.storyboard_id, node.model_id, attempt.id, source?.id || null, node.connection.identity, JSON.stringify(node.workflow),
          attempt.task_id, attempt.prompt_id, iteration, playable.video_url || '', playable.local_path || null, playable.duration, JSON.stringify(latent), 'completed', now());
        current = segment(db, segmentId);
      }
      let members = [current];
      if (node.append_version_id) {
        const previous = db.prepare('SELECT * FROM video_plan_versions WHERE id=?').get(node.append_version_id);
        members = [...json(previous?.segment_ids, []).map(id => segment(db, id)), current];
        if (!previous || previous.storyboard_id !== node.storyboard_id || members.some(s => !s || s.storyboard_id !== node.storyboard_id || s.status !== 'completed')) throw new Error('append_membership_invalid');
      }
      const playable = await media.compose(node.connection, members, versionId);
      if (!playable || (!playable.video_url && !playable.local_path) || !Number.isFinite(playable.duration) || playable.duration <= 0) throw new Error('composed_media_not_verified');
      db.transaction(() => {
        db.prepare(`INSERT INTO video_plan_versions(id,storyboard_id,model_id,tail_segment_id,segment_ids,video_url,local_path,duration,status,created_at,append_version_id)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(versionId, node.storyboard_id, node.model_id, segmentId, JSON.stringify(members.map(s => s.id)), playable.video_url || '', playable.local_path || null, playable.duration, 'completed', now(), node.append_version_id);
        db.prepare('UPDATE video_execution_nodes SET version_id=?, status=?, blocking_reasons=?, updated_at=? WHERE id=?').run(versionId, 'completed', '[]', now(), node.id);
        db.prepare('UPDATE video_execution_attempts SET status=?, error=NULL, updated_at=? WHERE id=?').run('completed', now(), attempt.id);
      })();
    } catch (error) {
      recordNode(db, node.id, 'media_failed', ['media_finalize_failed']);
      db.prepare('UPDATE video_execution_attempts SET status=?,error=?,updated_at=? WHERE id=?').run('media_failed', safeError(error, node.connection), now(), attempt.id);
    }
  }
  async function handleResult(db, node, attempt, result) {
    if (!result) throw new Error('provider_unknown_state');
    // Persist known identifiers and completion evidence before downloading/composing anything.
    const taskId = result.task_id || attempt.task_id, promptId = result.prompt_id || attempt.prompt_id;
    if (!taskId || !promptId || (attempt.task_id && (taskId !== attempt.task_id || promptId !== attempt.prompt_id))) throw new Error('provider_identity_unknown');
    db.prepare('UPDATE video_execution_attempts SET task_id=?,prompt_id=?,status=?,response=?,error=NULL,updated_at=? WHERE id=?').run(taskId, promptId,
      result.status === 'completed' ? 'materializing' : ['processing', 'failed'].includes(result.status) ? result.status : 'processing', JSON.stringify(result), now(), attempt.id);
    if (!['processing', 'completed', 'failed'].includes(result.status)) throw new Error('provider_unknown_state');
    attempt = { ...attempt, task_id: taskId, prompt_id: promptId };
    if (result.status === 'failed') {
      recordNode(db, node.id, 'failed', ['provider_task_failed']);
      db.prepare('UPDATE video_execution_attempts SET error=? WHERE id=?').run(safeError(result.error || 'provider_task_failed', node.connection), attempt.id);
    } else if (result.status === 'completed') await finish(db, node, attempt, result);
    else recordNode(db, node.id, 'processing');
  }
  function schedule(db, cfg, log, id, delay = pollIntervalMs) {
    if (!autoSchedule) return;
    let map = timers.get(db); if (!map) { map = new Map(); timers.set(db, map); }
    if (map.has(id)) return;
    const timer = setTimeout(() => {
      map.delete(id);
      if (!db.open) return;
      advance(db, cfg, log, id).catch(error => log?.warn?.('Video plan queue paused', { plan_id: id, code: error.code || 'execution_error' }));
    }, Math.max(0, delay));
    timer.unref?.(); map.set(id, timer);
  }
  async function advance(db, cfg, log, id) {
    let map = locks.get(db); if (!map) { map = new Map(); locks.set(db, map); }
    if (map.has(id)) return map.get(id);
    const work = (async () => {
      // Start in a microtask so concurrent run/resume always sees the lock first.
      await Promise.resolve();
      let again = true;
      const polled = new Set();
      while (again) {
        again = false;
        const nodes = db.prepare('SELECT * FROM video_execution_nodes WHERE plan_id=? ORDER BY position').all(id).map(nodeValue);
        for (const node of nodes) {
          let attempt = db.prepare('SELECT * FROM video_execution_attempts WHERE node_id=?').get(node.id);
          if (attempt) {
            if (['completed', 'failed', 'submitted_unknown'].includes(attempt.status) || polled.has(attempt.id)) continue;
            polled.add(attempt.id);
            if (!attempt.task_id) {
              db.prepare('UPDATE video_execution_attempts SET status=?,error=?,updated_at=? WHERE id=?').run('submitted_unknown', 'submission_result_unknown_do_not_resubmit', now(), attempt.id);
              recordNode(db, node.id, 'submitted_unknown', ['submission_result_unknown_do_not_resubmit']); again = true; continue;
            }
            try {
              // Recovery always reads the attempt's original connection, never current settings.
              node.connection = json(attempt.connection_snapshot, {});
              const saved = json(attempt.response);
              const result = saved?.status === 'completed' ? saved : await provider.poll(node.connection, node, attempt, log);
              await handleResult(db, node, attempt, result);
              if (result.status !== 'processing') again = true;
            } catch (error) {
              recordNode(db, node.id, 'processing', ['known_task_query_failed_resume_available']);
              db.prepare('UPDATE video_execution_attempts SET error=?,updated_at=? WHERE id=?').run(safeError(error, node.connection), now(), attempt.id);
            }
            continue;
          }
          const retryDependency = node.status === 'blocked' && node.blocking_reasons.every(reason => reason === 'source_execution_failed');
          if (!['queued', 'waiting_dependency', 'preflighting'].includes(node.status) && !retryDependency) continue;
          if (!isCurrent(db, node)) { recordNode(db, node.id, 'blocked', ['frozen_choice_or_content_changed']); continue; }
          const resolved = resolveSource(db, node);
          if (resolved.reasons.length) { recordNode(db, node.id, resolved.waiting ? 'waiting_dependency' : 'blocked', resolved.reasons); continue; }
          if (resolved.source) {
            node.source_segment_id = resolved.source.id;
            db.prepare('UPDATE video_execution_nodes SET source_segment_id=? WHERE id=?').run(resolved.source.id, node.id);
          }
          recordNode(db, node.id, 'preflighting');
          let prepared;
          try { prepared = await provider.preflight(node.connection, node, resolved.source, log); }
          catch (error) { recordNode(db, node.id, 'blocked', ['preflight_failed', safeError(error, node.connection)]); again = true; continue; }
          // A choice edit while the read-only preflight awaited must not start stale GPU work.
          if (!isCurrent(db, node)) { recordNode(db, node.id, 'blocked', ['frozen_choice_or_content_changed']); continue; }
          attempt = { id: randomUUID(), node_id: node.id, operation_id: randomUUID(), status: 'submitting', connection_snapshot: JSON.stringify(node.connection) };
          db.transaction(() => {
            db.prepare('INSERT INTO video_execution_attempts(id,node_id,operation_id,status,connection_snapshot,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(attempt.id, node.id, attempt.operation_id, 'submitting', attempt.connection_snapshot, now(), now());
            recordNode(db, node.id, 'submitting');
          })();
          try {
            const result = await provider.submit(node.connection, node, prepared, attempt, log);
            await handleResult(db, node, attempt, result);
            polled.add(attempt.id);
            if (result.status !== 'processing') again = true;
          } catch (error) {
            const savedAttempt = db.prepare('SELECT task_id,prompt_id FROM video_execution_attempts WHERE id=?').get(attempt.id);
            if (savedAttempt?.task_id && savedAttempt.prompt_id) {
              recordNode(db, node.id, 'processing', ['known_task_query_failed_resume_available']);
              db.prepare('UPDATE video_execution_attempts SET error=?,updated_at=? WHERE id=?').run(safeError(error, node.connection), now(), attempt.id);
              polled.add(attempt.id); continue;
            }
            // No operation-id support upstream: uncertainty is terminal for automatic submission.
            again = true;
            const status = error.definitive_rejection ? 'failed' : 'submitted_unknown';
            recordNode(db, node.id, status, [status === 'failed' ? 'submission_rejected' : 'submission_result_unknown_do_not_resubmit']);
            db.prepare('UPDATE video_execution_attempts SET status=?,error=?,updated_at=? WHERE id=?').run(status, safeError(error, node.connection), now(), attempt.id);
          }
        }
      }
      updateSummary(db, id);
      if (db.prepare("SELECT 1 FROM video_execution_nodes WHERE plan_id=? AND status='processing'").get(id)) schedule(db, cfg, log, id);
      return getPlan(db, id);
    })();
    map.set(id, work);
    try { return await work; } finally { map.delete(id); }
  }
  async function runPlan(db, cfg, log, id, body = {}) {
    requireSchema(db);
    const plan = getPlan(db, id);
    if (!plan) fail(404, 'plan_not_found');
    if (!Number.isSafeInteger(body.expected_revision)) fail(400, 'expected_revision_required');
    if (plan.revision !== body.expected_revision || plan.status !== 'preview') fail(409, 'plan_revision_conflict');
    db.transaction(() => {
      const nodes = db.prepare('SELECT * FROM video_execution_nodes WHERE plan_id=?').all(id).map(nodeValue);
      if (nodes.some(node => ['ready', 'waiting_dependency'].includes(node.status) && !isCurrent(db, node))) fail(409, 'frozen_choice_or_content_changed');
      if (!db.prepare("UPDATE video_execution_plans SET revision=revision+1,status='running',started_at=?,updated_at=? WHERE id=? AND revision=? AND status='preview'").run(now(), now(), id, body.expected_revision).changes) fail(409, 'plan_revision_conflict');
      db.prepare("UPDATE video_execution_nodes SET status='queued' WHERE plan_id=? AND status='ready'").run(id);
    })();
    if (autoSchedule) { schedule(db, cfg, log, id, 0); return getPlan(db, id); }
    return advance(db, cfg, log, id);
  }
  async function resumePlan(db, cfg, log, id) {
    requireSchema(db);
    const plan = getPlan(db, id);
    if (!plan) fail(404, 'plan_not_found');
    if (!plan.started_at) fail(409, 'preview_must_be_run_explicitly');
    // Explicit resume may retry a read-only preflight against the same frozen contract.
    for (const node of db.prepare("SELECT id,blocking_reasons FROM video_execution_nodes WHERE plan_id=? AND status='blocked'").all(id)) {
      if (json(node.blocking_reasons, []).includes('preflight_failed') && !db.prepare('SELECT 1 FROM video_execution_attempts WHERE node_id=?').get(node.id)) recordNode(db, node.id, 'queued');
    }
    if (autoSchedule) { schedule(db, cfg, log, id, 0); return getPlan(db, id); }
    return advance(db, cfg, log, id);
  }
  async function recoverPlans(db, cfg, log) {
    if (!hasExecutionSchema(db)) return [];
    const rows = db.prepare("SELECT id FROM video_execution_plans WHERE started_at IS NOT NULL AND status NOT IN ('completed','preview')").all();
    const results = [];
    for (const row of rows) {
      if (autoSchedule) { schedule(db, cfg, log, row.id, 0); results.push(getPlan(db, row.id)); }
      else results.push(await advance(db, cfg, log, row.id));
    }
    return results;
  }
  function dispose(db) {
    for (const timer of timers.get(db)?.values() || []) clearTimeout(timer);
    timers.delete(db);
  }
  return { ensureVideoExecutionSchema, previewPlan, runPlan, getPlan, resumePlan, recoverPlans, listSources, listVersions, adoptVersion, dispose };
}
module.exports = { ...createVideoPlanExecutionService(), createVideoPlanExecutionService };
