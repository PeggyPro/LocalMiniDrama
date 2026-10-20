<template>
  <div class="asset-batch-actions">
    <div class="asset-batch-trigger">
      <el-button
        type="primary"
        size="small"
        :loading="batch.running"
        :disabled="disabled || (!batch.running && batch.availableCount === 0)"
        title="批量生成当前区全部图片，已有图片也会重新生成，跳过正在生成的项目"
        @click="$emit('generate', 'all')"
      >
        <el-icon v-if="!batch.running"><MagicStick /></el-icon>
        一键AI生成
      </el-button>
      <el-dropdown
        trigger="click"
        :disabled="disabled || batch.running || batch.availableCount === 0"
        @command="$emit('generate', $event)"
      >
        <el-button
          type="primary"
          size="small"
          :disabled="disabled || batch.running || batch.availableCount === 0"
          title="选择批量生成范围"
          aria-label="选择批量生成范围"
        >
          <el-icon><ArrowDown /></el-icon>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="all">全部重新生成（{{ batch.availableCount }} 张）</el-dropdown-item>
            <el-dropdown-item command="missing" :disabled="batch.pendingCount === 0">仅补全缺图（{{ batch.pendingCount }} 张）</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
    <el-button v-if="batch.running" size="small" type="danger" plain :disabled="batch.stopping" @click="batch.stop()">
      {{ batch.stopping ? '正在停止' : '停止' }}
    </el-button>
    <span v-if="batch.total > 0 && batch.isCurrentScope" class="asset-batch-progress" role="status" aria-live="polite">
      {{ batch.running ? '生成中' : batch.stopping ? '已停止' : '已完成' }} {{ batch.current }}/{{ batch.total }}
      · 成功 {{ batch.succeeded }}
      <template v-if="batch.skipped"> · 跳过 {{ batch.skipped }}</template>
    </span>
    <span v-else-if="batch.running" class="asset-batch-progress">正在等待上一集已提交的任务完成</span>
    <span v-else-if="batch.pendingCount > 0" class="asset-batch-progress">待生成 {{ batch.pendingCount }} 张</span>
    <el-tooltip v-if="batch.errors.length && batch.isCurrentScope" :content="batch.errors.join('；')" placement="top">
      <span class="asset-batch-errors">{{ batch.errors.length }} 项失败</span>
    </el-tooltip>
  </div>
</template>

<script setup>
import { ArrowDown, MagicStick } from '@element-plus/icons-vue'

defineProps({
  batch: { type: Object, required: true },
  disabled: Boolean,
})
defineEmits(['generate'])
</script>

<style scoped>
.asset-batch-actions {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-left: 12px;
  vertical-align: middle;
  max-width: 100%;
}
.asset-batch-trigger {
  display: inline-flex;
  align-items: center;
}
.asset-batch-trigger > .el-button {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}
.asset-batch-trigger :deep(.el-dropdown .el-button) {
  border-left-color: rgba(255, 255, 255, 0.35);
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
  padding: 5px 8px;
}
.asset-batch-actions .el-button + .el-button {
  margin-left: 0;
}
.asset-batch-progress {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.asset-batch-errors {
  color: var(--el-color-danger);
  font-size: 12px;
  cursor: help;
}
</style>
