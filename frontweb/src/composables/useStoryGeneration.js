import { ElMessage } from 'element-plus'
import { generationAPI } from '@/api/generation'
import { GEN_RESOURCE } from '@/stores/generationTaskStore'
import { generateEpisodeStory } from '@/utils/episodeStoryGeneration'

/** The editor only generates its captured episode. Project generation lives on the project page. */
export async function runGenerateStoryFromPremise({
  store, premise, storyStyle, storyType, referencePrevious,
  pollTask, isActive, onApplied, onCandidate,
}) {
  const episode = store.currentEpisode
  const draft = episode && store.getEpisodeDraft(store.dramaId, episode)
  try {
    const result = await generateEpisodeStory({
      dramaId: store.dramaId, episodeId: episode?.id, expectedRevision: draft?.baseRevision,
      premise, sourceText: draft?.sourceText, storyStyle, storyType, referencePrevious,
      dramaTitle: store.drama?.title || '', episodeNumber: episode?.episode_number,
    }, {
      submit: (did, eid, body) => generationAPI.generateEpisodeStory(did, eid, body),
      poll: (taskId, meta) => pollTask(taskId, null, { ...meta, resourceType: GEN_RESOURCE.GENERATE_EPISODE_STORY }),
      isActive, onApplied, onCandidate,
    })
    if (result.ok && !result.scopeChanged && !result.conflict) ElMessage.success('本集剧本已生成并保存')
    return result
  } catch (error) {
    if (!isActive || isActive()) ElMessage.error(error.message || '本集剧本生成失败')
    return { ok: false, error: error.message }
  }
}
