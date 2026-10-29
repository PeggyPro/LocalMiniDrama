import test from 'node:test'
import assert from 'node:assert/strict'
import { createVideoPlanningAPI } from '../src/api/videoPlanningClient.js'
import { createVideoPlanningController, newPlanningState } from '../src/utils/videoPlanningController.js'
import { capabilityAvailable, planningPresentation, makeChoiceBody, makePreviewBody, sourceKey, sourceOptions, canRunPlan, canResumePlan, hasVideoPlanning, planningErrorMessage, reasonText, videoRecordUrl } from '../src/utils/videoPlanning.js'

test('latent diagnostics explain structure limits and video playback excludes input images', () => {
  assert.match(reasonText('latent_missing'), /未找到/)
  assert.match(reasonText('latent_unresolved_configure_output_root'), /输出目录/)
  assert.match(reasonText('latent_invalid_safetensors'), /结构/)
  assert.equal(videoRecordUrl({ local_path: 'images/input.png', video_url: 'https://host/chosen.mp4' }), 'https://host/chosen.mp4')
  assert.equal(videoRecordUrl({ local_path: 'images/input.png' }), '')
  assert.equal(videoRecordUrl({ video_url: '/static/images/input.png' }), '')
  assert.equal(videoRecordUrl({ local_path: '/static/videos/chosen.mp4' }), '/static/videos/chosen.mp4')
  assert.equal(videoRecordUrl({ local_path: 'videos\\chosen.mp4' }), '/static/videos/chosen.mp4')
})

const catalog = [
  { model_id: 'h3-first', stage: 'first', availability: 'registered_unverified', runtime_verified: false, input_supported: true, blocking_reasons: [] },
  { model_id: 'h3-continue', stage: 'continue', availability: 'registered_unverified', input_supported: true, blocking_reasons: [] },
  { model_id: 'audio-only', stage: 'single', availability: 'registered_unverified', input_supported: false, blocking_reasons: ['unsupported_audio_input'] },
]
const shot = (id = 10, revision = 4) => ({ storyboard_id: id, recommendation: { model_id: 'h3-first', reason: '开始新场景' }, choice: { model_id: 'h3-first', revision, source_ref: null, manual_locked: true }, validation: { state: 'ready', blocking_reasons: [] }, selected_version_id: 'old-version', adoption_revision: 3 })
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function fixture(overrides = {}) {
  const calls = []
  const api = {
    episode: async () => ({ items: [shot()] }), capabilities: async () => ({ items: catalog }), sources: async () => ({ storyboards: [], versions: [] }),
    choice: async (id, body) => { calls.push(['choice', id, body]); return shot(id, body.expected_revision + 1) },
    recommend: async () => { calls.push(['recommend']); return { items: [shot()] } },
    preview: async (body) => { calls.push(['preview', body]); return { id: 'p1', revision: 1, status: 'preview', nodes: body.storyboard_ids.map((id) => ({ id: `n${id}`, storyboard_id: id, status: 'ready', inputs: body.inputs[id] })) } },
    run: async (id, revision) => { calls.push(['run', id, revision]); return { id, revision: revision + 1, status: 'running', nodes: [] } },
    plan: async (id) => { calls.push(['get', id]); return { id, revision: 2, status: 'completed', nodes: [] } },
    versions: async () => ({ items: [{ id: 'new-version', status: 'completed' }] }),
    adopt: async (id, body) => { calls.push(['adopt', id, body]); return { ...shot(id), selected_version_id: body.version_id } },
    ...overrides,
  }
  const state = newPlanningState()
  const c = createVideoPlanningController(api, state)
  c.setScope({ episodeId: 1, dramaId: 2 })
  return { c, state, calls, api }
}

test('registered but unverified can be configured; unsupported or missing models never look ready', () => {
  assert.equal(capabilityAvailable(catalog[0]), true)
  assert.equal(capabilityAvailable(catalog[2]), false)
  assert.equal(planningPresentation(shot(), catalog).ready, true)
  for (const id of ['audio-only', 'removed-model']) {
    const item = { ...shot(), choice: { model_id: id } }
    const view = planningPresentation(item, catalog)
    assert.equal(view.state, 'blocked')
    assert.equal(view.ready, false)
    assert.ok(view.reasons.length)
  }
  const draft = { ...shot(), validation: { state: 'draft' } }
  assert.equal(planningPresentation(draft, catalog).ready, false)
  assert.equal(hasVideoPlanning({ validation: { state: 'draft' } }), true)
  assert.equal(hasVideoPlanning({ choice: null, recommendation: null, validation: { state: 'unplanned' } }), false)
})

