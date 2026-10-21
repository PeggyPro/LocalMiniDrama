import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse, compileScript } from 'vue/compiler-sfc'
import { computed, effectScope, nextTick, ref, shallowReactive, watch } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useFilmStore } from '../src/stores/film.js'

// Execute the editor's own handlers and watch statements, including their scheduling options.
const source = readFileSync(new URL('../src/views/FilmCreate.vue', import.meta.url), 'utf8')
const { descriptor } = parse(source)
const script = compileScript(descriptor, { id: 'film-episode-route-test' })
const setup = descriptor.scriptSetup.content
const handlerNames = ['resolveRouteEpisode', 'isProjectActive', 'onEpisodeSelect', 'loadDrama', 'applyRouteToStore', 'syncEpisodeQuery']
const handlers = handlerNames.map((name) => {
  const node = script.scriptSetupAst.find((item) => item.type === 'FunctionDeclaration' && item.id.name === name)
  assert.ok(node, `editor handler ${name} exists`)
  return setup.slice(node.start, node.end)
}).join('\n')
const routeWatches = script.scriptSetupAst.filter((node) => {
  if (node.type !== 'ExpressionStatement' || node.expression.type !== 'CallExpression') return false
  const call = node.expression
  if (call.callee.type !== 'Identifier' || call.callee.name !== 'watch') return false
  const watched = call.arguments[0]
  return watched && /route\.(?:params|query)/.test(setup.slice(watched.start, watched.end))
}).map((node) => setup.slice(node.start, node.end)).join('\n')
assert.ok(routeWatches, 'actual editor route watchers are registered')

function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function episode(id, number) {
  return {
    id, episode_number: number, revision: 1, title: `title-${id}`,
    source_text: `source-${id}`, description: `instructions-${id}`, script_content: `script-${id}`,
    characters: [{ id: id * 10 + 1 }], props: [{ id: id * 10 + 2 }],
    scenes: [{ id: id * 10 + 3 }], storyboards: [{ id: id * 10 + 4 }],
  }
}
const first = episode(1, 1)
const second = episode(2, 2)
const project = { id: 1, metadata: {}, episodes: [first, second] }

async function flushRoute() {
  await nextTick()
  // Let router promises and both response-await continuations complete without timers.
  await new Promise((resolve) => setImmediate(resolve))
  await nextTick()
}

async function createEditor(t, {
  url = '/film/1?episode=1', cachedDrama = project, cachedEpisodeId = 2,
  backfill = async (_api, _id, drama) => drama,
} = {}) {
  const store = useFilmStore(createPinia())
  if (cachedDrama) {
    store.setDrama(structuredClone(cachedDrama))
    store.setCurrentEpisode(store.drama.episodes?.find((ep) => ep.id === cachedEpisodeId) || null)
  }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/film/:id', component: {} }],
  })
  await router.push(url)
  // useRoute exposes shallow reactive getters backed by currentRoute in the same way.
  const route = shallowReactive({
    get params() { return router.currentRoute.value.params },
    get query() { return router.currentRoute.value.query },
  })
  const requests = []
  const flights = []
  const errors = []
  const warnings = []
  const navigations = []
  const removeAfterEach = router.afterEach((to) => navigations.push(to.fullPath))
  const selectedEpisodeId = ref(null)
  const applyingRoute = ref(false)
  const env = {
    store, route, router, selectedEpisodeId, applyingRoute,
    dramaId: computed(() => store.dramaId),
    // Keep the actual Vue scheduler and callback options; retain async completions for assertions.
    watch: (getter, callback, options) => watch(getter, (...args) => {
      const result = callback(...args)
      if (result?.then) flights.push(result)
      return result
    }, options),
    dramaAPI: {
      get(id) {
        const request = { dramaId: Number(id), ...deferred() }
        requests.push(request)
        return request.promise
      },
    },
    backfillDramaStylePromptMetadataIfNeeded: backfill,
    CUSTOM_STYLE_VALUE: 'custom',
    pipelineRunning: ref(false), pipelineAbortRequested: ref(false), pipelinePaused: ref(false),
    showServerScript: ref(false), referencePrevious: ref(false),
    syncStoryboardStateFromEpisode() {}, loadStoryboardMedia() {}, recoverAndSyncEpisodeTasks() {},
    ElMessage: { error(message) { errors.push(message) }, warning(message) { warnings.push(message) } },
  }
  for (const name of [
    'newProjectTitle', 'newProjectBackground', 'newEpisodeSource', 'newEpisodeTitle', 'newEpisodePremise',
    'newEpisodeScript', 'storyStyle', 'storyType', 'generationStyle', 'customStylePrompt', 'projectAspectRatio',
    'videoClipDuration', 'storyboardIncludeNarration', 'storyboardUniversalOmni', 'storyboardUseFirstLastFrame',
    'lastFrameUseFirstLayoutLock', 'gridMode', 'scriptLanguage', 'scriptStoryboardStyle',
  ]) env[name] = ref('')
  const scope = effectScope()
  const editor = scope.run(() => new Function(...Object.keys(env), `
    let pageActive = true, routeEpoch = 0, episodeEpoch = 0, loadRequest = 0, pipelineResolveResume = null
    ${handlers}
    ${routeWatches}
    return { ${handlerNames.join(',')}, dispose() { pageActive = false; routeEpoch++; loadRequest++ } }
  `)(...Object.values(env)))
  t.after(async () => {
    editor.dispose()
    scope.stop()
    removeAfterEach()
    for (const request of requests) request.resolve({ id: request.dramaId, episodes: [], metadata: {} })
    await Promise.all(flights)
    store.$dispose()
  })
  return {
    store, router, editor, requests, errors, warnings, navigations, selectedEpisodeId, applyingRoute,
    async settle() { await Promise.all(flights); await flushRoute() },
  }
}

