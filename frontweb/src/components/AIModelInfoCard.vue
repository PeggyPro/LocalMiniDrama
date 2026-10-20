<template>
  <el-tooltip :content="tooltip" placement="top" :show-after="250">
    <button
      type="button"
      :class="['ai-model-info-card', 'ai-service-type', info?.configured ? 'type-' + info.service_type : '']"
      :disabled="loading"
      :aria-busy="loading"
      :aria-label="tooltip"
      @click.stop="onClick"
    >
      <el-icon :class="{ 'model-info-loading': loading }"><Loading v-if="loading" /><component :is="modelIcon" v-else /></el-icon>
      <span v-if="usage" class="model-info-usage">{{ usage }}</span>
      <template v-if="loading">
        <span>读取模型…</span>
      </template>
      <template v-else-if="error">
        <span>模型信息暂不可用</span>
        <span class="model-info-hint">点击重试</span>
      </template>
      <template v-else-if="info?.configured">
        <span class="model-info-name">{{ info.config_name || info.provider }}</span>
        <span class="model-info-divider" aria-hidden="true">·</span>
        <span class="model-info-model">{{ info.model }}</span>
        <span v-if="info.service_type === 'text'" class="model-info-reasoning">{{ reasoningLabel }}</span>
      </template>
      <template v-else>
        <span>未配置{{ typeLabel }}模型</span>
        <span class="model-info-hint">点击配置</span>
      </template>
    </button>
  </el-tooltip>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ChatDotRound, Film, Loading, Picture, VideoCamera } from '@element-plus/icons-vue'
import { aiAPI } from '@/api/ai'

const props = defineProps({
  sceneKey: { type: String, default: '' },
  serviceType: { type: String, default: 'text' },
  usage: { type: String, default: '' },
  refreshKey: { type: Number, default: 0 },
})
const emit = defineEmits(['open-config'])
const info = ref(null)
const loading = ref(false)
const error = ref(false)
let requestId = 0

const typeLabels = { text: '文本', image: '图片', storyboard_image: '分镜图片', video: '视频' }
const typeLabel = computed(() => typeLabels[props.serviceType] || props.serviceType)
const modelIcon = computed(() => ({ image: Picture, storyboard_image: Film, video: VideoCamera }[props.serviceType] || ChatDotRound))
const reasoningLabel = computed(() => {
  if (info.value?.thinking === 'disabled') return '思考已关闭'
  return info.value?.reasoning_effort ? '推理 ' + info.value.reasoning_effort : '推理：模型默认'
})
const tooltip = computed(() => {
  if (loading.value) return '正在读取当前生成使用的 AI 配置'
  if (error.value) return '读取模型信息失败，点击重试'
  if (!info.value?.configured) return `尚未配置可用的${typeLabel.value}模型，点击打开 AI 配置`
  const source = info.value.source === 'scene' ? '业务场景配置' : '默认' + (typeLabels[info.value.service_type] || typeLabel.value) + '配置'
  const reasoning = info.value.service_type === 'text' ? ' · ' + reasoningLabel.value : ''
  return `${props.usage || '当前生成'}使用：${info.value.config_name || info.value.provider} · ${info.value.model}${reasoning}（${source}）。点击查看或修改 AI 配置`
})

async function refresh() {
  const id = ++requestId
  loading.value = true
  error.value = false
  try {
    const result = await aiAPI.getEffective(props.sceneKey, props.serviceType)
    if (id === requestId) info.value = result
  } catch (_) {
    if (id === requestId) {
      info.value = null
      error.value = true
    }
  } finally {
    if (id === requestId) loading.value = false
  }
}
function onClick() {
  if (error.value) refresh()
  else emit('open-config')
}
function onFocus() {
  if (document.visibilityState === 'visible' && !loading.value) refresh()
}
watch(() => [props.sceneKey, props.serviceType, props.refreshKey], refresh, { immediate: true })
onMounted(() => window.addEventListener('focus', onFocus))
onBeforeUnmount(() => {
  requestId++
  window.removeEventListener('focus', onFocus)
})
defineExpose({ refresh })
</script>

<style scoped>
.ai-model-info-card {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: 100%;
  min-width: 0;
  padding: 5px 10px;
  border-width: 1px;
  border-style: solid;
  border-radius: 7px;
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  text-align: left;
  cursor: pointer;
  transition: box-shadow 0.15s;
}
.ai-model-info-card:hover:not(:disabled),
.ai-model-info-card:focus-visible {
  box-shadow: 0 0 0 2px var(--ai-service-border, rgba(148, 163, 184, 0.25));
}
.ai-model-info-card:disabled {
  cursor: wait;
}
.ai-model-info-card .el-icon,
.model-info-usage,
.model-info-name,
.model-info-divider,
.model-info-reasoning {
  flex-shrink: 0;
}
.model-info-name {
  max-width: 160px;
  font-weight: 600;
}
.model-info-name,
.model-info-model {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-info-model {
  min-width: 40px;
  max-width: 290px;
}
.model-info-reasoning {
  padding-left: 7px;
  border-left: 1px solid var(--ai-service-border);
}
.model-info-usage {
  opacity: 0.8;
}
.model-info-hint {
  font-size: 11px;
  opacity: 0.8;
}
.model-info-loading {
  animation: model-info-spin 1s linear infinite;
}
@keyframes model-info-spin {
  to { transform: rotate(360deg); }
}
@media (max-width: 600px) {
  .model-info-name { max-width: 100px; }
  .model-info-model { max-width: 160px; }
  .model-info-reasoning { display: none; }
}
</style>
