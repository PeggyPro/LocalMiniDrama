import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ref, watch } from 'vue'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import { createEpisodeImportSubmission, mergeImportedEpisodeRows, prepareEpisodeBatchImportRows } from '../src/utils/episodeBatchImport.js'

test('committed append rows preserve hydrated assets and use server identities, content and order', () => {
  const storyboards = [{ id: 91, image_url: 'saved-board.png' }]
  const characters = [{ id: 31, name: '主角' }]
  const current = [{ id: 5, episode_number: 1, title: '旧标题', revision: 2, storyboards, characters }]
  const saved = [
    { id: 5, episode_number: 1, title: '服务端标题', revision: 2 },
    { id: 9, episode_number: 3, title: '新集', script_content: '正文', revision: 1 },
  ]
  const result = mergeImportedEpisodeRows(current, saved)
  assert.deepEqual(result.map((episode) => episode.id), [5, 9])
  assert.equal(result[0].title, '服务端标题')
  assert.equal(result[0].storyboards, storyboards)
  assert.equal(result[0].characters, characters)
  assert.equal(current[0].title, '旧标题')
  assert.deepEqual(result[1], saved[1])
  assert.notEqual(result[1], saved[1])
})

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function preview() {
  return [{ episode_number: 3, title: '第三章', script_content: '第三章\n新的故事', chapter_titles: ['第三章'] }]
}

function setup(submitImport) {
  const state = { pending: false, visible: true, preview: preview(), error: '', successes: 0 }
  const submission = createEpisodeImportSubmission({
    submitImport,
    onPendingChange: (pending) => { state.pending = pending },
    onSuccess: (count) => {
      state.successes += count
      state.visible = false
      state.preview = []
    },
    onError: (error) => { state.error = error.message },
  })
  return { state, submission }
}

test('keeps the dialog and preview until the actual async save succeeds, submitting only new episode rows', async () => {
  const save = deferred()
  const calls = []
  const { state, submission } = setup((episodes) => { calls.push(episodes); return save.promise })
  const pending = submission.submit(state.preview)
  assert.equal(state.pending, true)
  assert.equal(state.visible, true)
  assert.equal(state.preview.length, 1)
  assert.equal(state.successes, 0)
  assert.deepEqual(calls, [[{
    episode_number: 3, title: '第三章', source_text: '第三章\n新的故事',
  }]])
  save.resolve({ episodes_revision: 8 })
  assert.equal(await pending, true)
  assert.equal(state.pending, false)
  assert.equal(state.visible, false)
  assert.deepEqual(state.preview, [])
  assert.equal(state.successes, 1)
})

test('failed save retains the exact preview and error and supports a deliberate retry', async () => {
  const firstSave = deferred()
  let calls = 0
  const { state, submission } = setup(() => ++calls === 1 ? firstSave.promise : Promise.resolve({ episodes_revision: 9 }))
  const originalPreview = state.preview
  const pending = submission.submit(state.preview)
  firstSave.reject(new Error('分集版本已变更，请重新预览'))
  assert.equal(await pending, false)
  assert.equal(state.pending, false)
  assert.equal(state.visible, true)
  assert.equal(state.preview, originalPreview)
  assert.equal(state.preview[0].script_content, '第三章\n新的故事')
  assert.equal(state.error, '分集版本已变更，请重新预览')
  assert.equal(state.successes, 0)
  assert.equal(await submission.submit(state.preview), true)
  assert.equal(calls, 2)
  assert.equal(state.successes, 1)
})

test('double submission is ignored while a save is pending and the payload is a snapshot', async () => {
  const save = deferred()
  const calls = []
  const { state, submission } = setup((episodes) => { calls.push(episodes); return save.promise })
  const pending = submission.submit(state.preview)
  assert.equal(await submission.submit(state.preview), false)
  state.preview[0].title = '编辑后的标题'
  state.preview.push({ episode_number: 4, title: '第四章', script_content: '' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].length, 1)
  assert.equal(calls[0][0].title, '第三章')
  save.resolve()
  assert.equal(await pending, true)
  assert.equal(state.successes, 1)
})

