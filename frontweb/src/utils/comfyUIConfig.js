export const COMFYUI_H3_MODEL = 'huobao_minimax_h3_reference_turbo_api'
export const COMFYUI_WAN_MODEL = 'huobao_wan22_5b_t2v_32gb_api'
export const COMFYUI_QWEN_IMAGE_MODEL = 'huobao_qwen_image_2_1_reference_api'
export const COMFYUI_H3_MODELS = Object.freeze(['h3-standard', 'h3-drama', 'h3-action'])
const H3_MODEL_LABELS = Object.freeze({
  'h3-standard': '本地 H3 标准',
  'h3-drama': '本地 H3 文戏',
  'h3-action': '本地 H3 武戏',
})

export function isComfyUIH3Model(model) {
  const id = String(model || '').trim()
  return id === COMFYUI_H3_MODEL || COMFYUI_H3_MODELS.includes(id)
}

export function getComfyUIVideoModelLabel(model) {
  return COMFYUI_H3_MODELS.includes(model) ? `${H3_MODEL_LABELS[model]}（${model}）` : model
}

export const COMFYUI_IMAGE_PRESET = Object.freeze({
  id: 'comfyui',
  name: 'ComfyUI 本地（Qwen-Image2.1 多参考图）',
  base_url: 'http://127.0.0.1:8188',
  api_protocol: 'comfyui',
  endpoint: '',
  query_endpoint: '',
  models: Object.freeze([COMFYUI_QWEN_IMAGE_MODEL]),
})

export const COMFYUI_VIDEO_PRESET = Object.freeze({
  id: 'comfyui',
  name: 'ComfyUI 本地 H3（标准 / 文戏 / 武戏）',
  base_url: 'http://127.0.0.1:8188',
  api_protocol: 'comfyui',
  endpoint: '',
  query_endpoint: '',
  models: COMFYUI_H3_MODELS,
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
  const selected = getComfyUIVideoModel(config, model)
  if (isComfyUIH3Model(selected) || selected === COMFYUI_WAN_MODEL) return true
  const provider = String(config.provider || '').trim().toLowerCase()
  if (/comfyui|comfuui/i.test(provider)) return true
  return ['', 'openai', 'custom'].includes(provider) && /comfyui|comfuui/i.test(String(config.name || ''))
}

// Match native image routing without making external image proxies keyless.
export function isNativeComfyUIImageConfig(config, model) {
  if (!config || !['image', 'storyboard_image'].includes(String(config.service_type || '').trim().toLowerCase())) return false
  const protocol = String(config.api_protocol || '').trim().toLowerCase()
  if (protocol) return protocol === 'comfyui'
  if (String(config.endpoint || '').trim() || String(config.query_endpoint || '').trim()) return false
  if (getComfyUIVideoModel(config, model) === COMFYUI_QWEN_IMAGE_MODEL) return true
  return /^(comfyui|comfuui)$/i.test(String(config.provider || '').trim())
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
