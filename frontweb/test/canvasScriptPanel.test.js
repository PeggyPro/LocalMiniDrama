import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import { computed, reactive, ref, watch, onScopeDispose, effectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useFilmStore } from '../src/stores/film.js'
import { createCanvasOperationGuard } from '../src/utils/canvasEpisodeScope.js'

// Compile and run the actual setup bindings. API responses are controlled local promises.
function component(name, dependencies) {
  const { descriptor } = parse(readFileSync(new URL(`../src/components/dramaCanvas/${name}.vue`, import.meta.url), 'utf8'))
  const script = compileScript(descriptor, { id: name })
  const content = script.content.replace(/^import .*$/gm, '').replace(/^export default /m, 'return ')
  const instantiate = new Function(...Object.keys(dependencies), content)
  return { descriptor, script, options: instantiate(...Object.values(dependencies)) }
}
const scriptSource = readFileSync(new URL('../src/composables/useCanvasScript.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replace(/^export /gm, '')
const makeActions = new Function('ref', 'watch', 'onScopeDispose', 'ElMessage', 'dramaAPI',
  'generationAPI', 'propAPI', 'taskAPI', 'useFilmStore', 'getDramaGenerationOptions',
  'createCanvasOperationGuard', 'CANVAS_NODE_STATUS_LABELS', `${scriptSource}\nreturn useCanvasScript`)
const episode = (id, revision = 1) => ({
  id, revision, title: `第${id}集`, source_text: `小说原文${id}`, description: '改编要求', script_content: `剧本${id}`,
  characters: [], scenes: [], props: [], storyboards: [],
})
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
function harness(t) {
  setActivePinia(createPinia())
  const film = useFilmStore()
  const drama = ref({ id: 1, episodes: [episode(11), episode(22)] })
  film.setDrama(drama.value)
  film.setCurrentEpisode(drama.value.episodes[0])
  const focusedNodeId = ref('script:11')
  const ctx = { drama, focusedNodeId, clearFocusedNode: () => { focusedNodeId.value = null } }
  const calls = []
  const request = deferred()
  const api = { updateEpisode: (...args) => { calls.push(args); return request.promise } }
  const messages = []
  const message = { success: (text) => messages.push(text), error: (text) => messages.push(text) }
  const actionsScope = effectScope()
  let serverEpisode = drama.value.episodes[0]
  const refresh = async () => {
    drama.value = { ...drama.value, episodes: [serverEpisode, drama.value.episodes[1]] }
    film.setDrama(drama.value)
  }
  const actions = makeActions(ref, watch, onScopeDispose, message, api, {}, {}, {}, useFilmStore,
    () => ({}), createCanvasOperationGuard, {})
  ctx.scriptActions = actionsScope.run(() => actions({ drama, dramaId: computed(() => drama.value.id),
    filterEpisodeId: ref(11), refreshCanvas: refresh, nodeStatus: null,
  }))
  const scopes = [actionsScope]
  t.after(() => scopes.forEach((scope) => scope.stop()))
  function openPanel() {
    focusedNodeId.value = 'script:11'
    const compiled = component('CanvasScriptPanel', {
      computed, reactive, ref, watch, onScopeDispose, ElMessage: message, ElMessageBox: {},
      useCanvasContext: () => ctx, useFilmStore, dramaAPI: api,
    })
    const scope = effectScope()
    scopes.push(scope)
    const props = reactive({ episode: drama.value.episodes[0], nodeId: 'script:11' })
    const state = scope.run(() => compiled.options.setup(props, { expose() {} }))
    return { ...compiled, state, scope, props }
  }
  function openNode() {
    const compiled = component('CanvasScriptNode', {
      computed, Handle: {}, Position: {}, useCanvasContext: () => ctx, useFilmStore,
      CanvasScriptPanel: {}, CanvasNodeStatusOverlay: {},
    })
    return compiled.options.setup(reactive({ id: 'script:11', data: { episode: drama.value.episodes[0] } }), { expose() {} })
  }
  return { film, drama, ctx, calls, request, messages, refresh, openPanel, openNode,
    setServerEpisode: (ep) => { serverEpisode = ep },
  }
}

test('canvas panel renders explicit source, optional instructions and script models with manual title/save', (t) => {
  const h = harness(t)
  const { descriptor, script, state } = h.openPanel()
  for (const label of ['集标题', '本集原文', '改编要求（选填）', '本集剧本']) {
    assert.ok(descriptor.template.content.includes(`label="${label}"`), label)
  }
  const template = compileTemplate({ id: 'CanvasScriptPanel', source: descriptor.template.content,
    compilerOptions: { bindingMetadata: script.bindings },
  })
  assert.deepEqual(template.errors, [])
  assert.equal(state.form.title, '第11集')
  assert.equal(state.form.sourceText, '小说原文11')
  assert.equal(state.form.description, '改编要求')
  assert.equal(state.form.scriptContent, '剧本11')
  state.form.sourceText = '只修改原文'
  state.form.description = ''
  assert.equal(state.form.scriptContent, '剧本11')
  assert.equal(state.form.title, '第11集')
  assert.equal(state.scriptLen.value, '剧本11'.length)
  assert.equal(h.film.getEpisodeDraft(1, 11).sourceText, '只修改原文')
  assert.equal(h.film.getEpisodeDraft(1, 11).dirty, true)
})

test('source and other edits survive refresh, panel collapse and save acknowledgement before reopening', async (t) => {
  const h = harness(t)
  const panel = h.openPanel()
  Object.assign(panel.state.form, { title: '提交标题', sourceText: '提交原文', description: '提交要求', scriptContent: '提交剧本' })
  const saving = panel.state.onSave()
  assert.deepEqual(h.calls, [[1, 11, {
    title: '提交标题', source_text: '提交原文', description: '提交要求', script_content: '提交剧本', expected_revision: 1,
  }]])
  const newerEdits = { title: '继续改标题', sourceText: '保存期间的新原文', description: '', scriptContent: '保存期间的新剧本' }
  Object.assign(panel.state.form, newerEdits)
  await h.refresh()
  for (const [key, value] of Object.entries(newerEdits)) assert.equal(panel.state.form[key], value)
  panel.state.closePanel()
  assert.equal(h.ctx.focusedNodeId.value, null)
  panel.scope.stop() // v-if removes the panel; the canvas/store and submitted request remain alive.
  const saved = { ...episode(11, 2), title: '提交标题', source_text: '提交原文', description: '提交要求', script_content: '提交剧本' }
  h.setServerEpisode(saved)
  h.request.resolve(saved)
  await saving
  const reopened = h.openPanel()
  for (const [key, value] of Object.entries(newerEdits)) assert.equal(reopened.state.form[key], value)
  const draft = h.film.getEpisodeDraft(1, 11)
  assert.equal(draft.baseRevision, 2)
  assert.equal(draft.baseSnapshot.sourceText, '提交原文')
  assert.equal(draft.dirty, true)
  assert.equal(draft.remoteConflict, false)
  assert.equal(h.film.getEpisodeDraft(1, 22).dirty, false)
})

test('canvas node preview and empty-script state use only script output', (t) => {
  const h = harness(t)
  h.film.updateEpisodeDraft(1, 11, { sourceText: '很长的小说原文', description: '改编要求', scriptContent: '' })
  const node = h.openNode()
  assert.equal(node.hasScript.value, false)
  assert.equal(node.previewText.value, '暂无剧本，点击编辑')
  const panel = h.openPanel()
  panel.state.form.scriptContent = '剧本输出\n人物对白'
  assert.equal(node.hasScript.value, true)
  assert.equal(node.previewText.value, '剧本输出 人物对白')
  panel.state.form.sourceText = '新原文不进入预览'
  panel.state.form.description = '新要求不进入预览'
  panel.state.closePanel()
  panel.scope.stop()
  assert.equal(node.previewText.value, '剧本输出 人物对白')
  assert.equal(h.openPanel().state.form.sourceText, '新原文不进入预览')
})
