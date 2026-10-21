import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EPISODE_DRAFT_STORAGE_KEY, episodeDraftKey, createEpisodeDraft, editEpisodeDraft,
  mergeEpisodeDraft, acknowledgeEpisodeDraft, snapshotEpisodeDraft, resolveEpisodeDraftConflict,
  loadEpisodeDrafts, persistEpisodeDrafts, browserDraftStorage,
} from '../src/utils/episodeDrafts.js'

const episode = (revision = 1, fields = {}) => ({ id: 7, title: '第一集', source_text: '小说原文', description: '改编要求', script_content: '原稿', revision, ...fields })
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
  const changed = editEpisodeDraft(original, { title: '新标题', sourceText: '本地原文', description: '独立改编要求', scriptContent: '本地稿' })
  assert.equal(changed.dirty, true)
  assert.equal(original.scriptContent, '原稿')
  assert.equal(editEpisodeDraft(changed, original.baseSnapshot).dirty, false)
  assert.equal(editEpisodeDraft(original, { unrelated: 'ignored' }).dirty, false)
})

test('clean server refresh advances all fields and rejects older revisions', () => {
  const original = createEpisodeDraft(episode(2))
  const refreshed = mergeEpisodeDraft(original, episode(3, { title: '远端标题', source_text: '远端原文', description: null, script_content: '远端稿' }))
  assert.deepEqual(snapshotEpisodeDraft(refreshed), { title: '远端标题', sourceText: '远端原文', description: '', scriptContent: '远端稿', baseRevision: 3 })
  assert.equal(refreshed.dirty, false)
  assert.equal(mergeEpisodeDraft(refreshed, episode(1)), refreshed)
})

test('dirty refresh preserves every local field and signals newest remote conflict', () => {
  const draft = editEpisodeDraft(createEpisodeDraft(episode()), { title: '本地标题', sourceText: '本地原文', description: '本地改编要求', scriptContent: '本地稿' })
  const conflict = mergeEpisodeDraft(draft, episode(3, { title: '远端标题', source_text: '远端原文', script_content: '远端稿' }))
  assert.deepEqual(snapshotEpisodeDraft(conflict), { title: '本地标题', sourceText: '本地原文', description: '本地改编要求', scriptContent: '本地稿', baseRevision: 1 })
  assert.equal(conflict.dirty, true)
  assert.equal(conflict.remoteConflict, true)
  assert.equal(conflict.remoteRevision, 3)
  assert.equal(mergeEpisodeDraft(conflict, episode(2)), conflict)
  assert.equal(mergeEpisodeDraft(draft, episode()), draft)
})

test('revision-only refresh rebases a dirty draft without reporting a content conflict', () => {
  const draft = editEpisodeDraft(createEpisodeDraft(episode()), { sourceText: '本地原文', scriptContent: '本地剧本' })
  const merged = mergeEpisodeDraft(draft, episode(3))
  assert.equal(merged.sourceText, '本地原文')
  assert.equal(merged.scriptContent, '本地剧本')
  assert.equal(merged.baseRevision, 3)
  assert.equal(merged.baseSnapshot.sourceText, '小说原文')
  assert.equal(merged.baseSnapshot.scriptContent, '原稿')
  assert.equal(merged.dirty, true)
  assert.equal(merged.remoteConflict, false)
  assert.equal(merged.remoteRevision, null)
  assert.equal(mergeEpisodeDraft(merged, episode(2)), merged)
})

test('a refresh matching the local draft recognizes that its content is already saved', () => {
  const local = { title: '新标题', sourceText: '新原文', description: '', scriptContent: '新剧本' }
  const draft = editEpisodeDraft(createEpisodeDraft(episode()), local)
  const saved = mergeEpisodeDraft(draft, episode(2, {
    title: local.title, source_text: local.sourceText, description: local.description, script_content: local.scriptContent,
  }))
  assert.deepEqual(snapshotEpisodeDraft(saved), { ...local, baseRevision: 2 })
  assert.equal(saved.dirty, false)
  assert.equal(saved.remoteConflict, false)
})

