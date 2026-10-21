import { ref, watch, onScopeDispose } from 'vue'
import { ElMessage } from 'element-plus'
import { dramaAPI } from '@/api/drama'
import { generationAPI } from '@/api/generation'
import { propAPI } from '@/api/props'
import { taskAPI } from '@/api/task'
import { useFilmStore } from '@/stores/film'
import { getDramaGenerationOptions } from '@/utils/canvasWorkflow'
import { createCanvasOperationGuard } from '@/utils/canvasEpisodeScope'
import { CANVAS_NODE_STATUS_LABELS } from '@/composables/useCanvasNodeStatus'

async function pollTask(taskId, scope, onTick, maxAttempts = 450, interval = 2000) {
  if (!taskId) return { status: 'completed' }
  for (let i = 0; i < maxAttempts; i++) {
    if (!scope.isActive()) return { status: 'cancelled' }
    await new Promise((r) => setTimeout(r, interval))
    if (!scope.isActive()) return { status: 'cancelled' }
    try {
      const t = await taskAPI.get(taskId)
      if (!scope.isActive()) return { status: 'cancelled' }
      if (t.status === 'completed') return { status: 'completed', result: t.result }
      if (t.status === 'failed') return { status: 'failed', error: t.error?.message || t.error || '任务失败' }
      await onTick?.()
    } catch (e) {
      if (i === maxAttempts - 1) return { status: 'failed', error: e.message || '轮询失败' }
    }
  }
  return { status: 'timeout', error: '任务超时' }
}

export function scriptNodeId(episodeId) {
  return `script:${episodeId}`
}

