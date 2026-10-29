const fs = require('node:fs');
const path = require('node:path');
const { inspectFile } = require('./videoExecutionSafetensors');

const TASK = /^lmd-comfy-[a-f0-9]{32}$/;
function blocked(reason, detail) {
  return { state: 'blocked', blocking_reasons: [reason], ...(detail ? { detail } : {}) };
}
function within(root, target) {
  const rel = path.relative(root, target);
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
// The H3 loader interprets the suffix, so preserve it exactly; never accept a user path.
function safeRelative(value) {
  if (typeof value !== 'string' || !value || /[\\:\[\]\x00-\x1f%]/.test(value)) return false;
  return !value.startsWith('/') && value.split('/').every(p => p && p !== '.' && p !== '..' && !/[ .]$/.test(p));
}
function canonicalFile(root, relative) {
  if (!safeRelative(relative)) throw new Error('latent_unsafe_path');
  const realRoot = fs.realpathSync(root);
  const target = path.resolve(realRoot, ...relative.split('/'));
  const realTarget = fs.realpathSync(target);
  // Also reject links to another task within output: lexical task ownership must survive realpath.
  if (!within(realRoot, realTarget) || path.relative(target, realTarget) !== '') throw new Error('latent_outside_task_root');
  const stat = fs.statSync(realTarget);
  if (!stat.isFile() || stat.size <= 0) throw new Error('latent_missing');
  return realTarget;
}
function historyCandidates(output) {
  const candidates = [];
  const visit = (value, depth = 0) => {
    if (depth > 8 || value == null) return;
    if (typeof value === 'string') {
      if (/\.safetensors$/i.test(value)) candidates.push(value);
    } else if (Array.isArray(value)) {
      value.forEach(v => visit(v, depth + 1));
    } else if (typeof value === 'object') {
      if (typeof value.filename === 'string') {
        if (value.type && value.type !== 'output') throw new Error('latent_wrong_directory');
        candidates.push([value.subfolder, value.filename].filter(Boolean).join('/'));
      } else Object.values(value).forEach(v => visit(v, depth + 1));
    }
  };
  visit(output);
  return [...new Set(candidates)];
}

/** Resolve only the registered save node in an exact prompt, or its exclusive task directory.
 * No glob over output, modification-time heuristic, or video-to-latent substitution is permitted.
 * verifyRemote must confirm an exact /view output when there is no local output root.
 */
async function resolveLatentArtifact({ task_id, prompt_id, workflow, metadata, history, output_root, connection_identity, iteration = 0, verifyRemote }) {
  if (!workflow?.produces_latent && !workflow?.latent_output) return blocked('workflow_does_not_produce_latent');
  if (!TASK.test(task_id || '') || !/^[A-Za-z0-9_-]+$/.test(prompt_id || '')) return blocked('latent_missing_task_identity');
  const saveNode = String(workflow.latent_output || workflow.latent_save_node_id || '');
  if (!saveNode) return blocked('latent_missing_registered_node');
  const prefix = `latents/localminidrama/${task_id}/latent`;
  if (metadata?.latent_output?.filename_prefix !== prefix || metadata.latent_output.directory !== 'output') {
    return blocked('latent_task_prefix_mismatch');
  }
  const taskDir = prefix.slice(0, prefix.lastIndexOf('/'));
  const validFile = name => safeRelative(name) && name.startsWith(prefix + '_') &&
    name.slice(taskDir.length + 1).indexOf('/') === -1 && /\.safetensors$/i.test(name);
  let candidates = [];
  let evidence = 'task_exclusive_root';
  try {
    const entry = history?.[prompt_id];
    if (entry) {
      const graph = entry.prompt?.[2];
      const node = graph?.[saveNode];
      if (String(entry.prompt?.[1] || '') !== prompt_id || node?.class_type !== 'H3SaveLatent' || node.inputs?.filename_prefix !== prefix) {
        return blocked('latent_history_provenance_mismatch');
      }
      candidates = historyCandidates(entry.outputs?.[saveNode]);
      if (candidates.some(name => !validFile(name))) return blocked('latent_unsafe_history_path');
      if (candidates.length) evidence = 'prompt_history_save_node';
    }
    if (!candidates.length && output_root) {
      const root = fs.realpathSync(output_root);
      const dir = path.resolve(root, ...taskDir.split('/'));
      const realDir = fs.realpathSync(dir);
      if (!within(root, realDir) || path.relative(dir, realDir) !== '') return blocked('latent_outside_task_root');
      candidates = fs.readdirSync(realDir).filter(name => /^latent_[^/\\]+\.safetensors$/i.test(name)).map(name => `${taskDir}/${name}`);
    }
    if (!candidates.length) return blocked(output_root ? 'latent_missing' : 'latent_unresolved_configure_output_root');
    if (candidates.length !== 1) return blocked('latent_ambiguous');
    const filename = candidates[0];
    if (!validFile(filename)) return blocked('latent_unsafe_path');
    let localPath = null, checks;
    if (output_root) { localPath = canonicalFile(output_root, filename); checks = inspectFile(localPath); }
    else if (verifyRemote) checks = await verifyRemote(filename);
    if (!checks?.structure_verified) return blocked('latent_not_verified');
    return {
      state: 'ready', blocking_reasons: [], filename, loader_ref: filename + ' [output]',
      task_id, prompt_id, save_node_id: saveNode, connection_identity,
      continuation_model: workflow.continuation_model, iteration,
      evidence, structure_verified: true, loadability_verified: false, verification_note: checks.verification_note,
      output_root: output_root || null, local_path: localPath,
    };
  } catch (error) {
    return blocked(error.code === 'ENOENT' ? 'latent_missing' : (/^latent_/.test(error.message) ? error.message : 'latent_verification_failed'));
  }
}

function artifactEligibility(artifact, segment) {
  if (!artifact || artifact.state !== 'ready') return artifact?.blocking_reasons || ['latent_missing'];
  if (artifact.structure_verified !== true) return ['latent_structure_unverified'];
  if (segment.workflow?.latent_output && (String(segment.workflow.latent_output) !== artifact.save_node_id || segment.workflow.continuation_model !== artifact.continuation_model)) return ['latent_workflow_mismatch'];
  if (artifact.task_id !== segment.task_id || artifact.prompt_id !== segment.prompt_id ||
      artifact.connection_identity !== segment.connection_identity || artifact.iteration !== segment.iteration) return ['latent_provenance_mismatch'];
  const prefix = `latents/localminidrama/${segment.task_id}/latent_`;
  if (!TASK.test(segment.task_id || '') || !safeRelative(artifact.filename) || !artifact.filename.startsWith(prefix) ||
      artifact.filename.slice(prefix.length).includes('/') || !/\.safetensors$/i.test(artifact.filename) ||
      artifact.loader_ref !== artifact.filename + ' [output]') return ['latent_unsafe_path'];
  if (artifact.output_root) {
    try { inspectFile(canonicalFile(artifact.output_root, artifact.filename)); }
    catch (_) { return ['latent_missing_or_outside_root']; }
  }
  return [];
}
module.exports = { resolveLatentArtifact, artifactEligibility, canonicalFile, safeRelative, within };
