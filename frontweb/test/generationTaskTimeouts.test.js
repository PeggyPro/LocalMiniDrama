import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createPinia, defineStore, setActivePinia } from 'pinia'
import { ref, computed } from 'vue'
import * as scopeUtils from '../src/utils/generationTaskScope.js'
import * as timeoutUtils from '../src/utils/generationTaskTimeouts.js'

const { getTaskTimeouts, getTaskPollOptions } = timeoutUtils
const MINUTE = 60 * 1000
const START = Date.UTC(2026, 9, 21, 9)

// Run the actual store with mock HTTP dependencies, retaining its real polling/recovery code.
const storeSource = readFileSync(new URL('../src/stores/generationTaskStore.js', import.meta.url), 'utf8')
function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START })
  setActivePinia(createPinia())
  const remote = { id: 'sb-task', type: 'storyboard_generation', status: 'processing', updated_at: new Date(START).toISOString() }
  const env = {
    defineStore, ref, computed, ...scopeUtils, ...timeoutUtils,
    taskAPI: { get: async () => ({ ...remote }) }, imagesAPI: {}, videosAPI: {},
  }
  const useStore = new Function(...Object.keys(env), `${storeSource.replace(/^import .+$/gm, '').replace(/^export /gm, '')}\nreturn useGenerationTaskStore`)(...Object.values(env))
  return { store: useStore(), remote }
}
const meta = { dramaId: 1, episodeId: 2, resourceType: 'generate_storyboard', resourceId: 2 }

async function tick(t, count = 1) {
  for (let i = 0; i < count; i++) {
    t.mock.timers.tick(2000)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }
}

test('storyboard waiting covers long reasoning, continuation and page recovery', () => {
  for (const task of [{ type: 'storyboard_generation' }, { resourceType: 'generate_storyboard' }]) {
    const options = getTaskPollOptions(task)
    assert.equal(options.maxAttempts * options.interval, 60 * MINUTE)
    assert.equal(getTaskTimeouts(task).inactivityTimeoutMs, 60 * MINUTE)
    assert.equal(getTaskTimeouts(task).staleTimeoutMs, 60 * MINUTE)
    assert.match(options.timeoutMessage, /60分钟/)
  }
  assert.equal(getTaskPollOptions({ type: 'image_generation' }).maxAttempts, 450)
  assert.deepEqual(getTaskTimeouts({ type: 'image_generation' }), {
    pollTimeoutMs: 15 * MINUTE, inactivityTimeoutMs: 10 * MINUTE, staleTimeoutMs: 30 * MINUTE,
  })
  assert.equal(getTaskPollOptions(meta, { maxAttempts: 3, interval: 10 }).maxAttempts, 3)
})

test('actual storyboard poll survives the old 10-minute orphan and 15-minute polling limits', async (t) => {
  const { store, remote } = setup(t)
  let settled = false
  const promise = store.pollTask(remote.id, meta).then((result) => { settled = true; return result })
  await tick(t, 480) // 16 simulated minutes with no update from the thinking model.
  assert.equal(settled, false)
  assert.equal(store.isRunning(meta), true)
  remote.status = 'completed'
  remote.result = { total: 22 }
  await tick(t)
  assert.deepEqual(await promise, { status: 'completed', result: { total: 22 } })
  assert.equal(store.isRunning(meta), false)
})

test('reconciliation does not clear a 35-minute storyboard task as stale', async (t) => {
  const { store, remote } = setup(t)
  store.markRunning({ ...meta, taskId: remote.id })
  t.mock.timers.tick(35 * MINUTE)
  await store.reconcileRunningTasks()
  assert.equal(store.isRunning(meta), true)
  remote.status = 'failed'
  remote.error = '用户已取消'
  await store.reconcileRunningTasks()
  assert.equal(store.isRunning(meta), false)
})

test('refresh attachment accepts a storyboard that is already reasoning for 16 minutes', async (t) => {
  const { store, remote } = setup(t)
  t.mock.timers.tick(16 * MINUTE)
  let settled = false
  const promise = store.attachPollIfNeeded(remote.id, meta).then((result) => { settled = true; return result })
  await tick(t)
  assert.equal(settled, false)
  remote.status = 'completed'
  await tick(t)
  assert.equal((await promise).status, 'completed')
})
