import { ref, watch, onScopeDispose } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useFilmStore } from '@/stores/film'
import { createCanvasOperationGuard } from '@/utils/canvasEpisodeScope'
import { dramaAPI } from '@/api/drama'
import { storyboardsAPI } from '@/api/storyboards'
import { sceneAPI } from '@/api/scenes'
import { propAPI } from '@/api/props'

/** 合并 drama 级与本集已关联角色，避免 drama.characters 被布局保存截断后漏传 */
function collectExistingCharacters(dramaData, episodeId) {
  const map = new Map()
  for (const c of dramaData?.characters || []) {
    if (c?.id != null) map.set(Number(c.id), c)
  }
  if (episodeId != null) {
    const ep = (dramaData?.episodes || []).find((e) => Number(e.id) === Number(episodeId))
    for (const c of ep?.characters || []) {
      if (c?.id != null && !map.has(Number(c.id))) map.set(Number(c.id), c)
    }
  }
  return [...map.values()]
}

function toCharacterSavePayload(c) {
  return {
    id: c.id,
    name: c.name || '',
    role: c.role || undefined,
    description: c.description || undefined,
    personality: c.personality || undefined,
    appearance: c.appearance || undefined,
    image_url: c.image_url || undefined,
    local_path: c.local_path || undefined,
  }
}

