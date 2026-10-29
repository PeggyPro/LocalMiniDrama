<template>
  <el-dialog :model-value="modelValue" title="有限视频计划 · 预览与执行" width="min(960px, 94vw)" @update:model-value="$emit('update:modelValue', $event)">
    <template v-if="plan">
      <p>计划 {{ plan.id }} · 修订 {{ plan.revision }} · <b>{{ stateLabel(plan.status) }}</b></p>
      <el-alert title="预览不会提交 GPU 任务。仅点击「运行计划」才提交本次冻结的目标；完成后仍需逐镜显式采用版本。" type="info" :closable="false" />
      <p class="plan-note">跨集或跨镜来源只提供续接状态，不自动生成前集、不拼入前集成片。同卡追加仅在明确选择「预览同卡追加」时包含指定旧版本成员。本计划固定当前已选参考图，不自动提取或替换上一镜尾帧；续接以精确来源为准。</p>
      <p v-if="plan.append_version_id" class="plan-note">本次显式追加到版本：{{ plan.append_version_id }}</p>
      <p v-if="error" class="plan-error" role="alert">{{ error }}</p>
      <p v-for="reason in reasonTexts(plan.blocking_reasons)" :key="reason" class="plan-error">{{ reason }}</p>
      <div class="plan-table-wrap">
        <table class="plan-table">
          <thead><tr><th>目标镜头 / 节点</th><th>实际模型 ID</th><th>精确来源</th><th>状态 / 原因</th></tr></thead>
          <tbody><tr v-for="node in plan.nodes || []" :key="node.id">
            <td>#{{ node.storyboard_id }}<br><small>{{ node.id }}</small></td>
            <td>{{ node.model_id }}<p class="plan-note">连接 #{{ node.connection?.config_id || '未配置' }}<br>{{ node.connection?.identity || '' }}</p></td><td>{{ sourceLabel(node.source_ref) }}<p v-if="node.append_version_id" class="plan-note">同卡追加：{{ node.append_version_id }}</p></td>
            <td>{{ stateLabel(node.status) }}<p v-for="reason in reasonTexts(node.blocking_reasons)" :key="reason" class="plan-error">{{ reason }}</p><p v-if="node.error || node.error_msg" class="plan-error">{{ node.error || node.error_msg }}</p></td>
          </tr></tbody>
        </table>
      </div>
      <el-collapse>
        <el-collapse-item v-for="node in plan.nodes || []" :key="node.id" :name="node.id" :title="`镜头 #${node.storyboard_id} · 查看冻结提示词与参考输入`">
          <pre class="plan-inputs">{{ JSON.stringify(node.inputs || node.input || inputs[node.storyboard_id] || {}, null, 2) }}</pre>
        </el-collapse-item>
      </el-collapse>
      <p v-if="!canRunPlan(plan) && !activePlan(plan)" class="plan-note">没有可直接运行的就绪节点时，请先处理阻塞 / 草稿 / 过期来源，再重新预览。失败和提交结果未知保留在本计划中，不自动重复提交。</p>
    </template>
    <template #footer>
      <el-button :disabled="busy" @click="$emit('refresh')">只刷新状态</el-button>
      <el-button v-if="canResumePlan(plan)" :disabled="busy" @click="$emit('resume')">恢复已知任务查询</el-button>
      <el-button type="primary" :loading="busy" :disabled="!canRunPlan(plan)" @click="$emit('run')">运行计划（提交 GPU）</el-button>
      <el-button @click="$emit('update:modelValue', false)">关闭</el-button>
    </template>
  </el-dialog>
</template>
<script setup>
import { activePlan, canRunPlan, canResumePlan, reasonTexts, sourceLabel, stateLabel } from '../../utils/videoPlanning.js'
defineProps({ modelValue: Boolean, plan: Object, busy: Boolean, error: String, inputs: { type: Object, default: () => ({}) } })
defineEmits(['update:modelValue', 'run', 'resume', 'refresh'])
</script>
<style scoped>
.plan-note { color: var(--el-text-color-secondary); line-height: 1.6; font-size: 13px; }
.plan-error { color: var(--el-color-danger); overflow-wrap: anywhere; }
.plan-table-wrap { overflow-x: auto; margin: 16px 0; }
.plan-table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 8px; border: 1px solid var(--el-border-color); vertical-align: top; overflow-wrap: anywhere; }
.plan-inputs { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px; overflow: auto; }
</style>
