// The injected transport makes the HTTP contract testable without a browser or network.
export function createVideoPlanningAPI(request) {
  const root = '/video-planning'
  const id = (value) => encodeURIComponent(String(value))
  return {
    capabilities: () => request.get(`${root}/capabilities`),
    episode: (episodeId) => request.get(`${root}/episodes/${id(episodeId)}`),
    recommend: (episodeId) => request.post(`${root}/episodes/${id(episodeId)}/recommend`, {}),
    choice: (storyboardId, body) => request.put(`${root}/storyboards/${id(storyboardId)}/choice`, body),
    sources: (dramaId) => request.get(`${root}/sources`, { params: { drama_id: dramaId } }),
    preview: (body) => request.post(`${root}/plans/preview`, body),
    run: (planId, revision) => request.post(`${root}/plans/${id(planId)}/run`, { expected_revision: revision }),
    plan: (planId) => request.get(`${root}/plans/${id(planId)}`),
    resume: (planId) => request.post(`${root}/plans/${id(planId)}/resume`, {}),
    versions: (storyboardId) => request.get(`${root}/storyboards/${id(storyboardId)}/versions`),
    adopt: (storyboardId, body) => request.put(`${root}/storyboards/${id(storyboardId)}/adoption`, body),
  }
}