/** 画布内新建实体（复用列表模式同款 API） */
export function useCanvasCrud(deps) {
  const {
    drama,
    filterEpisodeId,
    layoutCache,
    focusedNodeId,
    refreshCanvas,
    persistCanvasState,
  } = deps

  const createDialogVisible = ref(false)
  const createDialogType = ref('storyboard')
  /** 右键菜单创建时在画布上的坐标 { x, y } */
  const pendingFlowPosition = ref(null)
  const deletingEpisode = ref(false)
  const film = useFilmStore()
  const guard = createCanvasOperationGuard(() => ({
    dramaId: deps.dramaId?.value ?? drama.value?.id,
    episodeId: filterEpisodeId.value,
  }))
  watch(() => [deps.dramaId?.value ?? drama.value?.id, filterEpisodeId.value], () => {
    guard.invalidate()
    createDialogVisible.value = false
    pendingFlowPosition.value = null
    deletingEpisode.value = false
  }, { flush: 'sync' })
  onScopeDispose(() => guard.dispose())

  function resolveEpisodeId() {
    if (filterEpisodeId.value) return filterEpisodeId.value
    const eps = drama.value?.episodes || []
    if (eps.length === 1) return eps[0].id
    return null
  }

  function openCreateDialog(type, flowPosition = null) {
    if (['storyboard', 'character', 'scene', 'prop'].includes(type) && !resolveEpisodeId()) {
      ElMessage.warning('请先选择集数（或确保项目至少有一集）')
      return
    }
    createDialogType.value = type
    pendingFlowPosition.value = flowPosition
    createDialogVisible.value = true
  }

  async function saveNodePosition(nodeId, pos, scope) {
    if (!scope.isActive() || !pos || !nodeId) return
    const prev = layoutCache.value || { version: 1, nodes: {} }
    layoutCache.value = {
      ...prev,
      version: 1,
      nodes: {
        ...(prev.nodes || {}),
        [nodeId]: { x: pos.x, y: pos.y },
      },
    }
    await persistCanvasState({ layoutOnly: true })
  }

  async function focusAfterCreate(nodeId, scope) {
    if (!scope.isActive()) return
    await refreshCanvas()
    if (!scope.isActive()) return
    if (nodeId) focusedNodeId.value = nodeId
    pendingFlowPosition.value = null
  }

  async function createStoryboard(form) {
    const scope = guard.capture()
    const episodeId = resolveEpisodeId()
    if (!episodeId) throw new Error('请先选择集数')

    const boards = (drama.value?.episodes || [])
      .find((ep) => ep.id === episodeId)?.storyboards || []
    const maxNum = boards.reduce((max, sb) => Math.max(max, sb.storyboard_number || 0), 0)
    const nextNum = maxNum + 1
    const title = (form.title || '').trim() || `镜头 ${nextNum}`

    const sb = await storyboardsAPI.create({
      episode_id: episodeId,
      storyboard_number: nextNum,
      title,
      description: (form.description || '').trim() || '',
    })

    const nodeId = `sb:${sb.id}`
    if (!scope.isActive()) return
    const pos = pendingFlowPosition.value
    if (pos) await saveNodePosition(nodeId, pos, scope)
    await focusAfterCreate(nodeId, scope)
    if (!scope.isActive()) return
    ElMessage.success('分镜已添加')
    return sb
  }

  async function createEpisode(form) {
    const scope = guard.capture()
    const dramaId = drama.value?.id
    if (!dramaId || Number(dramaId) !== Number(scope.dramaId)) throw new Error('项目未加载')
    const list = drama.value.episodes || []
    const nextNum = Math.max(0, ...list.map((ep) => Number(ep.episode_number) || 0)) + 1
    const title = (form.title || '').trim() || `第${nextNum}集`
    if (!scope.isActive()) return
    const pos = pendingFlowPosition.value
    const newEp = await dramaAPI.createEpisode(dramaId, {
      title,
      description: form.description || '',
      script_content: '',
    })
    film.hydrateEpisodeDraft(dramaId, newEp)
    if (!scope.isActive()) return
    await refreshCanvas()
    if (!scope.isActive()) return
    if (pos) await saveNodePosition(`episode:${newEp.id}`, pos, scope)
    if (!scope.isActive()) return
    pendingFlowPosition.value = null
    createDialogVisible.value = false
    ElMessage.success(`已添加${title}`)
    filterEpisodeId.value = newEp.id
  }

  async function deleteEpisode() {
    const scope = guard.capture()
    const ep = drama.value?.episodes?.find((item) => Number(item.id) === Number(filterEpisodeId.value))
    if (!ep || !scope.dramaId || deletingEpisode.value) return
    const expectedRevision = ep.revision ?? 0
    try {
      await ElMessageBox.confirm(`确定删除「${ep.title || `第${ep.episode_number}集`}」及其分镜？`, '删除本集', { type: 'warning' })
      if (!scope.isActive()) return
      deletingEpisode.value = true
      await dramaAPI.deleteEpisode(scope.dramaId, ep.id, { expected_revision: expectedRevision })
      if (!scope.isActive()) return
      // Clear selection before refresh so the URL cannot keep pointing at a deleted episode.
      filterEpisodeId.value = null
      const afterDelete = guard.capture()
      await refreshCanvas(false)
      if (afterDelete.isActive()) ElMessage.success('本集已删除')
    } catch (error) {
      if (!scope.isActive()) return
      if (error.response?.status === 409) await refreshCanvas(true)
      if (scope.isActive() && error?.message) ElMessage.error(error.message)
    } finally {
      if (scope.isActive()) deletingEpisode.value = false
    }
  }

  async function createCharacter(form) {
    const scope = guard.capture()
    const dramaId = drama.value?.id
    const episodeId = resolveEpisodeId()
    if (!dramaId) throw new Error('项目未加载')

    const beforeIds = new Set((drama.value?.characters || []).map((c) => c.id))

    const existing = collectExistingCharacters(drama.value, episodeId).map(toCharacterSavePayload)

    const name = form.name.trim()
    await dramaAPI.saveCharacters(dramaId, {
      characters: [...existing, {
        name,
        role: form.role?.trim() || undefined,
        description: form.description?.trim() || undefined,
        appearance: form.appearance?.trim() || undefined,
      }],
      episode_id: episodeId ?? undefined,
    })

    if (!scope.isActive()) return
    await refreshCanvas()
    if (!scope.isActive()) return
    const newChar = (drama.value?.characters || []).find((c) => !beforeIds.has(c.id))
      || (drama.value?.characters || []).find((c) => c.name === name)
    const nodeId = newChar?.id ? `char:${newChar.id}` : null
    if (!scope.isActive()) return
    const pos = pendingFlowPosition.value
    if (nodeId && pos) await saveNodePosition(nodeId, pos, scope)
    await focusAfterCreate(nodeId, scope)
    if (!scope.isActive()) return
    ElMessage.success('角色已添加')
  }

  async function createScene(form) {
    const scope = guard.capture()
    const dramaId = drama.value?.id
    const episodeId = resolveEpisodeId()
    if (!dramaId) throw new Error('项目未加载')

    const scene = await sceneAPI.create({
      drama_id: dramaId,
      episode_id: episodeId ?? undefined,
      location: form.location.trim(),
      time: form.time?.trim() || undefined,
      prompt: form.prompt?.trim() || undefined,
    })

    const sceneId = scene?.id ?? scene?.scene?.id
    const nodeId = sceneId ? `scene:${sceneId}` : null
    if (!scope.isActive()) return
    const pos = pendingFlowPosition.value
    if (nodeId && pos) await saveNodePosition(nodeId, pos, scope)
    await focusAfterCreate(nodeId, scope)
    if (!scope.isActive()) return
    ElMessage.success('场景已添加')
  }

  async function createProp(form) {
    const scope = guard.capture()
    const dramaId = drama.value?.id
    const episodeId = resolveEpisodeId()
    if (!dramaId) throw new Error('项目未加载')

    const prop = await propAPI.create({
      drama_id: dramaId,
      episode_id: episodeId ?? undefined,
      name: form.name.trim(),
      description: form.description?.trim() || undefined,
      prompt: form.prompt?.trim() || undefined,
    })

    const propId = prop?.id ?? prop?.prop?.id
    const nodeId = propId ? `prop:${propId}` : null
    if (!scope.isActive()) return
    const pos = pendingFlowPosition.value
    if (nodeId && pos) await saveNodePosition(nodeId, pos, scope)
    await focusAfterCreate(nodeId, scope)
    if (!scope.isActive()) return
    ElMessage.success('道具已添加')
  }

  async function submitCreate(form) {
    const scope = guard.capture()
    const type = createDialogType.value
    if (type === 'storyboard') await createStoryboard(form)
    else if (type === 'episode') await createEpisode(form)
    else if (type === 'character') await createCharacter(form)
    else if (type === 'scene') await createScene(form)
    else if (type === 'prop') await createProp(form)
    if (scope.isActive()) createDialogVisible.value = false
  }

  return {
    createDialogVisible,
    createDialogType,
    pendingFlowPosition,
    openCreateDialog,
    submitCreate,
    deleteEpisode,
    deletingEpisode,
    resolveEpisodeId,
  }
}