test('non-overlapping server and local edits merge without dropping either side', () => {
  const draft = editEpisodeDraft(createEpisodeDraft(episode()), { sourceText: '本地原文', description: '' })
  const merged = mergeEpisodeDraft(draft, episode(2, { title: '服务器标题', script_content: 'AI生成剧本' }))
  assert.deepEqual(snapshotEpisodeDraft(merged), {
    title: '服务器标题', sourceText: '本地原文', description: '', scriptContent: 'AI生成剧本', baseRevision: 2,
  })
  assert.equal(merged.baseSnapshot.sourceText, '小说原文')
  assert.equal(merged.baseSnapshot.scriptContent, 'AI生成剧本')
  assert.equal(merged.dirty, true)
  assert.equal(merged.remoteConflict, false)
})

test('different changes to the same field still require an explicit conflict choice', () => {
  for (const [field, serverField] of [
    ['title', 'title'], ['sourceText', 'source_text'], ['description', 'description'], ['scriptContent', 'script_content'],
  ]) {
    for (const localValue of ['本地修改', '']) {
      const draft = editEpisodeDraft(createEpisodeDraft(episode()), { [field]: localValue })
      const conflict = mergeEpisodeDraft(draft, episode(2, { [serverField]: '服务器修改' }))
      assert.equal(conflict[field], localValue)
      assert.equal(conflict.baseRevision, 1)
      assert.equal(conflict.remoteRevision, 2)
      assert.equal(conflict.remoteConflict, true)
      assert.deepEqual(conflict.baseSnapshot, draft.baseSnapshot)
    }
  }
})

test('persisted false conflicts clear on refresh without discarding the unsaved draft', () => {
  const draft = { ...editEpisodeDraft(createEpisodeDraft(episode()), { scriptContent: '保留未保存剧本' }), remoteConflict: true, remoteRevision: 3 }
  const session = storage()
  persistEpisodeDrafts({ '1:7': draft }, session)
  const restored = loadEpisodeDrafts(session)['1:7']
  assert.equal(mergeEpisodeDraft(restored, episode(2)), restored, 'older remote observations remain ignored')
  const refreshed = mergeEpisodeDraft(restored, episode(3))
  assert.equal(refreshed.scriptContent, '保留未保存剧本')
  assert.equal(refreshed.dirty, true)
  assert.equal(refreshed.baseRevision, 3)
  assert.equal(refreshed.remoteConflict, false)
  assert.equal(refreshed.remoteRevision, null)
})

test('a real conflict clears when the latest server content converges or returns to the baseline', () => {
  const draft = editEpisodeDraft(createEpisodeDraft(episode()), { scriptContent: '本地稿' })
  const conflict = mergeEpisodeDraft(draft, episode(2, { script_content: '远端稿' }))
  const converged = mergeEpisodeDraft(conflict, episode(3, { script_content: '本地稿' }))
  assert.equal(converged.remoteConflict, false)
  assert.equal(converged.dirty, false)
  const reverted = mergeEpisodeDraft(conflict, episode(3))
  assert.equal(reverted.scriptContent, '本地稿')
  assert.equal(reverted.baseRevision, 3)
  assert.equal(reverted.remoteConflict, false)
  assert.equal(reverted.dirty, true)
})

