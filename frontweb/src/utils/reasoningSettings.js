export const REASONING_EFFORT_PRESETS = [
  { value: 'none', label: 'none · 不推理' },
  { value: 'minimal', label: 'minimal · 最低' },
  { value: 'low', label: 'low · 低' },
  { value: 'medium', label: 'medium · 中' },
  { value: 'high', label: 'high · 高' },
  { value: 'xhigh', label: 'xhigh · 超高' },
  { value: 'max', label: 'max · 最大' },
]

export const DEFAULT_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh']

function parseSettings(settings) {
  if (typeof settings === 'string') {
    try {
      settings = JSON.parse(settings)
    } catch (_) {
      return {}
    }
  }
  return settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {}
}

function normalizeEffort(value) {
  if (typeof value !== 'string') return ''
  const effort = value.trim().toLowerCase()
  return effort === 'auto' || effort === 'default' ? '' : effort
}

export function parseReasoningEfforts(value) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n,，]/) : []
  return [...new Set(values.map(normalizeEffort).filter(Boolean))]
}

export function readReasoningSettings(settings) {
  const parsed = parseSettings(settings)
  const efforts = parseReasoningEfforts(parsed.reasoning_efforts ?? DEFAULT_REASONING_EFFORTS)
  const effort = normalizeEffort(parsed.reasoning_effort)
  // Preserve a previously configured value even if it predates the editable list.
  if (effort && !efforts.includes(effort)) efforts.push(effort)
  return { efforts, effort }
}

export function updateReasoningSettings(settings, efforts, effort) {
  const next = { ...parseSettings(settings), reasoning_efforts: parseReasoningEfforts(efforts) }
  const selected = normalizeEffort(effort)
  if (selected && next.reasoning_efforts.includes(selected)) next.reasoning_effort = selected
  else delete next.reasoning_effort
  return next
}

export function getReasoningLabel(effort) {
  return REASONING_EFFORT_PRESETS.find(option => option.value === effort)?.label || effort || '模型默认'
}

function isDeepSeekOfficial(config) {
  if (String(config.provider || '').trim().toLowerCase() === 'deepseek') return true
  try {
    return /(^|\.)api\.deepseek\.com$/i.test(new URL(config.base_url).hostname)
  } catch (_) {
    return false
  }
}

export function getReasoningSummary(config, modelOverride = '') {
  if (!config) return { effort: '', label: '尚未配置', description: '请选择可用的文本 AI 配置' }
  const settings = parseSettings(config.settings)
  if (isDeepSeekOfficial(config)) {
    const nested = settings.deepseek && typeof settings.deepseek === 'object' ? settings.deepseek : {}
    const model = String(modelOverride || config.default_model || (Array.isArray(config.model) ? config.model[0] : config.model) || '').toLowerCase()
    const thinking = settings.deepseek_thinking ?? settings.thinking ?? nested.thinking ?? nested.type
    const mode = String(thinking ?? '').trim().toLowerCase()
    const enabled = ['enabled', 'enable', 'on', 'true', 'thinking'].includes(mode)
      || (!mode && model === 'deepseek-reasoner')
    const disabled = ['disabled', 'disable', 'off', 'false', 'non-thinking'].includes(mode)
      || (!mode && model === 'deepseek-chat')
    if (disabled) return { effort: '', label: '思考已关闭', description: '沿用配置中的 DeepSeek 思考模式' }
    if (enabled) {
      const value = normalizeEffort(settings.deepseek_reasoning_effort ?? settings.reasoning_effort ?? nested.reasoning_effort ?? nested.effort)
      const effort = ['max', 'xhigh'].includes(value) ? 'max' : ['high', 'medium', 'low'].includes(value) ? 'high' : ''
      return { effort, label: getReasoningLabel(effort), description: '沿用配置中的 DeepSeek 思考强度' }
    }
    return { effort: '', label: '模型默认', description: '由模型决定思考模式和推理强度' }
  }
  const { effort } = readReasoningSettings(settings)
  return {
    effort,
    label: getReasoningLabel(effort),
    description: effort ? '使用该 AI 配置的默认推理强度' : '由模型决定推理强度',
  }
}