for (const fails of [false, true]) {
  test(`disposing the dialog ignores a late ${fails ? 'failure' : 'success'} without UI callbacks`, async () => {
    const save = deferred()
    const events = []
    const submission = createEpisodeImportSubmission({
      submitImport: () => save.promise,
      onPendingChange: (pending) => events.push(['pending', pending]),
      onSuccess: (count) => events.push(['success', count]),
      onError: (error) => events.push(['error', error.message]),
    })
    const pending = submission.submit(preview())
    submission.dispose()
    if (fails) save.reject(new Error('late failure'))
    else save.resolve()
    await pending
    assert.deepEqual(events, [['pending', true]])
    assert.equal(await submission.submit(preview()), false)
  })
}

test('synchronous save errors also preserve the preview without reporting success', async () => {
  const { state, submission } = setup(() => { throw new Error('未选择项目') })
  assert.equal(await submission.submit(state.preview), false)
  assert.equal(state.pending, false)
  assert.equal(state.visible, true)
  assert.equal(state.preview.length, 1)
  assert.equal(state.error, '未选择项目')
  assert.equal(state.successes, 0)
})

test('explicit existing-script import writes only script_content and carries the confirmed kind', async () => {
  let submitted
  const { state, submission } = setup((episodes, options) => { submitted = { episodes, options } })
  assert.equal(await submission.submit(state.preview, 'script'), true)
  assert.deepEqual(submitted, {
    episodes: [{ episode_number: 3, title: '第三章', script_content: '第三章\n新的故事' }],
    options: { importKind: 'script' },
  })
})

test('source confirmation preserves full-length text and does not invent other fields or mutate parser rows', () => {
  const text = `第三章\n${'长篇原文。\n'.repeat(10000)}最后一行也必须保留。`
  const episodes = [{ ...preview()[0], script_content: text }]
  const [row] = prepareEpisodeBatchImportRows(episodes)
  assert.deepEqual(row, { episode_number: 3, title: '第三章', source_text: text })
  assert.equal(Object.hasOwn(row, 'script_content'), false)
  assert.equal(Object.hasOwn(row, 'description'), false)
  assert.equal(Object.hasOwn(row, 'duration'), false)
  assert.equal(Object.hasOwn(episodes[0], 'source_text'), false)
  assert.equal(episodes[0].script_content, text)
})

test('already explicit source, adaptation instructions and optional fields survive confirmation unchanged', () => {
  const sourceOnly = { episode_number: 3, title: '原文', source_text: '原文全文' }
  const allSpecified = {
    episode_number: 4, title: '已有三段内容', source_text: '原文',
    description: '改编要求：保留结尾。', script_content: '明确提供的剧本', duration: 123,
  }
  for (const importKind of ['source', 'script']) {
    const rows = prepareEpisodeBatchImportRows([sourceOnly, allSpecified], importKind)
    assert.deepEqual(rows, [sourceOnly, allSpecified])
    assert.notEqual(rows[0], sourceOnly)
  }
  assert.deepEqual(prepareEpisodeBatchImportRows([{ ...sourceOnly, description: null, duration: 0 }]), [
    { ...sourceOnly, description: null, duration: 0 },
  ])
})

test('an unsupported content kind fails without saving or discarding the preview', async () => {
  const { state, submission } = setup(() => assert.fail('invalid kind cannot be saved'))
  const originalPreview = state.preview
  assert.equal(await submission.submit(state.preview, 'summary'), false)
  assert.equal(state.preview, originalPreview)
  assert.equal(state.visible, true)
  assert.equal(state.pending, false)
  assert.equal(state.error, '请选择本集原文或已有剧本')
})

function loadSfc(path) {
  const { descriptor, errors } = parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'batch-import-test' })
  return { descriptor, script }
}
const dialogSfc = loadSfc('../src/components/EpisodeBatchImportDialog.vue')
const detailSfc = loadSfc('../src/views/DramaDetail.vue')

