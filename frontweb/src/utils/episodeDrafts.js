// No Vue/browser dependencies: drafts can be merged and restored in Node tests too.
export const EPISODE_DRAFT_STORAGE_KEY = 'local-mini-drama:episode-drafts:v1'
export const EPISODE_DRAFT_FIELDS = ['title', 'sourceText', 'description', 'scriptContent']
const LEGACY_DRAFT_FIELDS = ['title', 'description', 'scriptContent']

export function episodeDraftKey(dramaId, episodeId) {
  if (dramaId == null || episodeId == null || dramaId === '' || episodeId === '') return null
  return `${dramaId}:${episodeId}`
}

function revision(value) {
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 0 ? n : 0
}

function fields(value = {}) {
  return {
    title: String(value.title ?? ''),
    sourceText: String(value.sourceText ?? value.source_text ?? ''),
    description: String(value.description ?? ''),
    scriptContent: String(value.scriptContent ?? value.script_content ?? ''),
  }
}

function sameFields(a, b) {
  return EPISODE_DRAFT_FIELDS.every((key) => a[key] === b[key])
}

export function createEpisodeDraft(episode = {}) {
  const base = fields(episode)
  return {
    ...base,
    dirty: false,
    baseRevision: revision(episode.revision),
    remoteConflict: false,
    remoteRevision: null,
    baseSnapshot: base,
    sourceTextNeedsHydration: false,
  }
}

/** Legacy v1 drafts never observed source_text; their empty placeholder must not erase it. */
function hydrateLegacySource(draft, episode) {
  if (!draft.sourceTextNeedsHydration || (!Object.hasOwn(episode, 'source_text') && !Object.hasOwn(episode, 'sourceText'))) return draft
  const sourceText = fields(episode).sourceText
  const next = {
    ...draft,
    sourceText: draft.sourceText === draft.baseSnapshot.sourceText ? sourceText : draft.sourceText,
    baseSnapshot: { ...draft.baseSnapshot, sourceText },
    sourceTextNeedsHydration: false,
  }
  next.dirty = !sameFields(next, next.baseSnapshot)
  return next
}

export function editEpisodeDraft(draft, patch) {
  const next = { ...draft }
  for (const key of EPISODE_DRAFT_FIELDS) {
    if (Object.hasOwn(patch, key)) next[key] = String(patch[key] ?? '')
  }
  next.dirty = !sameFields(next, next.baseSnapshot)
  return next
}

/** Server refreshes may advance clean drafts, but must never replace local edits. */
export function mergeEpisodeDraft(draft, episode) {
  if (!draft) return createEpisodeDraft(episode)
  const incoming = createEpisodeDraft(episode)
  if (incoming.baseRevision < draft.baseRevision) return draft
  if (draft.remoteRevision != null && incoming.baseRevision < draft.remoteRevision) return draft
  draft = hydrateLegacySource(draft, episode)
  if (!draft.dirty) return incoming
  if (incoming.baseRevision === draft.baseRevision) return draft
  return { ...draft, remoteConflict: true, remoteRevision: incoming.baseRevision }
}

export function resolveEpisodeDraftConflict(draft, episode, choice) {
  if (choice !== 'local' && choice !== 'server') throw new Error('Unknown draft conflict choice')
  const server = createEpisodeDraft(episode)
  if (server.baseRevision < (draft?.remoteRevision ?? draft?.baseRevision ?? 0)) return draft
  if (choice === 'server' || !draft) return server
  const next = { ...server, ...fields(hydrateLegacySource(draft, episode)) }
  next.dirty = !sameFields(next, next.baseSnapshot)
  return next
}

export function snapshotEpisodeDraft(draft) {
  return { ...fields(draft), baseRevision: draft.baseRevision }
}

/** Acknowledge exactly the request snapshot, preserving edits typed while awaiting it. */
export function acknowledgeEpisodeDraft(draft, episode, submittedSnapshot) {
  if (!draft || !submittedSnapshot) return draft
  const saved = createEpisodeDraft(episode)
  if (saved.baseRevision < draft.baseRevision) return draft
  // An older concurrent response must not acknowledge a more recent save.
  if (submittedSnapshot.baseRevision < draft.baseRevision) return draft
  const next = { ...draft }
  for (const key of EPISODE_DRAFT_FIELDS) {
    if (draft[key] === submittedSnapshot[key]) next[key] = saved[key]
  }
  next.baseSnapshot = saved.baseSnapshot
  next.baseRevision = saved.baseRevision
  next.sourceTextNeedsHydration = false
  next.remoteConflict = draft.remoteRevision != null && draft.remoteRevision > saved.baseRevision
  next.remoteRevision = next.remoteConflict ? draft.remoteRevision : null
  next.dirty = !sameFields(next, next.baseSnapshot)
  return next
}

export function browserDraftStorage() {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch (_) {
    return null
  }
}

/** Ignore malformed records individually; unavailable or full storage is non-fatal. */
export function loadEpisodeDrafts(storage = browserDraftStorage()) {
  try {
    const parsed = JSON.parse(storage?.getItem(EPISODE_DRAFT_STORAGE_KEY) || 'null')
    if (parsed?.version !== 1 || !parsed.drafts || typeof parsed.drafts !== 'object' || Array.isArray(parsed.drafts)) return {}
    const result = {}
    for (const [key, value] of Object.entries(parsed.drafts)) {
      if (!/^[^:]+:[^:]+$/.test(key) || !value || typeof value !== 'object' || Array.isArray(value)) continue
      if (!LEGACY_DRAFT_FIELDS.every((field) => typeof value[field] === 'string')) continue
      if (!value.baseSnapshot || !LEGACY_DRAFT_FIELDS.every((field) => typeof value.baseSnapshot[field] === 'string')) continue
      // Keep the v1 storage key and all unsaved fields. Missing source is an upgrade,
      // not a malformed record or a user edit; validate present source fields normally.
      const hasSource = Object.hasOwn(value, 'sourceText')
      const hasBaseSource = Object.hasOwn(value.baseSnapshot, 'sourceText')
      if ((hasSource && typeof value.sourceText !== 'string') || (hasBaseSource && typeof value.baseSnapshot.sourceText !== 'string')) continue
      const draft = {
        ...fields(value),
        baseSnapshot: fields(value.baseSnapshot),
        baseRevision: revision(value.baseRevision),
        remoteConflict: value.remoteConflict === true,
        remoteRevision: value.remoteRevision == null ? null : revision(value.remoteRevision),
        sourceTextNeedsHydration: value.sourceTextNeedsHydration === true || !hasSource || !hasBaseSource,
      }
      draft.dirty = !sameFields(draft, draft.baseSnapshot)
      result[key] = draft
    }
    return result
  } catch (_) {
    return {}
  }
}

export function persistEpisodeDrafts(drafts, storage = browserDraftStorage()) {
  try {
    if (!storage) return false
    storage.setItem(EPISODE_DRAFT_STORAGE_KEY, JSON.stringify({ version: 1, drafts }))
    return true
  } catch (_) {
    return false
  }
}
