'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyShot, heuristicRecommendations, hasCutInstructions } = require('../src/services/videoRecommendationPolicy');

const shot = (number, prompt, extras = {}) => ({ id: number, storyboard_number: number, video_prompt: prompt,
  scene_id: 10, location: '泥屋', time: '黄昏', duration: 5, ...extras });
const recommendations = (rows, choices) => heuristicRecommendations(rows, choices);

test('visual emphasis separates ordinary movement, character performance, and intense action', () => {
  const cases = [
    [{ video_prompt: '村口空镜，镜头缓推，炊烟升起' }, 'standard'],
    [{ video_prompt: '木桌上的粗陶碗特写' }, 'standard'],
    [{ action: '她走到门口，打开木门' }, 'standard'],
    [{ action: '她扶起男人，将饼递给他，神情迟疑' }, 'drama'],
    [{ action: '她把手中的藏饼动作做得很轻' }, 'drama'],
    [{ action: '两人坐在桌前', dialogue: '你为什么回来？' }, 'drama'],
    [{ action: '男人挥拳攻向对手，对手翻滚躲闪' }, 'action'],
    [{ video_prompt: '士兵追逐逃犯，双方在巷内快速攻防' }, 'action'],
    [{ video_prompt: '她低语：“昨夜的战斗太惨烈。”现在安静地落泪', dialogue: '昨夜的战斗太惨烈。' }, 'drama'],
    [{ title: '战斗回忆', action: '他低头沉默', dialogue: '记得那场战斗吗？' }, 'drama'],
    [{ video_prompt: '山村空镜，无打斗，无追逐，no combat', dialogue: '无对白' }, 'standard'],
    [{ title: '战斗', action: '平静走路', video_prompt: '没有激烈打斗，慢慢走到门口' }, 'standard'],
    [{ title: '追逐战斗' }, 'action'],
    [{}, 'standard'],
  ];
  for (const [row, category] of cases) assert.equal(classifyShot(row).category, category, JSON.stringify(row));
});

test('universal shot routing uses the universal visual text rather than obsolete classic combat text', () => {
  assert.equal(classifyShot({ creation_mode: 'universal', video_prompt: '激烈战斗',
    universal_segment_text: '人物眼神迟疑，慢慢落泪' }).category, 'drama');
  assert.equal(classifyShot({ creation_mode: 'universal', video_prompt: '',
    universal_segment_text: '骑兵追逐，挥刀劈砍' }).category, 'action');
});

test('duration alone never reserves a latent first segment or fabricates a continuation', () => {
  for (const duration of [5, 12, 13, 30, 60]) {
    const result = recommendations([shot(1, '空镜，缓推村口', { duration }), shot(2, '两人搏斗', { duration })]);
    assert.deepEqual(result.map((item) => item.model_id), ['h3-standard', 'h3-action']);
    assert.ok(result.every((item) => !item.predecessor));
  }
});

test('same actors/place and a generic uncut instruction do not establish a previous-tail relationship', () => {
  const result = recommendations([shot(1, '母亲含泪看向门外'), shot(2, '母亲含泪看着门外，保持连续跟拍，不切镜')]);
  assert.deepEqual(result.map((item) => item.model_id), ['h3-drama', 'h3-drama']);
});

test('explicit adjacent tail continuity plans paired drama and action chains', () => {
  for (const [content, family] of [['人物含泪凝视', 'drama'], ['双方挥拳搏斗', 'action']]) {
    const result = recommendations([shot(1, content), shot(2, `承接上一镜末帧，${content}，不切镜`), shot(3, `从前镜尾帧继续，${content}，no cuts`)]);
    assert.deepEqual(result.map((item) => item.model_id), [`h3-long-${family}-first`, `h3-long-${family}-continue`, `h3-long-${family}-continue`]);
    assert.deepEqual(result[2].predecessor, { kind: 'draft_shot', shot_number: 2 });
    assert.equal(result[2].continuous_shot, true);
  }
});

