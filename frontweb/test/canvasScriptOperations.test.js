import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ref, watch, onScopeDispose, effectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useFilmStore } from '../src/stores/film.js'
import { createCanvasOperationGuard } from '../src/utils/canvasEpisodeScope.js'

// Exercise the real composable with local API stubs; no browser, backend or AI service.
const source = readFileSync(new URL('../src/composables/useCanvasScript.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replace(/^export /gm, '')
const instantiate = new Function('ref', 'watch', 'onScopeDispose', 'ElMessage', 'dramaAPI',
  'generationAPI', 'propAPI', 'taskAPI', 'useFilmStore', 'getDramaGenerationOptions',
  'createCanvasOperationGuard', 'CANVAS_NODE_STATUS_LABELS', `${source}\nreturn useCanvasScript`)
const ep = (id, script = '剧本', revision = 1) => ({ id, title: `第${id}集`, description: '本集梗概', script_content: script, revision, characters: [], scenes: [], props: [] })
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
function harness(t, overrides = {}) {
  setActivePinia(createPinia())
  const film = useFilmStore()
  const drama = ref({ id: 1, episodes: [ep(11), ep(22)], characters: [{ id: 101 }], scenes: [{ id: 102 }], props: [{ id: 103 }] })
  film.setDrama(drama.value)
  film.setCurrentEpisode(drama.value.episodes[0])
  const dramaId = ref(1)
  const filterEpisodeId = ref(11)
  const calls = []
  let refreshes = 0
  const messages = []
  const api = { updateEpisode: async (...args) => { calls.push(['save', ...args]); return { ...ep(args[1]), ...args[2], revision: 2 } }, extractBackgrounds: async (id) => { calls.push(['scenes', id]); return {} }, ...overrides }
  const composable = instantiate(ref, watch, onScopeDispose, {
    success: (...args) => messages.push(args), info: (...args) => messages.push(args),
  }, api, { generateCharacters: async (did, body) => { calls.push(['characters', did, body]); return {} } },
  { extractFromScript: async (id) => { calls.push(['props', id]); return {} } },
  { get: async () => { throw new Error('unexpected polling') } }, useFilmStore, () => ({}), createCanvasOperationGuard, {})
  const nodeStatuses = new Map()
  const scope = effectScope()
  const actions = scope.run(() => composable({ drama, dramaId, filterEpisodeId,
    refreshCanvas: async () => { refreshes++ },
    nodeStatus: { set: (id, value) => nodeStatuses.set(id, value), clear: (id) => nodeStatuses.delete(id) },
  }))
  t.after(() => scope.stop())
  return { film, drama, dramaId, filterEpisodeId, calls, actions, messages, scope, nodeStatuses, get refreshes() { return refreshes } }
}

test('canvas saves only its episode with expected revision and acknowledges after switching episodes', async (t) => {
  const request = deferred()
  let submission
  const h = harness(t, { updateEpisode: (...args) => { submission = args; return request.promise } })
  h.film.updateEpisodeDraft(1, 11, { title: '独立标题', description: '独立梗概', scriptContent: '提交稿' })
  const saving = h.actions.saveScript(11)
  assert.deepEqual(submission, [1, 11, { title: '独立标题', description: '独立梗概', script_content: '提交稿', expected_revision: 1 }])
  h.film.updateEpisodeDraft(1, 11, { scriptContent: '保存期间继续输入' })
  h.filterEpisodeId.value = 22
  assert.equal(h.nodeStatuses.size, 0)
  request.resolve({ ...ep(11, '提交稿', 2), title: '独立标题', description: '独立梗概' })
  await saving
  assert.equal(h.film.getEpisodeDraft(1, 11).scriptContent, '保存期间继续输入')
  assert.equal(h.film.getEpisodeDraft(1, 11).baseRevision, 2)
  assert.equal(h.film.getEpisodeDraft(1, 11).dirty, true)
  assert.equal(h.refreshes, 0)
  assert.equal(h.messages.length, 0)
})

test('canvas save still acknowledges its draft after unmount without page callbacks', async (t) => {
  const request = deferred()
  const h = harness(t, { updateEpisode: () => request.promise })
  h.film.updateEpisodeDraft(1, 11, { scriptContent: '提交稿' })
  const saving = h.actions.saveScript(11)
  h.scope.stop()
  request.resolve(ep(11, '提交稿', 2))
  await saving
  assert.equal(h.film.getEpisodeDraft(1, 11).dirty, false)
  assert.equal(h.refreshes, 0)
  assert.equal(h.messages.length, 0)
  assert.equal(h.nodeStatuses.size, 0)
})

test('extractAll uses selected episode associations despite existing project assets', async (t) => {
  const h = harness(t)
  await h.actions.extractAll(11)
  assert.deepEqual(h.calls.map(([kind]) => kind), ['characters', 'scenes', 'props'])
  assert.deepEqual(h.calls[0], ['characters', 1, { episode_id: 11, outline: '剧本' }])
  assert.equal(h.calls[1][1], 11)
  assert.equal(h.calls[2][1], 11)
  assert.equal(h.refreshes, 3)
})

test('extractAll skips only resources already associated with the selected episode', async (t) => {
  const h = harness(t)
  h.drama.value.episodes[0].characters = [{ id: 101 }]
  h.drama.value.episodes[1].scenes = [{ id: 102 }]
  await h.actions.extractAll(11)
  assert.deepEqual(h.calls.map(([kind]) => kind), ['scenes', 'props'])
})

test('extraction pauses if edits arrive during its prerequisite save', async (t) => {
  const request = deferred()
  const h = harness(t, { updateEpisode: () => request.promise })
  h.film.updateEpisodeDraft(1, 11, { scriptContent: '提交稿' })
  const extracting = h.actions.extractAll(11)
  h.film.updateEpisodeDraft(1, 11, { scriptContent: '新编辑' })
  request.resolve(ep(11, '提交稿', 2))
  await assert.rejects(extracting, /保存期间剧本有新修改/)
  assert.equal(h.calls.length, 0)
  assert.equal(h.film.getEpisodeDraft(1, 11).dirty, true)
  assert.equal(h.actions.scriptBusy.value, false)
  assert.equal(h.nodeStatuses.size, 0)
})
