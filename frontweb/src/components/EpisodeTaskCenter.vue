<template>
  <div class="episode-task-center">
    <el-button class="episode-task-trigger" aria-label="打开本集任务中心" @click="openDrawer">
      <el-icon><List /></el-icon>
      <span>任务</span>
      <span v-if="state.stats.active > 0" class="task-active-count">{{ state.stats.active > 99 ? '99+' : state.stats.active }}</span>
    </el-button>

    <el-drawer
      v-model="opened"
      class="episode-task-drawer"
      direction="rtl"
      size="min(580px, 100vw)"
      :with-header="false"
      :close-on-click-modal="false"
      :close-on-press-escape="false"
      aria-label="本集任务中心"
      append-to-body
    >
      <div class="task-center-shell">
        <header class="task-center-header">
          <div class="task-title-row">
            <div class="task-title-icon"><el-icon><List /></el-icon></div>
            <div class="task-title-copy">
              <h2>任务中心</h2>
              <p>按创建时间倒序 · {{ state.total }} 个任务</p>
            </div>
            <el-button class="task-icon-button" :loading="state.loading" :disabled="state.loading" aria-label="刷新任务列表" title="刷新" @click="reader.refresh()">
              <el-icon v-if="!state.loading"><Refresh /></el-icon>
            </el-button>
            <el-button class="task-icon-button" aria-label="关闭任务中心" title="关闭" @click="opened = false">
              <el-icon><Close /></el-icon>
            </el-button>
          </div>
          <div class="task-context-row">
            <span class="task-episode-label" :title="episodeLabel"><el-icon><Film /></el-icon>{{ episodeLabel }}</span>
            <span class="task-sync-label"><span :class="{ offline: !!state.error }" />{{ state.error ? '同步异常' : '自动同步' }}</span>
          </div>
          <div class="task-status-filters" role="group" aria-label="筛选任务状态">
            <button v-for="filter in filters" :key="filter.value" type="button" :class="['task-status-filter', filter.value, { selected: state.filter === filter.value }]" :aria-pressed="state.filter === filter.value" @click="reader.setFilter(filter.value)">
              <span>{{ filter.label }}</span><strong>{{ filter.count }}</strong>
            </button>
          </div>
        </header>

        <div v-if="state.error" class="task-load-error" role="alert">
          <el-icon><WarningFilled /></el-icon>
          <span>{{ state.error }}{{ state.items.length ? '，当前保留上次结果' : '' }}</span>
          <button type="button" @click="reader.refresh()">重试</button>
        </div>

        <div class="task-center-list" :aria-busy="state.loading">
          <div v-if="state.loading && !state.items.length" class="task-center-empty">
            <el-icon class="task-loading-icon"><Loading /></el-icon><strong>正在读取任务</strong><p>同步本集已有的生成记录</p>
          </div>
          <div v-else-if="!state.items.length && !state.error" class="task-center-empty">
            <div class="task-empty-icon"><el-icon><List /></el-icon></div>
            <strong>{{ state.filter === 'all' ? '本集还没有任务' : '暂无' + selectedFilterLabel + '任务' }}</strong>
            <p>{{ state.filter === 'all' ? '提交生成后，可在这里查看状态和结果' : '可以切换其他状态查看任务记录' }}</p>
          </div>

          <article v-for="task in state.items" :key="task.id" class="task-record" :class="'task-record-' + taskStatusGroup(task.status)" :data-task-id="task.id">
            <div class="task-record-main">
              <div class="task-thumbnail" :class="'kind-' + taskKind(task)">
                <el-icon class="task-thumbnail-fallback"><component :is="kindIcons[taskKind(task)]" /></el-icon>
                <img v-if="task.thumbnail_url && !failedImages[task.thumbnail_url]" :src="task.thumbnail_url" alt="任务结果缩略图" loading="lazy" @error="failedImages[task.thumbnail_url] = true" />
                <span class="task-kind-tag">{{ kindLabels[taskKind(task)] }}</span>
              </div>
              <div class="task-record-copy">
                <div class="task-record-title-row">
                  <h3 :title="task.label">{{ task.label || kindLabels[taskKind(task)] + '任务' }}</h3>
                  <span class="task-state" :class="taskStatusGroup(task.status)">
                    <el-icon v-if="taskStatusGroup(task.status) === 'active'" class="task-loading-icon"><Loading /></el-icon>
                    <el-icon v-else-if="task.status === 'completed'"><CircleCheckFilled /></el-icon>
                    <el-icon v-else-if="taskStatusGroup(task.status) === 'failed'"><WarningFilled /></el-icon>
                    {{ taskStatusLabel(task.status) }}
                  </span>
                </div>
                <div class="task-model-line" :title="[task.provider, task.model].filter(Boolean).join(' · ')">{{ [task.provider, task.model].filter(Boolean).join(' · ') || '未记录模型' }}</div>
                <div class="task-record-meta">
                  <span>{{ formatCreatedAt(task.created_at) }}</span>
                  <span v-if="taskElapsed(task, now)"><el-icon><Timer /></el-icon>{{ taskStatusGroup(task.status) === 'active' ? '已等待 ' : '耗时 ' }}{{ taskElapsed(task, now) }}</span>
                </div>
              </div>
            </div>
            <div v-if="taskStatusGroup(task.status) === 'active'" class="task-record-progress">
              <div class="task-progress-caption"><span>{{ task.message || '等待任务更新' }}</span><span>{{ taskProgress(task) == null ? '处理中' : taskProgress(task) + '%' }}</span></div>
              <div class="task-progress-track" :class="{ indeterminate: taskProgress(task) == null }" role="progressbar" :aria-label="task.label + '进度'" :aria-valuenow="taskProgress(task) ?? undefined" aria-valuemin="0" aria-valuemax="100">
                <span :style="taskProgress(task) == null ? {} : { width: taskProgress(task) + '%' }" />
              </div>
            </div>
            <p v-else-if="task.message" class="task-result-message">{{ task.message }}</p>
            <details v-if="task.error" class="task-error-detail">
              <summary><el-icon><WarningFilled /></el-icon><span>{{ task.error }}</span><span class="task-error-expand">详情</span></summary>
              <p>{{ task.error }}</p>
            </details>
            <div v-if="task.execution_plan_id" class="task-plan-link">
              <span class="task-id" :title="task.execution_plan_id">计划 {{ task.execution_plan_id }}</span>
              <el-button size="small" @click="openPlan(task.execution_plan_id)">查看执行计划</el-button>
            </div>
            <div class="task-record-footer">
              <span class="task-id" :title="String(task.id)">#{{ task.id }}</span>
              <span v-if="task.scope === 'shared'" class="task-scope" title="素材被本集引用，其生成记录可能来自其他集">共享素材</span>
              <span v-else-if="task.scope === 'project'" class="task-scope" title="该任务属于整个项目，没有独立的集数归属">项目任务</span>
              <span v-else class="task-scope episode">本集</span>
            </div>
          </article>
        </div>

        <footer class="task-center-footer">
          <el-pagination v-if="state.filteredTotal > 30" :current-page="state.page" :page-size="30" :total="state.filteredTotal" layout="prev, pager, next" @current-change="reader.setPage" />
          <div class="task-footer-status"><span>任务状态自动更新</span><span>{{ updatedLabel }}</span></div>
          <p>包含本集生成记录及关联的共享素材、项目任务。</p>
        </footer>
      </div>
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { CircleCheckFilled, Close, Connection, Document, Film, List, Loading, Picture, Refresh, Timer, VideoCamera, WarningFilled } from '@element-plus/icons-vue'
import { listEpisodeTasks } from '@/api/episodeTasks'
import { createEpisodeTaskReader, taskElapsed, taskKind, taskProgress, taskStatusGroup, taskStatusLabel, taskTimestamp } from '@/utils/episodeTaskCenter'

