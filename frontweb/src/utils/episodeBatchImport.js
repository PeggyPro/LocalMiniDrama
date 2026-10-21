// Batch saves return raw rows; keep hydrated production resources on existing episodes.
export function mergeImportedEpisodeRows(currentEpisodes, savedEpisodes) {
  const currentById = new Map(currentEpisodes.map((episode) => [episode.id, episode]))
  return savedEpisodes.map((episode) => ({ ...currentById.get(episode.id), ...episode }))
}

// Legacy chapter parsers use script_content internally. Map that text only when
// the user confirms its kind; already explicit source/instruction fields survive.
export function prepareEpisodeBatchImportRows(previewEpisodes, importKind = 'source') {
  if (!['source', 'script'].includes(importKind)) throw new Error('请选择本集原文或已有剧本')
  return previewEpisodes.map((episode) => {
    const row = { episode_number: episode.episode_number, title: episode.title }
    for (const field of ['source_text', 'description', 'duration']) {
      if (Object.hasOwn(episode, field) && episode[field] !== undefined) row[field] = episode[field]
    }
    if (Object.hasOwn(episode, 'script_content') && episode.script_content !== undefined) {
      const field = importKind === 'script' || Object.hasOwn(row, 'source_text') ? 'script_content' : 'source_text'
      row[field] = episode.script_content
    }
    return row
  })
}

// Keep preview data intact until the caller's actual save promise succeeds.
export function createEpisodeImportSubmission({ submitImport, onPendingChange, onSuccess, onError }) {
  let pending = false
  let disposed = false

  return {
    async submit(previewEpisodes, importKind = 'source') {
      if (disposed || pending || !previewEpisodes.length) return false
      let episodes
      pending = true
      onPendingChange(true)
      try {
        episodes = prepareEpisodeBatchImportRows(previewEpisodes, importKind)
        await submitImport(episodes, { importKind })
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
