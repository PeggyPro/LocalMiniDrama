import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import {
  episodeDraftKey,
  createEpisodeDraft,
  editEpisodeDraft,
  mergeEpisodeDraft,
  acknowledgeEpisodeDraft,
  resolveEpisodeDraftConflict as resolveDraftConflict,
  snapshotEpisodeDraft as snapshotDraft,
  loadEpisodeDrafts,
  persistEpisodeDrafts,
} from '../utils/episodeDrafts.js'

function episodeVideoKey(dramaId, episodeId) {
  if (dramaId == null || episodeId == null) return null
  return `${dramaId}:${episodeId}`
}

export const useFilmStore = defineStore('film', () => {
  const drama = ref(null)
  const currentEpisode = ref(null)
  const storyInput = ref('')
  const episodeDrafts = ref(loadEpisodeDrafts())
  watch(episodeDrafts, (drafts) => persistEpisodeDrafts(drafts), { deep: true, flush: 'sync' })

  // Preserve the object identity used by title/premise/script bindings across refreshes.
  function commitDraft(key, next) {
    if (!key || !next) return null
    const existing = episodeDrafts.value[key]
    if (existing) {
      if (existing !== next) Object.assign(existing, next)
    } else {
      episodeDrafts.value[key] = next
    }
    return episodeDrafts.value[key]
  }

  function hydrateEpisodeDraft(did, episode) {
    const key = episodeDraftKey(did, episode?.id)
    if (!key) return null
    return commitDraft(key, mergeEpisodeDraft(episodeDrafts.value[key], episode))
  }

  function getEpisodeDraft(did, episodeOrId) {
    if (episodeOrId && typeof episodeOrId === 'object') return hydrateEpisodeDraft(did, episodeOrId)
    const key = episodeDraftKey(did, episodeOrId)
    if (!key) return null
    if (!episodeDrafts.value[key]) {
      const ep = Number(drama.value?.id) === Number(did)
        ? drama.value?.episodes?.find((e) => Number(e.id) === Number(episodeOrId))
        : null
      commitDraft(key, createEpisodeDraft(ep || {}))
    }
    return episodeDrafts.value[key]
  }

  function updateEpisodeDraft(did, eid, patch) {
    const draft = getEpisodeDraft(did, eid)
    return draft ? commitDraft(episodeDraftKey(did, eid), editEpisodeDraft(draft, patch)) : null
  }

  function snapshotEpisodeDraft(did, eid) {
    const draft = getEpisodeDraft(did, eid)
    return draft ? snapshotDraft(draft) : null
  }

  function markEpisodeDraftSaved(did, eid, serverEpisode, submittedSnapshot) {
    const key = episodeDraftKey(did, eid)
    const draft = getEpisodeDraft(did, eid)
    return draft ? commitDraft(key, acknowledgeEpisodeDraft(draft, serverEpisode, submittedSnapshot)) : null
  }

  function resolveEpisodeDraftConflict(did, serverEpisode, choice) {
    const key = episodeDraftKey(did, serverEpisode?.id)
    if (!key) return null
    return commitDraft(key, resolveDraftConflict(getEpisodeDraft(did, serverEpisode.id), serverEpisode, choice))
  }

  const currentEpisodeDraft = computed(() => {
    const did = drama.value?.id
    const eid = currentEpisode.value?.id
    return did != null && eid != null ? getEpisodeDraft(did, eid) : null
  })
  const scriptContent = computed({
    get: () => currentEpisodeDraft.value?.scriptContent ?? '',
    set: (text) => setScriptContent(text),
  })
  const videoResolution = ref('480p')
  /** 按 dramaId:episodeId 存储合成视频进度与状态 */
  const videoStateByKey = ref({})

  const dramaId = computed(() => drama.value?.id ?? null)
  // 角色/道具/场景默认只显示本集资源（随「选择第几集」变化）
  const characters = computed(() => currentEpisode.value?.characters ?? [])
  const scenes = computed(() => currentEpisode.value?.scenes ?? [])
  const props = computed(() => currentEpisode.value?.props ?? [])
  const storyboards = computed(() => currentEpisode.value?.storyboards ?? [])

  const currentVideoKey = computed(() =>
    episodeVideoKey(drama.value?.id ?? null, currentEpisode.value?.id ?? null)
  )

  const videoProgress = computed(() => {
    const k = currentVideoKey.value
    if (!k) return 0
    return videoStateByKey.value[k]?.progress ?? 0
  })

  const videoStatus = computed(() => {
    const k = currentVideoKey.value
    if (!k) return 'idle'
    return videoStateByKey.value[k]?.status ?? 'idle'
  })

  function _ensureVideoState(key) {
    if (!key) return null
    if (!videoStateByKey.value[key]) {
      videoStateByKey.value = {
        ...videoStateByKey.value,
        [key]: { status: 'idle', progress: 0 },
      }
    }
    return videoStateByKey.value[key]
  }

  function setDrama(d) {
    drama.value = d
    for (const ep of d?.episodes || []) hydrateEpisodeDraft(d.id, ep)
  }

  function setCurrentEpisode(ep) {
    currentEpisode.value = ep
    if (ep && drama.value?.id != null) hydrateEpisodeDraft(drama.value.id, ep)
  }

  function setStoryInput(text) {
    storyInput.value = text
  }

  /** User edit only. Server data must go through hydrateEpisodeDraft/setCurrentEpisode. */
  function setScriptContent(text) {
    const did = drama.value?.id
    const eid = currentEpisode.value?.id
    if (did != null && eid != null) updateEpisodeDraft(did, eid, { scriptContent: text })
  }

  function setVideoProgress(p, dId, eId) {
    const key = episodeVideoKey(
      dId ?? drama.value?.id ?? null,
      eId ?? currentEpisode.value?.id ?? null
    )
    if (!key) return
    const prev = _ensureVideoState(key)
    videoStateByKey.value = {
      ...videoStateByKey.value,
      [key]: { ...prev, progress: p },
    }
  }

  function setVideoStatus(s, dId, eId) {
    const key = episodeVideoKey(
      dId ?? drama.value?.id ?? null,
      eId ?? currentEpisode.value?.id ?? null
    )
    if (!key) return
    const prev = _ensureVideoState(key)
    videoStateByKey.value = {
      ...videoStateByKey.value,
      [key]: { ...prev, status: s },
    }
  }

  function getVideoStatus(dId, eId) {
    const key = episodeVideoKey(dId, eId)
    if (!key) return 'idle'
    return videoStateByKey.value[key]?.status ?? 'idle'
  }

  function reset() {
    drama.value = null
    currentEpisode.value = null
    storyInput.value = ''
    // Drafts and video state survive project/episode switches and page unmounts.
  }

  return {
    drama,
    currentEpisode,
    storyInput,
    scriptContent,
    currentEpisodeDraft,
    getEpisodeDraft,
    updateEpisodeDraft,
    hydrateEpisodeDraft,
    snapshotEpisodeDraft,
    markEpisodeDraftSaved,
    resolveEpisodeDraftConflict,
    videoResolution,
    videoStateByKey,
    videoProgress,
    videoStatus,
    dramaId,
    characters,
    scenes,
    props,
    storyboards,
    setDrama,
    setCurrentEpisode,
    setStoryInput,
    setScriptContent,
    setVideoProgress,
    setVideoStatus,
    getVideoStatus,
    reset,
  }
})
