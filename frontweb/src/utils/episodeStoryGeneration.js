/** Runs one fixed episode request. Navigation only suppresses UI work, never retargets it. */
export async function generateEpisodeStory({
  dramaId, episodeId, expectedRevision, premise, sourceText, storyStyle, storyType,
  referencePrevious = false, dramaTitle = '', episodeNumber,
}, { submit, poll, isActive = () => true, onApplied, onCandidate }) {
  const did = Number(dramaId)
  const eid = Number(episodeId)
  const revision = Number(expectedRevision)
  const text = String(premise ?? '').trim()
  if (!Number.isSafeInteger(did) || did <= 0 || !Number.isSafeInteger(eid) || eid <= 0) {
    throw new Error('请先选择当前集')
  }
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('请刷新本集后再生成')
  if (!text && !String(sourceText ?? '').trim()) throw new Error('请先填写本集原文或改编要求')
  if (!isActive()) return { ok: false, scopeChanged: true }
  const response = await submit(did, eid, {
    premise: text, expected_revision: revision,
    reference_previous: !!referencePrevious,
    style: storyStyle || undefined, type: storyType || undefined,
  })
  if (!response?.task_id) throw new Error('未能启动本集剧本生成任务')
  const task = await poll(response.task_id, {
    dramaId: did, episodeId: eid, episodeNumber, dramaTitle,
    resourceId: eid, label: `${dramaTitle ? dramaTitle + ' · ' : ''}第${episodeNumber ?? ''}集 生成剧本`,
  })
  if (task?.status !== 'completed') {
    return { ok: false, dramaId: did, episodeId: eid, error: task?.error || '本集剧本生成失败' }
  }
  let result = task.result || {}
  if (typeof result === 'string') {
    try { result = JSON.parse(result) } catch { throw new Error('生成任务结果格式错误，请在任务中心查看') }
  }
  if ((result.episode_id != null && Number(result.episode_id) !== eid)
      || (result.drama_id != null && Number(result.drama_id) !== did)) {
    throw new Error('生成任务返回的目标集不匹配，请在任务中心查看')
  }
  if (!isActive()) return { ok: true, dramaId: did, episodeId: eid, result, scopeChanged: true }
  if (result.applied === false) {
    if (result.candidate && onCandidate) await onCandidate(result.candidate, result)
    return { ok: true, dramaId: did, episodeId: eid, conflict: true, result }
  }
  if (result.applied !== true) throw new Error('生成任务未确认保存，请在任务中心查看')
  if (onApplied) await onApplied(result)
  return { ok: true, dramaId: did, episodeId: eid, result }
}