// Run the dialog's actual setup, including its preview-invalidating watchers.
// Browser reads and persistence are stubs; no service, database or AI is used.
function dialogSetup(submitImport = async () => {}, extraEnv = {}) {
  const messages = []
  const env = {
    ref, watch, createEpisodeImportSubmission,
    defineProps: () => ({ startEpisodeNumber: 3, disabled: false, submitImport }),
    defineExpose() {}, onBeforeUnmount() {},
    ElMessage: Object.fromEntries(['success', 'error', 'warning'].map((kind) => [kind, (text) => messages.push([kind, text])])),
    ...extraEnv,
  }
  const setup = dialogSfc.script.scriptSetupAst.filter((node) => node.type !== 'ImportDeclaration')
    .map((node) => dialogSfc.descriptor.scriptSetup.content.slice(node.start, node.end)).join('\n')
  return {
    ...new Function(...Object.keys(env), `${setup}\nreturn {
      visible, rawText, importKind, previewImportKind, previewReady, importing, importError,
      previewEpisodes, previewChapters, chapterPattern, chaptersPerEpisode, fileName,
      openDialog, confirmConfig, confirmImport, onFileChange, onTextInput,
    }`)(...Object.values(env)),
    messages,
  }
}

for (const importKind of ['source', 'script']) {
  test(`batch text preview and confirmation save full chapters as ${importKind}`, async () => {
    const save = deferred()
    const calls = []
    const dialog = dialogSetup((episodes, options) => { calls.push({ episodes, options }); return save.promise })
    dialog.openDialog()
    assert.equal(dialog.importKind.value, 'source')
    dialog.importKind.value = importKind
    const first = `第一章 开始\n${'这一行原文不能被概括。\n'.repeat(2000)}全文的最后一行。`
    const second = '第二章 继续\n继续后的完整内容与结尾。'
    dialog.rawText.value = `${first}\n\n${second}`
    dialog.chaptersPerEpisode.value = 2
    dialog.confirmConfig()
    assert.equal(dialog.previewReady.value, true)
    assert.equal(dialog.previewImportKind.value, importKind)
    assert.equal(dialog.previewChapters.value.length, 2)
    const originalPreview = dialog.previewEpisodes.value
    assert.equal(originalPreview[0].script_content, `${first}\n\n${second}`)
    const saving = dialog.confirmImport()
    assert.equal(dialog.importing.value, true)
    assert.equal(dialog.visible.value, true)
    assert.equal(dialog.previewEpisodes.value, originalPreview)
    const field = importKind === 'source' ? 'source_text' : 'script_content'
    assert.deepEqual(calls, [{
      episodes: [{ episode_number: 3, title: '第一章 开始 - 第二章 继续', [field]: `${first}\n\n${second}` }],
      options: { importKind },
    }])
    save.resolve()
    await saving
    assert.equal(dialog.importing.value, false)
    assert.equal(dialog.visible.value, false)
    assert.deepEqual(dialog.previewEpisodes.value, [])
  })
}

test('failed real dialog submission retains its preview, content kind and text for retry', async () => {
  let attempts = 0
  const dialog = dialogSetup(async () => { if (++attempts === 1) throw new Error('分集版本已变更，请重新预览') })
  dialog.openDialog()
  dialog.importKind.value = 'script'
  dialog.rawText.value = '第一章\n已有剧本全文。'
  dialog.confirmConfig()
  const originalPreview = dialog.previewEpisodes.value
  await dialog.confirmImport()
  assert.equal(dialog.visible.value, true)
  assert.equal(dialog.importing.value, false)
  assert.equal(dialog.previewReady.value, true)
  assert.equal(dialog.previewEpisodes.value, originalPreview)
  assert.equal(dialog.previewImportKind.value, 'script')
  assert.equal(dialog.importError.value, '分集版本已变更，请重新预览')
  await dialog.confirmImport()
  assert.equal(attempts, 2)
  assert.equal(dialog.visible.value, false)
})

test('changing import type, text or parsing settings invalidates the previous preview before saving', async () => {
  for (const [field, value] of [
    ['importKind', 'script'], ['rawText', '第二章\n新的内容。'],
    ['chapterPattern', '^未匹配的章节标题'], ['chaptersPerEpisode', 2],
  ]) {
    const dialog = dialogSetup(() => assert.fail('stale preview must not be saved'))
    dialog.rawText.value = '第一章\n原文。'
    dialog.confirmConfig()
    assert.equal(dialog.previewReady.value, true)
    dialog[field].value = value
    assert.equal(dialog.previewReady.value, false)
    assert.deepEqual(dialog.previewEpisodes.value, [])
    await dialog.confirmImport()
  }
})

