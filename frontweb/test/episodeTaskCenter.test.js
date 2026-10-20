import test from 'node:test'
import assert from 'node:assert/strict'
import { createEpisodeTaskReader, taskElapsed, taskKind, taskProgress, taskStatusGroup, taskTimestamp } from '../src/utils/episodeTaskCenter.js'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function result(episodeId, items = []) {
  return { drama_id: 4, episode_id: episodeId, items, total: items.length, filtered_total: items.length, stats: { active: items.length, completed: 0, failed: 0 } }
}

test('switching episode discards a late old response and aborts display requests only', async () => {
  const requests = []
  let state
  const reader = createEpisodeTaskReader({
    load: (episodeId, options) => { const request = { episodeId, options, ...deferred() }; requests.push(request); return request.promise },
    onChange: value => { state = value },
  })
  const first = reader.setContext(4, 10)
  const second = reader.setContext(4, 20)
  assert.equal(requests[0].options.signal.aborted, true)
  requests[1].resolve(result(20, [{ id: 'episode-20-task' }]))
  await second
  requests[0].resolve(result(10, [{ id: 'episode-10-task' }]))
  await first
  assert.equal(state.episodeId, 20)
  assert.deepEqual(state.items, [{ id: 'episode-20-task' }])
  assert.equal(state.loading, false)
  reader.dispose()
})

test('a stale filter response cannot overwrite a newer filter or its counts', async () => {
  const requests = []
  let state
  const reader = createEpisodeTaskReader({
    load: (episodeId, options) => { const request = { episodeId, options, ...deferred() }; requests.push(request); return request.promise },
    onChange: value => { state = value },
  })
  const first = reader.setContext(4, 10)
  const filtered = reader.setFilter('failed')
  assert.equal(requests[1].options.status, 'failed')
  assert.equal(requests[1].options.page, 1)
  requests[1].resolve({ ...result(10, [{ id: 'failed-task' }]), total: 25 })
  await filtered
  requests[0].resolve(result(10, [{ id: 'old-task' }]))
  await first
  assert.equal(state.filter, 'failed')
  assert.equal(state.total, 25)
  assert.equal(state.items[0].id, 'failed-task')
  reader.dispose()
})

test('refresh keeps the selected history page and preserves results on network failure', async () => {
  let state, fail = false
  const calls = []
  const reader = createEpisodeTaskReader({
    load: async (episodeId, options) => {
      calls.push(options)
      if (fail) throw new Error('network unavailable')
      return { ...result(episodeId, [{ id: `page-${options.page}` }]), total: 65, filtered_total: 65 }
    },
    onChange: value => { state = value },
  })
  await reader.setContext(4, 10)
  await reader.setPage(2)
  fail = true
  await reader.refresh()
  assert.equal(calls.at(-1).page, 2)
  assert.equal(state.items[0].id, 'page-2')
  assert.equal(state.total, 65)
  assert.match(state.error, /network unavailable/)
  assert.equal(state.loading, false)
  reader.dispose()
})

test('shrinking active results returns to a valid page and reloads its remaining tasks', async () => {
  let state, remaining = 31
  const calls = []
  const reader = createEpisodeTaskReader({
    load: async (episodeId, options) => {
      calls.push(options)
      const tasks = Array.from({ length: remaining }, (_, index) => ({ id: 'task-' + index }))
      return { ...result(episodeId), items: tasks.slice((options.page - 1) * 30, options.page * 30), total: 31, filtered_total: remaining, stats: { active: remaining, completed: 31 - remaining, failed: 0 } }
    },
    onChange: value => { state = value },
  })
  await reader.setContext(4, 10)
  await reader.setFilter('active')
  await reader.setPage(2)
  assert.equal(state.items.length, 1)
  remaining = 29
  await reader.refresh()
  assert.equal(state.page, 1)
  assert.equal(state.filter, 'active')
  assert.equal(state.items.length, 29)
  assert.equal(state.stats.active, 29)
  assert.equal(calls.at(-1).page, 1)
  assert.equal(state.loading, false)
  reader.dispose()
})

test('mismatched server episode is rejected rather than shown in the current episode', async () => {
  let state
  const reader = createEpisodeTaskReader({ load: async () => result(99, [{ id: 'wrong-episode' }]), onChange: value => { state = value } })
  await reader.setContext(4, 10)
  assert.deepEqual(state.items, [])
  assert.match(state.error, /集数不匹配/)
  reader.dispose()
})

test('unmount cancels the reader without changing a task or accepting its late response', async () => {
  const request = deferred()
  let state, signal
  const reader = createEpisodeTaskReader({ load: (_, options) => { signal = options.signal; return request.promise }, onChange: value => { state = value } })
  const pending = reader.setContext(4, 10)
  reader.dispose()
  assert.equal(signal.aborted, true)
  request.resolve(result(10, [{ id: 'late-task' }]))
  await pending
  assert.deepEqual(state.items, [])
})

test('progress only uses supplied finite percentages and never guesses completion', () => {
  assert.equal(taskProgress({ progress: null }), null)
  assert.equal(taskProgress({ progress: '' }), null)
  assert.equal(taskProgress({ progress: 'NaN' }), null)
  assert.equal(taskProgress({ progress: '42.7' }), 43)
  assert.equal(taskProgress({ progress: 150 }), 100)
  assert.equal(taskProgress({ progress: -2 }), 0)
  assert.equal(taskStatusGroup('cancelled'), 'failed')
  assert.equal(taskStatusGroup('running'), 'active')
  assert.equal(taskStatusGroup('new-server-status'), 'unknown')
})

test('SQLite UTC timestamps and elapsed time include waiting without timezone drift', () => {
  const start = '2026-05-10 12:00:00'
  assert.equal(taskTimestamp(start), Date.parse('2026-05-10T12:00:00Z'))
  assert.equal(taskTimestamp('invalid'), null)
  assert.equal(taskElapsed({ status: 'processing', created_at: start }, Date.parse('2026-05-10T12:01:05Z')), '1分5秒')
  assert.equal(taskElapsed({ status: 'completed', created_at: start, finished_at: '2026-05-10 13:02:05' }), '1小时2分')
  assert.equal(taskElapsed({ status: 'failed', created_at: start, updated_at: '2026-05-10 11:59:00' }), '')
  assert.equal(taskElapsed({ status: 'completed', created_at: start }), '')
})

test('media and merge records use distinct preview categories', () => {
  assert.equal(taskKind({ source: 'image', type: 'image_generation' }), 'image')
  assert.equal(taskKind({ source: 'video', type: 'video_generation' }), 'video')
  assert.equal(taskKind({ source: 'video', type: 'video_merge' }), 'merge')
  assert.equal(taskKind({ source: 'text', type: 'storyboard_generation' }), 'text')
})