const props = defineProps({
  dramaId: { type: [Number, String], required: true },
  episodeId: { type: [Number, String], required: true },
  episodeNumber: { type: [Number, String], default: '' },
  episodeTitle: { type: String, default: '' },
  refreshKey: { type: [Number, String], default: 0 },
})
const emit = defineEmits(['open-plan'])
const opened = ref(false)
const now = ref(Date.now())
const failedImages = reactive({})
const state = ref({ items: [], total: 0, filteredTotal: 0, stats: { active: 0, completed: 0, failed: 0 }, filter: 'all', page: 1, loading: false, error: '', updatedAt: null })
const reader = createEpisodeTaskReader({ load: listEpisodeTasks, onChange: value => { state.value = value } })
const kindIcons = { image: Picture, video: VideoCamera, merge: Connection, text: Document }
const kindLabels = { image: '图片', video: '视频', merge: '合成', text: '文本' }
const filters = computed(() => [
  { value: 'all', label: '全部', count: state.value.total },
  { value: 'active', label: '进行中', count: state.value.stats.active },
  { value: 'completed', label: '已完成', count: state.value.stats.completed },
  { value: 'failed', label: '异常 / 取消', count: state.value.stats.failed },
])
const selectedFilterLabel = computed(() => filters.value.find(item => item.value === state.value.filter)?.label || '')
const episodeLabel = computed(() => `${props.episodeNumber ? '第 ' + props.episodeNumber + ' 集' : '当前集'}${props.episodeTitle ? ' · ' + props.episodeTitle : ''}`)
const updatedLabel = computed(() => state.value.updatedAt ? new Date(state.value.updatedAt).toLocaleTimeString('zh-CN', { hour12: false }) + ' 更新' : '')

