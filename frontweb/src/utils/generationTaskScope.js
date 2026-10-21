export const EPISODE_TASK_TYPES = [
  'video_merge',
  'prop_extraction',
  'background_extraction',
  'storyboard_generation',
  'character_extraction',
  'episode_story_generation',
]
export const PROJECT_TASK_TYPES = ['character_generation', 'story_generation']

// Resource IDs occupy separate numeric namespaces. Never infer a task kind from its ID.
export function tasksForResource(tasks, resourceId, types) {
  const allowed = new Set(types)
  return (Array.isArray(tasks) ? tasks : []).filter((task) =>
    String(task.resource_id) === String(resourceId) && allowed.has(task.type)
  )
}

export function taskScopeEpisodeId(taskType, episodeId) {
  return taskType === 'story_generation' ? 0 : episodeId
}

export function episodeStoryCandidate(task) {
  if (task?.type !== 'episode_story_generation' || task.status !== 'completed') return null
  try {
    const result = typeof task.result === 'string' ? JSON.parse(task.result) : task.result
    return result?.applied === false && result.candidate
      ? { candidate: result.candidate, taskId: task.id, result }
      : null
  } catch (_) {
    return null
  }
}

export function latestEpisodeStoryCandidate(tasks, episodeId) {
  const latest = tasksForResource(tasks, episodeId, ['episode_story_generation'])
    .slice().sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0]
  return episodeStoryCandidate(latest)
}
