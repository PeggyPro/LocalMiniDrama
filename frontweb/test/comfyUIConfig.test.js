import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import * as comfyUI from '../src/utils/comfyUIConfig.js'
import * as reasoning from '../src/utils/reasoningSettings.js'
import { canUseUniversalOmniVideoApi } from '../src/utils/videoOmniSupport.js'

const { COMFYUI_H3_MODEL: H3, COMFYUI_WAN_MODEL: WAN, COMFYUI_VIDEO_PRESET: preset,
  getComfyUIVideoModel, isNativeComfyUIVideoConfig, buildAIConnectionTestPayload } = comfyUI
const nativeConfig = (extra = {}) => ({
  service_type: 'video', name: 'Comfyui', provider: 'ComfuUI',
  base_url: 'http://127.0.0.1:8188', api_key: '', api_protocol: '', endpoint: '', query_endpoint: '',
  model: [H3, WAN], default_model: H3, ...extra,
})

const component = readFileSync(new URL('../src/components/AIConfigContent.vue', import.meta.url), 'utf8')

// Exercise the actual script-setup handlers without mounting Element Plus or making network calls.
function formHarness() {
  const calls = []
  const script = component.match(/<script setup>([\s\S]*?)<\/script>/)[1]
    .replace(/^import[\s\S]*?from ['"][^'"]+['"]\r?\n/gm, '')
  const context = vm.createContext({
    ...comfyUI, ...reasoning,
    ref: value => ({ value }),
    computed: fn => ({ get value() { return fn() } }),
    watch() {}, onMounted() {},
    aiAPI: { async testConnection(payload) { calls.push(payload) } },
    ElMessage: { info() {}, warning() {}, error() {}, success() {} },
  })
  vm.runInContext(`${script}\nglobalThis.formTest = { form, formRef, saving, submit, vendorLock, rules, isNativeComfyUIForm, comfyUICapabilityHint, endpointPreviewInfo, onProviderChange, openTest, testResult };`, context)
  return {
    ...context.formTest, calls,
    evaluate(expression) {
      return vm.runInContext(expression.replace(/\bform\./g, 'form.value.')
        .replace(/\bisNativeComfyUIForm\b/g, 'isNativeComfyUIForm.value'), context)
    },
  }
}

function validateKey(harness, key) {
  let result
  harness.rules.value.api_key[0].validator({}, key, error => { result = error || null })
  return result
}

test('native preset uses the two exact Firebao workflows and the source8188 URL', () => {
  assert.equal(preset.id, 'comfyui')
  assert.equal(preset.base_url, 'http://127.0.0.1:8188')
  assert.equal(preset.api_protocol, 'comfyui')
  assert.equal(preset.endpoint, '')
  assert.equal(preset.query_endpoint, '')
  assert.deepEqual(preset.models, [H3, WAN])
})

test('native inference supports saved typo provider, exact aliases and newline form models', () => {
  assert.equal(isNativeComfyUIVideoConfig(nativeConfig()), true)
  for (const model of [H3, WAN]) {
    assert.equal(isNativeComfyUIVideoConfig(nativeConfig({ name: '', provider: 'custom', model, default_model: '' })), true)
    assert.equal(isNativeComfyUIVideoConfig(nativeConfig({ name: '', provider: 'custom', model: undefined, modelText: `\n ${model}\n`, default_model: '' })), true)
  }
  assert.equal(isNativeComfyUIVideoConfig(nativeConfig({ model: [], default_model: '', provider: ' COMFYUI ' })), true)
  assert.equal(isNativeComfyUIVideoConfig(nativeConfig({ model: [], default_model: '', provider: 'openai' })), true)
})