/** Shared per-episode drafts; no collection snapshots or local editor copies. */
export function useCanvasScript(deps) {
  const { drama, dramaId, filterEpisodeId, refreshCanvas, nodeStatus } = deps
  const film = useFilmStore()
  const scriptBusy = ref(false)
  const busyNodes = new Set()
  function clearBusy() {
    for (const id of busyNodes) nodeStatus?.clear(id)
    busyNodes.clear()
  }
  function setBusy(episodeId, payload) {
    const id = scriptNodeId(episodeId)
    busyNodes.add(id)
    nodeStatus?.set(id, payload)
  }
  const guard = createCanvasOperationGuard(() => ({
    dramaId: dramaId.value,
    episodeId: filterEpisodeId?.value ?? null,
  }))
  watch(() => [dramaId.value, filterEpisodeId?.value], () => {
    guard.invalidate()
    clearBusy()
    scriptBusy.value = false
  }, { flush: 'sync' })
  onScopeDispose(() => { guard.dispose(); clearBusy() })

  function episode(episodeId) {
    return drama.value?.episodes?.find((ep) => Number(ep.id) === Number(episodeId))
  }

  async function persistDraft(did, episodeId, scope) {
    const snapshot = film.snapshotEpisodeDraft(did, episodeId)
    if (!scope.isActive()) return null
    try {
      const saved = await dramaAPI.updateEpisode(did, episodeId, {
        title: snapshot.title,
        source_text: snapshot.sourceText,
        description: snapshot.description,
        script_content: snapshot.scriptContent,
        expected_revision: snapshot.baseRevision,
      })
      // Store acknowledgements belong to the submitted IDs, even when their editor has closed.
      film.markEpisodeDraftSaved(did, episodeId, saved, snapshot)
      if (scope.isActive()) await refreshCanvas(true)
      return saved
    } catch (error) {
      if (error.response?.status === 409 && scope.isActive()) await refreshCanvas(true)
      throw error
    }
  }

  async function saveScript(episodeId, fields = {}) {
    const did = dramaId.value
    const ep = episode(episodeId)
    if (!did || !ep || Number(drama.value?.id) !== Number(did)) throw new Error('缺少项目或集数')
    film.hydrateEpisodeDraft(did, ep)
    film.updateEpisodeDraft(did, episodeId, fields)
    const scope = guard.capture()
    scriptBusy.value = true
    setBusy(episodeId, { step: 'save_script', message: CANVAS_NODE_STATUS_LABELS.save_script })
    try {
      const saved = await persistDraft(did, episodeId, scope)
      if (scope.isActive()) ElMessage.success('剧本已保存')
      return saved
    } finally {
      if (scope.isActive()) {
        scriptBusy.value = false
        busyNodes.delete(scriptNodeId(episodeId))
        nodeStatus?.clear(scriptNodeId(episodeId))
      }
    }
  }

  async function runExtractTask(taskId, scope, label) {
    const polled = await pollTask(taskId, scope, () => scope.isActive() && refreshCanvas(true))
    if (!scope.isActive() || polled.status === 'cancelled') return false
    if (polled.status !== 'completed') throw new Error(polled.error || `${label}失败`)
    await refreshCanvas(true)
    return scope.isActive()
  }

  async function extractStep(kind, did, episodeId, scope) {
    if (!scope.isActive()) return false
    let res
    if (kind === 'characters') {
      res = await generationAPI.generateCharacters(did, {
        episode_id: episodeId,
        outline: film.getEpisodeDraft(did, episodeId).scriptContent.trim() || undefined,
      })
    } else if (kind === 'scenes') {
      res = await dramaAPI.extractBackgrounds(episodeId, {
        style: getDramaGenerationOptions(drama.value).style || undefined,
        language: 'zh',
      })
    } else {
      res = await propAPI.extractFromScript(episodeId)
    }
    if (!scope.isActive()) return false
    return runExtractTask(res?.task_id, scope, '提取素材')
  }

  async function extract(episodeId, kinds, scriptContent) {
    const did = dramaId.value
    const ep = episode(episodeId)
    if (!did || !ep || Number(drama.value?.id) !== Number(did)) throw new Error('请先选择集数')
    const draft = film.hydrateEpisodeDraft(did, ep)
    if (scriptContent !== undefined) film.updateEpisodeDraft(did, episodeId, { scriptContent })
    if (!draft.scriptContent.trim()) throw new Error('请先填写剧本内容')
    if (draft.remoteConflict) throw new Error('本集已有新版本，请先处理草稿冲突')
    const scope = guard.capture()
    scriptBusy.value = true
    let didWork = false
    const config = {
      characters: ['extract_chars', '提取角色'],
      scenes: ['extract_scenes', '提取场景'],
      props: ['extract_props', '提取道具'],
    }
    try {
      if (draft.dirty) {
        await persistDraft(did, episodeId, scope)
        if (!scope.isActive()) return
        if (film.getEpisodeDraft(did, episodeId).dirty) throw new Error('保存期间剧本有新修改，请先保存后再提取素材')
      }
      for (const kind of kinds) {
        if (!scope.isActive()) return
        // One-click extraction is based on this episode's associated assets only.
        if (kinds.length > 1 && (episode(episodeId)?.[kind] || []).length) continue
        const [step, message] = config[kind]
        setBusy(episodeId, { step, message })
        if (!await extractStep(kind, did, episodeId, scope)) return
        didWork = true
      }
      if (scope.isActive()) {
        if (!didWork) ElMessage.info('本集角色、场景、道具均已存在，无需重复提取')
        else {
          const latest = episode(episodeId)
          ElMessage.success(`提取完成：${(latest?.characters || []).length} 角色 · ${(latest?.scenes || []).length} 场景 · ${(latest?.props || []).length} 道具`)
        }
      }
    } finally {
      if (scope.isActive()) {
        scriptBusy.value = false
        busyNodes.delete(scriptNodeId(episodeId))
        nodeStatus?.clear(scriptNodeId(episodeId))
      }
    }
  }

  return {
    scriptBusy,
    saveScript,
    extractCharacters: (eid, text) => extract(eid, ['characters'], text),
    extractScenes: (eid) => extract(eid, ['scenes']),
    extractProps: (eid) => extract(eid, ['props']),
    extractAll: (eid, text) => extract(eid, ['characters', 'scenes', 'props'], text),
  }
}
