const MINUTE = 60 * 1000

// 分镜可能先长时间推理，且截断后还会续写；页面等待和僵尸检测须覆盖整个任务。
function isStoryboardTask(task) {
  return task?.type === 'storyboard_generation' || task?.resourceType === 'generate_storyboard'
}

export function getTaskTimeouts(task) {
  return isStoryboardTask(task)
    ? { pollTimeoutMs: 60 * MINUTE, inactivityTimeoutMs: 60 * MINUTE, staleTimeoutMs: 60 * MINUTE }
    : { pollTimeoutMs: 15 * MINUTE, inactivityTimeoutMs: 10 * MINUTE, staleTimeoutMs: 30 * MINUTE }
}

export function getTaskPollOptions(task, options = {}) {
  const interval = options.interval ?? 2000
  const { pollTimeoutMs } = getTaskTimeouts(task)
  return {
    ...options,
    interval,
    maxAttempts: options.maxAttempts ?? Math.ceil(pollTimeoutMs / interval),
    timeoutMessage: options.timeoutMessage ?? (isStoryboardTask(task)
      ? '分镜任务已等待超过60分钟，请刷新页面查看是否已完成'
      : '生成任务已超时（超过15分钟），请刷新页面查看是否已完成'),
  }
}
