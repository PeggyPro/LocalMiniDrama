export function parseEpisodeQuery(value) {
  const raw = Array.isArray(value) ? value[0] : value
  if (raw == null || !/^\d+$/.test(String(raw))) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export function resolveCanvasEpisodeId(value, episodes) {
  const id = parseEpisodeQuery(value)
  return id != null && (episodes || []).some((ep) => Number(ep.id) === id) ? id : null
}

/** A scope is permanently invalidated by navigation, even when navigating back to the same IDs. */
export function createCanvasOperationGuard(readContext) {
  let version = 0
  let disposed = false
  return {
    invalidate() { version++ },
    dispose() { disposed = true; version++ },
    capture() {
      const capturedVersion = version
      const context = { ...readContext() }
      return {
        ...context,
        isActive: () => {
          const current = readContext()
          return !disposed && capturedVersion === version
            && String(context.dramaId) === String(current.dramaId)
            && String(context.episodeId) === String(current.episodeId)
        },
      }
    },
  }
}
