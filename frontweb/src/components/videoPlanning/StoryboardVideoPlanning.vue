<template>
  <section class="video-planning-card" :aria-label="`镜头 ${storyboard.id} 视频方案`">
    <div class="planning-title">
      <strong>逐镜视频方案</strong>
      <el-tag size="small" :type="view.ready ? 'success' : view.state === 'blocked' ? 'danger' : 'info'">{{ view.ready ? '方案就绪' : view.label }}</el-tag>
      <el-tag v-if="item?.last_execution" size="small" :type="activeExecution(item.last_execution) ? 'warning' : item.last_execution.status === 'completed' ? 'success' : 'info'">执行：{{ stateLabel(item.last_execution.status) }}</el-tag>
      <el-tag v-if="item?.choice?.manual_locked" size="small" type="warning">手动锁定</el-tag>
    </div>
    <p v-if="!loaded" class="planning-warning">{{ error || '正在加载方案，暂不允许提交视频' }}</p>
    <template v-else>
      <p v-if="error" class="planning-warning" role="alert">{{ error }}</p>
      <p><b>推荐：</b>{{ item?.recommendation?.model_id || '暂无' }} <span v-if="recommendationOrigin">（{{ recommendationOrigin }}）</span></p>
      <p class="planning-detail">{{ item?.recommendation?.reason || '旧镜头不会自动补写推荐；可点击顶部「更新推荐」或手动选择。' }}</p>
      <p v-if="item?.recommendation" class="planning-detail">推荐来源：{{ sourceLabel(item.recommendation.source_ref) }}</p>
      <p><b>当前选择：</b>{{ item?.choice?.model_id || '未选工作流' }}</p>
      <p class="planning-detail">来源：{{ sourceLabel(item?.choice?.source_ref) }}</p>
      <p v-if="selectedModel?.runtime_verified === false" class="planning-detail">目录已注册，尚未经本机 GPU 实测；执行前仍需校验输入和来源。</p>
      <p v-for="reason in view.reasons" :key="reason" class="planning-warning">{{ reason }}</p>
      <p v-if="item?.last_execution" class="planning-detail">最近执行：{{ item.last_execution.model_id || '见计划节点' }} · {{ executionLabel(item.last_execution) }} <span v-if="item.last_execution.plan_id">· 计划 {{ item.last_execution.plan_id }}</span></p>
      <p class="planning-detail">当前采用版本：{{ item?.selected_version_id || '未采用规划版本（保留原选片）' }}</p>
      <p v-if="adoptedVersionMissing" class="planning-warning">当前采用版本尚未加载，主播放器不会切换到其他历史。请点击顶部「刷新方案」。</p>
      <div class="planning-actions">
        <el-button size="small" :disabled="busy || view.state === 'draft'" @click="startEdit">手动选择 / 锁定</el-button>
        <el-button size="small" :disabled="busy || view.state === 'draft' || item?.recommendation?.stale || !!item?.recommendation?.blocking_reasons?.length || !item?.recommendation?.model_id" @click="followRecommendation">明确跟随推荐</el-button>
        <el-button v-if="item?.choice?.manual_locked" size="small" :disabled="busy || view.state === 'draft'" @click="saveChoice(storyboard.id, { expected_revision: item.choice.revision, model_id: item.choice.model_id, source_ref: item.choice.source_ref, manual_locked: item.choice.manual_locked })">重新确认当前方案</el-button>
        <el-button size="small" :disabled="busy || !planned || view.state === 'draft'" @click="$emit('preview')">预览本镜计划</el-button>
        <el-button v-if="item?.last_execution?.plan_id" size="small" @click="$emit('open-plan', item.last_execution.plan_id)">查看执行计划</el-button>
        <el-button size="small" :disabled="busy" @click="showVersions">版本 / 采用</el-button>
      </div>
      <div v-if="editing" class="planning-editor">
        <p class="planning-detail">编辑基于选择修订 {{ expectedRevision }}；保存冲突时不自动重试、不覆盖他人选择。</p>
        <label>具体模型 ID</label>
        <el-select v-model="modelId" filterable placeholder="选择具体工作流模型" class="planning-select" @change="source = ''">
          <el-option v-for="model in capabilities" :key="model.model_id" :value="model.model_id" :label="`${model.label} · ${model.model_id}${capabilityAvailable(model) ? '' : '（不可用）'}`" :disabled="!capabilityAvailable(model)" />
        </el-select>
        <template v-if="editModel?.stage === 'continue'">
          <label>同剧精确来源（跨集只提供续接状态，不拼入前集视频）</label>
          <p class="planning-detail">候选来源仅通过任务归属和结构校验，仍需本机 GPU 加载验证。</p>
          <el-select v-model="source" filterable placeholder="选择具体版本或规划镜头修订" class="planning-select">
            <el-option v-for="option in options" :key="option.key" :label="option.label" :value="option.key" :disabled="option.disabled" />
          </el-select>
          <el-button size="small" link @click="$emit('refresh-sources')">刷新可用来源</el-button>
        </template>
        <p class="planning-detail">保存手动选择会锁定，更新推荐不覆盖此选择；点击「明确跟随推荐」可解除锁定。</p>
        <p v-if="editError" class="planning-warning" role="alert">{{ editError }}</p>
        <div class="planning-actions">
          <el-button size="small" type="primary" :disabled="busy || !modelId" @click="save">保存选择</el-button>
          <el-button size="small" @click="editing = false">取消编辑</el-button>
        </div>
      </div>
      <div v-if="versionsOpen" class="planning-versions">
        <p class="planning-detail">播放仅预览；点击「采用此版本」才替换本镜选片。生成新版本不自动采用。同卡追加需先手动选择续接模型，并将本版本设为精确来源。</p>
        <el-button size="small" :disabled="busy" @click="loadVersions(storyboard.id)">刷新版本与采用修订</el-button>
        <p v-if="!versions.length">暂无版本。</p>
        <article v-for="version in versions" :key="version.id" class="planning-version">
          <p><b>{{ version.id }}</b> · {{ version.model_id }} · {{ stateLabel(version.status) }}</p>
          <p class="planning-detail">尾段 {{ version.tail_segment_id || '无' }} · {{ version.continuable ? '续接来源结构校验通过' : '不可续接' }}</p>
          <p v-if="version.latent_loadability_verified !== true" class="planning-detail">latent 尚未经过本机 GPU 加载与张量语义验证；结构校验通过不代表实际续接已验证。</p>
          <p v-for="reason in reasonTexts(version.blocking_reasons || version.reasons)" :key="reason" class="planning-warning">{{ reason }}</p>
          <video v-if="versionUrl(version)" :src="versionUrl(version)" controls preload="none" />
          <div class="planning-actions">
            <el-button size="small" :type="item?.selected_version_id === version.id ? 'success' : 'primary'" :disabled="busy || version.status !== 'completed' || !versionUrl(version) || item?.selected_version_id === version.id" @click="adoptVersion(storyboard.id, version.id, adoptionRevision)">{{ item?.selected_version_id === version.id ? '当前已采用' : '采用此版本' }}</el-button>
            <el-button size="small" :disabled="busy || !version.continuable || !planned" @click="$emit('append', version.id)">预览同卡追加</el-button>
          </div>
        </article>
      </div>
    </template>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue'