test('save acknowledges the submitted snapshot while preserving typing during the save', () => {
  const submitted = editEpisodeDraft(createEpisodeDraft(episode()), { title: '提交标题', sourceText: '提交原文', scriptContent: '提交稿' })
  const snapshot = snapshotEpisodeDraft(submitted)
  const typed = editEpisodeDraft(submitted, { title: '继续改标题', sourceText: '保存中的新原文', description: '保存中的新要求', scriptContent: '继续输入' })
  const acknowledged = acknowledgeEpisodeDraft(typed, episode(2, { title: '提交标题', source_text: '提交原文', script_content: '提交稿' }), snapshot)
  assert.equal(acknowledged.baseRevision, 2)
  assert.equal(acknowledged.baseSnapshot.sourceText, '提交原文')
  assert.equal(acknowledged.baseSnapshot.scriptContent, '提交稿')
  assert.equal(acknowledged.title, '继续改标题')
  assert.equal(acknowledged.sourceText, '保存中的新原文')
  assert.equal(acknowledged.description, '保存中的新要求')
  assert.equal(acknowledged.scriptContent, '继续输入')
  assert.equal(acknowledged.dirty, true)
  const saved = acknowledgeEpisodeDraft(submitted, episode(2, { title: '提交标题', source_text: '提交原文', script_content: '提交稿' }), snapshot)
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
  const conflict = mergeEpisodeDraft(draft, episode(3, { script_content: '更新的远端稿' }))
  const ack = acknowledgeEpisodeDraft(conflict, episode(2, { script_content: '提交稿' }), snapshotEpisodeDraft(draft))
  assert.equal(ack.baseRevision, 2)
  assert.equal(ack.remoteRevision, 3)
  assert.equal(ack.remoteConflict, true)
})

