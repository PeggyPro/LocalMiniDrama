// 从本集剧本提取道具；完整校验后仅替换本集拥有的道具。
const taskService = require('./taskService');
const aiClient = require('./aiClient');
const promptI18n = require('./promptI18n');
const propService = require('./propService');

function taskIsActive(db, taskId) {
  const task = taskService.getTask(db, taskId);
  return task && (task.status === 'pending' || task.status === 'processing');
}

function getActiveEpisode(db, episodeId) {
  return db.prepare(
    `SELECT e.id, e.drama_id, e.script_content FROM episodes e
     INNER JOIN dramas d ON d.id = e.drama_id AND d.deleted_at IS NULL
     WHERE e.id = ? AND e.deleted_at IS NULL`
  ).get(Number(episodeId));
}

function assertExtractionCurrent(db, taskId, episode) {
  if (!taskIsActive(db, taskId)) throw new Error('道具提取任务已取消或失效');
  const current = getActiveEpisode(db, episode.id);
  if (!current) throw new Error('剧集不存在或已删除');
  if (current.drama_id !== episode.drama_id || current.script_content !== episode.script_content) {
    throw new Error('剧本内容已变更，请重新提取道具');
  }
}

function parseExtractedProps(response) {
  if (typeof response !== 'string' || !response.trim()) throw new Error('AI返回内容为空');
  // 替换操作不能使用截断修复：部分数组不能代表本集完整的道具集合。
  const text = response.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const parsed = JSON.parse(text);
  const items = Array.isArray(parsed) ? parsed : parsed && parsed.props;
  if (!Array.isArray(items)) throw new Error('AI返回的道具列表格式无效');
  const names = new Set();
  const props = [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.name !== 'string' || !item.name.trim()) {
      throw new Error('AI返回的道具缺少有效名称');
    }
    for (const field of ['type', 'description', 'image_prompt']) {
      if (item[field] != null && typeof item[field] !== 'string') throw new Error('AI返回的道具字段格式无效');
    }
    const name = item.name.trim();
    if (names.has(name)) continue;
    names.add(name);
    props.push({
      name,
      type: item.type?.trim() || null,
      description: item.description?.trim() || null,
      prompt: item.image_prompt?.trim() || null,
    });
  }
  return props;
}

