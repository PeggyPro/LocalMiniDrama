import test from 'node:test'
import assert from 'node:assert/strict'
import { createEpisodeImportSubmission, mergeImportedEpisodeRows } from '../src/utils/episodeBatchImport.js'

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
    episode_number: 3, title: '第三章', script_content: '第三章\n新的故事', description: null, duration: 0,
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