test('failed chapter parsing clears an old preview instead of leaving it importable', async () => {
  const dialog = dialogSetup(() => assert.fail('failed preview cannot be saved'))
  dialog.rawText.value = '第一章\n正文。'
  dialog.confirmConfig()
  dialog.chapterPattern.value = '['
  dialog.confirmConfig()
  assert.equal(dialog.previewReady.value, false)
  assert.deepEqual(dialog.previewEpisodes.value, [])
  assert.equal(dialog.messages.at(-1)[1], '章节正则格式不正确')
  await dialog.confirmImport()
})

test('TXT reads use the same explicit kind and a late read cannot overwrite newly pasted text', async () => {
  const readers = []
  let submitted
  class FileReaderStub {
    constructor() { readers.push(this) }
    readAsText(file, encoding) { assert.equal(encoding, 'utf-8') }
  }
  const dialog = dialogSetup((episodes) => { submitted = episodes }, { FileReader: FileReaderStub })
  dialog.onFileChange({ target: { files: [{ name: '原文.txt' }] } })
  dialog.rawText.value = '第一章\n粘贴的原文。'
  dialog.onTextInput()
  readers[0].onload({ target: { result: '第一章\n不应覆盖的旧文件。' } })
  assert.equal(dialog.rawText.value, '第一章\n粘贴的原文。')
  dialog.onFileChange({ target: { files: [{ name: '新原文.txt' }] } })
  readers[1].onload({ target: { result: '第一章\n文件原文全文。' } })
  assert.equal(dialog.importKind.value, 'source')
  dialog.confirmConfig()
  await dialog.confirmImport()
  assert.deepEqual(submitted, [{ episode_number: 3, title: '第一章', source_text: '第一章\n文件原文全文。' }])
})

test('DramaDetail forwards source/import fields unchanged with append and collection revision', async () => {
  const node = detailSfc.script.scriptSetupAst.find((item) => item.type === 'FunctionDeclaration' && item.id.name === 'onBatchImportEpisodes')
  const handlerSource = detailSfc.descriptor.scriptSetup.content.slice(node.start, node.end)
  const target = { dramaId: 7, version: 1 }
  const saving = deferred()
  const calls = []
  const importing = ref(false)
  const rows = prepareEpisodeBatchImportRows([{ ...preview()[0], description: '保留原文结尾。' }])
  const existing = [{ id: 5, episode_number: 1, script_content: '已有剧本', storyboards: [{ id: 91 }] }]
  const env = {
    captureDramaTarget: () => target, isCurrentDramaTarget: (value) => value === target,
    episodeActionsDisabled: ref(false), episodeCollectionRevision: () => 8, importingEpisodes: importing,
    dramaAPI: { saveEpisodes(...args) { calls.push(args); return saving.promise } },
    episodes: ref(existing), mergeImportedEpisodeRows,
    applyEpisodeList: (...args) => calls.push(['apply', ...args]),
    loadDrama: async () => false, // A failed refresh cannot turn the committed save into a retry.
  }
  const handler = new Function(...Object.keys(env), `${handlerSource}\nreturn onBatchImportEpisodes`)(...Object.values(env))
  const pending = handler(rows, { importKind: 'source' })
  assert.equal(importing.value, true)
  assert.equal(calls[0][0], 7)
  assert.equal(calls[0][1], rows)
  assert.deepEqual(calls[0][1], [{ episode_number: 3, title: '第三章', source_text: '第三章\n新的故事', description: '保留原文结尾。' }])
  assert.deepEqual(calls[0][2], { mode: 'append', expected_collection_revision: 8 })
  const committed = { episodes: [...existing, { ...rows[0], id: 9, revision: 1 }], episodes_revision: 9 }
  saving.resolve(committed)
  assert.equal(await pending, committed)
  assert.equal(importing.value, false)
  assert.equal(calls[1][0], 'apply')
  assert.equal(calls[1][1][0].storyboards, existing[0].storyboards)
})

test('batch dialog and detail templates compile after the import controls change', () => {
  for (const { descriptor } of [dialogSfc, detailSfc]) {
    const compiled = compileTemplate({ source: descriptor.template.content, filename: 'BatchImport.vue', id: 'batch-import-test' })
    assert.deepEqual(compiled.errors, [])
  }
})
