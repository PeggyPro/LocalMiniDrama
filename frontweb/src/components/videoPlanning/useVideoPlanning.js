import { reactive, watch, onBeforeUnmount } from 'vue'
import { createVideoPlanningController, newPlanningState } from '../../utils/videoPlanningController.js'
import { activePlan, planningErrorMessage } from '../../utils/videoPlanning.js'

export function useVideoPlanning({ api, episodeId, dramaId, notify, onAdopted }) {
  const state = reactive(newPlanningState())
  const controller = createVideoPlanningController(api, state)
  let timer = null
  let disposed = false
  function stopPoll() { clearTimeout(timer); timer = null }
  async function safe(action) {
    const eid = episodeId.value
    const did = dramaId.value
    try {
      const result = await action()
      if (eid === episodeId.value && did === dramaId.value && result) state.error = ''
      return result
    } catch (error) {
      if (!disposed && eid === episodeId.value && did === dramaId.value) {
        state.error = planningErrorMessage(error)
        notify(state.error)
      }
      return null
    }
  }
  function schedulePoll() {
    stopPoll()
    if (disposed || !state.dialogOpen || !activePlan(state.plan)) return
    timer = setTimeout(async () => {
      const result = await safe(() => controller.refreshPlan())
      if (result && !activePlan(result)) await safe(() => controller.load())
      if (result) schedulePoll() // Network failure stops automatic polling; user can retry GET.
    }, 2500)
  }
  watch([episodeId, dramaId], ([eid, did]) => {
    stopPoll()
    controller.setScope({ episodeId: eid, dramaId: did })
    if (eid && did) safe(() => controller.load())
  }, { immediate: true, flush: 'sync' })
  watch(() => [state.dialogOpen, state.plan?.id, state.plan?.status], schedulePoll)
  onBeforeUnmount(() => { disposed = true; stopPoll(); controller.setScope({}) })
  return {
    state, controller, safe,
    refresh: () => safe(() => controller.load()),
    recommend: () => safe(() => controller.recommend()),
    saveChoice: (id, body) => safe(() => controller.choice(id, body)),
    openPlan: (id) => safe(() => controller.openPlan(id)),
    refreshPlan: async () => {
      const result = await safe(() => controller.refreshPlan())
      if (result) { await safe(() => controller.load()); schedulePoll() }
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
