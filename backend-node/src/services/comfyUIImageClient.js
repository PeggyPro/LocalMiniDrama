const timers = require('node:timers/promises');
const { flattenModelIds, pickModelId } = require('./modelId');
const { resolveComfyUIImage } = require('./comfyUIVideoClient');

const QWEN_IMAGE_MODEL = 'huobao_qwen_image_2_1_reference_api';
const MAX_REFERENCE_IMAGES = 16;
const HTTP_TIMEOUT_MS = 30000;
const IMAGE_TIMEOUT_MS = 600000;
const POLL_INTERVAL_MS = 1000;

function getComfyUIImageModel(config, model) {
  return pickModelId(model) || pickModelId(config?.default_model) || flattenModelIds(config?.model)[0] || '';
}

function getComfyUIImageCapabilities(model) {
  return model === QWEN_IMAGE_MODEL
    ? { supports_references: true, supports_text_to_image: true, max_reference_images: MAX_REFERENCE_IMAGES }
    : null;
}

// Explicit proxy protocols/paths retain their existing HTTP routing.
function isNativeComfyUIImageConfig(config, model) {
  if (!config) return false;
  const serviceType = String(config.service_type || '').trim().toLowerCase();
  if (serviceType && !['image', 'storyboard_image'].includes(serviceType)) return false;
  const selected = getComfyUIImageModel(config, model);
  const protocol = String(config.api_protocol || '').trim().toLowerCase();
  if (protocol) return protocol === 'comfyui' && (!!serviceType || selected === QWEN_IMAGE_MODEL);
  if (String(config.endpoint || '').trim() || String(config.query_endpoint || '').trim()) return false;
  if (selected === QWEN_IMAGE_MODEL) return true;
  return !!serviceType && /^(comfyui|comfuui)$/i.test(String(config.provider || '').trim());
}

