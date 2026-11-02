'use strict';
const catalog = require('./videoWorkflowCatalog');
const { flattenModelIds } = require('./modelId');
const { isNativeComfyUIConfig } = require('./comfyUIVideoClient');

function configuredModelIds(config) {
  return [...new Set([...flattenModelIds(config.model), ...flattenModelIds(config.default_model)]
    .map(id => catalog.getVideoWorkflow(id)?.model_id).filter(Boolean))];
}
function listVideoConnections(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_service_configs'").get()) return [];
  return db.prepare("SELECT * FROM ai_service_configs WHERE service_type='video'").all().filter(config => {
    if (config.deleted_at || !config.is_active || !isNativeComfyUIConfig(config)) return false;
    try {
      const url = new URL(config.base_url);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    } catch (_) { return false; }
  }).sort((a, b) => (Number(b.is_default) - Number(a.is_default)) || (Number(b.priority) - Number(a.priority)) || (a.id - b.id));
}
function chooseVideoConnection(db, modelId, configId) {
  const canonical = catalog.getVideoWorkflow(modelId)?.model_id;
  if (!canonical) return null;
  return listVideoConnections(db).find(config => (configId == null || config.id === Number(configId)) && configuredModelIds(config).includes(canonical)) || null;
}
function getConfiguredVideoWorkflows(db) {
  const connections = listVideoConnections(db).map(config => ({ config, models: configuredModelIds(config) }));
  return catalog.getVideoWorkflowCatalog().items.filter(item => item.recommendable).map(item => ({ ...item,
    // Only this safe projection is sent to the text model. Never expose connection URLs, settings or credentials.
    configured_connections: connections.filter(entry => entry.models.includes(item.model_id)).map(({ config }) => ({
      id: config.id, name: String(config.name || '').slice(0, 120), is_default: !!config.is_default, priority: Number(config.priority) || 0,
    })),
  })).filter(item => item.configured_connections.length);
}
module.exports = { configuredModelIds, chooseVideoConnection, getConfiguredVideoWorkflows };