test('explicit protocols and proxy paths retain backend routing precedence', () => {
  for (const api_protocol of ['openai', 'sora', 'volcengine_omni']) {
    assert.equal(isNativeComfyUIVideoConfig(nativeConfig({ api_protocol })), false)
  }
  for (const field of ['endpoint', 'query_endpoint']) {
    assert.equal(isNativeComfyUIVideoConfig(nativeConfig({ [field]: '/custom/proxy' })), false)
    assert.equal(isNativeComfyUIVideoConfig(nativeConfig({ [field]: '/custom/proxy', api_protocol: ' ComfyUI ' })), true)
  }
})

test('name inference does not alter another known provider or another service type', () => {
  for (const provider of ['minimax', 'agnes', 'dashscope']) {
    assert.equal(isNativeComfyUIVideoConfig(nativeConfig({ provider, model: ['other-model'], default_model: '' })), false)
  }
  for (const service_type of ['image', 'text', 'tts', '']) {
    assert.equal(isNativeComfyUIVideoConfig(nativeConfig({ service_type, api_protocol: 'comfyui' })), false)
  }
  assert.equal(isNativeComfyUIVideoConfig(nativeConfig({ name: '', provider: 'custom', model: `${H3}-other`, default_model: '' })), false)
  assert.equal(isNativeComfyUIVideoConfig(null), false)
})

test('selected model honors overrides, saved defaults, nested lists and newline form input', () => {
  assert.equal(getComfyUIVideoModel(nativeConfig({ default_model: WAN })), WAN)
  assert.equal(getComfyUIVideoModel(nativeConfig(), WAN), WAN)
  assert.equal(getComfyUIVideoModel({ model: JSON.stringify([[WAN, H3]]) }), WAN)
  assert.equal(getComfyUIVideoModel({ modelText: `\n ${WAN}，${H3}\n` }), WAN)
  assert.equal(getComfyUIVideoModel(null), '')
})

test('native H3 supports references automatically while switching default to Wan disables them', () => {
  const config = nativeConfig()
  assert.equal(canUseUniversalOmniVideoApi(config), true)
  config.default_model = WAN
  assert.equal(canUseUniversalOmniVideoApi(config), false)
  config.default_model = H3
  assert.equal(canUseUniversalOmniVideoApi(config), true)
})

test('native Wan ignores legacy full-reference opt-ins in object and JSON settings', () => {
  for (const settings of [{ supports_universal_omni: true }, '{"supports_universal_omni":true}', { supports_universal_omni: 1 }]) {
    assert.equal(canUseUniversalOmniVideoApi(nativeConfig({ default_model: WAN, settings })), false)
  }
  assert.equal(canUseUniversalOmniVideoApi(nativeConfig({ api_protocol: 'comfyui', default_model: 'unsupported-workflow', settings: { supports_universal_omni: true } })), false)
})

test('explicit HTTP proxies preserve prior opt-in behavior even for Wan aliases', () => {
  for (const proxy of [{ endpoint: '/proxy/generations' }, { query_endpoint: '/proxy/tasks/{id}' }, { api_protocol: 'openai' }]) {
    const config = nativeConfig({ default_model: WAN, ...proxy })
    assert.equal(canUseUniversalOmniVideoApi(config), false)
    config.settings = '{"supports_universal_omni":true}'
    assert.equal(canUseUniversalOmniVideoApi(config), true)
  }
  assert.equal(canUseUniversalOmniVideoApi(nativeConfig({ api_protocol: 'volcengine_omni', default_model: WAN })), true)
})

test('connection payload preserves the full model list, selected default and routing fields', () => {
  const config = nativeConfig({ default_model: WAN, settings: '{"preserve":true}' })
  const snapshot = structuredClone(config)
  assert.deepEqual(buildAIConnectionTestPayload(config), snapshot)
  assert.deepEqual(config, snapshot)
  const proxy = { ...config, api_protocol: 'openai', endpoint: '/proxy/create', query_endpoint: '/proxy/poll' }
  assert.deepEqual(buildAIConnectionTestPayload(proxy), proxy)
  assert.equal(buildAIConnectionTestPayload({ ...config, model: 'unchanged-scalar-model' }).model, 'unchanged-scalar-model')
})