async function processPropExtraction(db, log, taskId, episodeId, providedCfg) {
  if (!taskIsActive(db, taskId)) return;
  taskService.updateTaskStatus(db, taskId, 'processing', 0, '正在分析剧本...');

  const episode = getActiveEpisode(db, episodeId);
  if (!episode) {
    taskService.updateTaskError(db, taskId, '剧集不存在');
    return;
  }

  const scriptContent = episode.script_content;
  if (!scriptContent || !String(scriptContent).trim()) {
    taskService.updateTaskError(db, taskId, '剧本内容为空');
    return;
  }

  const loadConfig = require('../config').loadConfig;
  let cfg = providedCfg || loadConfig();
  // 用项目的 aspect_ratio 和 style 覆盖全局配置，使 image_prompt 使用正确比例和风格
  try {
    const dramaRow = db.prepare('SELECT style, metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(episode.drama_id);
    if (dramaRow) {
      const { mergeCfgStyleWithDrama } = require('../utils/dramaStyleMerge');
      let next = { ...cfg, style: { ...(cfg?.style || {}), default_prop_style: '' } };
      if (dramaRow.metadata) {
        const meta = typeof dramaRow.metadata === 'string' ? JSON.parse(dramaRow.metadata) : dramaRow.metadata;
        if (meta && meta.aspect_ratio) {
          next.style.default_prop_ratio = meta.aspect_ratio;
          next.style.default_image_ratio = meta.aspect_ratio;
        }
      }
      cfg = mergeCfgStyleWithDrama(next, dramaRow);
    }
  } catch (_) {}
  const systemPrompt = promptI18n.getPropExtractionPrompt(cfg);
  const contentLabel = promptI18n.isEnglish(cfg) ? '[Script Content]\n' : '【剧本内容】\n';
  const prompt = contentLabel + String(scriptContent).trim();

  try {
    const response = await aiClient.generateText(db, log, 'text', prompt, systemPrompt, {
      scene_key: 'prop_extraction',
      max_tokens: 2000,
      temperature: 0.3,
    });
    assertExtractionCurrent(db, taskId, episode);
    let extractedProps;
    try {
      extractedProps = parseExtractedProps(response);
    } catch (err) {
      throw new Error('解析 AI 返回的道具 JSON 失败: ' + err.message);
    }

    taskService.updateTaskStatus(db, taskId, 'processing', 50, '正在保存道具...');
    const dramaId = episode.drama_id;
    // 显式 [] 可表示本集无关键道具，但不能据此清空用户已有资产。
    if (extractedProps.length === 0) {
      taskService.updateTaskResult(db, taskId, {
        props: [], count: 0, episode_id: episodeId, drama_id: dramaId,
        preserved_existing: true,
        warning: 'AI返回空道具列表，已保留现有道具',
      });
      return;
    }

    const createdProps = db.transaction(() => {
      assertExtractionCurrent(db, taskId, episode);
      const existing = db.prepare(
        'SELECT * FROM props WHERE drama_id = ? AND episode_id = ? AND deleted_at IS NULL ORDER BY id ASC'
      ).all(dramaId, episode.id);
      // 其他有效剧集显式引用的本集道具也是共享资产，提取不能改变其提示词或删除它。
      const sharedIds = new Set(db.prepare(
        `SELECT DISTINCT p.id FROM props p
         INNER JOIN storyboard_props sp ON sp.prop_id = p.id
         INNER JOIN storyboards sb ON sb.id = sp.storyboard_id AND sb.deleted_at IS NULL
         INNER JOIN episodes e ON e.id = sb.episode_id AND e.deleted_at IS NULL
         WHERE p.drama_id = ? AND p.episode_id = ? AND p.deleted_at IS NULL AND e.id <> ?`
      ).all(dramaId, episode.id, episode.id).map((row) => row.id));
      const byName = new Map();
      for (const prop of existing) {
        const name = String(prop.name || '').trim();
        const preferred = byName.get(name);
        if (!preferred || (sharedIds.has(preferred.id) && !sharedIds.has(prop.id))) byName.set(name, prop);
      }
      const keptIds = new Set();
      const result = [];
      const now = new Date().toISOString();
      for (const prop of extractedProps) {
        const previous = byName.get(prop.name);
        if (previous && sharedIds.has(previous.id)) {
          const next = {
            ...previous,
            name: prop.name,
            type: prop.type ?? previous.type,
            description: prop.description ?? previous.description,
            prompt: prop.prompt ?? previous.prompt,
          };
          const changed = ['name', 'type', 'description', 'prompt'].some((field) => next[field] !== previous[field]);
          if (changed) {
            const copy = propService.create(db, log, next);
            if (!copy) throw new Error('保存道具失败');
            db.prepare('UPDATE props SET extra_images = ?, ref_image = ? WHERE id = ?')
              .run(previous.extra_images ?? null, previous.ref_image ?? null, copy.id);
            keptIds.add(copy.id);
            result.push(propService.getById(db, copy.id));
          } else {
            keptIds.add(previous.id);
            result.push(propService.getById(db, previous.id));
          }
        } else if (previous) {
          // 同集重新提取复用 ID 和媒体；省略提示词时保留已有提示词。
          db.prepare(
            `UPDATE props SET type = COALESCE(?, type), description = COALESCE(?, description),
             prompt = COALESCE(?, prompt), updated_at = ?
             WHERE id = ? AND drama_id = ? AND episode_id = ? AND deleted_at IS NULL`
          ).run(prop.type, prop.description, prop.prompt, now, previous.id, dramaId, episode.id);
          keptIds.add(previous.id);
          result.push(propService.getById(db, previous.id));
        } else {
          const created = propService.create(db, log, { ...prop, drama_id: dramaId, episode_id: episode.id });
          if (!created) throw new Error('保存道具失败');
          keptIds.add(created.id);
          result.push(created);
        }
      }
      const retire = db.prepare(
        'UPDATE props SET deleted_at = ?, updated_at = ? WHERE id = ? AND episode_id = ? AND deleted_at IS NULL'
      );
      for (const previous of existing) {
        if (!keptIds.has(previous.id) && !sharedIds.has(previous.id)) retire.run(now, now, previous.id, episode.id);
      }
      return { props: result, preservedShared: [...sharedIds].filter((id) => !keptIds.has(id)).length };
    })();

    taskService.updateTaskResult(db, taskId, {
      props: createdProps.props,
      count: createdProps.props.length,
      episode_id: episodeId,
      drama_id: dramaId,
      ...(createdProps.preservedShared > 0 ? {
        preserved_shared: createdProps.preservedShared,
        warning: '已保留其他剧集正在使用的共享道具，变更已保存为本集独立副本',
      } : {}),
    });
    log.info('Prop extraction completed', { task_id: taskId, episode_id: episodeId, count: createdProps.props.length });
  } catch (err) {
    log.error('Prop extraction failed', { error: err.message, task_id: taskId });
    // 用户取消的任务保持原状态，不让迟到的 AI 响应覆盖它。
    if (taskIsActive(db, taskId)) taskService.updateTaskError(db, taskId, err.message || '道具提取失败');
  }
}

function extractPropsForEpisode(db, log, episodeId, cfg) {
  const episode = getActiveEpisode(db, episodeId);
  if (!episode) throw new Error('episode not found');
  if (!episode.script_content || !String(episode.script_content).trim()) {
    throw new Error('剧集剧本内容为空，无法提取道具');
  }

  const task = taskService.createTask(db, log, 'prop_extraction', String(episodeId));
  setImmediate(() => {
    processPropExtraction(db, log, task.id, episodeId, cfg).catch((err) => {
      log.error('processPropExtraction fatal', { error: err.message, task_id: task.id });
      if (taskIsActive(db, task.id)) taskService.updateTaskError(db, task.id, err.message);
    });
  });
  return task.id;
}

module.exports = {
  extractPropsForEpisode,
  processPropExtraction,
};
