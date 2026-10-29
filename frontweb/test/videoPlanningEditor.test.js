import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse, compileScript } from 'vue/compiler-sfc'
import { hasVideoPlanning, planningErrorMessage, videoRecordUrl } from '../src/utils/videoPlanning.js'

const { descriptor } = parse(readFileSync(new URL('../src/views/FilmCreate.vue', import.meta.url), 'utf8'))
const compiled = compileScript(descriptor, { id: 'planning-editor-test' })
function handlers(names, bindings) {
  const body = names.map((name) => {
    const node = compiled.scriptSetupAst.find((n) => n.type === 'FunctionDeclaration' && n.id.name === name)
    assert.ok(node, `editor handler ${name} exists`)
    return descriptor.scriptSetup.content.slice(node.start, node.end)
  }).join('\n')
  return new Function(...Object.keys(bindings), `${body}\nreturn { ${names.join(', ')} }`)(...Object.values(bindings))
}
const messages = { error() {}, warning() {}, info() {} }

test('main player respects adopted version and exact saved history, never latest or storyboard image cache', () => {
  const storyboard = { id: 10, video_url: 'https://host/chosen.mp4', local_path: 'images/input.png' }
  const state = { items: {}, sources: { versions: [] }, versions: {} }
  const videos = [{ id: 2, status: 'completed', video_url: 'https://host/latest.mp4', local_path: 'videos/latest.mp4' }, { id: 1, status: 'completed', video_url: 'https://host/chosen.mp4', local_path: 'videos/chosen.mp4' }]
  const editor = handlers(['getSbVideo', 'getSbAllVideos', 'recordHasPlayableVideoUrl', 'assetVideoUrl'], {
    videoPlanning: { state }, store: { storyboards: [storyboard] }, sbVideos: { value: { 10: videos } }, sbSelectedVideoId: { value: {} }, videoRecordUrl,
  })
  assert.equal(editor.getSbVideo(10).id, 1)
  assert.equal(editor.assetVideoUrl(editor.getSbVideo(10)), '/static/videos/chosen.mp4')
  storyboard.video_url = '/static/videos/chosen.mp4'
  assert.equal(editor.getSbVideo(10).id, 1)
  storyboard.video_url = null
  assert.equal(editor.getSbVideo(10), null)
  state.items[10] = { selected_version_id: 'not-loaded' }
  assert.equal(editor.getSbVideo(10), null)
  state.sources.versions = [{ id: 'not-loaded', video_url: 'https://host/adopted.mp4' }]
  assert.equal(editor.getSbVideo(10).video_url, 'https://host/adopted.mp4')
})

test('actual single-shot handler routes planned shots to finite preview without touching legacy generation', async () => {
  const previews = []
  const sb = { id: 10, video_url: 'keep-old.mp4', video_prompt: 'keep prompt' }
  const { onGenerateSbVideo } = handlers(['onGenerateSbVideo'], {
    dramaId: { value: 1 }, sbCanSubmitVideo: () => true, hasVideoPlanning, ElMessage: messages,
    videoPlanning: { controller: { load: async () => true }, state: { items: { 10: { choice: { model_id: 'first' } } } } },
    previewStoryboardVideos: async (shots) => previews.push(shots),
    isSbUniversalMode: () => { throw new Error('planned route must not enter legacy global-model flow') },
  })
  await onGenerateSbVideo(sb)
  assert.deepEqual(previews, [[sb]])
  assert.equal(sb.video_url, 'keep-old.mp4')
  assert.equal(sb.video_prompt, 'keep prompt')
})

test('actual batch router keeps finite current targets and stops automatic continuation with existing adoption', async () => {
  const previews = []
  const pipelineCurrentStep = { value: '' }
  const { routeBatchToVideoPlan } = handlers(['routeBatchToVideoPlan'], {
    videoPlanning: { controller: { load: async () => true }, state: { items: { 10: { choice: {}, selected_version_id: 'chosen' }, 11: { choice: {} }, 12: { choice: null } } } },
    hasVideoPlanning, sbVideos: { value: {} }, recordHasPlayableVideoUrl: () => true,
    previewStoryboardVideos: async (shots) => { previews.push(shots); return { id: 'finite' } },
    pipelineCurrentStep, ElMessage: messages,
  })
  assert.equal(await routeBatchToVideoPlan([{ id: 10 }, { id: 11 }, { id: 12 }]), true)
  assert.deepEqual(previews[0].map((s) => s.id), [11, 12])
  assert.match(pipelineCurrentStep.value, /自动合成已停止/)
  assert.equal(await routeBatchToVideoPlan([{ id: 10 }]), true)
  assert.equal(previews.length, 1)
})

test('actual last-moment legacy guard prevents POST when a recommendation arrived meanwhile', async () => {
  let posts = 0
  const { createLegacyStoryboardVideo } = handlers(['createLegacyStoryboardVideo'], {
    videoPlanning: { controller: { guardLegacy: async () => { throw new Error('already planned') } } },
    videosAPI: { create: async () => { posts++ } },
  })
  await assert.rejects(createLegacyStoryboardVideo({ storyboard_id: 10 }), /already planned/)
  assert.equal(posts, 0)
})

test('actual legacy-history adoption carries CAS and never selects the rejected video', async () => {
  const updates = []
  let refreshes = 0
  const sbSelectedVideoId = { value: { 10: 7 } }
  const { onSelectSbMainVideo } = handlers(['onSelectSbMainVideo'], {
    videoPlanning: { state: { loaded: true, items: { 10: { adoption_revision: 8 } } }, refresh: async () => { refreshes++ } },
    currentEpisodeId: { value: 2 }, sbSelectedVideoId, ElMessage: messages, planningErrorMessage,
    storyboardsAPI: { update: async (id, body) => { updates.push([id, body]); throw Object.assign(new Error('conflict'), { response: { status: 409 } }) } },
  })
  await onSelectSbMainVideo({ id: 10 }, { id: 9, video_url: 'new.mp4' })
  assert.equal(updates[0][1].expected_adoption_revision, 8)
  assert.equal(sbSelectedVideoId.value[10], 7)
  assert.equal(refreshes, 1)
})

test('actual input snapshot uses active universal references and exact editor prompt without automatic extraction', () => {
  const { getStoryboardPlanInputs } = handlers(['getStoryboardPlanInputs'], {
    isSbUniversalMode: () => true,
    sbVideoFirstLastUrls: (_sb, universal, autoFrame) => { assert.equal(universal, true); assert.equal(autoFrame, null); return { first: 'first.png', last: 'last.png' } },
    collectSbOmniReferenceAbsoluteUrls: () => ['second.png', 'first.png'],
    buildSbVideoPromptForApi: () => '  @图片2 用户当前提示词  ', getSelectedStyle: () => '动漫',
    projectAspectRatio: { value: '9:16' }, videoResolution: { value: '720p' }, getSbVideoDurationForApi: () => 8,
  })
  assert.deepEqual(getStoryboardPlanInputs({ id: 10 }), {
    prompt: '  @图片2 用户当前提示词  ', image_url: 'first.png', first_frame_url: 'first.png', last_frame_url: 'last.png',
    reference_image_urls: ['second.png', 'first.png'], style: '动漫', aspect_ratio: '9:16', resolution: '720p', duration: 8,
  })
})
