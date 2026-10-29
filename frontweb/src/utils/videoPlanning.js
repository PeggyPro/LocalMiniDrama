export const planningStateLabels = {
  unplanned: '未规划（保留原流程）', draft: '草稿 · 不可执行', ready: '就绪',
  waiting_dependency: '等待来源', waiting: '等待来源', blocked: '受阻', stale: '已过期 · 需重新规划',
  preview: '待确认预览', running: '执行中', pending: '待执行', queued: '排队中',
  submitted: '已提交', submitted_unknown: '提交结果未知 · 请勿重复提交',
  completed: '已完成', failed: '失败', partial: '部分完成', cancelled: '已取消',
  preflighting: '检查运行条件', submitting: '提交中', processing: '生成中', materializing: '保存视频中', media_failed: '产物处理失败',
}
export const stateLabel = (value) => planningStateLabels[value] || value || '未知'
const blockingReasonLabels = {
  unknown_model: '模型不在当前目录中', unsupported_audio_input: '当前页面不支持该模型所需的音频输入',
  unsupported_video_input: '当前页面不支持该模型所需的视频输入', draft_not_executable: '分镜仍是草稿，最终保存后才能执行',
  recommendation_not_activated: '推荐尚未成为可执行选择', content_changed: '镜头内容已改变，请重新推荐或确认手动选择',
  source_content_changed: '来源镜头内容已改变，请重新选择来源修订', source_choice_revision_changed: '来源选择已更新，请重新选择精确修订',
  continuation_source_required: '续接模型需要精确前序来源', source_version_not_completed: '来源版本未完成',
  source_tail_mismatch: '来源尾段与版本不符', source_model_incompatible: '来源与当前续接模型不兼容',
  source_latent_unavailable: '来源没有可验证的续接 latent', source_requires_explicit_plan_binding: '等待本次有限计划中的前序节点',
  source_is_draft: '来源仍是草稿', source_choice_missing: '来源尚未设置视频方案', source_not_in_this_plan: '来源不在本计划内，不会自动生成',
  source_cross_drama: '来源不属于当前项目', dependency_cycle: '来源关系形成循环',
  continuation_prompt_contains_cuts: '提示词包含切镜要求，不能作为连续续接', continuation_intent_required: '未明确为连续镜头，不能推荐续接模型',
  frozen_choice_or_content_changed: '预览后选择或镜头内容已改变，请重新预览',
  submission_result_unknown_do_not_resubmit: '提交结果未知；请查看原计划状态，不要重复提交',
  known_task_query_failed_resume_available: '已知任务查询失败，可明确恢复查询',
  no_matching_video_config: '未找到支持该具体模型的本地视频连接',
  latent_missing: '未找到本次任务的 latent 文件，不能续接',
  latent_unresolved_configure_output_root: '尚未定位 latent；请按项目 docs/video-planning-guide.md 配置 ComfyUI 输出目录',
  latent_ambiguous: '找到多个候选 latent，无法确认唯一来源',
  latent_unsafe_path: 'latent 路径不符合任务来源要求', latent_unsafe_history_path: '任务历史中的 latent 路径不符合要求',
  latent_outside_task_root: 'latent 位于允许的任务目录之外', latent_missing_or_outside_root: 'latent 文件缺失或超出允许目录',
  latent_wrong_directory: 'latent 不在 ComfyUI output 目录',
  latent_missing_task_identity: 'latent 缺少精确任务或 prompt 标识', latent_missing_registered_node: '工作流未注册 latent 保存节点',
  latent_task_prefix_mismatch: 'latent 文件前缀与本次任务不一致', latent_history_provenance_mismatch: 'latent 历史记录与本次任务来源不一致',
  latent_not_verified: 'latent 尚未通过结构校验', latent_structure_unverified: 'latent 结构未验证',
  latent_workflow_mismatch: 'latent 与来源工作流不匹配', latent_provenance_mismatch: 'latent 的任务、连接或迭代来源不匹配',
  latent_verification_failed: 'latent 校验失败', latent_save_node_mismatch: '工作流中的 latent 保存节点与注册信息不一致',
  latent_iteration_mismatch: 'latent 迭代次数与续接链不一致', source_latent_dimensions_mismatch: '来源 latent 的尺寸或帧率与本次任务不匹配',
  latent_invalid_safetensors: 'latent 不是有效的 safetensors 文件或结构不完整',
  latent_invalid_response: '读取 latent 返回了无效内容', latent_truncated_response: 'latent 文件传输不完整',
  latent_changed_during_verification: 'latent 在校验期间改变，请重新确认来源',
  workflow_does_not_produce_latent: '该工作流不产生可续接的 latent',
}
export const reasonText = (reason) => {
  const value = typeof reason === 'string' ? reason : reason?.message || reason?.reason || reason?.code || JSON.stringify(reason)
  return blockingReasonLabels[value] || value
}
export const reasonTexts = (reasons) => (Array.isArray(reasons) ? reasons : reasons ? [reasons] : []).map(reasonText)
export const clonePlanningValue = (value) => value == null ? value : JSON.parse(JSON.stringify(value))
const videoFile = /\.(mp4|webm|mov|mkv|m4v|avi|m3u8)(?:[?#]|$)/i
const imageFile = /\.(png|jpe?g|gif|webp|bmp|svg|avif)(?:[?#]|$)/i
/** Only exact video/history records may supply a cache path; storyboard.local_path may be its image. */
export function videoRecordUrl(record) {
  const local = String(record?.local_path || '').trim().replace(/\\/g, '/')
  if (local && videoFile.test(local)) return local.startsWith('/static/') ? local : '/static/' + local.replace(/^\/+/, '')
  const url = String(record?.video_url || '').trim()
  if (imageFile.test(url)) return ''
  if (/^(https?:\/\/|\/static\/)/.test(url)) return url
  return videoFile.test(url) ? '/static/' + url.replace(/^\/+/, '') : ''
}

export function hasVideoPlanning(item) {
  return !!(item && (item.choice || item.recommendation || item.selected_version_id ||
    (item.validation?.state && item.validation.state !== 'unplanned')))
}

export function capabilityAvailable(capability) {
  // Registration is not GPU verification. Runtime validation remains independently required.
  return !!capability && ['available', 'ready', 'registered_unverified'].includes(capability.availability) &&
    capability.application_supported !== false && capability.input_supported !== false && !capability.blocking_reasons?.length
}

export function planningPresentation(item, capabilities = []) {
  const state = item?.validation?.state || 'unplanned'
  const model = capabilities.find((c) => c.model_id === item?.choice?.model_id)
  const reasons = reasonTexts(item?.validation?.blocking_reasons)
  if (item?.choice?.model_id && !capabilityAvailable(model)) {
    reasons.push(...reasonTexts(model?.blocking_reasons))
    reasons.push(`模型 ${item.choice.model_id} 当前不可用或尚未确认可用`)
    return { state: state === 'draft' ? 'draft' : 'blocked', label: stateLabel(state === 'draft' ? 'draft' : 'blocked'), ready: false, reasons: [...new Set(reasons)] }
  }
  return { state, label: stateLabel(state), ready: state === 'ready' && !!item?.choice?.model_id, reasons }
}

export function sourceKey(ref) {
  if (!ref) return ''
  if (ref.kind === 'version') return `version:${ref.version_id}:${ref.tail_segment_id || ''}`
  if (ref.kind === 'storyboard') return `storyboard:${ref.storyboard_id}:${ref.choice_revision}`
  return ''
}
export function sourceLabel(ref) {
  if (!ref) return '无前序来源'
  if (ref.kind === 'version') return `版本 ${ref.version_id}${ref.tail_segment_id ? ` · 尾段 ${ref.tail_segment_id}` : ''}`
  if (ref.kind === 'storyboard') return `规划镜头 #${ref.storyboard_id} · 选择修订 ${ref.choice_revision}`
  return '未解析来源'
}

export function sourceOptions(sources, storyboardId, targetModelId = null, capabilities = []) {
  const compatible = (modelId) => {
    if (!targetModelId) return true
    const source = capabilities.find((c) => c.model_id === modelId)
    const target = capabilities.find((c) => c.model_id === targetModelId)
    return !!(source?.produces_latent && target?.requires_latent && source.continuation_model === target.model_id && source.family === target.family)
  }
  const versions = (sources?.versions || []).map((v) => {
    const ref = { kind: 'version', version_id: v.id ?? v.version_id, ...(v.tail_segment_id ? { tail_segment_id: v.tail_segment_id } : {}) }
    const reasons = reasonTexts(v.blocking_reasons || v.reasons)
    const matching = compatible(v.model_id)
    if (!matching) reasons.push('与当前续接模型不兼容')
    const eligible = matching && (v.eligible === true || (v.eligible == null && v.continuable === true))
    return { key: sourceKey(ref), ref, disabled: !eligible, label: `${v.episode_number != null ? `第${v.episode_number}集` : `集 #${v.episode_id ?? '?'}`} · 镜头 #${v.storyboard_id} · ${sourceLabel(ref)}${eligible ? '' : `（不可用：${reasons.join('；') || '无可续接产物'}）`}` }
  })
  const boards = (sources?.storyboards || []).filter((s) => String(s.storyboard_id ?? s.id) !== String(storyboardId)).map((s) => {
    const ref = { kind: 'storyboard', storyboard_id: s.storyboard_id ?? s.id, choice_revision: s.choice_revision ?? s.choice?.revision }
    const reasons = reasonTexts(s.blocking_reasons || s.reasons)
    const matching = compatible(s.model_id ?? s.choice?.model_id)
    if (!matching) reasons.push('与当前续接模型不兼容')
    const eligible = matching && s.eligible === true && ref.choice_revision != null
    return { key: sourceKey(ref), ref, disabled: !eligible, label: `${s.episode_number != null ? `第${s.episode_number}集` : `集 #${s.episode_id ?? '?'}`} · ${sourceLabel(ref)}${eligible ? '（本计划外未完成时仅等待）' : `（不可用：${reasons.join('；') || '未验证来源'}）`}` }
  })
  return [...versions, ...boards]
}

export function makeChoiceBody({ expectedRevision, modelId, sourceRef, manualLocked }, capabilities) {
  const model = capabilities.find((c) => c.model_id === modelId)
  if (!model) throw new Error('请选择目录中的具体模型 ID')
  const preciseSource = sourceRef?.kind === 'version'
    ? typeof sourceRef.version_id === 'string' && !!sourceRef.version_id
    : sourceRef?.kind === 'storyboard' && Number.isSafeInteger(Number(sourceRef.storyboard_id)) && Number(sourceRef.storyboard_id) > 0 && Number.isSafeInteger(sourceRef.choice_revision) && sourceRef.choice_revision >= 0
  if (model.stage === 'continue' && !preciseSource) throw new Error('续接模型必须选择精确版本或带选择修订的规划镜头来源')
  return { expected_revision: expectedRevision ?? 0, model_id: modelId,
    source_ref: model.stage === 'continue' ? clonePlanningValue(sourceRef) : null, manual_locked: !!manualLocked }
}

// A snapshot, not a prompt generator. Preserve whitespace, reference order and all explicit options.
export function makePreviewBody({ episodeId, storyboards, inputs, configId, appendVersionId }) {
  const ids = [...new Set(storyboards.map((s) => s.id))]
  if (!ids.length) throw new Error('没有本次计划的目标镜头')
  if (appendVersionId && ids.length !== 1) throw new Error('同卡追加只允许一个目标镜头')
  const snapshot = {}
  for (const id of ids) {
    if (!inputs[id] || typeof inputs[id].prompt !== 'string') throw new Error(`镜头 #${id} 缺少本次提示词快照`)
    snapshot[id] = clonePlanningValue(inputs[id])
  }
  return { episode_id: episodeId, storyboard_ids: ids, inputs: snapshot,
    ...(configId != null ? { config_id: configId } : {}), ...(appendVersionId ? { append_version_id: appendVersionId } : {}) }
}

export const activePlan = (plan) => ['running', 'queued', 'submitted', 'pending'].includes(plan?.status)
// These are execution states, not the readiness of a recommended workflow.
export const activeExecution = (execution) => ['pending', 'queued', 'waiting', 'waiting_dependency', 'preflighting', 'submitting', 'submitted', 'processing', 'materializing', 'running'].includes(execution?.status)
export function executionLabel(execution) {
  if (execution?.blocking_reasons?.includes('known_task_query_failed_resume_available')) return '任务查询异常 · 请查看执行计划'
  if (execution?.status === 'completed') return '生成已完成 · 请在「版本 / 采用」中选片'
  if (execution?.status === 'materializing') return '正在保存视频'
  return stateLabel(execution?.status)
}
export function canRunPlan(plan) {
  return !!plan?.id && plan.status === 'preview' &&
    (plan.nodes || []).some((n) => n.status === 'ready' && !n.blocking_reasons?.length)
}
export function canResumePlan(plan) {
  // Resume only known submitted work; never turn an unknown submission into another run.
  return !!plan?.id && plan.status !== 'preview' && (plan.nodes || []).some((n) =>
    ['processing', 'media_failed', 'submitting'].includes(n.status) && n.attempt?.status !== 'submitted_unknown' &&
    (n.provider_task_id || n.task_id || n.attempt?.task_id || n.attempt?.prompt_id))
}
export function planningErrorMessage(error) {
  if (error?.response?.status === 409 || error?.status === 409) return '方案或采用版本已被其他操作修改。已重新加载服务器状态；你的编辑未提交，请核对后重新选择。'
  const reasons = reasonTexts(error?.response?.data?.error?.details?.blocking_reasons)
  return [reasonText(error?.message || '视频规划请求失败'), ...reasons].join('；')
}