function assertEpisode(editor, expected) {
  assert.equal(editor.selectedEpisodeId.value, expected?.id ?? null)
  assert.equal(editor.store.currentEpisode?.id ?? null, expected?.id ?? null)
  const draft = editor.store.currentEpisodeDraft
  assert.equal(draft?.title ?? '', expected?.title ?? '')
  assert.equal(draft?.sourceText ?? '', expected?.source_text ?? '')
  assert.equal(draft?.description ?? '', expected?.description ?? '')
  assert.equal(editor.store.scriptContent, expected?.script_content ?? '')
  for (const resource of ['characters', 'props', 'scenes', 'storyboards']) {
    assert.deepEqual(editor.store[resource].map((item) => item.id), (expected?.[resource] || []).map((item) => item.id))
  }
}

async function travel(router, direction) {
  const navigated = new Promise((resolve, reject) => {
    const stop = router.afterEach((_to, _from, failure) => {
      stop()
      if (failure) reject(failure)
      else resolve()
    })
  })
  router[direction]()
  await navigated
  await flushRoute()
}

test('reopening cached episode 2 at episode 1 binds episode 1 before loading and keeps it on failure', async (t) => {
  const editor = await createEditor(t)
  assert.equal(editor.requests.length, 1, 'the actual immediate params watcher starts loading')
  assert.equal(editor.applyingRoute.value, true)
  assertEpisode(editor, first)
  assert.equal(editor.router.currentRoute.value.fullPath, '/film/1?episode=1')
  editor.requests[0].reject(new Error('simulated load failure'))
  await editor.settle()
  assertEpisode(editor, first)
  assert.deepEqual(editor.errors, ['simulated load failure'])
  assert.equal(editor.applyingRoute.value, false)
  assert.equal(editor.router.currentRoute.value.fullPath, '/film/1?episode=1')
})

test('a requested episode absent from the cache clears the previous episode while loading', async (t) => {
  const editor = await createEditor(t, { cachedDrama: { ...project, episodes: [second] } })
  assertEpisode(editor, null)
  assert.equal(editor.router.currentRoute.value.query.episode, '1')
  editor.requests[0].resolve(structuredClone(project))
  await editor.settle()
  assertEpisode(editor, first)
  assert.equal(editor.router.currentRoute.value.query.episode, '1')
})

test('query navigation during a pending load wins immediately and cannot be rolled back by its response', async (t) => {
  const editor = await createEditor(t, { url: '/film/1?episode=2' })
  assertEpisode(editor, second)
  await editor.router.push('/film/1?episode=1')
  assert.equal(editor.applyingRoute.value, true)
  assertEpisode(editor, first)
  editor.requests[0].resolve(structuredClone(project))
  await editor.settle()
  assertEpisode(editor, first)
  assert.equal(editor.router.currentRoute.value.fullPath, '/film/1?episode=1')
  assert.deepEqual(editor.navigations, ['/film/1?episode=1'])
  assert.equal(editor.requests.length, 1, 'query-only navigation does not restart the project request')
})

