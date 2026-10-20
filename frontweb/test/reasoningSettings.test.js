import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_REASONING_EFFORTS,
  parseReasoningEfforts,
  readReasoningSettings,
  updateReasoningSettings,
  getReasoningSummary,
} from '../src/utils/reasoningSettings.js'
import { getSelectableModels, resolveAIConfig } from '../src/utils/modelSelection.js'

test('reasoning lists accept commas, newlines and custom values, normalize case and remove duplicates', () => {
  assert.deepEqual(parseReasoningEfforts(' low, HIGH\nmedium，low,custom-effort, auto,default '), ['low', 'high', 'medium', 'custom-effort'])
  assert.deepEqual(parseReasoningEfforts(['HIGH', 'high', '', null, 3, 'xhigh']), ['high', 'xhigh'])
})

test('editing an old configuration does not enable reasoning or lose its saved custom default', () => {
  assert.deepEqual(readReasoningSettings(null), { efforts: DEFAULT_REASONING_EFFORTS, effort: '' })
  assert.deepEqual(readReasoningSettings('{invalid'), { efforts: DEFAULT_REASONING_EFFORTS, effort: '' })
  assert.deepEqual(readReasoningSettings('{"reasoning_effort":"custom"}'), {
    efforts: [...DEFAULT_REASONING_EFFORTS, 'custom'], effort: 'custom',
  })
  assert.deepEqual(readReasoningSettings({ reasoning_efforts: [] }), { efforts: [], effort: '' })
})

test('saving reasoning preserves unrelated settings and does not mutate its input', () => {
  const original = { max_tokens: 8192, custom: { keep: true }, reasoning_effort: 'low' }
  const saved = updateReasoningSettings(original, 'high\nxhigh\nhigh', 'XHIGH')
  assert.deepEqual(saved, { max_tokens: 8192, custom: { keep: true }, reasoning_efforts: ['high', 'xhigh'], reasoning_effort: 'xhigh' })
  assert.equal(original.reasoning_effort, 'low')
  assert.equal(original.reasoning_efforts, undefined)
  assert.deepEqual(readReasoningSettings(JSON.stringify(saved)), { efforts: ['high', 'xhigh'], effort: 'xhigh' })
})

test('removing the chosen effort or selecting model default removes the outgoing override', () => {
  for (const effort of ['high', '', 'auto', 'default']) {
    const saved = updateReasoningSettings({ reasoning_effort: 'high', max_tokens: 4096 }, ['low'], effort)
    assert.equal(saved.reasoning_effort, undefined)
    assert.equal(saved.max_tokens, 4096)
  }
  assert.deepEqual(updateReasoningSettings({}, [], ''), { reasoning_efforts: [] })
})

test('none is an explicit reasoning value rather than model default', () => {
  const saved = updateReasoningSettings({}, ['none'], 'none')
  assert.equal(saved.reasoning_effort, 'none')
  assert.equal(getReasoningSummary({ settings: saved }).label, 'none · 不推理')
})

test('business scenes inherit the selected active text configuration and fall back like the backend', () => {
  const configs = [
    { id: 1, service_type: 'text', is_active: true, is_default: true, model: ['default-model'], settings: '{"reasoning_effort":"medium"}' },
    { id: 2, service_type: 'text', is_active: true, model: ['chosen-model'], settings: { reasoning_effort: 'xhigh' } },
    { id: 3, service_type: 'text', is_active: false, settings: { reasoning_effort: 'low' } },
    { id: 4, service_type: 'image', is_active: true, settings: { reasoning_effort: 'high' } },
  ]
  assert.equal(getReasoningSummary(resolveAIConfig(configs, 'text', '2')).effort, 'xhigh')
  for (const configId of [null, 3, 4, 999]) {
    assert.equal(getReasoningSummary(resolveAIConfig(configs, 'text', configId)).effort, 'medium')
    assert.deepEqual(getSelectableModels(configs, 'text', configId), ['default-model'])
  }
  assert.equal(resolveAIConfig([], 'text', null), null)
  assert.equal(getReasoningSummary(null).label, '尚未配置')
})

test('business scene summary follows updated config settings without an independent scene override', () => {
  const config = { provider: 'custom', settings: { reasoning_effort: 'high' } }
  assert.equal(getReasoningSummary(config, 'some-model').effort, 'high')
  config.settings = { reasoning_effort: 'low' }
  assert.equal(getReasoningSummary(config, 'another-model').effort, 'low')
  config.settings = {}
  assert.equal(getReasoningSummary(config).label, '模型默认')
})

test('DeepSeek cards preserve native thinking enablement and normalized high/max effort', () => {
  const config = { provider: 'deepseek', default_model: 'deepseek-v4-flash' }
  assert.equal(getReasoningSummary({ ...config, settings: { deepseek_thinking: 'disabled', deepseek_reasoning_effort: 'max' } }).label, '思考已关闭')
  assert.equal(getReasoningSummary({ ...config, settings: { deepseek_thinking: 'enabled', deepseek_reasoning_effort: 'xhigh', reasoning_effort: 'low' } }).effort, 'max')
  assert.equal(getReasoningSummary({ ...config, settings: { deepseek_thinking: true, reasoning_effort: 'medium' } }).effort, 'high')
  assert.equal(getReasoningSummary({ ...config, settings: {} }).label, '模型默认')
})

test('DeepSeek cards honor legacy model aliases when no explicit thinking option is configured', () => {
  const config = { base_url: 'https://api.deepseek.com/v1', settings: { deepseek_reasoning_effort: 'max' } }
  assert.equal(getReasoningSummary(config, 'deepseek-chat').label, '思考已关闭')
  assert.equal(getReasoningSummary(config, 'deepseek-reasoner').effort, 'max')
})
