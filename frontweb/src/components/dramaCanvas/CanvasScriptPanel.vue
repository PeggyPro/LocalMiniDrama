<template>
  <div
    class="canvas-node-panel script-panel nodrag nopan nowheel"
    @pointerdown.stop
    @mousedown.stop
    @click.stop
    @mouseup.stop
    @wheel.stop
  >
    <div class="panel-head">
      <span>剧本 · 第 {{ episode?.episode_number ?? '?' }} 集</span>
      <div class="head-right">
        <span v-if="draft?.dirty" class="draft-tag">未保存</span>
        <span class="revision-tag">v{{ draft?.baseRevision ?? 0 }}</span>
        <span v-if="busyLabel" class="busy-tag">{{ busyLabel }}</span>
        <el-button link size="small" @click.stop="closePanel">收起</el-button>
      </div>
    </div>

    <p class="flow-hint">创作起点：编写剧本 → 提取角色/场景/道具 → AI 生成分镜 → 生图/生视频</p>
    <p v-if="episode?.storyboards?.length" class="flow-hint">修改本集剧本会保留已有分镜和素材，请核对是否需要重新生成。</p>

    <el-form label-position="left" label-width="112px" size="small" class="compact-form">
      <el-form-item label="集标题">
        <el-input v-model="form.title" placeholder="第 N 集" />
      </el-form-item>
      <el-form-item label="本集原文">
        <el-input v-model="form.sourceText" type="textarea" :rows="4" resize="vertical" placeholder="本集小说原文或改编素材…" />
      </el-form-item>
      <el-form-item label="改编要求（选填）">
        <el-input v-model="form.description" type="textarea" :rows="2" placeholder="如节奏、人物重点、需要保留或调整的情节…" />
      </el-form-item>
      <el-form-item label="本集剧本">
        <el-input
          v-model="form.scriptContent"
          type="textarea"
          :rows="6"
          resize="vertical"
          placeholder="在此粘贴或编写本集剧本…"
          class="script-textarea"
        />
      </el-form-item>
    </el-form>

    <div v-if="draft?.remoteConflict" class="conflict-banner">
      <span>服务器已有 v{{ draft.remoteRevision }}，本地草稿已保留。请选择要保存的版本。</span>
      <div>
        <el-button link size="small" type="warning" :disabled="saving || extracting" @click.stop="resolveConflict('local')">保留草稿并保存</el-button>
        <el-button link size="small" :disabled="saving || extracting" @click.stop="resolveConflict('server')">使用服务器版本</el-button>
      </div>
    </div>

    <div class="stats-row">
      <span>素材：{{ charCount }} 角色 · {{ sceneCount }} 场景 · {{ propCount }} 道具</span>
      <span class="len">{{ scriptLen }} 字</span>
    </div>

    <div class="panel-actions">
      <el-button size="small" type="primary" :loading="saving" :disabled="extracting || draft?.remoteConflict" title="保存本集原文、改编要求、标题和剧本" @click.stop="onSave">保存当前集</el-button>
      <el-button size="small" :loading="extracting" :disabled="saving || draft?.remoteConflict" @click.stop="onExtractChars">提取角色</el-button>
      <el-button size="small" :loading="extracting" :disabled="saving || draft?.remoteConflict" @click.stop="onExtractScenes">提取场景</el-button>
      <el-button size="small" :loading="extracting" :disabled="saving || draft?.remoteConflict" @click.stop="onExtractProps">提取道具</el-button>
      <el-button size="small" type="warning" :loading="extracting" :disabled="saving || draft?.remoteConflict" @click.stop="onExtractAll">一键提取</el-button>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive, ref, watch, onScopeDispose } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useCanvasContext } from '@/composables/useCanvasContext'
import { useFilmStore } from '@/stores/film'
import { dramaAPI } from '@/api/drama'

const props = defineProps({
  episode: { type: Object, required: true },
  nodeId: { type: String, required: true },
})

const ctx = useCanvasContext()
const film = useFilmStore()
const saving = ref(false)
const extracting = ref(false)
let alive = true
onScopeDispose(() => { alive = false })
const dramaId = computed(() => ctx?.drama?.value?.id)
const draft = computed(() => film.getEpisodeDraft(dramaId.value, props.episode.id))
watch(() => [dramaId.value, props.episode.id, props.episode.revision], () => {
  film.hydrateEpisodeDraft(dramaId.value, props.episode)
}, { immediate: true })
const field = (key) => computed({
  get: () => draft.value?.[key] ?? '',
  set: (value) => film.updateEpisodeDraft(dramaId.value, props.episode.id, { [key]: value }),
})
const form = reactive({ title: field('title'), sourceText: field('sourceText'), description: field('description'), scriptContent: field('scriptContent') })

