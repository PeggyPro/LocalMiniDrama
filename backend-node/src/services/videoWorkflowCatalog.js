'use strict';

// The Python registry is owned by the bridge. Read it; never rewrite or execute it here.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const REGISTRY_PATH = path.resolve(__dirname, '../../scripts/comfyui-models.json');

function buildVideoWorkflowCatalog(registry) {
  if (!registry || !Array.isArray(registry.models)) throw new Error('Invalid video workflow registry');
  const ids = new Set();
  const items = registry.models.map((entry) => {
    if (!entry.id || ids.has(entry.id) || !['single', 'first', 'continue'].includes(entry.stage || 'single')) {
      throw new Error('Invalid or duplicate video workflow registration');
    }
    ids.add(entry.id);
    const required = [];
    if (entry.input_audio) required.push('input_audio');
    if (entry.input_video) required.push('input_video');
    if (entry.previous_latent) required.push('previous_latent');
    return {
      model_id: entry.id,
      label: entry.name || entry.id,
      aliases: [...(entry.aliases || [])],
      family: entry.kind,
      stage: entry.stage || 'single',
      continuation_model: entry.continuation_model || null,
      requires_latent: !!entry.previous_latent,
      produces_latent: !!entry.latent_output,
      requires_audio: !!entry.input_audio,
      requires_video: !!entry.input_video,
      required_inputs: required,
      supports_first_frame: entry.kind === 'h3',
      supports_last_frame: entry.kind === 'h3',
      supports_references: entry.kind === 'h3',
      max_reference_images: entry.kind === 'h3' ? 9 : 0,
      availability: 'registered_unverified',
      runtime_verified: false,
      input_supported: entry.kind === 'h3' && !entry.input_audio && !entry.input_video,
      blocking_reasons: [...(entry.input_audio ? ['unsupported_audio_input'] : []), ...(entry.input_video ? ['unsupported_video_input'] : []), ...(entry.kind !== 'h3' ? ['unsupported_workflow_family'] : [])],
      verification_note: '仅从脚本注册表读取；节点、模型、连接与真实 GPU 兼容性须在执行预检确认',
      recommendable: entry.kind === 'h3' && !entry.input_audio && !entry.input_video,
    };
  });
  for (const item of items) {
    const next = items.find((other) => other.model_id === item.continuation_model);
    if ((item.stage === 'continue' && !item.requires_latent) ||
        (item.continuation_model && (!next || next.stage !== 'continue' || next.family !== item.family))) {
      item.blocking_reasons.push('invalid_continuation_registration');
      item.availability = 'blocked';
      item.recommendable = false;
    }
  }
  return { version: createHash('sha256').update(JSON.stringify(registry.models)).digest('hex').slice(0, 24), items };
}

const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
const catalog = buildVideoWorkflowCatalog(registry);
const clone = (value) => JSON.parse(JSON.stringify(value));
function getVideoWorkflowCatalog() { return clone(catalog); }
function getVideoWorkflow(modelId) {
  const model = catalog.items.find((item) => item.model_id === modelId || item.aliases.includes(modelId));
  return model ? clone(model) : null;
}
function getVideoWorkflowDefinition(modelId) {
  const model = getVideoWorkflow(modelId);
  const entry = model && registry.models.find((item) => item.id === model.model_id);
  return entry ? clone(entry) : null;
}
function isContinuationCompatible(sourceModelId, targetModelId) {
  const source = getVideoWorkflow(sourceModelId);
  const target = getVideoWorkflow(targetModelId);
  return !!(source && target && source.produces_latent && target.requires_latent &&
    source.continuation_model === target.model_id && source.family === target.family);
}

module.exports = { buildVideoWorkflowCatalog, getVideoWorkflowCatalog, getVideoWorkflow, getVideoWorkflowDefinition, isContinuationCompatible };
