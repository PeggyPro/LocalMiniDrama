<template>
  <div class="episode-batch-import-trigger">
    <el-button size="small" :disabled="disabled || importing" @click="openDialog">
      <el-icon><Upload /></el-icon>批量导入剧集
    </el-button>

    <el-dialog
      v-model="visible"
      title="批量追加导入剧集"
      width="920px"
      append-to-body
      destroy-on-close
      :close-on-click-modal="!importing"
      :close-on-press-escape="!importing"
      :show-close="!importing"
      @close="resetState"
    >
      <el-alert
        title="追加导入：仅新增预览中的分集，保留已有分集及其制作资源。"
        type="info"
        :closable="false"
        show-icon
      />
      <el-alert v-if="importError" :title="importError" type="error" :closable="false" show-icon />
      <div class="batch-import-dialog" v-loading="importing" element-loading-text="正在保存导入分集…">
        <el-tabs v-model="activeTab" class="batch-import-tabs">
          <el-tab-pane label="1. 导入设置" name="config">
            <div class="batch-import-panel">
              <div class="batch-import-toolbar">
                <input ref="fileInputRef" type="file" accept=".txt,text/plain" style="display:none" :disabled="importing" @change="onFileChange" />
                <el-button :disabled="importing" @click="fileInputRef?.click()">
                  <el-icon><Upload /></el-icon>选择 TXT 文件
                </el-button>
                <span class="batch-import-file" :class="{ 'is-empty': !fileName }">
                  {{ fileName || '未选择文件' }}
                </span>
              </div>

              <el-form label-width="120px" class="batch-import-form" :disabled="importing">
                <el-form-item label="内容类型">
                  <el-radio-group v-model="importKind">
                    <el-radio label="source">本集原文</el-radio>
                    <el-radio label="script">已有剧本</el-radio>
                  </el-radio-group>
                </el-form-item>
                <el-form-item label="导入正文">
                  <el-input v-model="rawText" type="textarea" :rows="8" placeholder="粘贴包含章节标题的完整原文或剧本，也可选择 TXT 文件载入" @input="onTextInput" />
                </el-form-item>
                <el-form-item label="章节正则">
                  <el-input v-model="chapterPattern" placeholder="例如：^\s*(第\d+章[^\n]*)" />
                </el-form-item>
                <el-form-item label="每集章节数">
                  <el-input-number v-model="chaptersPerEpisode" :min="1" :max="100" />
                </el-form-item>
              </el-form>

              <div class="batch-import-tip-block">
                <div class="batch-import-tip">默认作为“本集原文”保存，导入后进入各集填写创作要求并生成剧本；选择“已有剧本”则直接保存为剧本。</div>
                <div class="batch-import-tip">只写入选定类型的完整正文，不自动填充另一类正文或创作要求。</div>
                <div class="batch-import-tip">请正确输入用于匹配章节标题的正则表达式。</div>
                <div class="batch-import-tip">示例：<code class="batch-import-code">^\s*(第\d+章[^\n]*)</code>、<code class="batch-import-code">^\s*(第\d+集[^\n]*)</code></div>
                <div class="batch-import-tip">点击“确认导入配置”后，会先解析章节并切换到预览页。</div>
              </div>
            </div>
          </el-tab-pane>

          <el-tab-pane label="2. 预览确认" name="preview" :disabled="!previewReady">
            <div class="batch-import-panel">
              <template v-if="previewEpisodes.length">
                <div class="batch-import-preview-header">
                  <el-tag>{{ previewImportKind === 'source' ? '本集原文' : '已有剧本' }}</el-tag>
                  <span>共识别 {{ previewChapters.length }} 章，将作为{{ previewImportKind === 'source' ? '本集原文' : '已有剧本' }}追加 {{ previewEpisodes.length }} 集（第 {{ previewEpisodes[0].episode_number }}–{{ previewEpisodes[previewEpisodes.length - 1].episode_number }} 集）</span>
                </div>
                <el-table :data="previewEpisodes" border stripe height="420" class="batch-import-preview-table">
                  <el-table-column prop="episode_number" label="集数" width="80" align="center" />
                  <el-table-column prop="title" label="集标题" min-width="220" show-overflow-tooltip />
                  <el-table-column label="包含章节" min-width="260" show-overflow-tooltip>
                    <template #default="scope">
                      {{ scope.row.chapter_titles.join('、') || '未识别章节标题' }}
                    </template>
                  </el-table-column>
                  <el-table-column label="内容预览" min-width="320" show-overflow-tooltip>
                    <template #default="scope">
                      <div class="batch-import-preview-cell batch-import-preview-cell--single-line">
                        {{ scope.row.script_content || '暂无内容' }}
                      </div>
                    </template>
                  </el-table-column>
                </el-table>
              </template>
              <div v-else class="batch-import-empty">请先在上一步确认导入配置</div>
            </div>
          </el-tab-pane>
        </el-tabs>
      </div>
      <template #footer>
        <el-button :disabled="importing" @click="visible = false">取消</el-button>
        <el-button v-if="activeTab === 'preview'" :disabled="importing" @click="activeTab = 'config'">上一步</el-button>
        <el-button
          v-if="activeTab === 'config'"
          type="primary"
          :disabled="!rawText.trim() || importing"
          @click="confirmConfig"
        >确认导入配置</el-button>
        <el-button
          v-else
          type="primary"
          :disabled="!previewReady || !previewEpisodes.length || importing || disabled"
          :loading="importing"
          @click="confirmImport"
        >按{{ previewImportKind === 'source' ? '本集原文' : '已有剧本' }}追加 {{ previewEpisodes.length }} 集</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, watch, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'
