import { ref, watch, onScopeDispose } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { dramaAPI } from '@/api/drama'
import { storyboardsAPI } from '@/api/storyboards'
import { taskAPI } from '@/api/task'
import { useFilmStore } from '@/stores/film'
import { parseDramaMetadata } from '@/utils/canvasLayout'
import { getDramaGenerationOptions } from '@/utils/canvasWorkflow'
import { createCanvasOperationGuard } from '@/utils/canvasEpisodeScope'
import { runImageStep, runVideoStep } from '@/composables/useCanvasWorkflowRunner'
import { hasStoryboardImage, hasStoryboardVideo } from '@/utils/storyboardMedia'
import { CANVAS_NODE_STATUS_LABELS } from '@/composables/useCanvasNodeStatus'
import { getTaskPollOptions } from '@/utils/generationTaskTimeouts'

/** Canvas jobs retain their submitted IDs and stop observing/submitting after navigation. */
export function useCanvasEpisodeGenerate(deps) {
  const { drama, filterEpisodeId, imagesBySbId, videosBySbId, refreshCanvas, nodeStatus } = deps
  const film = useFilmStore()
  const episodeGenerating = ref(false)
  const episodeGenProgress = ref('')
  const guard = createCanvasOperationGuard(() => ({
    dramaId: deps.dramaId?.value ?? drama.value?.id,
    episodeId: filterEpisodeId.value,
  }))
  const waits = new Map()
  const busyNodes = new Set()

  function clearBusy() {
    for (const id of busyNodes) nodeStatus?.clear(id)
    busyNodes.clear()
  }
  function stopWaiting() {
    for (const [timer, resolve] of waits) { clearTimeout(timer); resolve() }
    waits.clear()
  }
  watch(() => [deps.dramaId?.value ?? drama.value?.id, filterEpisodeId.value], () => {
    guard.invalidate()
    stopWaiting()
    clearBusy()
    episodeGenerating.value = false
    episodeGenProgress.value = ''
  }, { flush: 'sync' })
  onScopeDispose(() => { guard.dispose(); stopWaiting(); clearBusy() })

  function getEpisode() {
    return drama.value?.episodes?.find((ep) => Number(ep.id) === Number(filterEpisodeId.value)) || null
  }
  function setSbBusy(sb, step, message) {
    const ids = [`sb:${sb.id}`]
    if (step === 'image') ids.push(`sbimg:${sb.id}`)
    if (step === 'video') ids.push(`sbvid:${sb.id}`)
    for (const id of ids) { busyNodes.add(id); nodeStatus?.set(id, { step, message }) }
  }
  function clearSbBusy(sb) {
    for (const id of [`sb:${sb.id}`, `sbimg:${sb.id}`, `sbvid:${sb.id}`]) {
      busyNodes.delete(id)
      nodeStatus?.clear(id)
    }
  }
  function wait() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { waits.delete(timer); resolve() }, 2000)
      waits.set(timer, resolve)
    })
  }
  async function pollTask(taskId, scope) {
    if (!taskId) return { status: 'completed' }
    const { maxAttempts, timeoutMessage } = getTaskPollOptions({ type: 'storyboard_generation' })
    for (let i = 0; i < maxAttempts; i++) {
      if (!scope.isActive()) return null
      await wait()
      if (!scope.isActive()) return null
      let task
      try {
        task = await taskAPI.get(taskId)
      } catch (error) {
        if (i === maxAttempts - 1) throw error
        continue
      }
      if (!scope.isActive()) return null
      if (task.status === 'completed') return task
      if (task.status === 'failed') throw new Error(task.error?.message || task.error || '任务失败')
      await refreshCanvas(true)
    }
    throw new Error(timeoutMessage)
  }
  function storyboardOptions(ep) {
    const meta = parseDramaMetadata(drama.value?.metadata)
    const gen = getDramaGenerationOptions(drama.value)
    const scriptLen = (ep?.script_content || '').trim().length
    return {
      style: gen.style || undefined,
      aspect_ratio: gen.aspectRatio,
      video_duration: meta.video_clip_duration ? Number(meta.video_clip_duration)
        : scriptLen > 0 ? Math.max(10, Math.round(10 + (scriptLen / 600) * 60)) : undefined,
      include_narration: !!meta.storyboard_include_narration,
      universal_omni_storyboard: !!meta.storyboard_universal_omni,
    }
  }

  async function aiGenerateStoryboards() {
    const scope = guard.capture()
    let ep = getEpisode()
    if (!ep || !scope.dramaId) return ElMessage.warning('请先在顶栏选择某一集')
    const draft = film.getEpisodeDraft(scope.dramaId, ep)
    if (!draft.scriptContent.trim()) return ElMessage.warning('该集暂无剧本，请先编写或导入剧本')
    if (draft.remoteConflict) return ElMessage.warning('请先处理本集草稿的版本冲突')
    const existing = ep.storyboards || []
    if (existing.length) {
      try {
        await ElMessageBox.confirm(`第 ${ep.episode_number || ''} 集已有 ${existing.length} 个分镜。重新生成可能追加或覆盖内容，是否继续？`, 'AI 生成分镜', { type: 'warning', confirmButtonText: '继续生成' })
      } catch { return }
    }
    if (!scope.isActive()) return
    episodeGenerating.value = true
    episodeGenProgress.value = '准备本集剧本…'
    try {
      if (draft.dirty) {
        await deps.saveScript(ep.id)
        if (!scope.isActive()) return
        if (film.getEpisodeDraft(scope.dramaId, ep.id).dirty) throw new Error('保存期间剧本有新修改，请先保存后再生成分镜')
        ep = getEpisode()
      }
      if (!scope.isActive()) return
      episodeGenProgress.value = 'AI 正在根据剧本解析分镜…'
      for (const sb of existing) setSbBusy(sb, 'generate_sb', CANVAS_NODE_STATUS_LABELS.generate_sb)
      const res = await dramaAPI.generateStoryboard(ep.id, storyboardOptions(ep))
      if (!scope.isActive()) return
      const task = await pollTask(res?.task_id ?? (typeof res === 'string' ? res : null), scope)
      if (!scope.isActive() || !task) return
      if (task.result?.truncated) ElMessage.warning('AI 输出可能被截断，请检查分镜数量是否完整')
      await refreshCanvas(true)
      if (!scope.isActive()) return
      await storyboardsAPI.batchInferParams(ep.id, false).catch(() => {})
      if (scope.isActive()) ElMessage.success(`分镜生成完成，共 ${(getEpisode()?.storyboards || []).length} 镜`)
    } catch (error) {
      if (scope.isActive()) ElMessage.error(error?.message || 'AI 生成分镜失败')
    } finally {
      if (scope.isActive()) {
        clearBusy()
        episodeGenerating.value = false
        episodeGenProgress.value = ''
      }
    }
  }

  async function batchGenerate(kind) {
    const scope = guard.capture()
    const ep = getEpisode()
    if (!ep) return ElMessage.warning('请先选择集数')
    const data = drama.value
    const options = { ...getDramaGenerationOptions(data), imagesBySbId: imagesBySbId.value }
    const isImage = kind === 'image'
    const label = isImage ? '生图' : '生视频'
    const todo = (ep.storyboards || []).filter((sb) => isImage
      ? sb.creation_mode !== 'universal' && !hasStoryboardImage(sb, imagesBySbId.value, data)
      : !hasStoryboardVideo(sb, videosBySbId.value))
    if (!todo.length) return ElMessage.info(isImage ? '当前集分镜均已有图片（全能模式分镜请直接生视频）' : '当前集分镜均已有视频')
    try {
      await ElMessageBox.confirm(`将为 ${todo.length} 个分镜依次${label}，耗时可能较长，是否继续？`, `批量${label}`, { type: 'info', confirmButtonText: '开始' })
    } catch { return }
    if (!scope.isActive()) return
    episodeGenerating.value = true
    let ok = 0
    let failed = 0
    try {
      for (let i = 0; i < todo.length; i++) {
        if (!scope.isActive()) return
        const sb = todo[i]
        episodeGenProgress.value = `批量${label} ${i + 1}/${todo.length}：分镜 #${sb.storyboard_number ?? sb.id}`
        setSbBusy(sb, kind, `${CANVAS_NODE_STATUS_LABELS[kind]} ${i + 1}/${todo.length}`)
        try {
          await (isImage ? runImageStep : runVideoStep)(data, sb, options)
          if (!scope.isActive()) return
          ok++
          await refreshCanvas(true)
        } catch (error) {
          if (!scope.isActive()) return
          failed++
          ElMessage.error(`分镜 #${sb.storyboard_number ?? sb.id} ${label}失败：${error?.message || error}`)
        } finally {
          if (scope.isActive()) clearSbBusy(sb)
        }
      }
      if (!scope.isActive()) return
      if (!failed) ElMessage.success(`批量${label}完成，共 ${ok} 镜`)
      else ElMessage.warning(`完成 ${ok} 镜，失败 ${failed} 镜`)
    } finally {
      if (scope.isActive()) {
        episodeGenerating.value = false
        episodeGenProgress.value = ''
      }
    }
  }

  return {
    episodeGenerating,
    episodeGenProgress,
    aiGenerateStoryboards,
    batchGenerateImages: () => batchGenerate('image'),
    batchGenerateVideos: () => batchGenerate('video'),
  }
}
