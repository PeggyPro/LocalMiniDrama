import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ref, watch, onScopeDispose, effectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useFilmStore } from '../src/stores/film.js'
import { createCanvasOperationGuard } from '../src/utils/canvasEpisodeScope.js'

const source = readFileSync(new URL('../src/composables/useCanvasEpisodeGenerate.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replace(/^export /gm, '')
const instantiate = new Function('ref', 'watch', 'onScopeDispose', 'ElMessage', 'ElMessageBox',
  'dramaAPI', 'storyboardsAPI', 'taskAPI', 'useFilmStore', 'parseDramaMetadata',
  'getDramaGenerationOptions', 'createCanvasOperationGuard', 'runImageStep', 'runVideoStep',
  'hasStoryboardImage', 'hasStoryboardVideo', 'CANVAS_NODE_STATUS_LABELS', `${source}\nreturn useCanvasEpisodeGenerate`)
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
function harness(t, script = '') {
  setActivePinia(createPinia())
  const film = useFilmStore()
  const ep = { id: 11, revision: 1, title: '手写标题', source_text: '小说原文'.repeat(5000),
    description: '改编要求不是剧本', script_content: script, storyboards: [] }
  const drama = ref({ id: 1, episodes: [ep] })
  film.setDrama(drama.value)
  film.setCurrentEpisode(ep)
  const calls = []
  const messages = []
  let saveAction = async () => { throw new Error('Unexpected save') }
  const composable = instantiate(ref, watch, onScopeDispose, {
    warning: (text) => messages.push(['warning', text]), error: (text) => messages.push(['error', text]),
    success: (text) => messages.push(['success', text]), info: (text) => messages.push(['info', text]),
  }, { confirm: async () => {} }, {
    generateStoryboard: async (...args) => { calls.push(['storyboards', ...args]); return {} },
  }, { batchInferParams: async (...args) => { calls.push(['infer', ...args]) } },
  { get: async () => { throw new Error('Unexpected polling') } }, useFilmStore, () => ({}),
  () => ({ style: '动画', aspectRatio: '16:9' }), createCanvasOperationGuard,
  async () => { throw new Error('Unexpected image generation') }, async () => { throw new Error('Unexpected video generation') },
  () => false, () => false, {})
  const scope = effectScope()
  const actions = scope.run(() => composable({ drama, dramaId: ref(1), filterEpisodeId: ref(11),
    imagesBySbId: ref({}), videosBySbId: ref({}), refreshCanvas: async () => {},
    saveScript: (id) => saveAction(id), nodeStatus: null,
  }))
  t.after(() => scope.stop())
  return { film, drama, ep, calls, messages, actions, setSaveAction: (fn) => { saveAction = fn } }
}

test('storyboard generation refuses source/instructions without an actual script', async (t) => {
  const h = harness(t, '  ')
  await h.actions.aiGenerateStoryboards()
  assert.deepEqual(h.calls, [])
  assert.deepEqual(h.messages, [['warning', '该集暂无剧本，请先编写或导入剧本']])
  assert.equal(h.film.currentEpisodeDraft.title, '手写标题')
  assert.equal(h.film.currentEpisodeDraft.dirty, false)
})

test('storyboard generation uses only script output for duration and keeps raw source out of its payload', async (t) => {
  const h = harness(t, '剧'.repeat(600))
  await h.actions.aiGenerateStoryboards()
  assert.deepEqual(h.calls, [
    ['storyboards', 11, {
      style: '动画', aspect_ratio: '16:9', video_duration: 70,
      include_narration: false, universal_omni_storyboard: false,
    }],
    ['infer', 11, false],
  ])
  assert.equal(h.film.currentEpisodeDraft.sourceText, h.ep.source_text)
  assert.equal(h.film.currentEpisodeDraft.title, '手写标题')
})

test('source edits arriving during the prerequisite save pause storyboard work and remain dirty', async (t) => {
  const h = harness(t, '已写剧本')
  const request = deferred()
  let submitted
  h.setSaveAction(async (id) => {
    assert.equal(id, 11)
    submitted = h.film.snapshotEpisodeDraft(1, id)
    const saved = await request.promise
    h.film.markEpisodeDraftSaved(1, id, saved, submitted)
    h.drama.value = { id: 1, episodes: [saved] }
    h.film.setDrama(h.drama.value)
  })
  h.film.updateEpisodeDraft(1, 11, { sourceText: '提交原文' })
  const generating = h.actions.aiGenerateStoryboards()
  assert.equal(submitted.sourceText, '提交原文')
  h.film.updateEpisodeDraft(1, 11, { sourceText: '继续编辑原文' })
  request.resolve({ ...h.ep, source_text: '提交原文', revision: 2 })
  await generating
  assert.deepEqual(h.calls, [])
  assert.deepEqual(h.messages, [['error', '保存期间剧本有新修改，请先保存后再生成分镜']])
  assert.equal(h.film.currentEpisodeDraft.sourceText, '继续编辑原文')
  assert.equal(h.film.currentEpisodeDraft.scriptContent, '已写剧本')
  assert.equal(h.film.currentEpisodeDraft.dirty, true)
  assert.equal(h.actions.episodeGenerating.value, false)
})