test('source references preserve exact cross-episode version tail or planned choice revision', () => {
  const options = sourceOptions({
    versions: [{ id: 'v8', storyboard_id: 8, episode_id: 1, tail_segment_id: 'tail-a', continuable: true }, { id: 'bad', storyboard_id: 9, continuable: false }],
    storyboards: [{ storyboard_id: 20, episode_id: 2, eligible: true, choice_revision: 11 }, { storyboard_id: 10, eligible: true, choice_revision: 3 }],
  }, 10)
  assert.equal(options.length, 3) // A shot cannot be its own future source.
  assert.equal(options[1].disabled, true)
  assert.deepEqual(options[0].ref, { kind: 'version', version_id: 'v8', tail_segment_id: 'tail-a' })
  assert.deepEqual(options[2].ref, { kind: 'storyboard', storyboard_id: 20, choice_revision: 11 })
  assert.notEqual(sourceKey(options[2].ref), sourceKey({ ...options[2].ref, choice_revision: 12 }))
  const body = makeChoiceBody({ expectedRevision: 4, modelId: 'h3-continue', sourceRef: options[0].ref, manualLocked: true }, catalog)
  assert.deepEqual(body, { expected_revision: 4, model_id: 'h3-continue', source_ref: options[0].ref, manual_locked: true })
  assert.throws(() => makeChoiceBody({ modelId: 'h3-continue' }, catalog), /精确版本/)
  assert.throws(() => makeChoiceBody({ modelId: 'h3-continue', sourceRef: { kind: 'draft_shot', shot_number: 1 } }, catalog), /精确版本/)
  const models = [{ model_id: 'first', produces_latent: true, continuation_model: 'continue', family: 'h3' }, { model_id: 'continue', requires_latent: true, family: 'h3' }]
  const filtered = sourceOptions({ versions: [{ id: 'ok', model_id: 'first', continuable: true }, { id: 'wrong-family', model_id: 'other', continuable: true }] }, 10, 'continue', models)
  assert.equal(filtered[0].disabled, false)
  assert.equal(filtered[1].disabled, true)
  assert.match(filtered[1].label, /不兼容/)
})

test('finite preview freezes actual prompt and ordered references, excludes source episode from targets', () => {
  const inputs = { 10: { prompt: '  用户原文\n@图片2 动作不变  ', duration: 8, aspect_ratio: '9:16', first_frame_url: '/static/a.png', last_frame_url: '/static/z.png', reference_image_urls: ['b', 'a'] } }
  const body = makePreviewBody({ episodeId: 2, storyboards: [{ id: 10 }, { id: 10 }], inputs, appendVersionId: 'v10' })
  assert.deepEqual(body.storyboard_ids, [10])
  assert.deepEqual(body.inputs[10], inputs[10])
  inputs[10].reference_image_urls.push('changed')
  assert.deepEqual(body.inputs[10].reference_image_urls, ['b', 'a'])
  assert.equal(body.append_version_id, 'v10')
  assert.throws(() => makePreviewBody({ episodeId: 2, storyboards: [{ id: 10 }, { id: 11 }], inputs, appendVersionId: 'v10' }), /一个目标/)
})

test('preview and GET polling never submit or adopt; run is explicit and CAS-bound', async () => {
  const { c, state, calls } = fixture()
  await c.load()
  await c.preview([{ id: 10 }], { 10: { prompt: 'keep' } })
  assert.deepEqual(calls.map((v) => v[0]), ['preview'])
  assert.equal(state.items[10].selected_version_id, 'old-version')
  assert.equal(state.items[10].choice.manual_locked, true)
  await c.run()
  assert.deepEqual(calls[1], ['run', 'p1', 1])
  await c.refreshPlan()
  assert.deepEqual(calls.map((v) => v[0]), ['preview', 'run', 'get'])
  assert.equal(state.items[10].selected_version_id, 'old-version')
  await assert.rejects(c.run(), /先预览/)
})

test('choice conflict reloads server state without retrying the captured edit', async () => {
  let saves = 0
  const conflict = Object.assign(new Error('conflict'), { response: { status: 409 } })
  const { c, state } = fixture({ episode: async () => ({ items: [shot(10, 8)] }), choice: async (_id, body) => { saves++; assert.equal(body.expected_revision, 4); throw conflict } })
  await c.load()
  const edit = { expected_revision: 4, model_id: 'h3-first', source_ref: null, manual_locked: true }
  await assert.rejects(c.choice(10, edit), (error) => error === conflict)
  assert.equal(saves, 1)
  assert.equal(state.items[10].choice.revision, 8)
  assert.equal(edit.expected_revision, 4)
  assert.match(planningErrorMessage(conflict), /未提交/)
})

test('switching episode discards late loads, previews and selection updates', async () => {
  const late = deferred()
  const { c, state } = fixture({ episode: async (id) => id === 1 ? late.promise : { items: [shot(20)] } })
  const first = c.load()
  c.setScope({ episodeId: 2, dramaId: 2 })
  await c.load()
  late.resolve({ items: [shot(10)] })
  assert.equal(await first, false)
  assert.deepEqual(Object.keys(state.items), ['20'])
  const previewLate = deferred()
  const other = fixture({ preview: () => previewLate.promise })
  const preview = other.c.preview([{ id: 10 }], { 10: { prompt: 'x' } })
  other.c.setScope({ episodeId: 3, dramaId: 2 })
  previewLate.resolve({ id: 'old-plan' })
  assert.equal(await preview, null)
  assert.equal(other.state.dialogOpen, false)
  assert.equal(other.state.plan, null)
})

