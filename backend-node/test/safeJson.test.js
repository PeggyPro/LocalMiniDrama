'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { safeParseAIJSON, extractFirstArray } = require('../src/utils/safeJson');
const log = { warn() {} };

function parseWithMeta(raw, target = null) {
  const meta = {};
  return { parsed: safeParseAIJSON(raw, target, log, meta), meta };
}

test('deep repair of a first storyboard cut inside its recommendation string retains truncation metadata', () => {
  const storyboard = { shot_number: 1, title: 'waiting', action: 'wait', duration: 5,
    video_prompt: 'Static camera.', video_recommendation: { model_id: 'h3-drama', reason: 'unfinished' } };
  const raw = JSON.stringify([storyboard]).slice(0, -4);
  const target = [];
  const { parsed, meta } = parseWithMeta(raw, target);
  assert.deepEqual(parsed, [storyboard]);
  assert.deepEqual(target, parsed);
  assert.equal(meta.truncated, true);
  assert.equal(meta.repairedIncomplete, true);
});

test('deep repair flags unclosed containers and strings even without a complete object to salvage', async (t) => {
  const cases = [
    ['array', '[1,2', [1, 2]],
    ['nested object', '{"value":{"count":2', { value: { count: 2 } }],
    ['nested array', '{"value":[1,2', { value: [1, 2] }],
    ['string ending in escaped quote', '{"value":"unfinished\\"', { value: 'unfinished"' }],
    // jsonrepair may interpret these braces as closing syntax; metadata must still reflect the unclosed original string.
    ['braces inside unfinished string', '{"value":"unfinished } ]', { value: 'unfinished' }],
    ['wrapper closing brace missing', '{"storyboards":[{"shot_number":1}]', { storyboards: [{ shot_number: 1 }] }],
    ['missing opening quote plus unfinished container', '{"title":分镜标题","count":2', { title: '分镜标题', count: 2 }],
  ];
  for (const [name, raw, expected] of cases) {
    await t.test(name, () => {
      const { parsed, meta } = parseWithMeta(raw);
      assert.deepEqual(parsed, expected);
      assert.equal(meta.truncated, true);
      assert.equal(meta.repairedIncomplete, true);
    });
  }
});

test('salvaging complete items from unfinished arrays or wrappers still marks the response truncated', async (t) => {
  const cases = [
    ['array', '[{"shot_number":1},{"shot_number":2,"title":"unfinished'],
    ['wrapper', '{"storyboards":[{"shot_number":1},{"shot_number":2,"title":"unfinished'],
    ['array with repairable complete item', '[{shot_number:1},{"shot_number":2,"title":"unfinished'],
    ['wrapper with repairable complete item', '{"storyboards":[{shot_number:1},{"shot_number":2,"title":"unfinished'],
  ];
  for (const [name, raw] of cases) {
    await t.test(name, () => {
      const { parsed, meta } = parseWithMeta(raw);
      assert.deepEqual(extractFirstArray(parsed), [{ shot_number: 1 }]);
      assert.equal(meta.truncated, true);
      assert.notEqual(meta.repairedIncomplete, true);
    });
  }
});

test('rough-cut repair that completes a nested half-item reports repairedIncomplete for arrays and wrappers', () => {
  const partial = '[{"shot_number":1,"video_recommendation":{"model_id":"h3-drama"},"title":"unfinished';
  for (const raw of [partial, '{"storyboards":' + partial]) {
    const { parsed, meta } = parseWithMeta(raw);
    assert.deepEqual(extractFirstArray(parsed), [{ shot_number: 1, video_recommendation: { model_id: 'h3-drama' } }]);
    assert.equal(meta.truncated, true);
    assert.equal(meta.repairedIncomplete, true);
  }
});

test('structurally complete repairable JSON is not mislabeled or partially salvaged as truncated', async (t) => {
  const escaped = { value: 'escaped " and slash \\ with braces } [', next: 2 };
  const cases = [
    ['missing comma in object', '{"a":1 "b":2}', { a: 1, b: 2 }],
    ['colon inside complete string', '{"video_prompt":"主体: 走路","duration":5 "shot_number":1}',
      { video_prompt: '主体: 走路', duration: 5, shot_number: 1 }],
    ['missing comma in array', '[{"a":1} {"b":2}]', [{ a: 1 }, { b: 2 }]],
    ['wrapped array with missing comma', '{"storyboards":[{"shot_number":1 "title":"first"}]}',
      { storyboards: [{ shot_number: 1, title: 'first' }] }],
    ['missing opening string quote', '{"title":分镜标题","count":2}', { title: '分镜标题', count: 2 }],
    ['bare keys', '{title: waiting, count: 2}', { title: 'waiting', count: 2 }],
    ['escaped quotes and braces in strings', JSON.stringify(escaped).replace(',"next"', ' "next"'), escaped],
    ['single quoted string with opening braces', "{'value':'{ [ are text','count':2}", { value: '{ [ are text', count: 2 }],
  ];
  for (const [name, raw, expected] of cases) {
    await t.test(name, () => {
      const { parsed, meta } = parseWithMeta(raw);
      assert.deepEqual(parsed, expected);
      assert.equal(meta.truncated, false);
      assert.notEqual(meta.repairedIncomplete, true);
    });
  }
});

test('valid JSON and fenced complete responses keep their established parsed values', () => {
  const expected = { storyboards: [{ shot_number: 1, title: 'quoted " bracket } text' }] };
  for (const raw of [JSON.stringify(expected), '```json\n' + JSON.stringify(expected) + '\n```']) {
    const { parsed, meta } = parseWithMeta(raw);
    assert.deepEqual(parsed, expected);
    assert.notEqual(meta.truncated, true);
  }
});