function openDrawer() {
  opened.value = true
  reader.refresh()
}

function openPlan(planId) {
  opened.value = false
  emit('open-plan', planId)
}

function formatCreatedAt(value) {
  const timestamp = taskTimestamp(value)
  if (timestamp == null) return '时间未记录'
  return new Date(timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}

watch(() => [props.dramaId, props.episodeId], ([dramaId, episodeId]) => {
  for (const key of Object.keys(failedImages)) delete failedImages[key]
  reader.setContext(dramaId, episodeId)
}, { immediate: true })

watch(() => props.refreshKey, () => reader.refresh({ force: true }))

let timer
let lastAttempt = 0
onMounted(() => {
  timer = window.setInterval(() => {
    now.value = Date.now()
    if (document.visibilityState !== 'visible' || state.value.loading) return
    const interval = opened.value ? 4000 : 12000
    if (now.value - Math.max(lastAttempt, state.value.updatedAt || 0) >= interval) {
      lastAttempt = now.value
      reader.refresh()
    }
  }, 1000)
})
onBeforeUnmount(() => {
  window.clearInterval(timer)
  reader.dispose()
})
</script>

<style scoped>
.episode-task-center { display: inline-flex; }
.episode-task-trigger { gap: 6px; border-color: color-mix(in srgb, var(--el-color-primary) 28%, var(--border-color)); background: color-mix(in srgb, var(--el-color-primary) 7%, var(--bg-card)); color: var(--el-color-primary); }
.task-active-count { display: inline-flex; align-items: center; justify-content: center; min-width: 21px; height: 21px; padding: 0 5px; border-radius: 6px; background: var(--el-color-primary); color: #fff; font-size: 13px; font-weight: 600; }
:global(.episode-task-drawer.el-drawer) { background: var(--bg-card); color: var(--text-primary); }
:global(.episode-task-drawer .el-drawer__body) { padding: 0; overflow: hidden; }
.task-center-shell { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 14px; line-height: 1.5; }
.task-center-header { flex-shrink: 0; padding: 26px 24px 20px; border-bottom: 1px solid var(--border-color); }
.task-title-row { display: flex; align-items: center; gap: 12px; }
.task-title-icon { width: 40px; height: 40px; flex-shrink: 0; display: grid; place-items: center; background: color-mix(in srgb, var(--el-color-primary) 12%, transparent); color: var(--el-color-primary); border-radius: 12px; font-size: 21px; }
.task-title-copy { flex: 1; min-width: 0; }
.task-title-copy h2 { font-size: 22px; font-weight: 650; margin: 0 0 5px; letter-spacing: .3px; line-height: 1.3; }
.task-title-copy p { color: var(--text-subtle); font-size: 14px; margin: 0; }
.task-icon-button.el-button { margin-left: 0; width: 36px; height: 36px; flex-shrink: 0; padding: 0; border: 0; background: transparent; color: var(--text-muted); font-size: 18px; }
.task-icon-button:hover { background: var(--bg-hover); color: var(--text-primary); }
.task-context-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin: 24px 0 18px; }
.task-episode-label { display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); font-size: 14px; }
.task-episode-label .el-icon { flex-shrink: 0; }
.task-sync-label { flex-shrink: 0; display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-subtle); }
.task-sync-label > span { width: 6px; height: 6px; background: #22c55e; border-radius: 50%; }
.task-sync-label > span.offline { background: #e6a23c; }
.task-status-filters { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.task-status-filter { display: flex; align-items: center; justify-content: center; gap: 8px; border: 1px solid var(--border-color); border-radius: 8px; padding: 9px 4px; background: var(--bg-inner); color: var(--text-muted); cursor: pointer; font-family: inherit; font-size: 14px; line-height: 1.5; transition: border-color .15s, background .15s; }
.task-status-filter strong { font-size: 15px; font-variant-numeric: tabular-nums; }
.task-status-filter:hover { border-color: var(--border-muted); }
.task-status-filter.selected { border-color: color-mix(in srgb, var(--el-color-primary) 40%, transparent); background: color-mix(in srgb, var(--el-color-primary) 9%, var(--bg-card)); color: var(--el-color-primary); }
.task-status-filter.active strong { color: #8b5cf6; }
.task-status-filter.completed strong { color: #22a66f; }
.task-status-filter.failed strong { color: #e06c55; }
.task-center-list { flex: 1; min-height: 0; overflow-y: auto; padding: 20px 24px; scrollbar-width: thin; scrollbar-color: var(--border-muted) transparent; }
.task-record { border: 1px solid var(--border-color); background: var(--bg-inner); border-radius: 12px; padding: 16px; margin-bottom: 12px; }
.task-record-active { border-color: color-mix(in srgb, var(--el-color-primary) 28%, var(--border-color)); }
.task-record-failed { border-color: color-mix(in srgb, #e56e63 25%, var(--border-color)); }
.task-record-main { display: flex; align-items: flex-start; gap: 14px; }
.task-thumbnail { width: 74px; height: 76px; flex-shrink: 0; position: relative; display: grid; place-items: center; border-radius: 8px; overflow: hidden; color: #8b5cf6; background: color-mix(in srgb, #8b5cf6 10%, var(--bg-card)); font-size: 25px; }
.task-thumbnail.kind-video { color: #5397e9; background: color-mix(in srgb, #5397e9 10%, var(--bg-card)); }
.task-thumbnail.kind-merge { color: #d99b44; background: color-mix(in srgb, #d99b44 10%, var(--bg-card)); }
.task-thumbnail.kind-text { color: #719992; background: color-mix(in srgb, #719992 10%, var(--bg-card)); }
.task-thumbnail img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.task-kind-tag { position: absolute; z-index: 1; bottom: 0; left: 0; right: 0; background: color-mix(in srgb, var(--bg-card) 84%, transparent); text-align: center; line-height: 22px; font-size: 12px; letter-spacing: 1px; color: var(--text-muted); }
.task-record-copy { flex: 1; min-width: 0; }
.task-record-title-row { display: flex; gap: 8px; align-items: center; justify-content: space-between; margin: 1px 0 8px; }
.task-record-title-row h3 { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 16px; font-weight: 600; color: var(--text-primary); margin: 0; }
.task-state { flex-shrink: 0; display: inline-flex; align-items: center; gap: 4px; font-size: 13px; color: var(--text-muted); }
.task-state.active { color: #8b5cf6; }
.task-state.completed { color: #22a66f; }
.task-state.failed { color: #e06c55; }
.task-model-line { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-subtle); font-size: 14px; margin-bottom: 8px; }
.task-record-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; font-size: 13px; color: var(--text-subtle); }
.task-record-meta > span { display: inline-flex; align-items: center; gap: 4px; }
.task-record-progress { margin-top: 16px; }
.task-progress-caption { display: flex; align-items: center; gap: 12px; justify-content: space-between; font-size: 13px; color: var(--text-muted); margin-bottom: 8px; }
.task-progress-caption > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-progress-caption > span:last-child { flex-shrink: 0; color: var(--el-color-primary); }
.task-progress-track { height: 5px; background: var(--border-color); border-radius: 4px; overflow: hidden; }
.task-progress-track > span { display: block; height: 100%; background: var(--el-color-primary); border-radius: inherit; transition: width .4s; }
.task-progress-track.indeterminate > span { width: 35%; animation: task-progress-slide 1.8s ease-in-out infinite; }
.task-result-message { color: var(--text-subtle); font-size: 14px; margin: 12px 0 0; line-height: 1.6; overflow-wrap: anywhere; }
.task-plan-link { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; }
.task-plan-link .el-button { flex-shrink: 0; }
.task-record-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-top: 1px solid var(--border-color); padding-top: 11px; margin-top: 13px; }
.task-id { min-width: 0; max-width: 75%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, monospace; color: var(--text-subtle); font-size: 11px; }
.task-scope { color: var(--text-subtle); border: 1px solid var(--border-color); border-radius: 4px; padding: 2px 5px; font-size: 12px; flex-shrink: 0; }
.task-scope.episode { border: none; padding-right: 0; }
.task-error-detail { margin-top: 13px; padding: 9px 10px; border-radius: 6px; background: color-mix(in srgb, #e56e63 7%, transparent); color: #e06c55; font-size: 13px; }
.task-error-detail summary { display: flex; align-items: center; gap: 5px; cursor: pointer; list-style: none; }
.task-error-detail summary::-webkit-details-marker { display: none; }
.task-error-detail summary > span:first-of-type { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; flex: 1; }
.task-error-expand { flex-shrink: 0; font-size: 12px; }
.task-error-detail > p { margin: 9px 0 0; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.task-center-empty { height: 100%; min-height: 220px; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--text-subtle); gap: 15px; }
.task-empty-icon { width: 66px; height: 66px; display: grid; place-items: center; font-size: 28px; border: 1px solid var(--border-color); border-radius: 20px; background: var(--bg-inner); color: var(--text-faint); }
.task-center-empty strong { color: var(--text-muted); font-size: 16px; font-weight: 500; }
.task-center-empty p { font-size: 14px; margin: 0; text-align: center; }
.task-center-footer { padding: 15px 24px 18px; border-top: 1px solid var(--border-color); background: var(--bg-card); flex-shrink: 0; }
.task-center-footer .el-pagination { justify-content: center; margin-bottom: 12px; }
.task-footer-status { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 10px; color: var(--text-subtle); font-size: 12px; }
.task-center-footer p { color: var(--text-subtle); font-size: 12px; margin: 8px 0 0; line-height: 1.6; }
.task-load-error { display: flex; align-items: center; gap: 6px; margin: 12px 24px 0; padding: 10px; border-radius: 8px; background: color-mix(in srgb, #e6a23c 9%, var(--bg-card)); color: #d99b44; font-size: 13px; }
.task-load-error > span { flex: 1; }
.task-load-error button { padding: 0; color: inherit; background: transparent; border: 0; cursor: pointer; text-decoration: underline; font: inherit; }
.task-loading-icon { animation: task-icon-spin 1.5s linear infinite; }
@keyframes task-icon-spin { to { transform: rotate(360deg); } }
@keyframes task-progress-slide { from { transform: translateX(-100%); } to { transform: translateX(390%); } }
@media (max-width: 520px) {
  .task-center-header { padding: 20px 16px 16px; }
  .task-center-list { padding: 16px; }
  .task-center-footer { padding: 12px 16px; }
  .task-record { padding: 12px; }
  .task-thumbnail { width: 56px; height: 70px; }
  .task-record-main { gap: 10px; }
  .task-status-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .task-record-title-row { flex-wrap: wrap; gap: 4px 8px; }
  .task-record-title-row h3 { flex-basis: 100%; white-space: normal; overflow-wrap: anywhere; }
  .task-record-meta { gap: 4px 8px; }
}
@media (prefers-reduced-motion: reduce) {
  .task-loading-icon, .task-progress-track.indeterminate > span { animation: none; }
}
</style>
