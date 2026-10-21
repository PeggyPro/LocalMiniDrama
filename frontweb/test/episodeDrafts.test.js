import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EPISODE_DRAFT_STORAGE_KEY, episodeDraftKey, createEpisodeDraft, editEpisodeDraft,
  mergeEpisodeDraft, acknowledgeEpisodeDraft, snapshotEpisodeDraft, resolveEpisodeDraftConflict,
  loadEpisodeDrafts, persistEpisodeDrafts, browserDraftStorage,
} from '../src/utils/episodeDrafts.js'

const episode = (revision = 1, fields = {}) => ({ id: 7, title: '第一集', description: '梗概', script_content: '原稿', revision, ...fields })
function storage() {
  const values = new Map()
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
}

test('draft identity scopes equal numeric episode IDs to separate dramas', () => {
  assert.equal(episodeDraftKey(1, 7), '1:7')
  assert.notEqual(episodeDraftKey(1, 7), episodeDraftKey(2, 7))
  assert.equal(episodeDraftKey(null, 7), null)
  assert.equal(episodeDraftKey(1, ''), null)
})

test('edits to all fields become dirty and exact reversion becomes clean', () => {
  const original = createEpisodeDraft(episode())
  const changed = editEpisodeDraft(original, { title: '新标题', description: '独立梗概', scriptContent: '本地稿' })
  assert.equal(changed.dirty, true)
  assert.equal(original.scriptContent, '原稿')
  assert.equal(editEpisodeDraft(changed, original.baseSnapshot).dirty, false)
  assert.equal(editEpisodeDraft(original, { unrelated: 'ignored' }).dirty, false)
})

test('clean server refresh advances all fields and rejects older revisions', () => {
  const original = createEpisodeDraft(episode(2))
  const refreshed = mergeEpisodeDraft(original, episode(3, { title: '远端标题', description: null, script_content: '远端稿' }))
  assert.deepEqual(snapshotEpisodeDraft(refreshed), { title: '远端标题', description: '', scriptContent: '远端稿', baseRevision: 3 })
  assert.equal(refreshed.dirty, false)
  assert.equal(mergeEpisodeDraft(refreshed, episode(1)), refreshed)
})

test('dirty refresh preserves every local field and signals newest remote conflict', () => {
  const draft = editEpisodeDraft(createEpisodeDraft(episode()), { title: '本地标题', description: '本地梗概', scriptContent: '本地稿' })
  const conflict = mergeEpisodeDraft(draft, episode(3, { title: '远端标题', script_content: '远端稿' }))
  assert.deepEqual(snapshotEpisodeDraft(conflict), { title: '本地标题', description: '本地梗概', scriptContent: '本地稿', baseRevision: 1 })
  assert.equal(conflict.dirty, true)
  assert.equal(conflict.remoteConflict, true)
  assert.equal(conflict.remoteRevision, 3)
  assert.equal(mergeEpisodeDraft(conflict, episode(2)), conflict)
  assert.equal(mergeEpisodeDraft(draft, episode()), draft)
})

test('save acknowledges the submitted snapshot while preserving typing during the save', () => {
  const submitted = editEpisodeDraft(createEpisodeDraft(episode()), { title: '提交标题', scriptContent: '提交稿' })
  const snapshot = snapshotEpisodeDraft(submitted)
  const typed = editEpisodeDraft(submitted, { description: '保存中的新梗概', scriptContent: '继续输入' })
  const acknowledged = acknowledgeEpisodeDraft(typed, episode(2, { title: '提交标题', script_content: '提交稿' }), snapshot)
  assert.equal(acknowledged.baseRevision, 2)
  assert.equal(acknowledged.baseSnapshot.scriptContent, '提交稿')
  assert.equal(acknowledged.title, '提交标题')
  assert.equal(acknowledged.description, '保存中的新梗概')
  assert.equal(acknowledged.scriptContent, '继续输入')
  assert.equal(acknowledged.dirty, true)
  const saved = acknowledgeEpisodeDraft(submitted, episode(2, { title: '提交标题', script_content: '提交稿' }), snapshot)
  assert.equal(saved.dirty, false)
})

test('older save responses and acknowledgements without a submitted snapshot cannot clear new edits', () => {
  const draft = editEpisodeDraft(createEpisodeDraft(episode()), { scriptContent: '提交稿' })
  const snapshot = snapshotEpisodeDraft(draft)
  const saved = acknowledgeEpisodeDraft(draft, episode(2, { script_content: '提交稿' }), snapshot)
  const newDraft = editEpisodeDraft(saved, { scriptContent: '新稿' })
  assert.equal(acknowledgeEpisodeDraft(newDraft, episode(2, { script_content: '提交稿' }), snapshot), newDraft)
  assert.equal(acknowledgeEpisodeDraft(newDraft, episode(3), null), newDraft)
})

