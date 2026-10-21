import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse, compileScript } from 'vue/compiler-sfc'
import { createPinia, setActivePinia } from 'pinia'
import { useFilmStore } from '../src/stores/film.js'
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
  const snapshot = { title: '第二集', sourceText: '小说完整原文', description: '第二集要求', scriptContent: content, baseRevision: 5 }
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
  assert.deepEqual(patch, ['patch', 7, 22, { title: '第二集', source_text: '小说完整原文', description: '第二集要求', script_content: content, expected_revision: 5 }])
  assert.equal(result.episodeId, 22)
  assert.equal(calls.filter(([kind]) => kind === 'patch').length, 1)
})

test('save after a revision-only refresh uses the latest version and preserves the actual store draft', async () => {
  setActivePinia(createPinia())
  const store = useFilmStore()
  const original = { id: 22, revision: 1, title: '集标题', source_text: '原文', description: '要求', script_content: '剧本' }
  store.setDrama({ id: 7, episodes: [original] })
  store.setCurrentEpisode(original)
  const edits = { title: '本地标题', sourceText: '本地原文', description: '', scriptContent: '本地剧本' }
  store.updateEpisodeDraft(7, 22, edits)
  const draft = store.currentEpisodeDraft
  const refreshed = { ...original, revision: 3 }
  store.setDrama({ id: 7, episodes: [refreshed] })
  store.setCurrentEpisode(refreshed)
  assert.equal(store.currentEpisodeDraft, draft)
  const calls = []
  const { saveScriptToBackend } = handlers(['saveScriptToBackend'], {
    store, ensureCurrentEpisode: async () => store.currentEpisode, captureCurrentScope: () => () => true,
    dramaAPI: { async updateEpisode(did, eid, body) {
      calls.push([did, eid, body])
      return { ...refreshed, title: body.title, source_text: body.source_text,
        description: body.description, script_content: body.script_content, revision: 4 }
    } },
    reviewEpisodeKeys: new Set(), loadDrama: async () => {},
  })
  await saveScriptToBackend(store.scriptContent)
  assert.deepEqual(calls, [[7, 22, {
    title: edits.title, source_text: edits.sourceText, description: '', script_content: edits.scriptContent, expected_revision: 3,
  }]])
  assert.equal(store.currentEpisodeDraft, draft)
  for (const [key, value] of Object.entries(edits)) assert.equal(draft[key], value)
  assert.equal(draft.baseRevision, 4)
  assert.equal(draft.dirty, false)
  assert.equal(draft.remoteConflict, false)
})

