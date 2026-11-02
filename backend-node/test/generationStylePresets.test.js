const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveStylePreset } = require('../src/constants/generationStylePresets');

const EXTRA = [
  '2d gufeng',
  'xianxia 3d',
  'gufeng 3d',
  'neo chinese guochao',
  'neo gufeng',
  'urban romance comic',
  'korean romance webtoon',
];

for (const value of EXTRA) {
  test(`resolves ${value}`, () => {
    const p = resolveStylePreset(value);
    assert.ok(p, `missing preset ${value}`);
    assert.ok(p.zh.length > 10);
    assert.ok(p.en.length > 10);
  });
}

test('custom is not a preset', () => {
  assert.equal(resolveStylePreset('custom'), null);
});

test('historical style stays scene-neutral and matches the frontend preset', async () => {
  const { findStyleOption } = await import('../../frontweb/src/constants/styleOptions.js');
  const preset = resolveStylePreset('historical');
  const option = findStyleOption('historical');
  assert.equal(preset.zh, option.prompt);
  assert.equal(preset.en, option.promptEn);
  assert.match(preset.en, /Chinese historical drama/);
  assert.doesNotMatch(preset.en, /imperial palace|classical garden|rich warm color grading/i);
  assert.doesNotMatch(preset.zh, /皇宫殿宇|古典园林|浓郁暖调/);
  assert.match(preset.en, /follow the described scene and reference images/);
});
