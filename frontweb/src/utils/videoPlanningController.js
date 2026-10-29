import { canRunPlan, clonePlanningValue, hasVideoPlanning, makePreviewBody } from './videoPlanning.js'

export function newPlanningState() {
  return { items: {}, capabilities: [], sources: { storyboards: [], versions: [] }, loaded: false,
    loading: false, busy: false, error: '', plan: null, previewInputs: {}, versions: {}, versionsRevision: {}, dialogOpen: false }
}

/** No timers, no automatic mutations: callers explicitly request recommendation/preview/run/adoption. */
export function createVideoPlanningController(api, state = newPlanningState()) {
  let epoch = 0
  let loadSerial = 0
  let episodeReadSerial = 0
  let pendingLoad = null
  let scope = { episodeId: null, dramaId: null }
  const same = (token) => token === epoch
  const mergeItem = (dto) => {
    if (dto?.storyboard_id != null) state.items = { ...state.items, [dto.storyboard_id]: dto }
  }
  const applyEpisode = (dto) => { state.items = Object.fromEntries((dto?.items || []).map((item) => [item.storyboard_id, item])) }
  // A successful run response must become visible before the first background GET.
  function applySubmittedPlan(plan) {
    if (!plan || plan.status === 'preview') return
    episodeReadSerial++
    const items = { ...state.items }
    for (const node of plan.nodes || []) {
      const item = items[node.storyboard_id]
      if (!item) continue
      items[node.storyboard_id] = { ...item, last_execution: {
        plan_id: plan.id, node_id: node.id, model_id: node.model_id, status: node.status,
        version_id: node.version_id, blocking_reasons: node.blocking_reasons || [], updated_at: node.updated_at,
      } }
    }
    state.items = items
  }
  async function refreshExecution() {
    if (!scope.episodeId) return false
    const token = epoch
    const serial = ++episodeReadSerial
    const episode = await api.episode(scope.episodeId)
    if (!same(token) || serial !== episodeReadSerial) return false
    applyEpisode(episode)
    return true
  }
  function setScope(next) {
    epoch++
    scope = { ...next }
    pendingLoad = null
    Object.assign(state, newPlanningState())
  }
  function load() {
    if (pendingLoad) return pendingLoad
    const promise = loadOnce()
    pendingLoad = promise
    promise.finally(() => { if (pendingLoad === promise) pendingLoad = null }).catch(() => {})
    return promise
  }
  async function reload() { pendingLoad = null; return load() }
  async function loadOnce() {
    if (!scope.episodeId) return false
    const token = epoch
    const serial = ++loadSerial
    const readSerial = ++episodeReadSerial
    state.loading = true
    try {
      const [episode, catalog, sources] = await Promise.all([
        api.episode(scope.episodeId), api.capabilities(), api.sources(scope.dramaId),
      ])
      if (!same(token) || serial !== loadSerial) return false
      if (readSerial === episodeReadSerial) applyEpisode(episode)
      state.capabilities = catalog?.items || []
      state.sources = sources || { storyboards: [], versions: [] }
      state.loaded = true
      state.error = ''
      return true
    } catch (error) {
      if (same(token) && serial === loadSerial) { state.loaded = false; state.error = error.message || '加载规划失败' }
      throw error
    } finally {
      if (same(token) && serial === loadSerial) state.loading = false
    }
  }
  async function mutate(action) {
    if (state.busy) throw new Error('另一个规划操作尚未结束')
    const token = epoch
    state.busy = true
    try {
      const result = await action()
      return same(token) ? result : null
    } catch (error) {
      if (same(token) && (error?.response?.status === 409 || error?.status === 409)) {
        try { await reload() } catch { /* keep original conflict */ }
      }
      throw error
    } finally { if (same(token)) state.busy = false }
  }
  async function recommend() {
    const token = epoch
    return mutate(async () => {
      const dto = await api.recommend(scope.episodeId)
      if (same(token)) { applyEpisode(dto); await reload() }
      return dto
    })
  }
  async function choice(id, body) {
    const token = epoch
    return mutate(async () => {
      const dto = await api.choice(id, clonePlanningValue(body))
      if (same(token)) { mergeItem(dto); await reload() }
      return dto
    })
  }
  async function preview(storyboards, inputs, options = {}) {
    const token = epoch
    const targetIds = new Set(storyboards.map((sb) => String(sb.id)))
    const unknown = storyboards.some((sb) => state.items[sb.id]?.last_execution?.status === 'submitted_unknown') ||
      (state.plan?.status === 'submitted_unknown' && (state.plan.nodes || []).some((node) => targetIds.has(String(node.storyboard_id))))
    if (unknown) throw new Error('该镜头有提交结果未知的任务，请查看原计划并刷新状态，不能重新预览重提')
    return mutate(async () => {
      const body = makePreviewBody({ episodeId: scope.episodeId, storyboards, inputs, ...options })
      const plan = await api.preview(body)
      if (same(token)) { state.plan = plan; state.previewInputs = body.inputs; state.dialogOpen = true }
      return plan
    })
  }
  async function openPlan(id) {
    const token = epoch
    const plan = await api.plan(id)
    if (same(token)) { state.plan = plan; state.previewInputs = plan.inputs || {}; state.dialogOpen = true }
    return plan
  }
  async function refreshPlan() {
    const token = epoch
    const id = state.plan?.id
    if (!id) return null
    const plan = await api.plan(id)
    if (same(token) && state.plan?.id === id) state.plan = plan
    return plan
  }
  async function run() {
    const token = epoch
    const plan = state.plan
    if (!canRunPlan(plan)) throw new Error('请先预览包含就绪节点的有限计划')
    return mutate(async () => {
      try {
        const dto = await api.run(plan.id, plan.revision)
        if (same(token) && state.plan?.id === plan.id) { state.plan = dto; applySubmittedPlan(dto) }
        return dto
      } catch (error) {
        // A lost response is not proof that submission failed. Read status before permitting another run.
        if (same(token) && state.plan?.id === plan.id) {
          try { const recovered = await refreshPlan(); if (same(token)) applySubmittedPlan(recovered) } catch {
            if (same(token) && state.plan?.id === plan.id) {
              state.plan = { ...plan, status: 'submitted_unknown', nodes: (plan.nodes || []).map((node) => ({ ...node, status: 'submitted_unknown' })) }
              applySubmittedPlan(state.plan)
            }
          }
        }
        throw error
      }
    })
  }
  async function resume() {
    const token = epoch
    const id = state.plan?.id
    if (!id) throw new Error('没有可恢复的计划')
    return mutate(async () => {
      const dto = await api.resume(id)
      if (same(token) && state.plan?.id === id) { state.plan = dto; applySubmittedPlan(dto) }
      return dto
    })
  }
  async function versions(id) {
    const token = epoch
    const dto = await api.versions(id)
    if (same(token)) {
      state.versions = { ...state.versions, [id]: dto?.items || [] }
      // Capture the revision when the list is displayed, not at the later click.
      state.versionsRevision = { ...state.versionsRevision, [id]: state.items[id]?.adoption_revision ?? 0 }
    }
    return dto
  }
  async function adopt(id, versionId, expectedRevision) {
    const token = epoch
    return mutate(async () => {
      const dto = await api.adopt(id, { expected_revision: expectedRevision, version_id: versionId })
      if (same(token)) {
        mergeItem(dto)
        await reload()
        if (same(token)) await versions(id)
      }
      return dto
    })
  }
  async function guardLegacy(id) {
    if (!await load()) throw new Error('分集已切换，请重新操作')
    if (!state.items[id]) throw new Error('当前分集不包含该镜头，请重新操作')
    if (hasVideoPlanning(state.items[id])) throw new Error('该镜头已有视频方案，请使用计划预览并点击「运行计划」')
  }
  return { state, setScope, load, refreshExecution, recommend, choice, preview, openPlan, refreshPlan, run, resume, versions, adopt, guardLegacy }
}
