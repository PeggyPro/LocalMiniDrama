import test from 'node:test'
import assert from 'node:assert/strict'
import { effectScope, nextTick, ref } from 'vue'
import { useAssetImageBatch } from '../src/composables/filmCreate/useAssetImageBatch.js'

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function setup(t, overrides = {}) {
  const effects = effectScope()
  const items = ref([{ id: 1, name: '甲' }, { id: 2, name: '乙' }, { id: 3, name: '丙' }])
  const scope = ref('drama:1:episode:1')
  const concurrency = ref(1)
  const generating = new Set()
  const batch = effects.run(() => useAssetImageBatch({
    items, scope, concurrency,
    hasImage: (item) => !!(item.image_url || item.local_path),
    isGenerating: (item) => generating.has(item.id),
    generate: async () => ({ status: 'completed' }),
    ...overrides,
  }))
  t.after(() => effects.stop())
  return { batch, items, scope, concurrency, generating, effects }
}

test('fills missing images within the concurrency limit and skips existing images and active tasks', async (t) => {
  const started = []
  const jobs = new Map()
  const { batch, items, concurrency, generating } = setup(t, {
    generate: (item) => {
      started.push(item.id)
      const job = deferred()
      jobs.set(item.id, job)
      return job.promise
    },
  })
  items.value = [{ id: 1, local_path: 'saved.png' }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]
  generating.add(2)
  concurrency.value = 2
  assert.equal(batch.pendingCount, 3)
  const run = batch.start()
  assert.deepEqual(started, [3, 4])
  assert.equal(await batch.start(), null)
  jobs.get(4).resolve({ status: 'completed' })
  await nextTick()
  assert.deepEqual(started, [3, 4, 5])
  jobs.get(3).resolve({ status: 'completed' })
  jobs.get(5).resolve({ status: 'completed' })
  assert.deepEqual(await run, { total: 3, succeeded: 3, skipped: 0, failed: 0, stopped: false, scopeChanged: false })
  assert.equal(batch.running, false)
})

test('regenerates existing images and can run again after every resource has an image', async (t) => {
  const started = []
  const { batch, items } = setup(t, {
    generate: async (item) => {
      started.push(item.id)
      item.image_url = `regenerated-${item.id}-${started.length}.png`
      return { status: 'completed' }
    },
  })
  items.value = [{ id: 1, local_path: 'existing.png' }, { id: 2, image_url: 'existing.png' }, { id: 3 }]
  assert.equal(batch.availableCount, 3)
  assert.equal(batch.pendingCount, 1)
  const first = await batch.start({ regenerateExisting: true })
  assert.equal(first.succeeded, 3)
  assert.equal(first.skipped, 0)
  assert.equal(batch.pendingCount, 0)
  assert.equal(batch.availableCount, 3)
  assert.equal(await batch.start(), null)
  const second = await batch.start({ regenerateExisting: true })
  assert.equal(second.succeeded, 3)
  assert.equal(second.failed, 0)
  assert.deepEqual(started, [1, 2, 3, 1, 2, 3])
})

test('regeneration rechecks deleted and active resources without skipping images changed while queued', async (t) => {
  const first = deferred()
  const started = []
  const { batch, items, generating } = setup(t, {
    generate: (item) => {
      started.push(item.id)
      return first.promise
    },
  })
  items.value = [1, 2, 3, 4, 5].map((id) => ({ id, image_url: 'existing.png' }))
  generating.add(4)
  assert.equal(batch.availableCount, 4)
  assert.equal(batch.pendingCount, 0)
  const run = batch.start({ regenerateExisting: true })
  items.value = items.value.filter((item) => item.id !== 3)
  items.value.find((item) => item.id === 5).image_url = 'uploaded.png'
  generating.add(2)
  first.resolve({ status: 'completed' })
  const result = await run
  assert.deepEqual(started, [1, 5])
  assert.equal(result.total, 4)
  assert.equal(result.succeeded, 2)
  assert.equal(result.skipped, 2)
  assert.equal(result.failed, 0)
})

test('records rejected submissions and failed polls without dropping the remaining queue', async (t) => {
  const { batch } = setup(t, {
    generate: async (item) => {
      if (item.id === 1) throw new Error('API 限流')
      if (item.id === 2) return { status: 'failed', error: '轮询超时' }
      return { status: 'completed' }
    },
  })
  const result = await batch.start()
  assert.equal(result.succeeded, 1)
  assert.equal(result.failed, 2)
  assert.equal(batch.current, 3)
  assert.deepEqual([...batch.errors], ['甲：API 限流', '乙：轮询超时'])
  assert.equal(batch.running, false)
})

test('rechecks queued resources after uploads, deletions and individual generation', async (t) => {
  const first = deferred()
  const started = []
  const { batch, items, generating } = setup(t, {
    generate: (item) => {
      started.push(item.id)
      return first.promise
    },
  })
  items.value.push({ id: 4 })
  const run = batch.start()
  items.value = [{ id: 1 }, { id: 2, image_url: 'uploaded.png' }, { id: 3 }]
  generating.add(3)
  first.resolve({ status: 'completed' })
  const result = await run
  assert.deepEqual(started, [1])
  assert.equal(result.skipped, 3)
  assert.equal(result.failed, 0)
})

for (const reason of ['stop', 'episode switch', 'dispose']) {
  test(`${reason} prevents new submissions while letting submitted tasks finish`, async (t) => {
    const first = deferred()
    const started = []
    const { batch, scope, effects } = setup(t, {
      generate: (item) => {
        started.push(item.id)
        return first.promise
      },
    })
    const run = batch.start()
    if (reason === 'stop') batch.stop()
    if (reason === 'episode switch') scope.value = 'drama:1:episode:2'
    if (reason === 'dispose') effects.stop()
    assert.equal(batch.stopping, true)
    first.resolve({ status: 'completed' })
    const result = await run
    assert.deepEqual(started, [1])
    assert.equal(result.stopped, true)
    assert.equal(result.scopeChanged, reason !== 'stop')
    assert.equal(batch.running, false)
    if (reason === 'dispose') assert.equal(await batch.start(), null)
  })
}

test('keeps the chosen image style and quad-grid mode for the whole batch', async (t) => {
  const first = deferred()
  const settings = { style: '古装', useQuadGrid: true }
  const received = []
  const { batch } = setup(t, {
    getOptions: () => ({ ...settings }),
    generate: (item, options) => {
      received.push({ ...options })
      return item.id === 1 ? first.promise : Promise.resolve({ status: 'completed' })
    },
  })
  const run = batch.start()
  settings.style = '写实'
  settings.useQuadGrid = false
  first.resolve({ status: 'completed' })
  await run
  assert.deepEqual(received, Array.from({ length: 3 }, () => ({ style: '古装', useQuadGrid: true })))
})

test('does not submit when blocked, without an episode, or without missing images', async (t) => {
  let blocked = true
  let calls = 0
  const { batch, scope, items, generating } = setup(t, {
    isBlocked: () => blocked,
    generate: async () => { calls++; return { status: 'completed' } },
  })
  assert.equal(await batch.start(), null)
  blocked = false
  scope.value = null
  assert.equal(await batch.start(), null)
  scope.value = 'drama:1:episode:1'
  items.value = [{ id: 1, image_url: 'existing.png' }, { id: 2 }]
  generating.add(2)
  assert.equal(await batch.start(), null)
  assert.equal(batch.running, false)
  assert.equal(calls, 0)
})