test('gaps, unknown/changed space-time, camera reset, negation, cuts and cross-family action break heuristic continuation', () => {
  const head = shot(1, '人物含泪凝视');
  const tail = shot(2, '承接上一镜末帧，人物含泪凝视，不切镜');
  const pairs = [
    [head, { ...tail, storyboard_number: 3 }],
    [head, { ...tail, scene_id: 11 }],
    [head, { ...tail, time: '次日清晨' }],
    [head, { ...tail, location: '城楼' }],
    [{ ...head, time: null }, { ...tail, time: null }],
    [{ ...head, shot_type: '中景' }, { ...tail, shot_type: '特写' }],
    [head, { ...tail, video_prompt: '不要承接上一镜末帧，人物独自落泪' }],
    [head, { ...tail, video_prompt: '不需要承接上一镜末帧，人物独自落泪' }],
    [head, { ...tail, video_prompt: '承接上一镜末帧，随后硬切至另一间房' }],
    [head, { ...tail, universal_segment_text: '正反打，另起机位' }],
    [shot(1, '人物挥拳搏斗'), tail],
    [head, shot(2, '承接上一镜末帧，人物挥拳搏斗')],
  ];
  for (const pair of pairs) assert.ok(recommendations(pair).every((item) => !item.model_id.includes('long')), JSON.stringify(pair));
  assert.equal(recommendations([tail])[0].model_id, 'h3-drama');
});

test('manual single/stale sources stay locked and do not cause automatic latent upgrades', () => {
  const rows = [shot(1, '人物凝视'), shot(2, '承接上一镜末帧，人物凝视')];
  for (const source of [
    { model_id: 'h3-standard', manual_locked: true, validation_state: 'ready' },
    { model_id: 'h3-long-action-first', manual_locked: true, validation_state: 'ready' },
    { model_id: 'h3-long-drama-first', manual_locked: true, validation_state: 'stale' },
  ]) assert.equal(recommendations(rows, new Map([[1, source]]))[1].model_id, 'h3-drama');
  const result = recommendations(rows, new Map([[1, { model_id: 'h3-long-drama-first', manual_locked: true, validation_state: 'ready' }]]));
  assert.equal(result[1].model_id, 'h3-long-drama-continue');
});

test('continuation intent comes only from the active prompt and rejects negated English requests', () => {
  const head = shot(1, '人物凝视');
  for (const prefix of ['Do not continue', "Don't continue", 'Never resume', 'No need to continue']) {
    const tail = shot(2, `${prefix} from the previous shot last frame. 人物凝视`);
    assert.equal(recommendations([head, tail])[1].model_id, 'h3-drama', prefix);
  }
  const universal = shot(2, '承接上一镜末帧，人物凝视', { creation_mode: 'universal', universal_segment_text: '人物沉默，眼神迟疑' });
  assert.equal(recommendations([head, universal])[1].model_id, 'h3-drama');
  const classic = shot(2, '人物沉默，眼神迟疑', { creation_mode: 'classic', universal_segment_text: '承接上一镜末帧，人物凝视' });
  assert.equal(recommendations([head, classic])[1].model_id, 'h3-drama');
  assert.equal(recommendations([head, shot(2, 'Continue from the previous shot last frame. 人物凝视')])[1].model_id, 'h3-long-drama-continue');
});

test('cut detection shares explicit reset checks with execution and preserves negated cut instructions', () => {
  for (const video_prompt of ['硬切到室外', '切到另一房间', 'hard cut to the street', '正反打', '机位重置', '时间跳跃']) assert.equal(hasCutInstructions({ video_prompt }), true, video_prompt);
  for (const video_prompt of ['连续缓推，不切镜，无硬切，禁止转场，无正反打，无时间跳跃', 'no cuts, no hard cuts, without jump cuts', '保持连续跟拍，镜头缓缓横移']) assert.equal(hasCutInstructions({ video_prompt }), false, video_prompt);
});
