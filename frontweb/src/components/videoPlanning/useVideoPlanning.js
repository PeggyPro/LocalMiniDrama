import { reactive, watch, onScopeDispose } from 'vue'
import { createVideoPlanningController, newPlanningState } from '../../utils/videoPlanningController.js'
import { activePlan, activeExecution, planningErrorMessage } from '../../utils/videoPlanning.js'

export function useVideoPlanning({ api, episodeId, dramaId, notify, onAdopted }) {
  const state = reactive(newPlanningState())
  const controller = createVideoPlanningController(api, state)
  let timer = null
  let disposed = false
  let epoch = 0
  let pollingEpoch = -1
  const hasActiveExecution = () => Object.values(state.items).some((item) => activeExecution(item.last_execution))
  function stopPoll() { clearTimeout(timer); timer = null }
  async function safe(action) {
    const token = epoch
    try {
      const result = await action()
      if (!disposed && token === epoch && result) state.error = ''
      return result
    } catch (error) {
      if (!disposed && token === epoch) {
        state.error = planningErrorMessage(error)
        notify?.(state.error)
      }
      return null
    }
  }
  function schedulePoll() {
    stopPoll()
    if (disposed || !episodeId.value || !dramaId.value || pollingEpoch === epoch) return
    const token = epoch
    // Keep the storyboard area current even with the plan dialog closed. Idle reads
    // also discover submissions from another tab; they never run or resume a task.
    const delay = state.error ? 10000 : (hasActiveExecution() || (state.dialogOpen && activePlan(state.plan))) ? 2500 : 15000
    timer = setTimeout(async () => {
      if (disposed || token !== epoch) return
      if (state.loading || state.busy) { schedulePoll(); return }
      pollingEpoch = token
      try {
        if (!state.loaded) { await controller.load(); return }
        const completedVersions = new Set(Object.values(state.items).map((item) => item.last_execution?.version_id).filter(Boolean))
        await controller.refreshExecution()
        if (disposed || token !== epoch) return
        if (Object.values(state.items).some((item) => item.last_execution?.version_id && !completedVersions.has(item.last_execution.version_id))) {
          await controller.load() // Refresh exact version/source choices once a new output appears.
          if (disposed || token !== epoch) return
        }
        if (state.dialogOpen && state.plan?.id) await controller.refreshPlan()
        if (!disposed && token === epoch) state.error = ''
      } catch (error) {
        // Retain the last known execution; a failed GET is not a failed GPU job.
        if (!disposed && token === epoch) state.error = planningErrorMessage(error)
      } finally {
        if (pollingEpoch === token) pollingEpoch = -1
        if (!disposed && token === epoch) schedulePoll()
      }
    }, delay)
  }
  async function refresh() {
    const token = epoch
    const result = await safe(() => controller.load())
    if (!disposed && token === epoch) schedulePoll()
    return result
  }
  watch([episodeId, dramaId], ([eid, did]) => {
    epoch++
    stopPoll()
    controller.setScope({ episodeId: eid, dramaId: did })
    if (eid && did) refresh()
  }, { immediate: true, flush: 'sync' })
  watch(() => [state.dialogOpen, state.plan?.id, state.plan?.status, hasActiveExecution()], schedulePoll)
  onScopeDispose(() => { disposed = true; epoch++; stopPoll(); controller.setScope({}) })
  return {
    state, controller, safe, refresh,
    recommend: () => safe(() => controller.recommend()),
    saveChoice: (id, body) => safe(() => controller.choice(id, body)),
    openPlan: (id) => safe(() => controller.openPlan(id)),
    refreshPlan: async () => {
      const result = await safe(() => controller.refreshPlan())
      if (result) await refresh()
      return result
    },
    run: () => safe(() => controller.run()),
    resume: () => safe(() => controller.resume()),
    versions: (id) => safe(() => controller.versions(id)),
    adopt: async (id, versionId, revision) => {
      const result = await safe(() => controller.adopt(id, versionId, revision))
      if (result) await onAdopted?.(id)
      return result
    },
  }
}
