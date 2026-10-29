import test from 'node:test'
import assert from 'node:assert/strict'
import { effectScope, nextTick, ref } from 'vue'
import { useVideoPlanning } from '../src/components/videoPlanning/useVideoPlanning.js'
import { activeExecution, executionLabel } from '../src/utils/videoPlanning.js'

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
const flush = async () => { for (let i = 0; i < 20; i++) await nextTick() }
const shot = (status = 'processing', id = 10) => ({ storyboard_id: id, choice: { model_id: 'h3-standard', revision: 1 }, selected_version_id: 'old-adopted', last_execution: status ? { plan_id: 'p1', node_id: 'n1', status, version_id: status === 'completed' ? 'generated-version' : null } : null })
function mount(t, overrides = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const episodeId = ref(1), dramaId = ref(1)
  let item = shot()
  const calls = { episode: [], plan: 0, run: 0, resume: 0, adopt: 0, preview: 0, capabilities: 0 }
  const api = {
    episode: async (id) => { calls.episode.push(id); return { items: [structuredClone(item)] } },
    capabilities: async () => { calls.capabilities++; return { items: [] } },
    sources: async () => ({ versions: [], storyboards: [] }),
    plan: async () => { calls.plan++; return { id: 'p1', status: item.last_execution?.status === 'completed' ? 'completed' : 'running', nodes: [] } },
    preview: async () => { calls.preview++; return { id: 'p1', revision: 1, status: 'preview', nodes: [{ id: 'n1', storyboard_id: 10, status: 'ready' }] } },
    run: async () => { calls.run++; item = shot('queued'); return { id: 'p1', status: 'running', nodes: [{ id: 'n1', storyboard_id: 10, status: 'queued' }] } },
    resume: async () => { calls.resume++ }, adopt: async () => { calls.adopt++ },
    ...overrides,
  }
  const scope = effectScope()
  const ui = scope.run(() => useVideoPlanning({ api, episodeId, dramaId }))
  t.after(() => scope.stop())
  return { ui, calls, episodeId, scope, setItem: (value) => { item = value } }
}

test('restored execution keeps polling with dialog closed, stops spinner on completion without adoption', async (t) => {
  const f = mount(t)
  await flush()
  assert.equal(f.ui.state.dialogOpen, false)
  assert.equal(activeExecution(f.ui.state.items[10].last_execution), true)
  t.mock.timers.tick(2500); await flush()
  assert.equal(f.calls.episode.length, 2)
  assert.equal(f.calls.plan, 0)
  assert.equal(f.calls.capabilities, 1, 'background polling only reads episode state')
  f.setItem(shot('completed'))
  t.mock.timers.tick(2500); await flush()
  assert.equal(activeExecution(f.ui.state.items[10].last_execution), false)
  assert.match(executionLabel(f.ui.state.items[10].last_execution), /采用/)
  assert.equal(f.ui.state.items[10].selected_version_id, 'old-adopted')
  assert.equal(f.calls.capabilities, 2, 'new output refreshes version/source choices once')
  assert.equal(f.calls.adopt + f.calls.run + f.calls.resume, 0)
  f.scope.stop()
  const count = f.calls.episode.length
  t.mock.timers.tick(60000); await flush()
  assert.equal(f.calls.episode.length, count)
})

test('new submission is shown immediately and closing dialog does not stop execution synchronization', async (t) => {
  const f = mount(t)
  f.setItem(shot(null)); await flush(); await f.ui.refresh()
  await f.ui.controller.preview([{ id: 10 }], { 10: { prompt: 'existing input' } })
  await f.ui.run()
  assert.equal(f.ui.state.items[10].last_execution.status, 'queued')
  f.ui.state.dialogOpen = false; await flush()
  f.setItem(shot('processing'))
  t.mock.timers.tick(2500); await flush()
  assert.equal(f.ui.state.items[10].last_execution.status, 'processing')
  assert.equal(f.calls.run, 1)
  assert.equal(f.calls.resume + f.calls.adopt, 0)
})

test('late poll from old episode cannot replace the new episode or create another timer', async (t) => {
  const pending = deferred()
  let reads = 0
  const f = mount(t, { episode: async (id) => {
    reads++
    if (reads === 2) return pending.promise
    return { items: [shot('processing', id === 1 ? 10 : 20)] }
  } })
  await flush()
  t.mock.timers.tick(2500); await flush()
  f.episodeId.value = 2; await flush()
  assert.deepEqual(Object.keys(f.ui.state.items), ['20'])
  pending.resolve({ items: [shot('completed', 10)] }); await flush()
  assert.deepEqual(Object.keys(f.ui.state.items), ['20'])
  t.mock.timers.tick(2500); await flush()
  assert.equal(reads, 4)
})

test('transient read failure preserves active state and retries GET only', async (t) => {
  let reads = 0
  const f = mount(t, { episode: async () => {
    if (++reads === 2) throw new Error('offline')
    return { items: [shot()] }
  } })
  await flush()
  t.mock.timers.tick(2500); await flush()
  assert.equal(activeExecution(f.ui.state.items[10].last_execution), true)
  assert.match(f.ui.state.error, /offline/)
  t.mock.timers.tick(10000); await flush()
  assert.equal(f.ui.state.error, '')
  assert.equal(reads, 3)
  assert.equal(f.calls.run + f.calls.resume + f.calls.adopt + f.calls.preview, 0)
})

test('initial network failure retries read-only loading and restores the persisted execution', async (t) => {
  let reads = 0
  const f = mount(t, { episode: async () => {
    if (++reads === 1) throw new Error('temporarily offline')
    return { items: [shot()] }
  } })
  await flush()
  assert.equal(f.ui.state.loaded, false)
  t.mock.timers.tick(10000); await flush()
  assert.equal(f.ui.state.loaded, true)
  assert.equal(activeExecution(f.ui.state.items[10].last_execution), true)
  assert.equal(f.calls.run + f.calls.resume + f.calls.adopt + f.calls.preview, 0)
})

test('idle episode discovers another tab submission; unknown result is not an endless generating spinner', async (t) => {
  const f = mount(t)
  f.setItem(shot(null)); await flush(); await f.ui.refresh()
  f.setItem(shot('processing'))
  t.mock.timers.tick(15000); await flush()
  assert.equal(activeExecution(f.ui.state.items[10].last_execution), true)
  assert.equal(activeExecution({ status: 'ready' }), false)
  assert.equal(activeExecution({ status: 'submitted_unknown' }), false)
  assert.match(executionLabel({ status: 'submitted_unknown' }), /请勿重复提交/)
  assert.match(executionLabel({ status: 'processing', blocking_reasons: ['known_task_query_failed_resume_available'] }), /查询异常/)
})
