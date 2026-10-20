#!/usr/bin/env node
/**
 * Sub2Api 中转站连通性 / 输出内容探针（只读测试，不改任何业务数据）
 *
 * 用法：
 *   node tools/test-sub2api.js              # 跑全部场景
 *   node tools/test-sub2api.js replica      # 只跑某个场景：replica | no-effort | effort-high | nonstream
 *   node tools/test-sub2api.js all gpt-6-astra   # 指定模型
 *
 * 场景说明：
 *   replica    —— 完全复刻「分镜生成」的请求参数：max_tokens=16384 + reasoning_effort=max（取自配置 settings）
 *   no-effort  —— 同上但不带 reasoning_effort
 *   effort-high—— 带 reasoning_effort=high
 *   nonstream  —— 非流式请求（看 reasoning_content / content 各自返回什么）
 *
 * 每个场景输出：HTTP 状态、是否 SSE、content 累计字符数、reasoning_content 累计字符数、
 * finish_reason、usage（含 reasoning tokens）、首尾原始数据行样本。
 */
const http = require('http');
const https = require('https');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'drama_generator.db');
const CONFIG_ID = Number(process.env.SUB2API_CONFIG_ID || 2);
const HARD_TIMEOUT_MS = 150 * 1000;
const SILENCE_TIMEOUT_MS = 60 * 1000;

const PROMPT_SYSTEM = '你是一个测试助手。';
const PROMPT_USER = '请只回复四个字：测试成功';

function loadConfig() {
  const db = new Database(DB_PATH, { readonly: true });
  const row = db.prepare('SELECT * FROM ai_service_configs WHERE id = ?').get(CONFIG_ID);
  db.close();
  if (!row) throw new Error(`ai_service_configs 中找不到 id=${CONFIG_ID}`);
  let settings = {};
  try { settings = typeof row.settings === 'string' ? JSON.parse(row.settings) : (row.settings || {}); } catch (_) {}
  let models = [];
  try { models = JSON.parse(row.model || '[]'); } catch (_) {}
  return { row, settings, models };
}

function buildUrl(config) {
  const base = (config.base_url || '').replace(/\/$/, '');
  let ep = config.endpoint || '/chat/completions';
  if (!ep.startsWith('/')) ep = '/' + ep;
  return base + ep;
}

function maskKey(k) {
  const s = String(k || '');
  return s.length <= 8 ? '(hidden)' : s.slice(0, 4) + '****' + s.slice(-4) + ` (len=${s.length})`;
}

/**
 * 发送一次请求（stream=true 时按 SSE 解析但保留全部原始行样本）。
 * 返回统计信息，不抛业务结论。
 */
function probeStream(url, apiKey, body, label) {
  return new Promise((resolve) => {
    const start = Date.now();
    const result = {
      label,
      ok: false,
      httpStatus: null,
      contentType: null,
      sawSSE: false,
      rawLineCount: 0,
      contentChars: 0,
      reasoningChars: 0,
      finishReasons: [],
      usage: null,
      firstTokenMs: null,
      elapsedMs: null,
      firstLines: [],
      lastLine: '',
      httpErrorBody: null,
      transportError: null,
    };

    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify({ ...body, stream: true });

    const finish = () => {
      if (result.elapsedMs == null) result.elapsedMs = Date.now() - start;
      resolve(result);
    };

    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      family: 4,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        Authorization: 'Bearer ' + (apiKey || ''),
      },
    }, (res) => {
      result.httpStatus = res.statusCode;
      result.contentType = res.headers['content-type'] || '';

      if (res.statusCode < 200 || res.statusCode >= 300) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          result.httpErrorBody = Buffer.concat(chunks).toString('utf-8').slice(0, 800);
          finish();
        });
        return;
      }

      let sseBuffer = '';
      const rawSamples = [];
      let totalLines = 0;

      res.on('data', (chunk) => {
        sseBuffer += chunk.toString('utf-8');
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          totalLines++;
          if (trimmed.startsWith('data:')) {
            result.sawSSE = true;
            const data = trimmed.slice(5).trim();
            if (data === '[DONE]') { result.lastLine = '[DONE]'; continue; }
            if (rawSamples.length < 6) rawSamples.push(data.slice(0, 300));
            result.lastLine = data.slice(0, 300);
            try {
              const evt = JSON.parse(data);
              const ch = evt.choices?.[0];
              const delta = ch?.delta || ch?.message || {};
              if (delta.content) {
                if (result.firstTokenMs == null) result.firstTokenMs = Date.now() - start;
                result.contentChars += String(delta.content).length;
              }
              if (delta.reasoning_content) {
                if (result.firstTokenMs == null) result.firstTokenMs = Date.now() - start;
                result.reasoningChars += String(delta.reasoning_content).length;
              }
              if (ch?.finish_reason && !result.finishReasons.includes(ch.finish_reason)) {
                result.finishReasons.push(ch.finish_reason);
              }
              if (evt.usage) result.usage = evt.usage;
            } catch (_) { /* 保留样本即可 */ }
          } else {
            // 非 SSE 行（可能是纯 JSON 响应或网关 HTML 错误页）
            if (rawSamples.length < 6) rawSamples.push(trimmed.slice(0, 300));
            result.lastLine = trimmed.slice(0, 300);
          }
        }
      });

      res.on('end', () => {
        result.rawLineCount = totalLines;
        result.firstLines = rawSamples;
        finish();
      });
      res.on('error', (e) => { result.transportError = String(e.message || e); finish(); });
    });

    req.on('error', (e) => { result.transportError = String(e.message || e); finish(); });
    req.setTimeout(SILENCE_TIMEOUT_MS, () => {
      result.transportError = `silence timeout ${SILENCE_TIMEOUT_MS}ms（${SILENCE_TIMEOUT_MS / 1000}s 无任何数据）`;
      req.destroy();
      finish();
    });
    req.write(bodyStr);
    req.end();

    setTimeout(() => {
      if (result.elapsedMs == null) {
        result.transportError = `hard timeout ${HARD_TIMEOUT_MS}ms`;
        req.destroy();
        finish();
      }
    }, HARD_TIMEOUT_MS);
  });
}