import { capabilityAvailable, hasVideoPlanning, makeChoiceBody, planningPresentation, reasonTexts, sourceKey, sourceLabel, sourceOptions, stateLabel, videoRecordUrl, activeExecution, executionLabel } from '../../utils/videoPlanning.js'
const props = defineProps({
  storyboard: { type: Object, required: true }, item: Object, loaded: Boolean, busy: Boolean, error: String,
  capabilities: { type: Array, default: () => [] }, sources: { type: Object, default: () => ({}) },
  versions: { type: Array, default: () => [] }, adoptionRevision: { type: Number, default: 0 },
  saveChoice: { type: Function, required: true }, loadVersions: { type: Function, required: true }, adoptVersion: { type: Function, required: true },
})
defineEmits(['preview', 'append', 'open-plan', 'refresh-sources'])
const view = computed(() => planningPresentation(props.item, props.capabilities))
const planned = computed(() => hasVideoPlanning(props.item))
const adoptedVersionMissing = computed(() => props.item?.selected_version_id && ![...props.versions, ...(props.sources.versions || [])].some((v) => v.id === props.item.selected_version_id))
const selectedModel = computed(() => props.capabilities.find((c) => c.model_id === props.item?.choice?.model_id))
const recommendationOrigin = computed(() => {
  const origin = props.item?.recommendation?.origin || props.item?.recommendation?.method || props.item?.recommendation?.strategy
  return origin === 'ai' || origin === 'llm' ? 'AI 推荐' : origin ? `规则 / 回退：${origin}` : ''
})
const editing = ref(false)
const modelId = ref('')
const source = ref('')
const locked = ref(true)
const expectedRevision = ref(0)
const editError = ref('')
const versionsOpen = ref(false)
const editModel = computed(() => props.capabilities.find((c) => c.model_id === modelId.value))
const options = computed(() => sourceOptions(props.sources, props.storyboard.id, modelId.value || null, props.capabilities))
function startEdit() {
  modelId.value = props.item?.choice?.model_id || props.item?.recommendation?.model_id || ''
  source.value = sourceKey(props.item?.choice?.source_ref)
  expectedRevision.value = props.item?.choice?.revision ?? props.item?.choice_revision ?? 0
  locked.value = true
  editError.value = ''
  editing.value = true
}
async function save() {
  try {
    const sourceRef = options.value.find((o) => o.key === source.value && !o.disabled)?.ref || null
    const body = makeChoiceBody({ expectedRevision: expectedRevision.value, modelId: modelId.value, sourceRef, manualLocked: locked.value }, props.capabilities)
    const result = await props.saveChoice(props.storyboard.id, body)
    if (result) editing.value = false
    else editError.value = '未保存；请查看上方错误。编辑仍保留，取消后重新打开可基于最新修订编辑。'
  } catch (error) { editError.value = error.message }
}
async function followRecommendation() {
  try {
    const recommendation = props.item.recommendation
    const body = makeChoiceBody({ expectedRevision: props.item?.choice?.revision ?? props.item?.choice_revision ?? 0,
      modelId: recommendation.model_id, sourceRef: recommendation.source_ref || null, manualLocked: false }, props.capabilities)
    await props.saveChoice(props.storyboard.id, body)
  } catch (error) { editError.value = error.message; editing.value = true }
}
async function showVersions() {
  versionsOpen.value = !versionsOpen.value
  if (versionsOpen.value) await props.loadVersions(props.storyboard.id)
}
function versionUrl(version) {
  return videoRecordUrl(version)
}
</script>

<style scoped>
.video-planning-card { margin: 10px 0; padding: 12px; border: 1px solid var(--el-border-color); border-radius: 8px; background: var(--el-fill-color-light); font-size: 12px; overflow-wrap: anywhere; }
.planning-title, .planning-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
p { margin: 7px 0; line-height: 1.5; }
.planning-detail { color: var(--el-text-color-secondary); }
.planning-warning { color: var(--el-color-danger); }
.planning-editor, .planning-versions { margin-top: 10px; border-top: 1px solid var(--el-border-color); padding-top: 10px; }
.planning-select { width: 100%; margin: 6px 0; }
.planning-version { padding: 8px 0; border-bottom: 1px solid var(--el-border-color); }
.planning-version video { display: block; width: 100%; max-height: 220px; }
.planning-actions .el-button + .el-button { margin-left: 0; }
</style>
