/**
 * 小说/长文章节导入服务
 * 功能：上传 txt/docx 内容 → AI 识别章节分割 → 自动填充各集剧本
 */
const aiClient = require('./aiClient');

function invalidInput(message) {
  return Object.assign(new Error(message), { statusCode: 400, code: 'BAD_REQUEST' });
}

function parseMaxChapters(value) {
  if (value === undefined) return 20;
  if ((typeof value !== 'number' && typeof value !== 'string') ||
      (typeof value === 'string' && !/^\d+$/.test(value.trim()))) {
    throw invalidInput('max_chapters 必须为正整数');
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit <= 0) throw invalidInput('max_chapters 必须为正整数');
  return limit;
}

/**
 * 简单的章节检测（不调用 AI，基于规则）
 * 识别常见章节标题格式
 */
function detectChaptersByRules(text) {
  const lines = text.split(/\r?\n/);
  const chapterPatterns = [
    /^第[零一二三四五六七八九十百千\d]+[章集]/,
    /^第[零一二三四五六七八九十百千\d]+节/,
    /^Chapter\s+\d+/i,
    /^CHAPTER\s+\d+/,
    /^\d+[\.、]\s*.{2,20}$/,
    /^【.{1,30}】$/,
    /^「.{1,30}」$/,
  ];
  const chapters = [];
  let currentStart = 0;
  let currentTitle = '序章';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const isChapter = chapterPatterns.some((p) => p.test(line));
    if (isChapter) {
      if (i > currentStart) {
        const content = lines.slice(currentStart, i).join('\n').trim();
        if (content) {
          chapters.push({ title: currentTitle, content });
        }
      }
      currentTitle = line;
      currentStart = i + 1;
    }
  }
  // 最后一章
  const lastContent = lines.slice(currentStart).join('\n').trim();
  if (lastContent) {
    chapters.push({ title: currentTitle, content: lastContent });
  }
  return chapters;
}

/**
 * 用 AI 将章节内容摘要为剧本形式
 */
async function summarizeChapterToScript(db, log, chapterTitle, chapterContent, dramaTitle) {
  const maxLen = 2000;
  const truncated = chapterContent.length > maxLen ? chapterContent.slice(0, maxLen) + '...' : chapterContent;
  const userPrompt = `小说名称：${dramaTitle || '未知'}
章节标题：${chapterTitle}

章节原文（部分）：
${truncated}

请将上述章节内容改写为短剧剧本格式，包含：场景描述、角色对话、动作说明。输出为中文纯文本，不需要 JSON 格式，长度200-500字。`;

  try {
    const result = await aiClient.generateText(db, log, 'text', userPrompt, null, {
      scene_key: 'novel_import',
      max_tokens: 800,
      temperature: 0.7,
    });
    return typeof result === 'string' && result.trim() ? result.trim() : chapterContent;
  } catch (err) {
    log.warn('[小说导入] AI改写章节失败，使用完整原文', { error: err.message });
    return chapterContent;
  }
}

/**
 * 主入口：解析小说文本，返回章节列表
 * @returns {{ chapters: Array<{title, content, script}> }}
 */
async function importNovel(db, log, { text, title, maxChapters, aiSummarize } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw invalidInput('小说内容不能为空，且必须为文本');
  if (title != null && typeof title !== 'string') throw invalidInput('小说标题必须为文本');
  const maxChapterCount = parseMaxChapters(maxChapters);
  const chapters = detectChaptersByRules(text);
  if (chapters.length === 0) {
    // 没有检测到章节，整个文本作为一章
    chapters.push({ title: title || '第一集', content: text.trim() });
  }

  const limit = Math.min(maxChapterCount, chapters.length);
  const result = [];

  for (let i = 0; i < limit; i++) {
    const ch = chapters[i];
    let script = ch.content;
    if (aiSummarize === true || aiSummarize === 'true') {
      script = await summarizeChapterToScript(db, log, ch.title, ch.content, title);
    }
    result.push({
      index: i + 1,
      title: ch.title,
      content: ch.content,
      script,
    });
  }

  return { chapters: result, total: chapters.length };
}

module.exports = { importNovel, detectChaptersByRules };