/** 非流式请求：直接看返回 JSON 里 content / reasoning_content 的真实取值 */
function probeNonStream(url, apiKey, body, label) {
  return new Promise((resolve) => {
    const start = Date.now();
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(body); // 不加 stream
    const result = { label, httpStatus: null, elapsedMs: null, transportError: null, raw: null };
    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      family: 4,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        Authorization: 'Bearer ' + (apiKey || ''),
      },
    }, (res) => {
      result.httpStatus = res.statusCode;
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        result.elapsedMs = Date.now() - start;
        try {
          const j = JSON.parse(text);
          const msg = j.choices?.[0]?.message || {};
          result.raw = {
            content_len: String(msg.content || '').length,
            content_preview: String(msg.content || '').slice(0, 120),
            reasoning_len: String(msg.reasoning_content || '').length,
            reasoning_preview: String(msg.reasoning_content || '').slice(0, 120),
            finish_reason: j.choices?.[0]?.finish_reason || null,
            usage: j.usage || null,
            error: j.error || null,
          };
        } catch (_) {
          result.raw = { unparseable_body: text.slice(0, 500) };
        }
        resolve(result);
      });
      res.on('error', (e) => { result.transportError = String(e.message || e); result.elapsedMs = Date.now() - start; resolve(result); });
    });
    req.on('error', (e) => { result.transportError = String(e.message || e); result.elapsedMs = Date.now() - start; resolve(result); });
    req.setTimeout(HARD_TIMEOUT_MS, () => { req.destroy(); result.transportError = 'timeout'; resolve(result); });
    req.write(bodyStr);
    req.end();
  });
}

function printResult(r) {
  console.log('\n===== ' + r.label + ' =====');
  if (r.raw) {
    console.log('http', r.httpStatus, 'elapsed', r.elapsedMs + 'ms');
    console.log('nonstream result:', JSON.stringify(r.raw, null, 1));
    return;
  }
  console.log('http', r.httpStatus, '| content-type', r.contentType, '| elapsed', r.elapsedMs + 'ms', '| first_token', r.firstTokenMs != null ? r.firstTokenMs + 'ms' : '(无)');
  console.log('SSE:', r.sawSSE, '| 原始行数:', r.rawLineCount);
  console.log('content 累计字符:', r.contentChars, '| reasoning_content 累计字符:', r.reasoningChars);
  console.log('finish_reason:', JSON.stringify(r.finishReasons), '| usage:', JSON.stringify(r.usage));
  if (r.transportError) console.log('transport_error:', r.transportError);
  if (r.httpErrorBody) console.log('http error body:', r.httpErrorBody);
  if (r.firstLines.length) {
    console.log('原始数据样本（前几行）:');
    for (const l of r.firstLines) console.log('  |', l);
  }
  if (r.lastLine) console.log('最后一行:', r.lastLine);
  // 结论提示（仅提示，不改配置）
  if (r.httpStatus && r.httpStatus >= 200 && r.httpStatus < 300) {
    if (!r.sawSSE) console.log('>> 提示：返回的不是 SSE 流（应用的解析器会静默吞掉，最终报「AI 返回内容为空」）');
    else if (r.contentChars === 0 && r.reasoningChars > 0) console.log('>> 提示：只有推理内容、没有正文 —— 应用只累计正文 delta，会报「AI 返回内容为空」');
    else if (r.contentChars === 0) console.log('>> 提示：正文和推理都没收到内容');
    else console.log('>> 提示：正文正常返回');
  }
}

