'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const createRouter = require('../src/routes/videoPlanning');

async function invoke(router, method, path, req = {}) {
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route.methods[method]);
  assert.ok(layer, `route ${method} ${path}`);
  const res = { statusCode: 200, payload: null, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return this; } };
  await layer.route.stack[0].handle({ params: {}, query: {}, body: {}, ...req }, res);
  return res;
}

test('capabilities and planning reads work without loading execution or starting any service', async () => {
  const router = createRouter({}, {}, {}, { planning: { getEpisodeVideoPlans: (db, id) => ({ items: [], episode_id: id }) } });
  const caps = await invoke(router, 'get', '/capabilities');
  assert.equal(caps.statusCode, 200);
  assert.equal(caps.payload.success, true);
  assert.ok(caps.payload.timestamp);
  assert.equal(caps.payload.data.items[0].runtime_verified, false);
  const read = await invoke(router, 'get', '/episodes/:episodeId', { params: { episodeId: '10' } });
  assert.equal(read.payload.data.episode_id, '10');
});

test('all execution routes delegate exact arguments, preserving frozen plan CAS and explicit adoption intent', async () => {
  const db = {}, cfg = { marker: 'cfg' }, log = {};
  const calls = [];
  const execution = Object.fromEntries(['listSources', 'previewPlan', 'runPlan', 'getPlan', 'resumePlan', 'listVersions', 'adoptVersion'].map((name) => [name, (...args) => {
    calls.push({ name, args }); return { delegated: name };
  }]));
  const router = createRouter(db, cfg, log, { execution });
  const preview = { episode_id: 10, storyboard_ids: [101], inputs: { 101: { prompt: 'same prompt', duration: 6 } }, append_version_id: 'exact-version' };
  const cases = [
    ['get', '/sources', { query: { drama_id: '1' } }, 'listSources', [db, '1']],
    ['post', '/plans/preview', { body: preview }, 'previewPlan', [db, cfg, log, preview]],
    ['post', '/plans/:id/run', { params: { id: 'plan' }, body: { expected_revision: 4 } }, 'runPlan', [db, cfg, log, 'plan', { expected_revision: 4 }]],
    ['get', '/plans/:id', { params: { id: 'plan' } }, 'getPlan', [db, 'plan']],
    ['post', '/plans/:id/resume', { params: { id: 'plan' } }, 'resumePlan', [db, cfg, log, 'plan']],
    ['get', '/storyboards/:id/versions', { params: { id: '101' } }, 'listVersions', [db, '101']],
    ['put', '/storyboards/:id/adoption', { params: { id: '101' }, body: { expected_revision: 3, version_id: 'v-1' } }, 'adoptVersion', [db, '101', { expected_revision: 3, version_id: 'v-1' }]],
  ];
  for (const [method, path, req, name, args] of cases) {
    const res = await invoke(router, method, path, req);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls.at(-1), { name, args });
  }
});

test('choice and re-recommendation are delegated without implicit GPU execution', async () => {
  const calls = [];
  const plans = {
    setVideoChoice(...args) { calls.push(['choice', args]); return { choice: { revision: 2 } }; },
    async recommendEpisodeVideoPlans(...args) { calls.push(['recommend', args]); return { items: [] }; },
  };
  const db = {}, cfg = {}, log = {};
  const router = createRouter(db, cfg, log, { planning: plans, execution: new Proxy({}, { get() { throw Error('No GPU endpoint expected'); } }) });
  await invoke(router, 'put', '/storyboards/:id/choice', { params: { id: '101' }, body: { expected_revision: 1, manual_locked: false } });
  await invoke(router, 'post', '/episodes/:episodeId/recommend', { params: { episodeId: '10' }, body: { strategy: 'heuristic' } });
  assert.deepEqual(calls, [
    ['choice', [db, '101', { expected_revision: 1, manual_locked: false }]],
    ['recommend', [db, cfg, log, '10', { strategy: 'heuristic' }]],
  ]);
});

test('domain errors retain the existing response envelope and 400/404/409 status, internals remain hidden', async () => {
  for (const statusCode of [400, 404, 409, 500]) {
    const router = createRouter({}, {}, { error() {} }, { planning: { setVideoChoice() {
      throw Object.assign(Error('local path or internal detail'), { statusCode, code: 'TEST_CODE', details: { state: 'blocked' } });
    } } });
    const res = await invoke(router, 'put', '/storyboards/:id/choice');
    assert.equal(res.statusCode, statusCode);
    assert.equal(res.payload.success, false);
    if (statusCode === 500) {
      assert.equal(res.payload.error.message, '视频规划请求失败');
      assert.equal(res.payload.error.details, undefined);
    } else assert.deepEqual(res.payload.error.details, { state: 'blocked' });
  }
});