test('save with conflicting script edits preserves the draft and cannot overwrite the server', async () => {
  setActivePinia(createPinia())
  const store = useFilmStore()
  const original = { id: 22, revision: 1, title: '集标题', source_text: '原文', description: '', script_content: '剧本' }
  store.setDrama({ id: 7, episodes: [original] })
  store.setCurrentEpisode(original)
  store.setScriptContent('本地修改')
  const refreshed = { ...original, revision: 2, script_content: '服务器修改' }
  store.setDrama({ id: 7, episodes: [refreshed] })
  store.setCurrentEpisode(refreshed)
  const { saveScriptToBackend } = handlers(['saveScriptToBackend'], {
    store, ensureCurrentEpisode: async () => store.currentEpisode, captureCurrentScope: () => () => true,
    dramaAPI: { updateEpisode() { assert.fail('unresolved conflicts must not reach the save API') } },
  })
  await assert.rejects(saveScriptToBackend(store.scriptContent), /内容冲突/)
  assert.equal(store.scriptContent, '本地修改')
  assert.equal(store.currentEpisode.script_content, '服务器修改')
  assert.equal(store.currentEpisodeDraft.remoteConflict, true)
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
    newEpisodeSource: ref('本集原文'), newEpisodePremise: ref('本集要求'), newEpisodeScript: ref('本集正文'), storyType: ref('drama'), storyStyle: ref('ancient'),
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

test('opening another empty project clears unbound new-project inputs before its first save', async () => {
  const title = ref('A的标题')
  const premise = ref('A的要求')
  const text = ref('A的正文')
  let createdBody
  const store = {
    dramaId: 4, currentEpisode: { id: 44 }, drama: { id: 4, episodes: [{ id: 44 }] },
    reset() { this.dramaId = null; this.drama = null; this.currentEpisode = null },
    setDrama(project) { this.drama = project; this.dramaId = project.id }, updateEpisodeDraft() {},
  }
  const route = { params: { id: '30' }, query: {} }
  const env = {
    store, route, routeEpoch: 1, episodeEpoch: 1, loadRequest: 1, pageActive: true,
    applyingRoute: ref(false), pipelineRunning: ref(false),
    newProjectTitle: ref('A项目'), newProjectBackground: ref('A背景'),
    newEpisodeSource: ref('A的原文'), newEpisodeTitle: title, newEpisodePremise: premise, newEpisodeScript: text,
    selectedEpisodeId: ref(44), isProjectActive: () => true,
    loadDrama: async () => { store.setDrama({ id: 30, episodes_revision: 0, episodes: [] }) },
    syncEpisodeQuery() {}, onEpisodeSelect(id) { store.currentEpisode = store.drama.episodes.find((ep) => ep.id === id) },
    dramaAPI: { async createEpisode(did, body) { assert.equal(did, 30); createdBody = body; return { id: 300, episode_number: 1, revision: 1, episodes_revision: 1 } } },
  }
  const { applyRouteToStore, ensureCurrentEpisode } = handlers(['applyRouteToStore', 'ensureCurrentEpisode', 'ensureCurrentEpisodeOnce'], env, 'let episodeCreationFlight = null')
  await applyRouteToStore()
  assert.equal(title.value, '')
  assert.equal(premise.value, '')
  assert.equal(text.value, '')
  await ensureCurrentEpisode()
  assert.equal(createdBody.title, undefined)
  assert.equal(createdBody.source_text, '')
  assert.equal(createdBody.description, '')
  assert.equal(createdBody.script_content, '')
})

test('generation locks the pre-save window against rapid duplicate clicks', async () => {
  const saved = deferred()
  let saveCount = 0
  let generationCount = 0
  const busy = ref(false)
  const env = {
    isStoryGenRunning: ref(false), episodeSubmitBusy: busy, scriptGenerating: ref(false), productionPreparing: ref(false),
    sourceText: ref(''), storyInput: ref('本集要求'), scriptContent: ref(''), episodeDraft: ref({ dirty: false }), scriptTitle: ref('第二集'),
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
  const running = generateEpisodeStory({ dramaId: 7, episodeId: 22, expectedRevision: 5, premise: '第二集梗概', title: '用户标题不参与生成写入', referencePrevious: true }, {
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
  assert.equal(Object.hasOwn(calls[0][2], 'title'), false)
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

test('adopting a recovered AI candidate preserves the manually filled or blank title', () => {
  for (const title of ['我填写的标题', '']) {
    const draft = { title, sourceText: '原始小说', description: '用户自己的要求' }
    const candidate = { title: '旧任务中的 AI 标题', description: '候选要求', script_content: '候选正文', taskId: 'old-task' }
    const candidates = { '7:22': candidate }
    const dismissed = new Set()
    const { adoptGenerationCandidate } = handlers(['adoptGenerationCandidate'], {
      store: {
        dramaId: 7, currentEpisode: { id: 22 },
        updateEpisodeDraft(did, eid, patch) {
          assert.equal(did, 7)
          assert.equal(eid, 22)
          assert.equal(Object.hasOwn(patch, 'title'), false)
          Object.assign(draft, patch)
        },
      },
      generationCandidate: ref(candidate), generationCandidates: candidates,
      episodeKey: ref('7:22'), dismissedCandidateTaskIds: dismissed,
    })
    adoptGenerationCandidate()
    assert.equal(draft.title, title)
    assert.equal(draft.scriptContent, '候选正文')
    assert.equal(draft.sourceText, '原始小说')
    assert.equal(draft.description, '用户自己的要求')
    assert.equal(dismissed.has('old-task'), true)
    assert.equal(Object.hasOwn(candidates, '7:22'), false)
  }
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


test('original source alone can generate a script without sending or rewriting source', async () => {
  let body
  const result = await generateEpisodeStory({ dramaId: 7, episodeId: 22, expectedRevision: 5, sourceText: '完整小说原文', premise: '' }, {
    submit: async (_did, _eid, request) => { body = request; return { task_id: 'source-only' } },
    poll: async () => ({ status: 'completed', result: { applied: true, drama_id: 7, episode_id: 22 } }),
  })
  assert.equal(result.ok, true)
  assert.equal(body.premise, '')
  assert.equal(body.expected_revision, 5)
  assert.equal(Object.hasOwn(body, 'source_text'), false, 'server reads saved source protected by revision')
  await assert.rejects(generateEpisodeStory({ dramaId: 7, episodeId: 22, expectedRevision: 5, sourceText: ' ', premise: '' }, {
    submit: () => assert.fail('empty source and instructions must not submit'), poll() {},
  }), /原文或改编要求/)
})

test('the generation button accepts source-only and preserves optional instructions', async () => {
  let generated = 0
  const env = {
    isStoryGenRunning: ref(false), episodeSubmitBusy: ref(false), scriptGenerating: ref(false), productionPreparing: ref(false),
    sourceText: ref('只有小说原文'), storyInput: ref(''), scriptContent: ref(''), episodeDraft: ref({ dirty: false }),
    storyStyle: ref('ancient'), storyType: ref('drama'), referencePrevious: ref(false),
    captureCurrentScope: () => () => true, ElMessage: messages, store: {}, operationScope: ref(null), storyGenerating: ref(false),
    saveScriptToBackend: async () => ({ dramaId: 7, episodeId: 22 }),
    runGenerateStoryFromPremise: async (options) => { generated++; assert.equal(options.premise, '') }, pollTask() {},
    reviewEpisodeKeys: new Set(), loadDrama: async () => {}, generationCandidates: {}, trackFilmCreateAction() {},
  }
  await handlers(['onGenerateStory'], env).onGenerateStory()
  assert.equal(generated, 1)
})

test('current novel import replaces only source draft and preserves instructions and script', async () => {
  const original = '序言完整保留\n第1章\n' + '小说原文'.repeat(5000)
  const source = ref('以前的原文')
  const scriptContent = ref('不能覆盖的已改编剧本')
  const instructions = ref('保留已有对白')
  let confirmation = 0
  const env = {
    novelImporting: ref(false), novelImportMode: ref('text'), novelText: ref(original), novelFileContent: ref(''),
    novelDestination: ref('current'), novelMaxChapters: ref(20), novelPreview: ref([{ source_text: '章节预览', script_content: '' }]),
    sourceText: source, scriptContent, storyInput: instructions,
    captureCurrentScope: () => () => true, pageActive: true, showNovelImport: ref(true), novelFileName: ref(''),
    ElMessage: messages, ElMessageBox: { async confirm(message) { confirmation++; assert.match(message, /已有改编要求和剧本会保留/) } },
  }
  await handlers(['onImportNovel'], env).onImportNovel()
  assert.equal(confirmation, 1)
  assert.equal(source.value, original)
  assert.equal(scriptContent.value, '不能覆盖的已改编剧本')
  assert.equal(instructions.value, '保留已有对白')
  assert.equal(env.showNovelImport.value, false)
})

test('batch original import and script-library import retain separate content fields', () => {
  const [raw] = prepareEpisodeImport([{ title: '原文章节', source_text: '完整小说原文', script_content: '' }], { mode: 'append', episodes: [{ episode_number: 1 }] })
  assert.equal(raw.source_text, '完整小说原文')
  assert.equal(raw.script_content, '')
  assert.equal(Object.hasOwn(raw, 'description'), false, 'source import must not clear unspecified adaptation instructions')
  assert.equal(raw.episode_number, 2)
  const [adapted] = prepareEpisodeImport([{ title: '已有剧本', source_text: '关联原文', description: '改编要求', script_content: '改编后的剧本' }], { mode: 'replace' })
  assert.equal(adapted.source_text, '关联原文')
  assert.equal(adapted.description, '改编要求')
  assert.equal(adapted.script_content, '改编后的剧本')
})


test('slow first episode creation in an existing empty project keeps all newer input', async () => {
  const pending = deferred()
  const source = ref('original before request')
  const instructions = ref('instructions before request')
  const text = ref('script before request')
  let patched
  let draft = {}
  const store = {
    dramaId: 7, drama: { id: 7, episodes: [], episodes_revision: 0 }, currentEpisode: null,
    setDrama(project) { this.drama = project },
    updateEpisodeDraft(_did, _eid, values) { Object.assign(draft, values) },
    snapshotEpisodeDraft() { return { ...draft, baseRevision: 1 } },
    getEpisodeDraft() { return draft }, markEpisodeDraftSaved() {},
  }
  const env = {
    store, route: { params: { id: '7' } }, routeEpoch: 1, pageActive: true,
    newEpisodeTitle: ref('manual title'), newEpisodeSource: source, newEpisodePremise: instructions, newEpisodeScript: text,
    isProjectActive: () => true, captureCurrentScope: () => () => true,
    onEpisodeSelect(id) { store.currentEpisode = store.drama.episodes.find((ep) => ep.id === id) },
    dramaAPI: {
      createEpisode: () => pending.promise,
      async updateEpisode(_did, _eid, values) { patched = values; return { id: 22, revision: 2 } },
    },
    reviewEpisodeKeys: new Set(), loadDrama: async () => {},
  }
  const { saveScriptToBackend } = handlers(['saveScriptToBackend', 'ensureCurrentEpisode', 'ensureCurrentEpisodeOnce'], env, 'let episodeCreationFlight = null')
  const saving = saveScriptToBackend(text.value)
  source.value = 'new original typed while creating'
  instructions.value = 'new instructions typed while creating'
  text.value = 'new script typed while creating'
  pending.resolve({ id: 22, episode_number: 1, title: 'default', revision: 1, episodes_revision: 1 })
  await saving
  assert.equal(draft.scriptContent, text.value)
  assert.equal(patched.source_text, source.value)
  assert.equal(patched.description, instructions.value)
  assert.equal(patched.script_content, text.value)
})

test('changing novel input while awaiting confirmation cannot import an outdated source', async () => {
  const confirmed = deferred()
  const source = ref('keep existing original')
  const env = {
    novelImporting: ref(false), novelImportMode: ref('text'), novelText: ref('old novel'), novelFileContent: ref(''),
    novelDestination: ref('current'), novelMaxChapters: ref(20), novelPreview: ref([{ source_text: 'old preview' }]),
    captureCurrentScope: () => () => true, sourceText: source, ElMessage: messages,
    ElMessageBox: { confirm: () => confirmed.promise }, pageActive: true,
  }
  const running = handlers(['onImportNovel'], env).onImportNovel()
  env.novelText.value = 'new novel while confirmation pending'
  confirmed.resolve()
  await running
  assert.equal(source.value, 'keep existing original')
  assert.equal(env.novelImporting.value, false)
})
