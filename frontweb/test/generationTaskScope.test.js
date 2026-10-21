import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EPISODE_TASK_TYPES, PROJECT_TASK_TYPES, tasksForResource, taskScopeEpisodeId,
  episodeStoryCandidate, latestEpisodeStoryCandidate,
} from '../src/utils/generationTaskScope.js'

const allTasks = [
  { id: 'project-story', type: 'story_generation', resource_id: '12' },
  { id: 'episode-story', type: 'episode_story_generation', resource_id: '12' },
  { id: 'image', type: 'image_generation', resource_id: '12' },
  { id: 'extract', type: 'character_extraction', resource_id: 12 },
  { id: 'next-episode', type: 'episode_story_generation', resource_id: '13' },
]

test('numeric project/episode/resource collisions cannot recover unrelated tasks', () => {
  assert.deepEqual(tasksForResource(allTasks, 12, EPISODE_TASK_TYPES).map((task) => task.id), ['episode-story', 'extract'])
  assert.deepEqual(tasksForResource(allTasks, 12, PROJECT_TASK_TYPES).map((task) => task.id), ['project-story'])
  assert.deepEqual(tasksForResource(null, 12, EPISODE_TASK_TYPES), [])
  assert.equal(taskScopeEpisodeId('story_generation', 12), 0)
  assert.equal(taskScopeEpisodeId('episode_story_generation', 12), 12)
})

test('conflicted completed episode story candidates are recovered from persisted result JSON', () => {
  const candidate = { title: '候选标题', description: '候选梗概', script_content: '候选剧本' }
  const task = {
    id: 'candidate', type: 'episode_story_generation', resource_id: '12', status: 'completed',
    result: JSON.stringify({ applied: false, candidate }),
  }
  assert.deepEqual(episodeStoryCandidate(task)?.candidate, candidate)
  assert.equal(episodeStoryCandidate(task)?.taskId, 'candidate')
  assert.deepEqual(episodeStoryCandidate({ ...task, result: { applied: false, candidate } })?.candidate, candidate)
  assert.equal(episodeStoryCandidate({ ...task, result: '{' }), null)
  assert.equal(episodeStoryCandidate({ ...task, status: 'processing' }), null)
  assert.equal(episodeStoryCandidate({ ...task, type: 'story_generation' }), null)
  assert.equal(episodeStoryCandidate({ ...task, result: { applied: true, candidate } }), null)
})

test('recovery exposes only the latest attempt candidate for the selected episode', () => {
  const candidate = (id, resource_id, created_at) => ({
    id, resource_id, created_at, type: 'episode_story_generation', status: 'completed',
    result: { applied: false, candidate: { script_content: id } },
  })
  const tasks = [candidate('old', 12, '2026-01-01'), candidate('latest', '12', '2026-01-02'), candidate('other', 13, '2026-01-03')]
  assert.equal(latestEpisodeStoryCandidate(tasks, 12).taskId, 'latest')
  assert.equal(latestEpisodeStoryCandidate(tasks, 13).taskId, 'other')
  assert.equal(latestEpisodeStoryCandidate([...tasks, { ...candidate('applied', 12, '2026-01-04'), result: { applied: true } }], 12), null)
  assert.equal(latestEpisodeStoryCandidate([...tasks, { ...candidate('processing', 12, '2026-01-04'), status: 'processing' }], 12), null)
})
