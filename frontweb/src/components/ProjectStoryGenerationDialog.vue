<template>
  <el-dialog :model-value="modelValue" title="整剧批量生成" width="640px" :close-on-click-modal="false" @update:model-value="emit('update:modelValue', $event)">
    <p>根据全剧梗概重新生成分集列表。只生成当前集，请从该集的「开始创作 / 进入制作」操作。</p>
    <el-alert type="warning" :closable="false" show-icon style="margin-bottom: 12px">
      将更新同集号的正文，保留这些集的 ID；未包含的旧集会移出列表。已制作的分镜与素材需要重新核对。
    </el-alert>
    <el-input v-model="premise" type="textarea" :rows="7" placeholder="全剧梗概" :disabled="busy || loading" />
    <div style="display: flex; gap: 12px; align-items: center; margin-top: 12px">
      <span>生成集数</span><el-input-number v-model="count" :min="1" :precision="0" :disabled="busy || loading" />
      <span>现有 {{ project?.episodes?.length || 0 }} 集</span>
    </div>
    <p v-if="error" role="alert" style="color: var(--el-color-danger)">{{ error }}</p>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">关闭</el-button>
      <el-button type="primary" :loading="busy || loading" :disabled="!project || !premise.trim()" @click="generate">确认生成整剧</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, watch, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { dramaAPI } from '@/api/drama'
import { generationAPI } from '@/api/generation'
import { useGenerationTaskStore, GEN_RESOURCE } from '@/stores/generationTaskStore'

const props = defineProps({ modelValue: Boolean, dramaId: [Number, String] })
const emit = defineEmits(['update:modelValue', 'saved'])
const tasks = useGenerationTaskStore()
const project = ref(null)
const premise = ref('')
const count = ref(1)
const error = ref('')
const loading = ref(false)
const busy = ref(false)
let alive = true
let generation = 0
onBeforeUnmount(() => { alive = false; generation++ })
watch(() => [props.modelValue, props.dramaId], async ([open, id]) => {
  const token = ++generation
  project.value = null
  error.value = ''
  busy.value = false
  loading.value = false
  if (!open || !id) return
  loading.value = true
  try {
    const data = await dramaAPI.get(id)
    if (!alive || token !== generation) return
    project.value = data
    premise.value = data.description || ''
    count.value = Math.max(1, data.episodes?.length || 1)
  } catch (e) {
    if (alive && token === generation) error.value = e.message || '读取项目失败'
  } finally {
    if (alive && token === generation) loading.value = false
  }
}, { immediate: true })

async function generate() {
  if (busy.value || !project.value) return
  const target = project.value
  const token = generation
  const isActive = () => alive && token === generation && props.modelValue && Number(props.dramaId) === Number(target.id)
  const meta = {
    dramaId: target.id, episodeId: 0, dramaTitle: target.title,
    resourceType: GEN_RESOURCE.GENERATE_STORY, resourceId: target.id,
    label: `${target.title || '项目'} 整剧批量生成`,
  }
  if (tasks.isRunning(meta)) { error.value = '这个项目已有整剧生成任务，请在任务中心查看'; return }
  const request = {
    drama_id: target.id, title: target.title,
    premise: premise.value.trim(), summary: premise.value.trim(),
    episode_count: count.value, expected_collection_revision: target.episodes_revision,
    style: target.metadata?.story_style || undefined, type: target.genre || undefined,
  }
  busy.value = true
  error.value = ''
  try {
    await ElMessageBox.confirm(`将整剧重新生成为 ${count.value} 集，现有 ${target.episodes?.length || 0} 集。未包含的集会移出列表，已有制作内容需检查。是否继续？`, '确认整剧批量生成', { type: 'warning', confirmButtonText: '生成整剧', cancelButtonText: '取消' })
    if (!isActive()) return
    const response = await generationAPI.generateStory(request)
    if (!response?.task_id) throw new Error('未能启动整剧生成任务')
    const result = await tasks.pollTask(response.task_id, meta, null, { showErrorToast: false, showTimeoutToast: false })
    if (!isActive()) return
    if (result.status !== 'completed') throw new Error(result.error || '整剧生成失败')
    let data = result.result || {}
    if (typeof data === 'string') data = JSON.parse(data)
    if (data.applied === false) throw new Error('生成期间分集已被修改，未覆盖现有内容。请在任务中心查看生成结果。')
    emit('saved', { dramaId: target.id })
    emit('update:modelValue', false)
    ElMessage.success('整剧分集已生成')
  } catch (e) {
    if (e !== 'cancel' && e !== 'close' && isActive()) error.value = e.message || '整剧生成失败'
  } finally {
    if (isActive()) busy.value = false
  }
}
</script>
