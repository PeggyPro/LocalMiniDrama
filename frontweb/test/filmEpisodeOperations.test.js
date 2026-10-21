import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse, compileScript } from 'vue/compiler-sfc'
import { captureEpisodeScope, prepareEpisodeImport } from '../src/utils/episodeOperations.js'
import { generateEpisodeStory } from '../src/utils/episodeStoryGeneration.js'

// Execute the actual editor handlers, with network and Vue state supplied by the test.
const source = readFileSync(new URL('../src/views/FilmCreate.vue', import.meta.url), 'utf8')
const { descriptor } = parse(source)
const script = compileScript(descriptor, { id: 'episode-editor-test' })
function handlers(names, env, declarations = '') {
  const functions = names.map((name) => {
    const node = script.scriptSetupAst.find((item) => item.type === 'FunctionDeclaration' && item.id.name === name)
    assert.ok(node, `handler ${name} exists`)
    return descriptor.scriptSetup.content.slice(node.start, node.end)
  }).join('\n')
  return new Function(...Object.keys(env), `${declarations}\n${functions}\nreturn {${names.join(',')}}`)(...Object.values(env))
}
const ref = (value) => ({ value })
function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const messages = { error() {}, warning() {}, success() {} }

test('a single episode save keeps chapter headings as text and never replaces the collection', async () => {
  const episode = { id: 22, episode_number: 2, script_content: 'old' }
  const calls = []
  const content = '第1集 标题是正文\n保留这段。\n第2集 也只是正文\n不得自动拆分。'
  const snapshot = { title: '第二集', description: '第二集要求', scriptContent: content, baseRevision: 5 }
  const store = {
    dramaId: 7, currentEpisode: episode,
    updateEpisodeDraft(did, eid, patch) { calls.push(['draft', did, eid, patch]) },
    snapshotEpisodeDraft() { return snapshot }, getEpisodeDraft() { return { remoteConflict: false } },
    markEpisodeDraftSaved(...args) { calls.push(['ack', ...args]) },
  }
  const { saveScriptToBackend } = handlers(['saveScriptToBackend'], {
    store, ensureCurrentEpisode: async () => episode, captureCurrentScope: () => () => true,
    dramaAPI: { async updateEpisode(...args) { calls.push(['patch', ...args]); return { ...episode, revision: 6 } } },
    reviewEpisodeKeys: new Set(), loadDrama: async () => {},
  })
  const result = await saveScriptToBackend(content)
  const patch = calls.find(([kind]) => kind === 'patch')
  assert.deepEqual(patch, ['patch', 7, 22, { title: '第二集', description: '第二集要求', script_content: content, expected_revision: 5 }])
  assert.equal(result.episodeId, 22)
  assert.equal(calls.filter(([kind]) => kind === 'patch').length, 1)
})

test('switching while the save prepares cannot patch either the old or new episode', async () => {
  const episode = { id: 22 }
  let active = true
  let writes = 0
  const store = { dramaId: 7, currentEpisode: episode }
  const { saveScriptToBackend } = handlers(['saveScriptToBackend'], {
    store, ensureCurrentEpisode: async () => { active = false; store.dramaId = 8; store.currentEpisode = { id: 33 }; return episode },
    captureCurrentScope: () => () => active,
    dramaAPI: { async updateEpisode() { writes++ } },
  })
  assert.deepEqual(await saveScriptToBackend('old episode text'), { scopeChanged: true })
  assert.equal(writes, 0)
})

test('first episode creation is single-flight during a slow project request', async () => {
  const pending = deferred()
  let projects = 0
  let episodes = 0
  const store = {
    dramaId: null, drama: null, currentEpisode: null,
    setDrama(project) { this.drama = project; this.dramaId = project.id },
    updateEpisodeDraft() {},
  }
  const route = { params: { id: 'new' } }
  const env = {
    store, route, routeEpoch: 1, pageActive: true,
    newProjectTitle: ref('全剧'), newProjectBackground: ref('背景'), newEpisodeTitle: ref('第二名称'),
    newEpisodePremise: ref('本集要求'), newEpisodeScript: ref('本集正文'), storyType: ref('drama'), storyStyle: ref('ancient'),
    generationStyle: ref('costume'), projectAspectRatio: ref('16:9'), projectStylePromptMetadata: () => ({}),
    isProjectActive: () => true,
    dramaAPI: {
      async create() { projects++; return pending.promise },
      async createEpisode(did, body) { episodes++; assert.equal(did, 4); assert.equal(body.expected_collection_revision, 0); return { id: 44, episode_number: 1, revision: 1, episodes_revision: 1 } },
    },
    onEpisodeSelect(id) { store.currentEpisode = store.drama.episodes.find((ep) => ep.id === id) },
    router: { async replace() {} },
  }
  const { ensureCurrentEpisode } = handlers(['ensureCurrentEpisode', 'ensureCurrentEpisodeOnce'], env, 'let episodeCreationFlight = null')
  const first = ensureCurrentEpisode()
  const second = ensureCurrentEpisode()
  assert.equal(first, second)
  pending.resolve({ id: 4, episodes_revision: 0 })
  assert.equal((await first).id, 44)
  assert.equal((await second).id, 44)
  assert.equal(projects, 1)
  assert.equal(episodes, 1)
})