import { Upload } from '@element-plus/icons-vue'
import { createEpisodeImportSubmission } from '@/utils/episodeBatchImport'

const props = defineProps({
  startEpisodeNumber: {
    type: Number,
    default: 1,
  },
  submitImport: {
    type: Function,
    required: true,
  },
  disabled: {
    type: Boolean,
    default: false,
  },
})

const visible = ref(false)
const activeTab = ref('config')
const previewReady = ref(false)
const importing = ref(false)
const fileInputRef = ref(null)
const fileName = ref('')
const rawText = ref('')
const importKind = ref('source')
const previewImportKind = ref('source')
const chapterPattern = ref('^\\s*(第[0-9０-９零一二三四五六七八九十百千万]+[章回节][^\\n\\r]*)')
const chaptersPerEpisode = ref(1)
const previewChapters = ref([])
const previewEpisodes = ref([])
const importError = ref('')
let fileReadVersion = 0

watch([rawText, importKind, chapterPattern, chaptersPerEpisode], invalidatePreview, { flush: 'sync' })

function invalidatePreview() {
  if (importing.value) return
  importError.value = ''
  previewReady.value = false
  previewChapters.value = []
  previewEpisodes.value = []
  activeTab.value = 'config'
}

const importSubmission = createEpisodeImportSubmission({
  submitImport: (episodes, options) => props.submitImport(episodes, options),
  onPendingChange: (pending) => { importing.value = pending },
  onSuccess: (count) => {
    ElMessage.success(`已追加导入 ${count} 集`)
    resetState()
  },
  onError: (error) => {
    importError.value = error?.message || '批量导入失败，请重试'
  },
})

onBeforeUnmount(() => {
  fileReadVersion += 1
  importSubmission.dispose()
})

function openDialog() {
  if (props.disabled || importing.value) return
  visible.value = true
  activeTab.value = 'config'
}

defineExpose({
  openDialog,
})

function resetState() {
  if (importing.value) return
  fileReadVersion += 1
  importError.value = ''
  visible.value = false
  activeTab.value = 'config'
  previewReady.value = false
  importing.value = false
  fileName.value = ''
  rawText.value = ''
  importKind.value = 'source'
  previewImportKind.value = 'source'
  chapterPattern.value = '^\\s*(第[0-9０-９零一二三四五六七八九十百千万]+[章回节][^\\n\\r]*)'
  chaptersPerEpisode.value = 1
  previewChapters.value = []
  previewEpisodes.value = []
  if (fileInputRef.value) fileInputRef.value.value = ''
}

function onTextInput() {
  fileReadVersion += 1
  fileName.value = ''
  if (fileInputRef.value) fileInputRef.value.value = ''
}

function onFileChange(event) {
  const file = event.target?.files?.[0]
  if (!file || importing.value) return
  const readVersion = ++fileReadVersion
  fileName.value = file.name
  rawText.value = ''
  importError.value = ''
  previewReady.value = false
  previewChapters.value = []
  previewEpisodes.value = []
  const reader = new FileReader()
  reader.onload = (ev) => {
    if (readVersion !== fileReadVersion) return
    rawText.value = String(ev.target?.result || '')
  }
  reader.onerror = () => {
    if (readVersion !== fileReadVersion) return
    ElMessage.error('读取文件失败')
  }
  reader.readAsText(file, 'utf-8')
}

function createChapterRegex(pattern) {
  const source = String(pattern || '').trim()
  if (!source) throw new Error('请输入章节正则')
  try {
    return new RegExp(source, 'gm')
  } catch {
    throw new Error('章节正则格式不正确')
  }
}