function safeMessage(value, secrets = []) {
  let message = String(value?.message || value || '未知错误');
  for (const secret of secrets) {
    if (secret) message = message.split(String(secret)).join('[已隐藏]');
  }
  return message
    .replace(/data:image\/[^\s"']+/gi, '[图片数据]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [已隐藏]')
    .replace(/([?&](?:token|api_key|key|secret|password)=)[^&\s"']+/gi, '$1[已隐藏]')
    .slice(0, 500);
}

function nativeUrl(config) {
  try {
    const url = new URL(String(config.base_url || '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid URL');
    return url.toString().replace(/\/+$/, '');
  } catch (_) {
    throw new Error('ComfyUI 地址无效，请填写原生 ComfyUI 的 HTTP 地址（例如 http://127.0.0.1:8188）');
  }
}

async function getConnection(log) {
  const { getComfyUIBridgeConnection } = require('./comfyUIBridgeProcess');
  const connection = await getComfyUIBridgeConnection({ log });
  if (!connection?.baseUrl || !connection?.token) throw new Error('本地 ComfyUI 桥接服务未返回有效连接，请检查 Python 启动日志');
  return connection;
}

async function bridgeRequest(connection, config, route, body, timeoutMs = HTTP_TIMEOUT_MS) {
  const response = await fetch(String(connection.baseUrl).replace(/\/+$/, '') + route, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(body ? { 'Content-Type': 'application/json' } : (config.api_key ? { 'X-ComfyUI-Token': config.api_key } : {})),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))),
  });
  let data;
  try { data = JSON.parse(await response.text()); }
  catch (_) { throw new Error(`本地 ComfyUI 桥接服务返回非 JSON 响应（HTTP ${response.status}）`); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('本地 ComfyUI 桥接服务返回无效响应');
  if (!response.ok) throw new Error(`本地 ComfyUI 请求失败（HTTP ${response.status}）：${safeMessage(data.error || data.message || '请检查桥接服务', [config.api_key, connection.token])}`);
  return data;
}

function requireSupportedModel(model) {
  if (!getComfyUIImageCapabilities(model)) throw new Error('请选择已适配的 ComfyUI Qwen-Image2.1 多参考图模型 huobao_qwen_image_2_1_reference_api');
}

/** Check node/model metadata only: never read reference files or queue a prompt. */
async function validateComfyUIImageConnection(config, log, modelHint) {
  let connection;
  try {
    const model = getComfyUIImageModel(config, modelHint);
    requireSupportedModel(model);
    const url = nativeUrl(config);
    connection = await getConnection(log);
    const data = await bridgeRequest(connection, config, '/image/validate', {
      model,
      comfyui_url: url,
      ...(config.api_key ? { comfyui_token: config.api_key } : {}),
      prompt: 'Connection dependency check',
      reference_urls: [],
      size: '1664x928',
      seed: 42,
    });
    if (data.valid !== true || data.model !== model) throw new Error(data.error || 'ComfyUI 未确认所选图片工作流依赖可用，请检查 Qwen-Image2.1 节点和模型文件');
    return { valid: true, model, capabilities: data.capabilities || getComfyUIImageCapabilities(model) };
  } catch (error) {
    throw new Error(safeMessage(error, [config?.api_key, connection?.token]));
  }
}

async function completedImage(config, data, timeoutMs) {
  const raw = String(data.image_url || '');
  if (/^data:image\//i.test(raw)) return { image_url: await resolveComfyUIImage(raw) };
  let url;
  const base = new URL(nativeUrl(config));
  try {
    url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== base.origin || url.pathname !== base.pathname.replace(/\/+$/, '') + '/view') throw new Error('unexpected URL');
  } catch (_) { throw new Error('ComfyUI 任务完成但未返回有效的原生 /view 图片地址'); }
  if (!config.api_key) return { image_url: url.toString() };

  // The generic image saver has no native token: fetch protected output here.
  // Disallow redirects so a ComfyUI token cannot reach another origin.
  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${config.api_key}` },
    redirect: 'error',
    signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))),
  });
  if (!response.ok) throw new Error(`ComfyUI 图片下载失败（HTTP ${response.status}）`);
  const mime = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!/^image\/[a-z0-9.+-]+$/.test(mime)) throw new Error('ComfyUI 图片下载返回了非图片内容');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error('ComfyUI 图片下载返回了空文件');
  return { image_url: `data:${mime};base64,${bytes.toString('base64')}` };
}

/** Submit once, then poll that same task; polling failures must never queue a duplicate. */
async function callComfyUIImageApi(config, log, opts = {}) {
  let connection;
  let taskId;
  try {
    const model = getComfyUIImageModel(config, opts.model);
    requireSupportedModel(model);
    const url = nativeUrl(config);
    const refs = opts.reference_image_urls ?? opts.reference_urls ?? [];
    if (!Array.isArray(refs)) throw new Error('ComfyUI 参考图列表格式无效，请重新选择参考图');
    if (refs.length > MAX_REFERENCE_IMAGES) throw new Error(`Qwen-Image2.1 节点最多支持 ${MAX_REFERENCE_IMAGES} 张参考图（含尾帧的首帧站位锁），当前 ${refs.length} 张；请减少参考图后重试，系统不会截断参考图`);
    const referenceUrls = [];
    for (let index = 0; index < refs.length; index++) {
      referenceUrls.push(await resolveComfyUIImage(refs[index], opts, `第 ${index + 1} 张参考图`));
    }
    const body = {
      model,
      comfyui_url: url,
      ...(config.api_key ? { comfyui_token: config.api_key } : {}),
      prompt: String(opts.prompt || ''),
      ...(opts.negative_prompt ? { negative_prompt: String(opts.negative_prompt) } : {}),
      reference_urls: referenceUrls,
      size: opts.size || '1664x928',
      ...(opts.seed != null ? { seed: opts.seed } : {}),
    };
    connection = await getConnection(log);
    const deadline = Date.now() + IMAGE_TIMEOUT_MS;
    const remaining = () => {
      const ms = deadline - Date.now();
      if (ms <= 0) throw new Error('本地 ComfyUI 图片生成查询超时；已提交的任务仍可能运行，请先检查 ComfyUI 队列再决定是否重新生成');
      return Math.min(HTTP_TIMEOUT_MS, ms);
    };
    log?.info?.('[ComfyUI] 提交本地图片工作流', { image_gen_id: opts.image_gen_id, model, reference_count: referenceUrls.length });
    let data = await bridgeRequest(connection, config, '/image/generations', body, remaining());
    if (!/^lmd-comfy-[a-f0-9]{32}$/.test(String(data.task_id || ''))) throw new Error('ComfyUI 桥接服务未返回有效的本地图片任务 ID');
    taskId = data.task_id;
    for (;;) {
      if (data.status === 'failed' || data.error) throw new Error(data.error || '本地 ComfyUI 图片任务失败');
      if (data.status === 'completed') return await completedImage(config, data, remaining());
      if (data.status !== 'processing') throw new Error('本地 ComfyUI 桥接服务返回未知图片任务状态');
      data = await bridgeRequest(connection, config, `/image/task/${encodeURIComponent(taskId)}`, undefined, remaining());
      if (data.status === 'processing' && !data.error) await timers.setTimeout(Math.min(POLL_INTERVAL_MS, remaining()));
    }
  } catch (error) {
    return { error: safeMessage(error, [config?.api_key, connection?.token]), ...(taskId ? { task_id: taskId } : {}) };
  }
}

module.exports = { QWEN_IMAGE_MODEL, getComfyUIImageModel, getComfyUIImageCapabilities, isNativeComfyUIImageConfig, validateComfyUIImageConnection, callComfyUIImageApi };
