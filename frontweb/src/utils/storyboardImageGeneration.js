/** First/last mode needs both slots; single and grid modes still need just one image. */
export function getMissingStoryboardImageSlots({ useFirstLastFrame, hasImage, hasFirstImage, hasLastImage }) {
  if (!useFirstLastFrame) return hasImage ? [] : ['single']
  return [!hasFirstImage && 'first', !hasLastImage && 'last'].filter(Boolean)
}

/** Finish each slot before starting the next so the last frame can reference the first. */
export async function generateMissingStoryboardImages({ getState, generate, shouldStop = () => false }) {
  const slots = getMissingStoryboardImageSlots(getState())
  for (const slot of slots) {
    if (shouldStop()) return { status: 'stopped' }
    // A queued frame may have been uploaded or generated while another frame was running.
    if (!getMissingStoryboardImageSlots(getState()).includes(slot)) continue
    const result = await generate(slot)
    if (result?.paused || result?.status === 'stopped' || result?.status === 'skipped') return result
    if (result?.status !== 'completed') {
      const label = slot === 'last' ? '尾帧' : slot === 'first' ? '首帧' : '分镜图'
      throw new Error(`${label}：${result?.error || '生成失败'}`)
    }
    if (shouldStop()) return { status: 'stopped' }
    // A completed task without a usable image must not unlock its dependent last frame.
    if (getMissingStoryboardImageSlots(getState()).includes(slot)) {
      const label = slot === 'last' ? '尾帧' : slot === 'first' ? '首帧' : '分镜图'
      throw new Error(`${label}生成完成，但未获取到图片，请刷新后重试`)
    }
  }
  return { status: 'completed' }
}