test('explicit local conflict resolution rebases and server choice discards edits cleanly', () => {
  const edited = editEpisodeDraft(createEpisodeDraft(episode()), { title: '本地标题', sourceText: '本地原文', description: '本地梗概', scriptContent: '本地稿' })
  const remote = episode(4, { title: '远端标题', source_text: '远端原文', script_content: '远端稿' })
  const conflict = mergeEpisodeDraft(edited, remote)
  const local = resolveEpisodeDraftConflict(conflict, remote, 'local')
  assert.equal(local.title, '本地标题')
  assert.equal(local.sourceText, '本地原文')
  assert.equal(local.baseSnapshot.sourceText, '远端原文')
  assert.equal(local.description, '本地梗概')
  assert.equal(local.scriptContent, '本地稿')
  assert.equal(local.baseRevision, 4)
  assert.equal(local.baseSnapshot.scriptContent, '远端稿')
  assert.equal(local.remoteConflict, false)
  assert.equal(local.dirty, true)
  const server = resolveEpisodeDraftConflict(conflict, remote, 'server')
  assert.equal(server.sourceText, '远端原文')
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

test('source, instructions and output have independent normalization, edits and exact reversion', () => {
  const draft = createEpisodeDraft(episode())
  assert.equal(draft.sourceText, '小说原文')
  assert.equal(draft.description, '改编要求')
  assert.equal(draft.scriptContent, '原稿')
  assert.equal(createEpisodeDraft({ sourceText: '前端原文', source_text: '后端原文' }).sourceText, '前端原文')
  assert.deepEqual(snapshotEpisodeDraft(createEpisodeDraft({ source_text: '只有原文' })), {
    title: '', sourceText: '只有原文', description: '', scriptContent: '', baseRevision: 0,
  })
  assert.equal(createEpisodeDraft({ description: '仅要求', script_content: '仅输出' }).sourceText, '')
  for (const key of ['title', 'sourceText', 'description', 'scriptContent']) {
    const edited = editEpisodeDraft(draft, { [key]: '' })
    assert.equal(edited.dirty, true, key)
    for (const other of ['title', 'sourceText', 'description', 'scriptContent'].filter((field) => field !== key)) {
      assert.equal(edited[other], draft[other], `${key} must not change ${other}`)
    }
    assert.equal(editEpisodeDraft(edited, { [key]: draft[key] }).dirty, false, key)
  }
})

test('source-only edits during save remain dirty while submitted instructions/output are acknowledged', () => {
  const submitted = editEpisodeDraft(createEpisodeDraft(episode()), { description: '', scriptContent: '已提交剧本' })
  const snapshot = snapshotEpisodeDraft(submitted)
  const typed = editEpisodeDraft(submitted, { sourceText: '' })
  const saved = acknowledgeEpisodeDraft(typed, episode(2, { description: '', script_content: '已提交剧本' }), snapshot)
  assert.equal(saved.sourceText, '')
  assert.equal(saved.baseSnapshot.sourceText, '小说原文')
  assert.equal(saved.description, '')
  assert.equal(saved.scriptContent, '已提交剧本')
  assert.equal(saved.dirty, true)
  const final = acknowledgeEpisodeDraft(saved, episode(3, { source_text: '', description: '', script_content: '已提交剧本' }), snapshotEpisodeDraft(saved))
  assert.equal(final.dirty, false)
  assert.equal(acknowledgeEpisodeDraft(editEpisodeDraft(final, { sourceText: '新原文' }), episode(2), snapshot).sourceText, '新原文')
})

function loadLegacyDrafts(patches = {}) {
  const session = storage()
  const baseSnapshot = { title: '第一集', description: '旧要求', scriptContent: '旧剧本' }
  const old = { ...baseSnapshot, baseSnapshot, baseRevision: 1, dirty: false, remoteConflict: false, remoteRevision: null, ...patches }
  session.setItem(EPISODE_DRAFT_STORAGE_KEY, JSON.stringify({ version: 1, drafts: { '1:7': old } }))
  return { session, drafts: loadEpisodeDrafts(session) }
}

test('legacy persisted v1 records gain empty source in draft and baseline without losing edits or adding dirtiness', () => {
  for (const patch of [{}, { title: '未保存标题' }, { description: '未保存要求' }, { scriptContent: '未保存剧本' }]) {
    const { session, drafts } = loadLegacyDrafts(patch)
    const draft = drafts['1:7']
    assert.ok(draft, 'legacy record must not be discarded')
    assert.equal(draft.sourceText, '')
    assert.equal(draft.baseSnapshot.sourceText, '')
    assert.equal(draft.sourceTextNeedsHydration, true)
    assert.equal(draft.dirty, Object.keys(patch).length > 0)
    for (const [field, value] of Object.entries(patch)) assert.equal(draft[field], value)
    assert.equal(persistEpisodeDrafts(drafts, session), true)
    assert.deepEqual(loadEpisodeDrafts(session), drafts, 'migration metadata survives a reload before hydration')
  }
})

test('legacy dirty hydration adopts newly introduced server source without clobbering unsaved fields', () => {
  for (const serverRevision of [1, 3]) {
    const { drafts } = loadLegacyDrafts({ title: '未保存标题', description: '未保存要求', scriptContent: '未保存剧本' })
    const server = episode(serverRevision, { source_text: '服务器小说原文' })
    const hydrated = mergeEpisodeDraft(drafts['1:7'], server)
    assert.deepEqual(snapshotEpisodeDraft(hydrated), {
      title: '未保存标题', sourceText: '服务器小说原文', description: '未保存要求', scriptContent: '未保存剧本', baseRevision: 1,
    })
    assert.equal(hydrated.baseSnapshot.sourceText, '服务器小说原文')
    assert.equal(hydrated.sourceTextNeedsHydration, false)
    assert.equal(hydrated.dirty, true)
    assert.equal(hydrated.remoteConflict, serverRevision > 1)
    const local = resolveEpisodeDraftConflict(hydrated, server, 'local')
    assert.equal(local.sourceText, '服务器小说原文', 'keeping legacy edits must not erase the server source')
    assert.equal(local.scriptContent, '未保存剧本')
  }
  const { drafts } = loadLegacyDrafts()
  const clean = mergeEpisodeDraft(drafts['1:7'], episode(1))
  assert.equal(clean.sourceText, '小说原文')
  assert.equal(clean.dirty, false)
})

test('legacy source hydration preserves source typed before hydration and ignores stale server data', () => {
  const { drafts } = loadLegacyDrafts({ description: '未保存要求' })
  const typed = editEpisodeDraft(drafts['1:7'], { sourceText: '刚输入的原文' })
  assert.equal(mergeEpisodeDraft(typed, episode(0)), typed)
  const hydrated = mergeEpisodeDraft(typed, episode(2))
  assert.equal(hydrated.sourceText, '刚输入的原文')
  assert.equal(hydrated.baseSnapshot.sourceText, '小说原文')
  assert.equal(hydrated.description, '未保存要求')
  assert.equal(hydrated.remoteConflict, true)
  const resolved = resolveEpisodeDraftConflict(typed, episode(2), 'local')
  assert.equal(resolved.sourceText, '刚输入的原文')
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