test('a newer remote version remains conflicted after an earlier save acknowledgement', () => {
  const draft = editEpisodeDraft(createEpisodeDraft(episode()), { scriptContent: '提交稿' })
  const conflict = mergeEpisodeDraft(draft, episode(3))
  const ack = acknowledgeEpisodeDraft(conflict, episode(2, { script_content: '提交稿' }), snapshotEpisodeDraft(draft))
  assert.equal(ack.baseRevision, 2)
  assert.equal(ack.remoteRevision, 3)
  assert.equal(ack.remoteConflict, true)
})

test('explicit local conflict resolution rebases and server choice discards edits cleanly', () => {
  const edited = editEpisodeDraft(createEpisodeDraft(episode()), { title: '本地标题', description: '本地梗概', scriptContent: '本地稿' })
  const remote = episode(4, { title: '远端标题', script_content: '远端稿' })
  const conflict = mergeEpisodeDraft(edited, remote)
  const local = resolveEpisodeDraftConflict(conflict, remote, 'local')
  assert.equal(local.title, '本地标题')
  assert.equal(local.description, '本地梗概')
  assert.equal(local.scriptContent, '本地稿')
  assert.equal(local.baseRevision, 4)
  assert.equal(local.baseSnapshot.scriptContent, '远端稿')
  assert.equal(local.remoteConflict, false)
  assert.equal(local.dirty, true)
  const server = resolveEpisodeDraftConflict(conflict, remote, 'server')
  assert.equal(server.scriptContent, '远端稿')
  assert.equal(server.baseRevision, 4)
  assert.equal(server.dirty, false)
  assert.equal(server.remoteConflict, false)
  assert.equal(resolveEpisodeDraftConflict(conflict, episode(2), 'local'), conflict)
  assert.throws(() => resolveEpisodeDraftConflict(conflict, remote, 'invalid'))
})

test('local resolution recomputes dirty rather than pretending an unsubmitted draft was saved', () => {
  const edited = editEpisodeDraft(createEpisodeDraft(episode()), { scriptContent: '相同新稿' })
  const resolved = resolveEpisodeDraftConflict(edited, episode(2, { script_content: '相同新稿' }), 'local')
  assert.equal(resolved.dirty, false)
  assert.equal(resolved.baseRevision, 2)
})

test('session persistence restores independent dirty drafts and conflict metadata', () => {
  const session = storage()
  const dirty = mergeEpisodeDraft(editEpisodeDraft(createEpisodeDraft(episode()), { scriptContent: '未保存' }), episode(4))
  const drafts = { '1:7': dirty, '2:7': createEpisodeDraft(episode(2)) }
  assert.equal(persistEpisodeDrafts(drafts, session), true)
  assert.deepEqual(loadEpisodeDrafts(session), drafts)
})

test('malformed or partially malformed persisted drafts fail safely and preserve valid records', () => {
  const session = storage()
  for (const raw of ['{', 'null', '[]', '{"version":2,"drafts":{}}', '{"version":1,"drafts":[]}']) {
    session.setItem(EPISODE_DRAFT_STORAGE_KEY, raw)
    assert.deepEqual(loadEpisodeDrafts(session), {})
  }
  const valid = editEpisodeDraft(createEpisodeDraft(episode()), { title: '本地' })
  session.setItem(EPISODE_DRAFT_STORAGE_KEY, JSON.stringify({ version: 1, drafts: {
    '1:7': valid, 'invalid': valid, '1:8': { title: 3 }, '1:9': null,
  } }))
  assert.deepEqual(loadEpisodeDrafts(session), { '1:7': valid })
})

test('no window, storage security errors and quota errors are non-fatal', (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else delete globalThis.window
  })
  delete globalThis.window
  assert.equal(browserDraftStorage(), null)
  assert.deepEqual(loadEpisodeDrafts(), {})
  assert.equal(persistEpisodeDrafts({}), false)
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    get sessionStorage() { throw new Error('denied') },
  } })
  assert.equal(browserDraftStorage(), null)
  assert.deepEqual(loadEpisodeDrafts(), {})
  assert.equal(persistEpisodeDrafts({}), false)
  assert.deepEqual(loadEpisodeDrafts({ getItem() { throw new Error('denied') } }), {})
  assert.equal(persistEpisodeDrafts({}, { setItem() { throw new Error('quota') } }), false)
})