test('the latest query also wins when it changes during the metadata await after the GET', async (t) => {
  const metadata = deferred()
  t.after(() => metadata.resolve(structuredClone(project)))
  let backfillStarted = false
  const editor = await createEditor(t, {
    url: '/film/1?episode=2',
    backfill: async () => { backfillStarted = true; return metadata.promise },
  })
  editor.requests[0].resolve(structuredClone(project))
  await flushRoute()
  assert.equal(backfillStarted, true)
  await editor.router.push('/film/1?episode=1')
  assertEpisode(editor, first)
  metadata.resolve(structuredClone(project))
  await editor.settle()
  assertEpisode(editor, first)
  assert.equal(editor.router.currentRoute.value.fullPath, '/film/1?episode=1')
})

test('loaded query-only navigation and browser back/forward keep all episode fields aligned', async (t) => {
  const editor = await createEditor(t)
  editor.requests[0].resolve(structuredClone(project))
  await editor.settle()
  assertEpisode(editor, first)
  await editor.router.push('/film/1?episode=2')
  assertEpisode(editor, second)
  await travel(editor.router, 'back')
  assertEpisode(editor, first)
  assert.equal(editor.router.currentRoute.value.query.episode, '1')
  await travel(editor.router, 'forward')
  assertEpisode(editor, second)
  assert.equal(editor.router.currentRoute.value.query.episode, '2')
  assert.equal(editor.requests.length, 1)
})

test('a late response from the previous project cannot replace the new project or episode', async (t) => {
  const editor = await createEditor(t)
  const nextEpisode = episode(21, 1)
  const nextProject = { id: 2, metadata: {}, episodes: [nextEpisode, episode(22, 2)] }
  await editor.router.push('/film/2?episode=21')
  assert.equal(editor.requests.length, 2)
  assert.equal(editor.requests[1].dramaId, 2)
  assert.equal(editor.store.dramaId, 2)
  assertEpisode(editor, null)
  editor.requests[1].resolve(nextProject)
  await flushRoute()
  assertEpisode(editor, nextEpisode)
  editor.requests[0].resolve(structuredClone(project))
  await editor.settle()
  assert.equal(editor.store.dramaId, 2)
  assertEpisode(editor, nextEpisode)
  assert.equal(editor.router.currentRoute.value.fullPath, '/film/2?episode=21')
})

test('an explicit episode query resolves database ID rather than chapter number or array position', async (t) => {
  const target = episode(41, 2)
  const numberedFirst = episode(99, 1)
  const data = { id: 1, metadata: {}, episodes: [numberedFirst, target] }
  const editor = await createEditor(t, { url: '/film/1?episode=41', cachedDrama: data, cachedEpisodeId: 99 })
  assertEpisode(editor, target)
  editor.requests[0].resolve(data)
  await editor.settle()
  assertEpisode(editor, target)
  assert.equal(editor.router.currentRoute.value.query.episode, '41')
})

test('an explicit invalid or nonexistent episode never falls back to a sibling or rewrites the query', async (t) => {
  for (const id of ['999', 'invalid', '']) {
    await t.test(`episode=${id}`, async (t) => {
      const editor = await createEditor(t, { url: `/film/1?episode=${id}` })
      assertEpisode(editor, null)
      editor.requests[0].resolve(structuredClone(project))
      await editor.settle()
      assertEpisode(editor, null)
      assert.equal(editor.router.currentRoute.value.query.episode, id)
      assert.deepEqual(editor.navigations, [])
      assert.deepEqual(editor.errors, [])
      assert.deepEqual(editor.warnings, ['该分集不存在或已删除，请返回剧集重新选择'])
    })
  }
})

test('only an absent episode query selects the first episode and canonicalizes while retaining other query keys', async (t) => {
  const target = episode(41, 2)
  const data = { id: 1, metadata: {}, episodes: [target, episode(99, 1)] }
  const editor = await createEditor(t, { url: '/film/1?tab=script', cachedDrama: data, cachedEpisodeId: 99 })
  assertEpisode(editor, target)
  editor.requests[0].resolve(data)
  await editor.settle()
  assertEpisode(editor, target)
  assert.equal(editor.router.currentRoute.value.query.episode, '41')
  assert.equal(editor.router.currentRoute.value.query.tab, 'script')
})
