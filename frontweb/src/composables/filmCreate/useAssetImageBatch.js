import { computed, onScopeDispose, reactive, watch } from 'vue'

/** 为一个资源区批量生成图片；切集或离开页面后不再提交队列中的任务。 */
export function useAssetImageBatch({
  items, hasImage, isGenerating, generate, concurrency, scope,
  isBlocked = () => false, getOptions = () => ({}),
}) {
  let disposed = false
  const batch = reactive({
    running: false,
    stopping: false,
    current: 0,
    total: 0,
    succeeded: 0,
    skipped: 0,
    errors: [],
    contextKey: null,
    isCurrentScope: computed(() => batch.contextKey === scope.value),
    availableCount: computed(() => items.value.filter((item) => !isGenerating(item)).length),
    pendingCount: computed(() => items.value.filter((item) => !hasImage(item) && !isGenerating(item)).length),
    start,
    stop,
  })

  function stop() {
    if (batch.running) batch.stopping = true
  }

  watch(scope, stop, { flush: 'sync' })
  onScopeDispose(() => {
    disposed = true
    stop()
  })

  async function start({ regenerateExisting = false } = {}) {
    if (disposed || batch.running || isBlocked() || !scope.value) return null
    const scopeAtStart = scope.value
    const todo = items.value.filter((item) => (regenerateExisting || !hasImage(item)) && !isGenerating(item)).map((item) => item.id)
    if (!todo.length) return null
    const options = getOptions()
    Object.assign(batch, { contextKey: scopeAtStart, running: true, stopping: false, current: 0, total: todo.length, succeeded: 0, skipped: 0, errors: [] })
    let index = 0
    const limit = Math.max(1, Math.floor(Number(concurrency.value) || 1))

    async function worker() {
      while (index < todo.length && !batch.stopping && !disposed && scope.value === scopeAtStart) {
        const id = todo[index++]
        // 每次使用最新资源，跳过已删除、生成中的项目；补图模式也跳过已有图片的项目。
        const item = items.value.find((asset) => String(asset.id) === String(id))
        try {
          if (!item || (!regenerateExisting && hasImage(item)) || isGenerating(item)) {
            batch.skipped++
            continue
          }
          const result = await generate(item, options)
          if (result?.status === 'skipped') {
            batch.skipped++
          } else if (result?.status === 'completed') {
            batch.succeeded++
          } else {
            batch.errors.push(`${item.name || item.location || id}：${result?.error || '生成失败'}`)
          }
        } catch (error) {
          batch.errors.push(`${item?.name || item?.location || id}：${error?.message || '生成失败'}`)
        } finally {
          batch.current++
        }
      }
    }

    try {
      await Promise.all(Array.from({ length: Math.min(limit, todo.length) }, () => worker()))
      return {
        total: batch.total,
        succeeded: batch.succeeded,
        skipped: batch.skipped,
        failed: batch.errors.length,
        stopped: batch.stopping,
        scopeChanged: disposed || scope.value !== scopeAtStart,
      }
    } finally {
      batch.running = false
    }
  }

  return batch
}