async function main() {
  const { row, settings, models } = loadConfig();
  const scenario = (process.argv[2] || 'all').toLowerCase();
  const modelArg = process.argv[3] || row.default_model || models[0];
  const apiKey = row.api_key;
  const url = buildUrl(row);

  console.log('Sub2Api 探针 | config_id=' + row.id, '| provider=' + row.provider, '| name=' + row.name);
  console.log('url:', url);
  console.log('api_key:', maskKey(apiKey));
  console.log('models:', JSON.stringify(models), '| 默认:', row.default_model);
  console.log('settings:', row.settings);
  console.log('测试模型:', modelArg, '| 场景:', scenario);

  const baseBody = {
    model: modelArg,
    messages: [
      { role: 'system', content: PROMPT_SYSTEM },
      { role: 'user', content: PROMPT_USER },
    ],
    temperature: 0.7,
    max_tokens: 16384, // 与分镜生成 DEFAULT_STORYBOARD_MAX_TOKENS 一致
  };
  const effort = settings.reasoning_effort;

  const scenarios = {
    replica: () => probeStream(url, apiKey, { ...baseBody, ...(effort ? { reasoning_effort: effort } : {}) }, `流式 · reasoning_effort=${effort || '(无)'} · max_tokens=16384（分镜真实参数）`),
    'no-effort': () => probeStream(url, apiKey, baseBody, '流式 · 不带 reasoning_effort · max_tokens=16384'),
    'effort-high': () => probeStream(url, apiKey, { ...baseBody, reasoning_effort: 'high' }, '流式 · reasoning_effort=high · max_tokens=16384'),
    nonstream: () => probeNonStream(url, apiKey, { ...baseBody, ...(effort ? { reasoning_effort: effort } : {}) }, `非流式 · reasoning_effort=${effort || '(无)'}`),
    // 重负载：长输出任务，逼近分镜真实场景（推理 + 长正文共用 16384 token）
    heavy: () => probeStream(url, apiKey, {
      model: modelArg,
      messages: [
        { role: 'system', content: '你是一个专业的编剧。' },
        {
          role: 'user',
          content: '请为一部都市复仇短剧写分镜脚本，输出严格的 JSON，包含至少 20 个分镜，每个分镜要有画面描述、台词、镜头运动，画面描述不少于 100 字。只输出 JSON。',
        },
      ],
      temperature: 0.7,
      max_tokens: 16384,
      ...(effort ? { reasoning_effort: effort } : {}),
    }, `流式 · 重负载（20 个分镜 JSON）· reasoning_effort=${effort || '(无)'} · max_tokens=16384`),
    // 对照组：同样的重负载，但推理档位=high
    'heavy-high': () => probeStream(url, apiKey, {
      model: modelArg,
      messages: [
        { role: 'system', content: '你是一个专业的编剧。' },
        {
          role: 'user',
          content: '请为一部都市复仇短剧写分镜脚本，输出严格的 JSON，包含至少 20 个分镜，每个分镜要有画面描述、台词、镜头运动，画面描述不少于 100 字。只输出 JSON。',
        },
      ],
      temperature: 0.7,
      max_tokens: 16384,
      reasoning_effort: 'high',
    }, '流式 · 重负载（20 个分镜 JSON）· reasoning_effort=high · max_tokens=16384'),
  };

  const todo = scenario === 'all' ? Object.keys(scenarios) : [scenario];
  for (const name of todo) {
    if (!scenarios[name]) { console.log('未知场景:', name, '可选:', Object.keys(scenarios).join(', ')); continue; }
    printResult(await scenarios[name]());
  }
  console.log('\n探针执行完毕（全程只读，未修改任何配置）。');
}

main().catch((e) => { console.error('探针失败:', e); process.exit(1); });