test('concurrent legacy guards coalesce reads; network errors and stored plans fail closed', async () => {
  const wait = deferred()
  let loads = 0
  const legacy = fixture({ episode: async () => { loads++; await wait.promise; return { items: [{ storyboard_id: 10, validation: { state: 'unplanned' } }] } } })
  const one = legacy.c.guardLegacy(10)
  const two = legacy.c.guardLegacy(10)
  wait.resolve()
  await Promise.all([one, two])
  assert.equal(loads, 1)
  const planned = fixture()
  await assert.rejects(planned.c.guardLegacy(10), /已有视频方案/)
  const broken = fixture({ episode: async () => { throw new Error('offline') } })
  await assert.rejects(broken.c.guardLegacy(10), /offline/)
  assert.equal(broken.state.loaded, false)
})

test('adoption uses the version-list revision and an explicit PUT only', async () => {
  const { c, state, calls } = fixture()
  await c.load()
  await c.versions(10)
  const displayedRevision = state.versionsRevision[10]
  assert.equal(displayedRevision, 3)
  assert.equal(calls.length, 0)
  state.items[10].adoption_revision = 4
  await c.adopt(10, 'new-version', displayedRevision)
  assert.deepEqual(calls[0], ['adopt', 10, { expected_revision: 3, version_id: 'new-version' }])
})

test('episode switch during adoption refresh cannot load old versions into the new scope', async () => {
  const started = deferred()
  const refreshed = deferred()
  let versionReads = 0
  const { c, state } = fixture({
    episode: async (id) => { if (id === 1) { started.resolve(); return refreshed.promise } return { items: [shot(20)] } },
    versions: async () => { versionReads++; return { items: [{ id: 'old-episode-version' }] } },
  })
  const adoption = c.adopt(10, 'chosen', 3)
  await started.promise
  c.setScope({ episodeId: 2, dramaId: 2 })
  await c.load()
  refreshed.resolve({ items: [shot(10)] })
  await adoption
  assert.equal(versionReads, 0)
  assert.deepEqual(Object.keys(state.items), ['20'])
  assert.deepEqual(state.versions, {})
})

test('lost run response reads status; total connection loss prevents blind resubmit', async () => {
  let submits = 0
  const { c, state } = fixture({ run: async () => { submits++; throw new Error('connection lost') }, plan: async () => { throw new Error('offline') } })
  await c.preview([{ id: 10 }], { 10: { prompt: 'keep' } })
  await assert.rejects(c.run(), /connection lost/)
  assert.equal(state.plan.status, 'submitted_unknown')
  assert.equal(canRunPlan(state.plan), false)
  await assert.rejects(c.run(), /先预览/)
  await assert.rejects(c.preview([{ id: 10 }], { 10: { prompt: 'retry' } }), /不能重新预览/)
  assert.equal(submits, 1)
})

test('resume is restricted to a known attempt, never an unknown submission', () => {
  assert.equal(canResumePlan({ id: 'p', status: 'partial', nodes: [{ status: 'processing', attempt: { task_id: 'task-7' } }] }), true)
  assert.equal(canResumePlan({ id: 'p', status: 'running', nodes: [{ status: 'processing', attempt: { task_id: 'task-7' } }] }), true)
  assert.equal(canResumePlan({ id: 'p', status: 'submitted_unknown', nodes: [{ status: 'submitted_unknown', attempt: { task_id: 'task-7' } }] }), false)
  assert.equal(canRunPlan({ id: 'p', status: 'preview', nodes: [{ status: 'waiting_dependency' }] }), false)
  assert.equal(canRunPlan({ id: 'p', status: 'blocked', nodes: [{ status: 'ready' }] }), false)
})

test('HTTP adapter uses only planning endpoints with exact choice, run and adoption revisions', async () => {
  const requests = []
  const request = Object.fromEntries(['get', 'post', 'put'].map((method) => [method, async (...args) => { requests.push([method, ...args]); return {} }]))
  const api = createVideoPlanningAPI(request)
  await api.capabilities(); await api.episode(2); await api.sources(8); await api.recommend(2)
  await api.choice(10, { expected_revision: 7 }); await api.preview({ episode_id: 2, storyboard_ids: [10] })
  await api.run('plan/a', 3); await api.plan('plan/a'); await api.resume('plan/a'); await api.versions(10); await api.adopt(10, { expected_revision: 4, version_id: 'v' })
  assert.ok(requests.every((r) => r[1].startsWith('/video-planning/')))
  assert.deepEqual(requests[6], ['post', '/video-planning/plans/plan%2Fa/run', { expected_revision: 3 }])
  assert.deepEqual(requests[10], ['put', '/video-planning/storyboards/10/adoption', { expected_revision: 4, version_id: 'v' }])
})