test('generation locks the pre-save window against rapid duplicate clicks', async () => {
  const saved = deferred()
  let saveCount = 0
  let generationCount = 0
  const busy = ref(false)
  const env = {
    isStoryGenRunning: ref(false), episodeSubmitBusy: busy, scriptGenerating: ref(false), productionPreparing: ref(false),
    storyInput: ref('本集要求'), scriptContent: ref(''), episodeDraft: ref({ dirty: false }), scriptTitle: ref('第二集'),
    storyStyle: ref('ancient'), storyType: ref('drama'), referencePrevious: ref(false),
    captureCurrentScope: () => () => true, ElMessage: messages, store: {}, operationScope: ref(null), storyGenerating: ref(false),
    saveScriptToBackend: async () => { saveCount++; return saved.promise },
    runGenerateStoryFromPremise: async () => { generationCount++ }, pollTask() {},
    reviewEpisodeKeys: new Set(), loadDrama: async () => {}, generationCandidates: {}, trackFilmCreateAction() {},
  }
  const { onGenerateStory } = handlers(['onGenerateStory'], env)
  const first = onGenerateStory()
  await onGenerateStory()
  assert.equal(saveCount, 1)
  assert.equal(busy.value, true)
  saved.resolve({ dramaId: 7, episodeId: 22 })
  await first
  assert.equal(generationCount, 1)
  assert.equal(busy.value, false)
})

test('a pipeline cannot submit its next stage after switching episodes', async () => {
  const response = deferred()
  let active = true
  let characterRequests = 0
  let sceneRequests = 0
  const env = {
    currentEpisodeId: ref(22), dramaId: ref(7), getSelectedStyle: () => 'costume',
    store: { currentEpisode: { id: 22, characters: [] }, scriptContent: '本集正文' }, storyInput: ref('本集要求'),
    pipelineScope: () => active, pipelineAbortRequested: ref(false), pageActive: true, pipelinePaused: ref(false),
    setPipelineStep() {}, addPipelineError() {}, waitForResume: async () => {},
    generationAPI: { async generateCharacters() { characterRequests++; return response.promise } },
    dramaAPI: { async extractBackgrounds() { sceneRequests++ } },
  }
  const { runOneClickPipeline } = handlers(['runOneClickPipeline', 'pipelineRequest', 'assertPipelineScope', 'checkPause'], env)
  const running = runOneClickPipeline(true)
  // Let the first submission enter, then navigate while its response is pending.
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(characterRequests, 1)
  active = false
  response.resolve({})
  await running
  assert.equal(sceneRequests, 0)
})

test('single generation captures the target and version and suppresses stale UI callbacks', async () => {
  const response = deferred()
  let active = true
  const calls = []
  const running = generateEpisodeStory({ dramaId: 7, episodeId: 22, expectedRevision: 5, premise: '第二集梗概', referencePrevious: true }, {
    submit: async (...args) => { calls.push(args); return response.promise },
    poll: async (taskId, meta) => { assert.equal(taskId, 'task-22'); assert.equal(meta.episodeId, 22); return { status: 'completed', result: JSON.stringify({ applied: true, drama_id: 7, episode_id: 22 }) } },
    isActive: () => active, onApplied() { assert.fail('stale callback must not refresh another episode') },
  })
  active = false
  response.resolve({ task_id: 'task-22' })
  const result = await running
  assert.equal(result.scopeChanged, true)
  assert.equal(calls[0][0], 7)
  assert.equal(calls[0][1], 22)
  assert.equal(calls[0][2].expected_revision, 5)
  assert.equal(calls[0][2].reference_previous, true)
  assert.equal(Object.hasOwn(calls[0][2], 'episode_count'), false)
})

test('generation conflicts retain a candidate and never claim the script was applied', async () => {
  const candidate = { title: '候选', script_content: '候选正文' }
  let received
  const result = await generateEpisodeStory({ dramaId: 7, episodeId: 22, expectedRevision: 5, premise: '要求' }, {
    submit: async () => ({ task_id: 'conflict-task' }),
    poll: async () => ({ status: 'completed', result: { applied: false, conflict: true, candidate, drama_id: 7, episode_id: 22 } }),
    onCandidate(value) { received = value }, onApplied() { assert.fail('conflict is not an applied save') },
  })
  assert.deepEqual(received, candidate)
  assert.equal(result.conflict, true)
})

test('scope epochs prevent a stale A to B to A callback from becoming active again', () => {
  let scope = { active: true, dramaId: 7, episodeId: 22, epoch: 1 }
  const isActive = captureEpisodeScope(() => scope)
  scope = { ...scope, episodeId: 23, epoch: 2 }
  assert.equal(isActive(), false)
  scope = { ...scope, episodeId: 22, epoch: 3 }
  assert.equal(isActive(), false)
})

test('explicit append imports start after current episodes and strip incoming IDs', () => {
  const result = prepareEpisodeImport([{ id: 999, episode_number: 1, title: '导入', script_content: '完整正文' }], { mode: 'append', episodes: [{ episode_number: 2 }, { episode_number: 5 }] })
  assert.equal(result[0].episode_number, 6)
  assert.equal(Object.hasOwn(result[0], 'id'), false)
  assert.equal(result[0].script_content, '完整正文')
  assert.throws(() => prepareEpisodeImport([{ script_content: ' ' }], { mode: 'replace' }), /没有正文/)
})
