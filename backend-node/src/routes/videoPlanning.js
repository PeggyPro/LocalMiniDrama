'use strict';

const express = require('express');
const response = require('../response');
const planning = require('../services/videoPlanningService');
const catalog = require('../services/videoWorkflowCatalog');

// The optional fourth argument is an in-process test seam, never request-controlled.
module.exports = function videoPlanningRoutes(db, cfg, log, dependencies = {}) {
  const router = express.Router();
  const plans = dependencies.planning || planning;
  const execution = () => dependencies.execution || require('../services/videoPlanExecutionService');
  const route = (handler) => async (req, res) => {
    try {
      const result = await handler(req);
      if (result == null) return response.notFound(res, '视频计划不存在');
      return response.success(res, result);
    } catch (error) {
      const status = [400, 404, 409].includes(error.statusCode || error.status) ? (error.statusCode || error.status) : 500;
      if (status === 500) log?.error?.('Video planning request failed', { message: error.message });
      return response.error(res, status, error.code || (status === 500 ? 'INTERNAL_ERROR' : 'VIDEO_PLANNING_ERROR'),
        status === 500 ? '视频规划请求失败' : error.message, status === 500 ? undefined : error.details);
    }
  };
  router.get('/capabilities', route(() => catalog.getVideoWorkflowCatalog()));
  router.get('/episodes/:episodeId', route((req) => plans.getEpisodeVideoPlans(db, req.params.episodeId)));
  router.post('/episodes/:episodeId/recommend', route((req) => plans.recommendEpisodeVideoPlans(db, cfg, log, req.params.episodeId, req.body || {})));
  router.put('/storyboards/:id/choice', route((req) => plans.setVideoChoice(db, req.params.id, req.body || {})));
  router.get('/sources', route((req) => execution().listSources(db, req.query.drama_id)));
  router.post('/plans/preview', route((req) => execution().previewPlan(db, cfg, log, req.body || {})));
  router.post('/plans/:id/run', route((req) => execution().runPlan(db, cfg, log, req.params.id, req.body || {})));
  router.get('/plans/:id', route((req) => execution().getPlan(db, req.params.id)));
  router.post('/plans/:id/resume', route((req) => execution().resumePlan(db, cfg, log, req.params.id)));
  router.get('/storyboards/:id/versions', route((req) => execution().listVersions(db, req.params.id)));
  router.put('/storyboards/:id/adoption', route((req) => execution().adoptVersion(db, req.params.id, req.body || {})));
  return router;
};
