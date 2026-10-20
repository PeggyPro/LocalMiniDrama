import test from 'node:test'
import assert from 'node:assert/strict'
import { getMissingStoryboardImageSlots, generateMissingStoryboardImages } from '../src/utils/storyboardImageGeneration.js'

function setup(overrides = {}) {
  const state = { useFirstLastFrame: true, hasImage: false, hasFirstImage: false, hasLastImage: false, ...overrides }
  const calls = []
  const run = (options = {}) => generateMissingStoryboardImages({
    getState: () => state,
    generate: async (slot) => {
      calls.push(slot)
      if (slot === 'first') state.hasFirstImage = true
      else if (slot === 'last') state.hasLastImage = true
      else state.hasImage = true
      return { status: 'completed' }
    },
    ...options,
  })
  return { state, calls, run }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test('plans both frame slots independently, including an existing first image with a missing last image', () => {
  for (const [first, last, expected] of [
    [false, false, ['first', 'last']],
    [true, false, ['last']],
    [false, true, ['first']],
    [true, true, []],
  ]) {
    assert.deepEqual(getMissingStoryboardImageSlots({
      useFirstLastFrame: true, hasImage: true, hasFirstImage: first, hasLastImage: last,
    }), expected)
  }
  assert.deepEqual(getMissingStoryboardImageSlots({ useFirstLastFrame: false, hasImage: false }), ['single'])
  assert.deepEqual(getMissingStoryboardImageSlots({ useFirstLastFrame: false, hasImage: true }), [])
})

test('fills only the last frame when the existing first frame is already usable', async () => {
  const { calls, run, state } = setup({ hasImage: true, hasFirstImage: true })
  assert.deepEqual(await run(), { status: 'completed' })
  assert.deepEqual(calls, ['last'])
  assert.equal(state.hasLastImage, true)
  await run()
  assert.deepEqual(calls, ['last'])
})

test('waits for the first frame to finish and refresh before submitting the last frame', async () => {
  const { run, state } = setup()
  const first = deferred()
  const calls = []
  const result = run({
    generate: async (slot) => {
      calls.push(slot)
      if (slot === 'first') {
        await first.promise
        state.hasFirstImage = true
      } else {
        assert.equal(state.hasFirstImage, true, 'the last frame needs the completed first reference')
        state.hasLastImage = true
      }
      return { status: 'completed' }
    },
  })
  assert.deepEqual(calls, ['first'])
  first.resolve()
  assert.deepEqual(await result, { status: 'completed' })
  assert.deepEqual(calls, ['first', 'last'])
})

test('first-frame failure, timeout and cancellation cannot submit a dependent last frame', async () => {
  for (const status of ['failed', 'timeout', 'cancelled']) {
    const { run } = setup()
    const calls = []
    await assert.rejects(run({
      generate: async (slot) => {
        calls.push(slot)
        return { status, error: '服务不可用' }
      },
    }), /首帧：服务不可用/)
    assert.deepEqual(calls, ['first'])
  }
})

test('a retry after last-frame failure keeps the completed first frame', async () => {
  const { run, state } = setup()
  const calls = []
  let failLast = true
  const generate = async (slot) => {
    calls.push(slot)
    if (slot === 'first') state.hasFirstImage = true
    else if (failLast) return { status: 'failed', error: '尾帧限流' }
    else state.hasLastImage = true
    return { status: 'completed' }
  }
  await assert.rejects(run({ generate }), /尾帧：尾帧限流/)
  failLast = false
  await run({ generate })
  assert.deepEqual(calls, ['first', 'last', 'last'])
})

test('a completed task without a refreshed image does not claim a completed pair', async () => {
  const { run } = setup()
  const calls = []
  await assert.rejects(run({
    generate: async (slot) => {
      calls.push(slot)
      return { status: 'completed' }
    },
  }), /首帧生成完成，但未获取到图片/)
  assert.deepEqual(calls, ['first'])
})

test('stopping during first-frame generation drains it without submitting the last frame', async () => {
  const { run, state } = setup()
  let stopped = false
  const calls = []
  const result = await run({
    shouldStop: () => stopped,
    generate: async (slot) => {
      calls.push(slot)
      state.hasFirstImage = true
      stopped = true
      return { status: 'completed' }
    },
  })
  assert.deepEqual(result, { status: 'stopped' })
  assert.deepEqual(calls, ['first'])
})

test('pausing an in-flight frame returns control without submitting another image', async () => {
  const { run } = setup()
  const calls = []
  const result = await run({
    generate: async (slot) => {
      calls.push(slot)
      return { paused: true }
    },
  })
  assert.deepEqual(result, { paused: true })
  assert.deepEqual(calls, ['first'])
})

test('rechecks queued slots and preserves a last frame uploaded while the first was running', async () => {
  const { run, state } = setup()
  const calls = []
  await run({
    generate: async (slot) => {
      calls.push(slot)
      state.hasFirstImage = true
      state.hasLastImage = true
      return { status: 'completed' }
    },
  })
  assert.deepEqual(calls, ['first'])
})

test('single and grid modes submit a single image and never create an extra last frame', async () => {
  const { run, calls } = setup({ useFirstLastFrame: false })
  await run()
  await run()
  assert.deepEqual(calls, ['single'])
})
