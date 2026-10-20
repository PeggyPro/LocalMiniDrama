export function parseModelList(models, defaultModel = '') {
  if (Array.isArray(models)) {
    return models.map((m) => String(m).trim()).filter(Boolean)
  }
  if (typeof models === 'string') {
    return models.split(/[\n,，]/).map((s) => s.trim()).filter(Boolean)
  }
  return defaultModel ? [String(defaultModel).trim()].filter(Boolean) : []
}

export function resolveAIConfig(configs, serviceType, configId) {
  const active = (Array.isArray(configs) ? configs : [])
    .filter(config => config.service_type === serviceType && config.is_active)
  return (configId ? active.find(config => String(config.id) === String(configId)) : null)
    || active.find(config => config.is_default)
    || active[0]
    || null
}

export function getSelectableModels(configs, serviceType, configId) {
  const config = resolveAIConfig(configs, serviceType, configId)
  if (!config) return []
  return parseModelList(config.model, config.default_model)
}
