const taskService = require('../services/taskService');
const episodeTaskService = require('../services/episodeTaskService');
const response = require('../response');

function getEpisodeTasks(db, log) {
  return (req, res) => {
    try {
      const result = episodeTaskService.listEpisodeTasks(db, req.params.episodeId, req.query);
      if (!result) return response.notFound(res, '剧集不存在');
      response.success(res, result);
    } catch (err) {
      if (err.statusCode === 400) return response.badRequest(res, err.message);
      log.errorw('Get episode tasks failed', { error: err.message, episode_id: req.params.episodeId });
      response.internalError(res, err.message);
    }
  };
}

function getTaskStatus(db, log) {
  return (req, res) => {
    const task = taskService.getTask(db, req.params.task_id);
    if (!task) return response.notFound(res, '任务不存在');
    response.success(res, task);
  };
}

function getResourceTasks(db, log) {
  return (req, res) => {
    const resourceId = req.query.resource_id;
    if (!resourceId) return response.badRequest(res, '缺少resource_id参数');
    try {
      const tasks = taskService.getTasksByResource(db, resourceId);
      response.success(res, tasks);
    } catch (err) {
      log.errorw('Get resource tasks failed', { error: err.message });
      response.internalError(res, err.message);
    }
  };
}

function cancelTaskStatus(db, log) {
  return (req, res) => {
    try {
      const result = taskService.cancelTask(db, log, req.params.task_id, req.body?.reason);
      if (!result.ok && result.reason === 'not_found') {
        return response.notFound(res, '任务不存在');
      }
      response.success(res, result.task || { id: req.params.task_id });
    } catch (err) {
      log.errorw('Cancel task failed', { error: err.message, task_id: req.params.task_id });
      response.internalError(res, err.message);
    }
  };
}

module.exports = function taskRoutes(db, log) {
  return {
    getEpisodeTasks: getEpisodeTasks(db, log),
    getTaskStatus: getTaskStatus(db, log),
    getResourceTasks: getResourceTasks(db, log),
    cancelTaskStatus: cancelTaskStatus(db, log),
  };
};
