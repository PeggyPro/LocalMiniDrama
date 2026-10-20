export const COMFYUI_H3_MODEL = 'huobao_minimax_h3_reference_turbo_api'
export const COMFYUI_WAN_MODEL = 'huobao_wan22_5b_t2v_32gb_api'

export const COMFYUI_VIDEO_PRESET = Object.freeze({
  id: 'comfyui',
  name: 'ComfyUI 本地（火宝工作流）',
  base_url: 'http://127.0.0.1:8188',
  api_protocol: 'comfyui',
  endpoint: '',
  query_endpoint: '',
  models: Object.freeze([COMFYUI_H3_MODEL, COMFYUI_WAN_MODEL]),
})

function flattenModelIds(model, depth = 0) {
  if (model == null || depth > 4) return []
  if (Array.isArray(model)) return model.flatMap(item => flattenModelIds(item, depth + 1))
  const text = String(model).trim()
  if (!text) return []
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) return flattenModelIds(parsed, depth + 1)
    } catch (_) {}
  }
  return [text]
}

export function getComfyUIVideoModel(config, model) {
  if (!config) return ''
  const models = config.model ?? String(config.modelText || '').split(/[\n,，]/)
  return flattenModelIds(model)[0] || flattenModelIds(config.default_model)[0] || flattenModelIds(models)[0] || ''
}

// Keep protocol/path precedence aligned with backend comfyUIVideoClient.js.
export function isNativeComfyUIVideoConfig(config, model) {
  if (!config || String(config.service_type || '').trim().toLowerCase() !== 'video') return false
  const protocol = String(config.api_protocol || '').trim().toLowerCase()
  if (protocol) return protocol === 'comfyui'
  if (String(config.endpoint || '').trim() || String(config.query_endpoint || '').trim()) return false
  if (COMFYUI_VIDEO_PRESET.models.includes(getComfyUIVideoModel(config, model))) return true
  const provider = String(config.provider || '').trim().toLowerCase()
  if (/comfyui|comfuui/i.test(provider)) return true
  return ['', 'openai', 'custom'].includes(provider) && /comfyui|comfuui/i.test(String(config.name || ''))
}

export function buildAIConnectionTestPayload(row) {
  return {
    base_url: row.base_url,
    api_key: row.api_key,
    model: row.model,
    default_model: row.default_model,
    name: row.name,
    provider: row.provider,
    api_protocol: row.api_protocol,
    endpoint: row.endpoint,
    query_endpoint: row.query_endpoint,
    service_type: row.service_type,
    settings: row.settings,
  }
}
