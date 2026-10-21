const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const aiClient = require('../src/services/aiClient');
const aiConfigService = require('../src/services/aiConfigService');

const contentEvent = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const DONE = 'data: [DONE]\n\n';
const calls = [
  { name: 'generateText', send: (log, options, onText) => aiClient.generateText(null, log, 'text', 'prompt', '', { ...options, streamCallback: onText }) },
  { name: 'streamGenerateText', send: (log, options, onText) => aiClient.streamGenerateText(null, log, 'text', 'prompt', '', options, onText) },
];

async function fixture(t, respond, settings = {}) {
  const requests = [];
  const timers = [];
  const later = (ms, fn) => timers.push(setTimeout(fn, ms));
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      respond(res, later);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    return new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  });
  const config = {
    id: 1, service_type: 'text', is_active: true, is_default: true,
    base_url: `http://127.0.0.1:${server.address().port}`, api_key: 'test-key',
    model: ['test-model'], settings,
  };
  t.mock.method(aiConfigService, 'listConfigs', () => [config]);
  const entries = [];
  const log = { info: (message, data) => entries.push({ message, ...data }), warn() {}, error() {} };
  return { config, log, requests, entries };
}

for (const call of calls) {
  test(`${call.name}: timeout defaults, settings and options stay local and validate bad inputs`, async (t) => {
    const { config, log, requests, entries } = await fixture(t, (res) => res.end(contentEvent('正文') + DONE));
    const cases = [
      { settings: null, options: {}, expected: [300000, 180000] },
      { settings: '{bad json', options: {}, expected: [300000, 180000] },
      { settings: JSON.stringify({ first_response_timeout_ms: 2500, silence_timeout_ms: 1500, reasoning_effort: 'high' }), options: {}, expected: [2500, 1500] },
      { settings: { first_response_timeout_ms: 2500, silence_timeout_ms: 1500 }, options: { first_response_timeout_ms: '1200', silence_timeout_ms: 700 }, expected: [1200, 700] },
      ...[null, '', 0, -1, NaN, Infinity, 2147483648, true, 'bad'].map((value) => ({
        settings: { first_response_timeout_ms: 2500, silence_timeout_ms: 1500 },
        options: { first_response_timeout_ms: value, silence_timeout_ms: value }, expected: [2500, 1500],
      })),
      { settings: { first_response_timeout_ms: -1, silence_timeout_ms: 'NaN' }, options: {}, expected: [300000, 180000] },
    ];
    for (const entry of cases) {
      config.settings = entry.settings;
      assert.equal(await call.send(log, entry.options), '正文');
      const logged = entries.findLast((e) => e.message.endsWith(' request'));
      assert.deepEqual([logged.first_response_timeout_ms, logged.silence_timeout_ms], entry.expected);
      assert.equal('first_response_timeout_ms' in requests.at(-1), false);
      assert.equal('silence_timeout_ms' in requests.at(-1), false);
      assert.equal(requests.at(-1).reasoning_effort, typeof entry.settings === 'string' && entry.settings.startsWith('{"first') ? 'high' : undefined);
    }
  });

  test(`${call.name}: delayed headers/content use the longer first-response window`, async (t) => {
    for (const flushHeaders of [false, true]) {
      await t.test(flushHeaders ? 'headers before content' : 'no headers until content', async (t) => {
        const { log } = await fixture(t, (res, later) => {
          if (flushHeaders) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.flushHeaders();
          }
          later(200, () => res.end(contentEvent('慢启动成功') + DONE));
        }, { first_response_timeout_ms: 1500, silence_timeout_ms: 80 });
        assert.equal(await call.send(log, {}), '慢启动成功');
      });
    }
  });

  test(`${call.name}: reasoning and heartbeat bytes renew the pre-content inactivity window`, async (t) => {
    const { log } = await fixture(t, (res, later) => {
      res.write('data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}\n\n');
      later(120, () => res.write(': heartbeat\n\n'));
      later(240, () => res.write('data: {"choices":[{"delta":{"reasoning_content":"继续思考"}}]}\n\n'));
      later(360, () => res.end(contentEvent('仅正文') + DONE));
    });
    // 总等待超过 300ms，但单次静默不超过 300ms；没有正文时不能切到 40ms。
    assert.equal(await call.send(log, { first_response_timeout_ms: 300, silence_timeout_ms: 40 }), '仅正文');
  });

  test(`${call.name}: a truly silent request fails in the startup phase and closes upstream`, async (t) => {
    let markClosed;
    const closed = new Promise((resolve) => { markClosed = resolve; });
    const { log, requests } = await fixture(t, (res) => {
      res.on('close', markClosed);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
    });
    await assert.rejects(call.send(log, { first_response_timeout_ms: 100, silence_timeout_ms: 20 }), (error) => {
      assert.equal(error.code, 'AI_STREAM_TIMEOUT');
      assert.equal(error.phase, 'first_response');
      assert.equal(error.timeoutMs, 100);
      return true;
    });
    await closed;
    assert.equal(requests.length, 1, 'a timeout must not retry a paid generation');
  });

  test(`${call.name}: first visible text switches to the shorter stream silence window`, async (t) => {
    let markClosed;
    const closed = new Promise((resolve) => { markClosed = resolve; });
    const { log } = await fixture(t, (res) => {
      res.on('close', markClosed);
      res.write(contentEvent('开头'));
    });
    const output = [];
    await assert.rejects(call.send(log, { first_response_timeout_ms: 1500, silence_timeout_ms: 80 }, (text) => output.push(text)), (error) => {
      assert.equal(error.phase, 'stream');
      assert.equal(error.timeoutMs, 80);
      return true;
    });
    await closed;
    assert.deepEqual(output, ['开头']);
  });

  test(`${call.name}: DONE resolves even if the proxy holds the connection open`, async (t) => {
    const { log } = await fixture(t, (res) => {
      res.write(contentEvent('已经完成') + DONE + contentEvent('不得追加'));
      // 故意不 res.end()；原实现会在这里等待至超时。
    });
    const output = [];
    assert.equal(await call.send(log, { first_response_timeout_ms: 1500, silence_timeout_ms: 80 }, (text) => output.push(text)), '已经完成');
    assert.deepEqual(output, ['已经完成']);
  });

  test(`${call.name}: split UTF-8 and an unterminated final SSE line retain all text`, async (t) => {
    const { log } = await fixture(t, (res, later) => {
      const bytes = Buffer.from(contentEvent('中文正文').trimEnd());
      const split = bytes.indexOf(Buffer.from('中')) + 1;
      res.write(bytes.subarray(0, split));
      later(20, () => res.end(bytes.subarray(split)));
    });
    assert.equal(await call.send(log, {}), '中文正文');
  });

  test(`${call.name}: interrupted HTTP error bodies report the connection failure promptly`, async (t) => {
    const { log } = await fixture(t, (res, later) => {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.write('{"error":');
      later(20, () => res.destroy());
    });
    await assert.rejects(call.send(log, { first_response_timeout_ms: 1500 }), (error) => {
      assert.notEqual(error.code, 'AI_STREAM_TIMEOUT');
      assert.match(error.message, /aborted|reset|closed|hang up/i);
      return true;
    });
  });
}
