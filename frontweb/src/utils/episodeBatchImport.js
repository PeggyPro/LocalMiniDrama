// Batch saves return raw rows; keep hydrated production resources on existing episodes.
export function mergeImportedEpisodeRows(currentEpisodes, savedEpisodes) {
  const currentById = new Map(currentEpisodes.map((episode) => [episode.id, episode]))
  return savedEpisodes.map((episode) => ({ ...currentById.get(episode.id), ...episode }))
}

// Keep preview data intact until the caller's actual save promise succeeds.
export function createEpisodeImportSubmission({ submitImport, onPendingChange, onSuccess, onError }) {
  let pending = false
  let disposed = false

  return {
    async submit(previewEpisodes) {
      if (disposed || pending || !previewEpisodes.length) return false
      const episodes = previewEpisodes.map((episode) => ({
        episode_number: episode.episode_number,
        title: episode.title,
        script_content: episode.script_content,
        description: null,
        duration: 0,
      }))
      pending = true
      onPendingChange(true)
      try {
        await submitImport(episodes)
      } catch (error) {
        if (!disposed) onError(error)
        return false
      } finally {
        pending = false
        if (!disposed) onPendingChange(false)
      }
      if (!disposed) onSuccess(episodes.length)
      return true
    },
    dispose() {
      disposed = true
    },
  }
}
