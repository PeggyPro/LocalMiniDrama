// Separate GET client: task-center polling failures stay inside the drawer and do not
// trigger the generation request client's global toast or affect its polling lifecycle.
export async function listEpisodeTasks(episodeId, { page = 1, limit = 30, status = 'all', signal } = {}) {
  const query = new URLSearchParams({ page: String(page), limit: String(limit), status })
  const response = await fetch(`/api/v1/tasks/episode/${encodeURIComponent(episodeId)}?${query}`, {
    method: 'GET', cache: 'no-store', signal,
  })
  const body = await response.json()
  if (!response.ok || body.success === false) {
    throw new Error(body.error?.message || '任务列表加载失败')
  }
  return body.data
}
