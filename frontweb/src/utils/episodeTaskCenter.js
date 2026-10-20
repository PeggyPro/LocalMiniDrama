// This reader owns display requests only. It never registers, reconciles or cancels generation tasks.
export function createEpisodeTaskReader({ load, onChange = () => {} }) {
  let revision = 0
  let controller = null
  let disposed = false
  let state = emptyState()

  function emptyState() {
    return {
      dramaId: null, episodeId: null, filter: 'all', page: 1,
      items: [], total: 0, filteredTotal: 0,
      stats: { active: 0, completed: 0, failed: 0 },
      loading: false, error: '', updatedAt: null,
    }
  }

  function publish(patch) {
    state = { ...state, ...patch }
    onChange(state)
  }

  function invalidate() {
    revision += 1
    controller?.abort()
    controller = null
  }

  async function refresh() {
    if (disposed || !state.episodeId || state.loading) return
    const requestRevision = revision
    const { dramaId, episodeId, page, filter } = state
    const requestController = new AbortController()
    controller = requestController
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      requestController.abort()
    }, 15000)
    publish({ loading: true })
    try {
      const data = await load(episodeId, { page, limit: 30, status: filter, signal: requestController.signal })
      if (disposed || requestRevision !== revision) return
      if (String(data.drama_id) !== String(dramaId) || String(data.episode_id) !== String(episodeId)) {
        throw new Error('任务列表的集数不匹配，请重新刷新')
      }
      const lastPage = Math.max(1, Math.ceil((Number(data.filtered_total) || 0) / 30))
      if (page > lastPage) {
        invalidate()
        publish({ page: lastPage, items: [], loading: false })
        return refresh()
      }
      publish({
        items: Array.isArray(data.items) ? data.items : [],
        total: Number(data.total) || 0,
        filteredTotal: Number(data.filtered_total) || 0,
        stats: data.stats || { active: 0, completed: 0, failed: 0 },
        error: '', updatedAt: Date.now(),
      })
    } catch (error) {
      if (disposed || requestRevision !== revision) return
      publish({ error: timedOut ? '任务列表加载超时，稍后将自动重试' : (error.message || '任务列表加载失败') })
    } finally {
      clearTimeout(timeout)
      if (!disposed && requestRevision === revision) {
        controller = null
        publish({ loading: false })
      }
    }
  }

  function setContext(dramaId, episodeId) {
    invalidate()
    publish({ ...emptyState(), dramaId, episodeId })
    return refresh()
  }

  function setFilter(filter) {
    if (filter === state.filter) return
    invalidate()
    publish({ filter, page: 1, items: [], filteredTotal: 0, loading: false, error: '' })
    return refresh()
  }

  function setPage(page) {
    if (page === state.page) return
    invalidate()
    publish({ page, items: [], loading: false, error: '' })
    return refresh()
  }

  function dispose() {
    disposed = true
    invalidate()
  }

  return { refresh, setContext, setFilter, setPage, dispose }
}

const ACTIVE_STATUSES = new Set(['pending', 'queued', 'running', 'processing', 'downloading'])

export function taskStatusGroup(status) {
  if (ACTIVE_STATUSES.has(status)) return 'active'
  if (status === 'completed') return 'completed'
  if (['failed', 'cancelled', 'blocked'].includes(status)) return 'failed'
  return 'unknown'
}

export function taskStatusLabel(status) {
  return {
    pending: '等待中', queued: '排队中', running: '生成中', processing: '生成中',
    downloading: '保存中', completed: '已完成', failed: '失败', cancelled: '已取消', blocked: '已阻挡',
  }[status] || status || '未知状态'
}

export function taskKind(task) {
  if (/merge|finaliz/.test(task.type)) return 'merge'
  if (task.source === 'video' || /video_generation|sb_video/.test(task.type)) return 'video'
  if (task.source === 'image' || /image/.test(task.type)) return 'image'
  return 'text'
}

export function taskProgress(task) {
  if (task.progress == null || task.progress === '') return null
  const progress = Number(task.progress)
  return Number.isFinite(progress) ? Math.max(0, Math.min(100, Math.round(progress))) : null
}

export function taskTimestamp(value) {
  if (!value) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  // SQLite CURRENT_TIMESTAMP is UTC but omits the timezone suffix.
  const timestamp = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value
  const result = Date.parse(timestamp)
  return Number.isFinite(result) ? result : null
}

export function taskElapsed(task, now = Date.now()) {
  const start = taskTimestamp(task.created_at)
  const end = taskStatusGroup(task.status) === 'active'
    ? now
    : taskTimestamp(task.finished_at || task.completed_at || task.updated_at)
  if (start == null || end == null || end < start) return ''
  const seconds = Math.floor((end - start) / 1000)
  if (seconds < 60) return `${seconds}秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}分${seconds % 60}秒`
  return `${Math.floor(minutes / 60)}小时${minutes % 60}分`
}
