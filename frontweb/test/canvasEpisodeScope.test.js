import test from 'node:test'
import assert from 'node:assert/strict'
import { parseEpisodeQuery, resolveCanvasEpisodeId, createCanvasOperationGuard } from '../src/utils/canvasEpisodeScope.js'

test('canvas episode query accepts valid IDs and rejects ambiguous route values', () => {
  assert.equal(parseEpisodeQuery('12'), 12)
  assert.equal(parseEpisodeQuery(['12', '13']), 12)
  for (const value of [undefined, null, '', ' ', 'NaN', '0', '-1', '1.5', '1e3', 'Infinity', '9007199254740992', [], {}]) {
    assert.equal(parseEpisodeQuery(value), null, String(value))
  }
  const episodes = [{ id: 12 }, { id: '13' }]
  assert.equal(resolveCanvasEpisodeId('12', episodes), 12)
  assert.equal(resolveCanvasEpisodeId('13', episodes), 13)
  assert.equal(resolveCanvasEpisodeId('99', episodes), null)
  assert.equal(resolveCanvasEpisodeId(undefined, episodes), null)
})

test('changing project or episode invalidates an operation before any navigation watcher runs', () => {
  const context = { dramaId: 1, episodeId: 12 }
  const guard = createCanvasOperationGuard(() => context)
  const first = guard.capture()
  assert.equal(first.isActive(), true)
  context.episodeId = 13
  assert.equal(first.isActive(), false)
  const second = guard.capture()
  context.dramaId = 2
  assert.equal(second.isActive(), false)
})

test('navigation away and back cannot revive a pending canvas operation', async () => {
  const context = { dramaId: 1, episodeId: 12 }
  const guard = createCanvasOperationGuard(() => context)
  const first = guard.capture()
  let complete
  const response = new Promise((resolve) => { complete = resolve })
  let callbacks = 0
  const pending = response.then(() => { if (first.isActive()) callbacks++ })
  context.episodeId = 13
  guard.invalidate()
  context.episodeId = 12
  guard.invalidate()
  complete()
  await pending
  assert.equal(callbacks, 0)
  assert.equal(first.isActive(), false)
  assert.equal(guard.capture().isActive(), true)
})

test('unmount permanently prevents stale callbacks, including a newly captured scope', () => {
  const guard = createCanvasOperationGuard(() => ({ dramaId: 1, episodeId: 12 }))
  const scope = guard.capture()
  guard.dispose()
  assert.equal(scope.isActive(), false)
  assert.equal(guard.capture().isActive(), false)
})