test('actual provider selection clears stale proxy paths and previews native ComfyUI', () => {
  const harness = formHarness()
  Object.assign(harness.form.value, { service_type: 'video', provider: 'comfyui', endpoint: '/old/create', query_endpoint: '/old/poll', supports_universal_omni: true })
  harness.onProviderChange('comfyui')
  assert.equal(harness.form.value.base_url, preset.base_url)
  assert.equal(harness.form.value.api_protocol, 'comfyui')
  assert.equal(harness.form.value.modelText, `${H3}\n${WAN}`)
  assert.equal(harness.form.value.default_model, H3)
  assert.equal(harness.form.value.endpoint, '')
  assert.equal(harness.form.value.query_endpoint, '')
  assert.equal(harness.form.value.supports_universal_omni, true)
  assert.equal(harness.endpointPreviewInfo.value.submit, `${preset.base_url}/prompt`)
  assert.equal(harness.endpointPreviewInfo.value.query, `${preset.base_url}/history/{promptId}`)
  assert.equal(harness.endpointPreviewInfo.value.isComfyUI, true)
  assert.match(harness.comfyUICapabilityHint.value, /9 张参考图.*首帧和尾帧/)
  harness.form.value.default_model = WAN
  assert.match(harness.comfyUICapabilityHint.value, /单张首帧.*不支持尾帧或多图/)
})

test('actual normal and locked form key rules allow native empty keys but keep proxy keys required', () => {
  const harness = formHarness()
  const lockedKeyRule = component.match(/<el-form-item prop="api_key" :rules="([^"]+)"/)[1]
  Object.assign(harness.form.value, { ...nativeConfig(), modelText: `${H3}\n${WAN}` })
  assert.equal(validateKey(harness, ''), null)
  assert.equal(harness.evaluate(lockedKeyRule)[0].required, false)
  harness.form.value.api_protocol = 'openai'
  assert.match(validateKey(harness, '').message, /API Key/)
  assert.equal(harness.evaluate(lockedKeyRule)[0].required, true)
  assert.equal(validateKey(harness, 'proxy-key'), null)
  harness.form.value.service_type = 'jimeng2_character_auth'
  assert.match(validateKey(harness, '').message, /Token/)
  harness.form.value.service_type = 'video'
  harness.form.value.api_protocol = 'kling_omni'
  harness.form.value.kling_access_key = 'ak'
  harness.form.value.kling_secret_key = 'sk'
  assert.equal(validateKey(harness, ''), null)
})

test('native capability UI hides the legacy opt-in switch and restores it for explicit proxies', () => {
  const harness = formHarness()
  const switchCondition = component.match(/<el-form-item v-if="([^"]+)">\s*<template #label>\s*<span class="form-label-tip">全能多图/)[1]
  Object.assign(harness.form.value, nativeConfig())
  assert.equal(harness.evaluate(switchCondition), false)
  harness.form.value.api_protocol = 'openai'
  assert.equal(harness.evaluate(switchCondition), true)
})

test('failed form validation never enters the save operation', async () => {
  for (const validate of [async () => { throw new Error('API Key required') }, async () => false]) {
    const harness = formHarness()
    const savingTransitions = []
    Object.defineProperty(harness.saving, 'value', { get: () => false, set: value => savingTransitions.push(value) })
    harness.formRef.value = { validate }
    await harness.submit()
    assert.deepEqual(savingTransitions, [])
    assert.deepEqual(harness.calls, [])
  }
})

test('actual openTest forwards the selected Wan default together with all saved routing fields', async () => {
  const harness = formHarness()
  const config = nativeConfig({ default_model: WAN, settings: null })
  await harness.openTest(config)
  assert.equal(harness.calls.length, 1)
  assert.deepEqual(harness.calls[0], config)
  assert.equal(harness.testResult.value, true)
})