function splitNovelChapters(text, pattern) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim()
  if (!normalized) return []
  const regex = createChapterRegex(pattern)
  const matches = [...normalized.matchAll(regex)]
  if (!matches.length) throw new Error('未匹配到任何章节，请调整章节正则')
  return matches.map((match, index) => {
    const title = String(match[1] || match[0] || '').trim()
    const titleStart = match.index ?? 0
    const contentStart = titleStart + String(match[0] || '').length
    const nextTitleStart = index + 1 < matches.length
      ? (matches[index + 1].index ?? normalized.length)
      : normalized.length
    const content = normalized.slice(contentStart, nextTitleStart).trim()
    return {
      title: title || `第${index + 1}章`,
      content,
    }
  }).filter((chapter) => chapter.title || chapter.content)
}

function buildEpisodesFromChapters(chapters, sizeValue) {
  const size = Math.max(1, Number(sizeValue) || 1)
  return chapters.reduce((list, chapter, index) => {
    const groupIndex = Math.floor(index / size)
    if (!list[groupIndex]) {
      list[groupIndex] = {
        title: '',
        script_content: '',
        chapter_titles: [],
      }
    }
    list[groupIndex].chapter_titles.push(chapter.title)
    list[groupIndex].script_content = [list[groupIndex].script_content, `${chapter.title}\n${chapter.content}`].filter(Boolean).join('\n\n')
    return list
  }, []).map((episode, index) => ({
    episode_number: props.startEpisodeNumber + index,
    title: episode.chapter_titles.length === 1
      ? episode.chapter_titles[0]
      : `${episode.chapter_titles[0]} - ${episode.chapter_titles[episode.chapter_titles.length - 1]}`,
    script_content: episode.script_content,
    chapter_titles: episode.chapter_titles,
  }))
}

function confirmConfig() {
  if (importing.value) return
  importError.value = ''
  if (!rawText.value.trim()) {
    ElMessage.warning('请先粘贴正文或选择 TXT 文件')
    return
  }
  try {
    const chapters = splitNovelChapters(rawText.value, chapterPattern.value)
    const episodes = buildEpisodesFromChapters(chapters, chaptersPerEpisode.value)
    if (!episodes.length) {
      ElMessage.warning('未生成可导入的集数')
      return
    }
    previewChapters.value = chapters
    previewEpisodes.value = episodes
    previewImportKind.value = importKind.value
    previewReady.value = true
    activeTab.value = 'preview'
    ElMessage.success(`已识别 ${chapters.length} 章，可导入 ${episodes.length} 集`)
  } catch (e) {
    invalidatePreview()
    ElMessage.error(e.message || '章节预览失败')
  }
}

async function confirmImport() {
  if (importing.value || props.disabled) return
  if (!previewReady.value || !previewEpisodes.value.length) {
    ElMessage.warning('请先完成预览')
    return
  }
  importError.value = ''
  await importSubmission.submit(previewEpisodes.value, previewImportKind.value)
}
</script>

<style scoped>
.episode-batch-import-trigger { display: inline-flex; }
.batch-import-dialog { display: flex; flex-direction: column; }
.batch-import-tabs { width: 100%; }
.batch-import-panel { display: flex; flex-direction: column; gap: 16px; min-height: 420px; }
.batch-import-toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.batch-import-file { font-size: 0.85rem; color: #a1a1aa; }
.batch-import-file.is-empty { color: #71717a; }
.batch-import-form { margin-bottom: 0; }
.batch-import-tip-block { display: flex; flex-direction: column; gap: 8px; }
.batch-import-tip { font-size: 0.82rem; color: #71717a; }
.batch-import-code { color: #c084fc; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace; }
.batch-import-empty { min-height: 320px; display: flex; align-items: center; justify-content: center; color: #71717a; border: 1px dashed #3f3f46; border-radius: 12px; }
.batch-import-preview-header { display: flex; align-items: center; justify-content: flex-end; gap: 12px; margin-bottom: 12px; color: #c084fc; font-size: 0.85rem; flex-wrap: wrap; }
.batch-import-preview-table :deep(.el-table) { --el-table-bg-color: transparent; --el-table-tr-bg-color: transparent; --el-table-border-color: #3f3f46; --el-table-header-bg-color: rgba(39, 39, 42, 0.9); --el-table-row-hover-bg-color: rgba(139, 92, 246, 0.08); color: #e4e4e7; }
.batch-import-preview-table :deep(.el-table__inner-wrapper::before) { display: none; }
.batch-import-preview-table :deep(th.el-table__cell) { color: #fafafa; }
.batch-import-preview-table :deep(td.el-table__cell) { vertical-align: top; }
.batch-import-preview-cell { line-height: 1.6; white-space: pre-wrap; color: #d4d4d8; }
.batch-import-preview-cell--single-line { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.4; }
</style>
