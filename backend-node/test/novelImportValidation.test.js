const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const aiClient = require('../src/services/aiClient');
const { importNovel, detectChaptersByRules } = require('../src/services/novelImportService');
const log = { info() {}, warn() {}, error() {} };
const novel = Array.from({ length: 25 }, (_, i) => `第${i + 1}章 章节${i + 1}\n章节${i + 1}的完整正文。`).join('\n');

describe('novel import validation and complete episode input', () => {
  for (const value of [null, false, true, 0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1,
    '', ' ', '0', '-1', '2.5', '2e1', '2 chapters', [], {}, [2]]) {
    it(`rejects invalid maxChapters ${JSON.stringify(value)} without calling AI`, async (t) => {
      const ai = t.mock.method(aiClient, 'generateText', () => { throw new Error('must not call AI'); });
      await assert.rejects(importNovel(null, log, { text: novel, maxChapters: value, aiSummarize: true }),
        (err) => err.statusCode === 400 && err.code === 'BAD_REQUEST' && /max_chapters/.test(err.message));
      assert.equal(ai.mock.callCount(), 0);
    });
  }

  for (const value of [undefined, 2, '2', ' 2 ', Number.MAX_SAFE_INTEGER]) {
    it(`applies a positive integer/default chapter limit ${JSON.stringify(value)} on the server`, async (t) => {
      const ai = t.mock.method(aiClient, 'generateText', () => { throw new Error('must not call AI'); });
      const result = await importNovel(null, log, { text: novel, maxChapters: value, aiSummarize: false });
      assert.equal(result.chapters.length, Math.min(value === undefined ? 20 : Number(value), 25));
      assert.equal(result.total, 25);
      assert.equal(ai.mock.callCount(), 0);
    });
  }

  for (const text of [undefined, null, '', '  ', 42, {}, ['text']]) {
    it(`rejects invalid novel text ${JSON.stringify(text)}`, async () => {
      await assert.rejects(importNovel(null, log, { text }), (err) => err.statusCode === 400);
    });
  }

  it('returns full original content and script, with the existing response fields', async (t) => {
    t.mock.method(aiClient, 'generateText', () => { throw new Error('must not call AI'); });
    const body = '这是完整章节正文，包含开场、转折和结局。'.repeat(120) + '这是正文最后一句，必须保留。';
    const result = await importNovel(null, log, { text: `第1章 开始\n${body}\n第2章 后续\n故事完整结局。`, maxChapters: '1' });
    assert.equal(result.total, 2);
    assert.equal(result.chapters.length, 1);
    assert.deepEqual(result.chapters[0], { index: 1, title: '第1章 开始', content: body, script: body });
  });

  it('keeps short chapters and short prefaces instead of silently dropping source text', () => {
    assert.deepEqual(detectChaptersByRules('序言。\n第1章 开场\n来了。\n第2章 结束\n走了。'), [
      { title: '序章', content: '序言。' },
      { title: '第1章 开场', content: '来了。' },
      { title: '第2章 结束', content: '走了。' },
    ]);
  });

  it('recognizes numbered episode headings like chapter headings and retains the preface', async (t) => {
    const ai = t.mock.method(aiClient, 'generateText', () => { throw new Error('must not call AI'); });
    const result = await importNovel(null, log, { text: '序言。\n第1集 开场\n开场原文。\n第二集 结束\n最后原文。', aiSummarize: false });
    assert.deepEqual(result.chapters.map(({ title, content }) => ({ title, content })), [
      { title: '序章', content: '序言。' }, { title: '第1集 开场', content: '开场原文。' }, { title: '第二集 结束', content: '最后原文。' },
    ]);
    assert.equal(ai.mock.callCount(), 0);
  });

  it('uses complete text as one episode when there are no chapter headings', async () => {
    const body = '没有章节标题的整篇小说正文。'.repeat(100);
    const result = await importNovel(null, log, { text: body });
    assert.equal(result.total, 1);
    assert.equal(result.chapters[0].content, body);
    assert.equal(result.chapters[0].script, body);
  });

  for (const outcome of ['success', 'empty', 'error']) {
    it(`keeps full chapter content when optional AI rewriting returns ${outcome}`, async (t) => {
      const body = '完整原始正文。'.repeat(100);
      t.mock.method(aiClient, 'generateText', async () => {
        if (outcome === 'error') throw new Error('mock AI failure');
        return outcome === 'empty' ? '  ' : '改写后的剧本正文。';
      });
      const result = await importNovel(null, log, { text: `第1章 开场\n${body}`, aiSummarize: true });
      assert.equal(result.chapters[0].content, body);
      assert.equal(result.chapters[0].script, outcome === 'success' ? '改写后的剧本正文。' : body);
    });
  }

  it('treats string false as disabled and never accidentally calls AI', async (t) => {
    const ai = t.mock.method(aiClient, 'generateText', () => { throw new Error('must not call AI'); });
    const result = await importNovel(null, log, { text: '短正文。', aiSummarize: 'false' });
    assert.equal(result.chapters[0].script, '短正文。');
    assert.equal(ai.mock.callCount(), 0);
  });
});