function captureScope() {
  const did = dramaId.value
  const eid = props.episode.id
  return () => alive && Number(dramaId.value) === Number(did) && Number(props.episode.id) === Number(eid)
}

const charCount = computed(() => (props.episode.characters || []).length)
const sceneCount = computed(() => (props.episode.scenes || []).length)
const propCount = computed(() => (props.episode.props || []).length)
const scriptLen = computed(() => (form.scriptContent || '').length)

const busyLabel = computed(() => {
  const map = ctx?.nodeStatus?.map
  return map?.[props.nodeId]?.message || ''
})

function closePanel() {
  ctx?.clearFocusedNode?.()
}

function getScriptApi() {
  return ctx?.scriptActions
}

async function onSave() {
  if (draft.value?.remoteConflict) return
  const isActive = captureScope()
  saving.value = true
  try {
    await getScriptApi()?.saveScript?.(props.episode.id)
  } catch (e) {
    if (isActive()) ElMessage.error(e?.message || '保存失败')
  } finally {
    if (isActive()) saving.value = false
  }
}

async function resolveConflict(choice) {
  const isActive = captureScope()
  const did = dramaId.value
  const eid = props.episode.id
  try {
    await ElMessageBox.confirm(
      choice === 'local' ? '将保留当前草稿并保存到本集最新版本，是否继续？' : '将放弃本地修改并使用服务器版本，是否继续？',
      '处理版本冲突', { type: 'warning' }
    )
    if (!isActive()) return
    const latest = await dramaAPI.get(did)
    if (!isActive()) return
    const ep = latest.episodes?.find((item) => Number(item.id) === Number(eid))
    if (!ep) throw new Error('本集已被删除；本地草稿仍保留在当前会话中')
    film.resolveEpisodeDraftConflict(did, ep, choice)
    if (choice === 'local') await onSave()
    else if (isActive()) await ctx?.refresh?.(true)
  } catch (e) {
    if (isActive() && e?.message) ElMessage.error(e.message)
  }
}

async function runExtract(fn) {
  const isActive = captureScope()
  extracting.value = true
  try {
    await fn()
  } catch (e) {
    if (isActive() && e?.message) ElMessage.error(e.message)
  } finally {
    if (isActive()) extracting.value = false
  }
}

async function onExtractChars() {
  await runExtract(() =>
    getScriptApi()?.extractCharacters?.(props.episode.id, form.scriptContent)
  )
}

async function onExtractScenes() {
  await runExtract(() => getScriptApi()?.extractScenes?.(props.episode.id))
}

async function onExtractProps() {
  await runExtract(() => getScriptApi()?.extractProps?.(props.episode.id))
}

async function onExtractAll() {
  if (!form.scriptContent.trim()) {
    ElMessage.warning('请先填写剧本')
    return
  }
  await runExtract(() =>
    getScriptApi()?.extractAll?.(props.episode.id, form.scriptContent)
  )
}
</script>

<style scoped>
.script-panel {
  margin-top: 10px;
  width: min(520px, 92vw);
  padding: 10px 14px 12px;
  border-radius: 12px;
  border: 1px solid rgba(251, 191, 36, 0.45);
  background: rgba(15, 15, 18, 0.97);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  font-weight: 700;
  color: #fcd34d;
  margin-bottom: 6px;
}
.head-right {
  display: flex;
  align-items: center;
  gap: 6px;
}
.busy-tag {
  font-size: 10px;
  color: #93c5fd;
}
.draft-tag { font-size: 10px; color: #fbbf24; }
.revision-tag { font-size: 10px; color: #a1a1aa; }
.conflict-banner {
  margin-bottom: 8px;
  padding: 8px;
  border: 1px solid #d97706;
  border-radius: 6px;
  color: #fcd34d;
  font-size: 11px;
  line-height: 1.5;
}
.flow-hint {
  margin: 0 0 10px;
  font-size: 10px;
  line-height: 1.45;
  color: #71717a;
}
.compact-form :deep(.el-form-item) {
  margin-bottom: 8px;
}
.compact-form :deep(.el-form-item__label) {
  color: #71717a;
  font-size: 11px;
}
.compact-form :deep(.el-textarea__inner) {
  resize: vertical;
  min-height: 120px;
  line-height: 1.5;
}
.stats-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 10px;
  color: #a1a1aa;
  margin-bottom: 8px;
}
.len {
  color: #71717a;
}
.panel-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(63, 63, 70, 0.6);
}
.panel-actions :deep(.el-button) {
  margin: 0;
}
</style>
