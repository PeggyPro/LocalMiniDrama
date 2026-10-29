const { createHash } = require('node:crypto');
const path = require('node:path');
const { resolveComfyUIImage, isNativeComfyUIConfig } = require('./comfyUIVideoClient');
const { resolveLatentArtifact, artifactEligibility } = require('./videoExecutionLatent');
const { inspectRemote } = require('./videoExecutionSafetensors');

function object(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try { const out = JSON.parse(value || '{}'); return out && typeof out === 'object' && !Array.isArray(out) ? out : {}; } catch (_) { return {}; }
}
function nativeUrl(value) {
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('invalid_native_connection');
  return url.toString().replace(/\/+$/, '');
}
function snapshotConnection(config, cfg = {}) {
  if (!config || !isNativeComfyUIConfig(config)) throw new Error('native_comfyui_config_required');
  const settings = object(config.settings);
  const base_url = nativeUrl(config.base_url);
  const configuredRoot = settings.comfyui_output_root || cfg.comfyui?.output_root || null;
  const output_root = configuredRoot ? path.resolve(configuredRoot) : null;
  const storage = cfg.storage?.local_path || cfg.storage_local_path || null;
  return {
    config_id: config.id, provider: 'comfyui', api_protocol: 'comfyui', base_url,
    api_key: config.api_key || '', output_root,
    // The managed bridge transport is reacquired after restart; the actual upstream is immutable.
    identity: createHash('sha256').update(JSON.stringify({ base_url, output_root })).digest('hex'),
    storage_local_path: storage ? path.resolve(storage) : null,
    files_base_url: cfg.storage?.base_url || cfg.files_base_url || '/static',
  };
}
function safeError(error, snapshot) {
  let message = String(error?.message || error || 'provider_error');
  for (const secret of [snapshot?.api_key, snapshot?.transport_token]) if (secret) message = message.split(secret).join('[redacted]');
  return message.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]').replace(/data:image\/[^\s"']+/gi, '[image]')
    .replace(/([?&](?:token|api_key|key|secret|password)=)[^&\s"']+/gi, '$1[redacted]').slice(0, 500);
}
function createExecutionProvider({ fetch: fetcher = (...args) => fetch(...args), getBridgeConnection } = {}) {
  const connection = getBridgeConnection || ((log) => require('./comfyUIBridgeProcess').getComfyUIBridgeConnection({ log }));
  async function bridge(snapshot, log, route, body) {
    const transport = await connection(log);
    if (!transport?.baseUrl || !transport.token) throw new Error('managed_bridge_unavailable');
    try {
      const response = await fetcher(transport.baseUrl.replace(/\/+$/, '') + route, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${transport.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(snapshot.api_key ? { 'X-ComfyUI-Token': snapshot.api_key } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      let result;
      try { result = await response.json(); } catch (_) { throw new Error('bridge_invalid_json'); }
      if (!response.ok) {
        const error = new Error(String(result.error || `bridge_http_${response.status}`));
        error.definitive_rejection = response.status >= 400 && response.status < 500;
        throw error;
      }
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('bridge_invalid_response');
      return result;
    } catch (error) {
      error.message = safeError(error, { ...snapshot, transport_token: transport.token });
      throw error;
    }
  }
  async function native(snapshot, route, options = {}) {
    return fetcher(snapshot.base_url + route, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30000), ...options,
      headers: { ...(snapshot.api_key ? { Authorization: snapshot.api_key.startsWith('Bearer ') ? snapshot.api_key : `Bearer ${snapshot.api_key}` } : {}), ...options.headers },
    });
  }
  async function verifyRemote(snapshot, filename) {
    const slash = filename.lastIndexOf('/');
    const query = new URLSearchParams({ filename: filename.slice(slash + 1), subfolder: filename.slice(0, slash), type: 'output' });
    return inspectRemote(range => native(snapshot, '/view?' + query, { headers: { Range: range } }));
  }
  return {
    snapshotConnection,
    async preflight(snapshot, node, source, log) {
      const inputs = { ...node.inputs };
      for (const key of ['first_frame_url', 'last_frame_url', 'image_url']) {
        if (inputs[key]) inputs[key] = await resolveComfyUIImage(inputs[key], snapshot, key);
      }
      const refs = inputs.reference_image_urls || [];
      delete inputs.reference_image_urls;
      inputs.reference_urls = await Promise.all(refs.map((url, i) => resolveComfyUIImage(url, snapshot, `reference ${i + 1}`)));
      if (node.workflow.requires_latent || node.workflow.stage === 'continue') {
        const reasons = source ? artifactEligibility(source.latent_artifact, source) : ['source_not_ready'];
        if (reasons.length) throw new Error(reasons.join(', '));
        if (!source.latent_artifact.output_root && !await verifyRemote(snapshot, source.latent_artifact.filename)) throw new Error('latent_missing');
        inputs.previous_latent = source.latent_artifact.loader_ref;
        inputs.iteration = source.iteration + 1;
      }
      const body = { ...inputs, model: node.model_id, comfyui_url: snapshot.base_url,
        ...(snapshot.api_key ? { comfyui_token: snapshot.api_key } : {}) };
      const result = await bridge(snapshot, log, '/video/validate', body);
      if (result.valid !== true || result.model !== node.model_id) throw new Error('provider_preflight_not_confirmed');
      const graph = result.workflow, definition = node.workflow, metadata = result.metadata;
      if (!graph?.[definition.output] || metadata?.source_workflow !== definition.workflow || !/^[a-f0-9]{64}$/.test(metadata?.source_sha256 || '')) throw new Error('workflow_contract_mismatch');
      if (definition.produces_latent && graph[definition.latent_output]?.class_type !== 'H3SaveLatent') throw new Error('latent_save_node_mismatch');
      if (definition.requires_latent) {
        if (graph[definition.continuation]?.class_type !== 'MiniMaxH3FiniteLatentContinuation' || graph[definition.finalize]?.class_type !== 'MiniMaxH3FiniteSegmentFinalize') throw new Error('finite_segment_contract_missing');
        if (metadata.iteration !== inputs.iteration) throw new Error('continuation_iteration_mismatch');
        const artifact = source.latent_artifact;
        if (['width', 'height', 'fps'].some(key => artifact[key] != null && artifact[key] !== metadata[key])) throw new Error('source_latent_dimensions_mismatch');
      }
      // Validation chooses a random seed only when one was not frozen already; reuse that exact choice.
      if (body.seed == null || body.seed === -1) body.seed = metadata.seed;
      return { body, metadata, validation_scope: result.validation_scope || 'workflow dependencies only', generation_tested: false };
    },
    async submit(snapshot, node, prepared, attempt, log) {
      const result = await bridge(snapshot, log, '/video/generations', prepared.body);
      // The adapter does not implement operation-id idempotency. Any lost response stays unknown.
      if (!/^lmd-comfy-[a-f0-9]{32}$/.test(result.task_id || '') || !/^[A-Za-z0-9_-]+$/.test(result.prompt_id || '')) throw new Error('submission_identity_unknown');
      if (result.model && result.model !== node.model_id) throw new Error('submission_model_mismatch');
      return result;
    },
    async poll(snapshot, node, attempt, log) {
      if (!/^lmd-comfy-[a-f0-9]{32}$/.test(attempt.task_id || '')) throw new Error('invalid_known_task_id');
      const result = await bridge(snapshot, log, '/video/task/' + encodeURIComponent(attempt.task_id));
      if (result.task_id !== attempt.task_id || result.prompt_id !== attempt.prompt_id || (result.model && result.model !== node.model_id)) throw new Error('task_identity_mismatch');
      return result;
    },
    async resolveLatent(snapshot, node, attempt, result, iteration) {
      let history;
      try {
        const response = await native(snapshot, '/history/' + encodeURIComponent(attempt.prompt_id));
        if (response.ok) history = await response.json();
      } catch (_) { /* A trusted task-exclusive root remains an independent source of evidence. */ }
      if (node.workflow.requires_latent && result.metadata?.iteration !== iteration) return { state: 'blocked', blocking_reasons: ['latent_iteration_mismatch'] };
      const artifact = await resolveLatentArtifact({ task_id: attempt.task_id, prompt_id: attempt.prompt_id, workflow: node.workflow,
        metadata: result.metadata, history, output_root: snapshot.output_root, connection_identity: snapshot.identity,
        iteration, verifyRemote: filename => verifyRemote(snapshot, filename) });
      if (artifact.state === 'ready') {
        for (const key of ['width', 'height', 'fps']) if (Number.isFinite(result.metadata?.[key])) artifact[key] = result.metadata[key];
      }
      return artifact;
    },
  };
}
module.exports = { createExecutionProvider, snapshotConnection, safeError };
