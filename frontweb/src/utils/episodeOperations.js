/** Explicit batch import only; the single-episode editor never calls this parser. */
export function prepareEpisodeImport(rows, { mode, episodes = [] }) {
  if (!['append', 'replace'].includes(mode)) throw new Error('请选择追加分集或替换全剧分集')
  if (!Array.isArray(rows) || !rows.length) throw new Error('没有可导入的分集')
  const start = mode === 'append'
    ? Math.max(0, ...episodes.map((ep) => Number(ep.episode_number) || 0)) + 1
    : 1
  return rows.map((row, index) => {
    const content = String(row.script_content ?? row.script ?? row.content ?? '')
    if (!content.trim()) throw new Error(`第 ${index + 1} 个导入项没有正文`)
    return {
      episode_number: start + index,
      title: String(row.title || `第${start + index}集`),
      description: row.description == null ? null : String(row.description),
      script_content: content,
      duration: Number(row.duration) || 0,
    }
  })
}

/** An epoch prevents an old callback from becoming active again after A -> B -> A. */
export function captureEpisodeScope(readScope) {
  const original = readScope()
  return () => {
    const current = readScope()
    return current.active !== false && current.dramaId === original.dramaId
      && current.episodeId === original.episodeId && current.epoch === original.epoch
  }
}
