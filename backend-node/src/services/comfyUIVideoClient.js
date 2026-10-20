const fs = require('node:fs/promises');
const path = require('node:path');
const { flattenModelIds, pickModelId } = require('./modelId');

const COMFYUI_TASK_PREFIX = 'lmd-comfy-';
const H3_MODEL = 'huobao_minimax_h3_reference_turbo_api';
const WAN_MODEL = 'huobao_wan22_5b_t2v_32gb_api';
const MODEL_CAPABILITIES = Object.freeze({
  [H3_MODEL]: Object.freeze({ supports_first_frame: true, supports_last_frame: true, supports_references: true, max_reference_images: 9 }),
  [WAN_MODEL]: Object.freeze({ supports_first_frame: true, supports_last_frame: false, supports_references: false, max_reference_images: 1, reference_mode: 'single_first_frame' }),
});
const HTTP_TIMEOUT_MS = 30000;

function getComfyUIVideoCapabilities(model) {
  const capabilities = MODEL_CAPABILITIES[String(model || '').trim()];
  return capabilities ? { ...capabilities } : null;
}

/** Explicit HTTP proxy paths and other explicit protocols keep their existing routing. */
function isNativeComfyUIConfig(config, model) {
  if (!config) return false;
  const protocol = String(config.api_protocol || '').trim().toLowerCase();
  if (protocol) return protocol === 'comfyui';
  if (String(config.endpoint || '').trim() || String(config.query_endpoint || '').trim()) return false;
  const selected = pickModelId(model) || pickModelId(config.default_model) || flattenModelIds(config.model)[0] || '';
  if (MODEL_CAPABILITIES[selected]) return true;
  const provider = String(config.provider || '').trim().toLowerCase();
  if (/comfyui|comfuui/i.test(provider)) return true;
  return ['', 'openai', 'custom'].includes(provider) && /comfyui|comfuui/i.test(String(config.name || ''));
}

function isComfyUITaskId(taskId) {
  return typeof taskId === 'string' && taskId.startsWith(COMFYUI_TASK_PREFIX);
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

function isWithinDirectory(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function normalizeDataImage(raw, label) {
  const match = /^data:(image\/[a-z0-9.+-]+)(;[^,]*)?,([\s\S]*)$/i.exec(raw);
  if (!match) throw new Error(`ComfyUI ${label}不是有效的图片 data URL，请重新上传图片`);
  let bytes;
  if (/(?:^|;)base64(?:;|$)/i.test(match[2] || '')) {
    const encoded = match[3].replace(/\s/g, '');
    if (!/^[a-z0-9+/]*={0,2}$/i.test(encoded) || encoded.length % 4 === 1) {
      throw new Error(`ComfyUI ${label}的 base64 图片数据无效，请重新上传图片`);
    }
    bytes = Buffer.from(encoded, 'base64');
  } else {
    const parts = match[3].match(/%[0-9a-f]{2}|[^%]+/gi) || [];
    if (parts.join('') !== match[3]) throw new Error(`ComfyUI ${label}的图片数据无法解码，请重新上传图片`);
    bytes = Buffer.concat(parts.map((part) => part.startsWith('%') ? Buffer.from([parseInt(part.slice(1), 16)]) : Buffer.from(part, 'utf8')));
  }
  if (!bytes.length) throw new Error(`ComfyUI ${label}的图片数据为空，请重新上传图片`);
  return `data:${match[1].toLowerCase()};base64,${bytes.toString('base64')}`;
}

/** Read local inputs directly: bridge requests must never depend on an image hosting service. */
async function resolveComfyUIImage(rawInput, { files_base_url, storage_local_path } = {}, label = '参考图') {
  const raw = String(rawInput || '').trim();
  if (!raw) throw new Error(`ComfyUI ${label}为空，请重新选择图片`);
  if (/^data:/i.test(raw)) return normalizeDataImage(raw, label);

  let relative = raw.replace(/\\/g, '/').split(/[?#]/)[0];
  if (/^https?:\/\//i.test(raw)) {
    let url;
    try { url = new URL(raw); }
    catch (_) { throw new Error(`ComfyUI ${label}的图片 URL 无效`); }
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const isLoopback = hostname === 'localhost' || hostname.endsWith('.localhost') || /^127\./.test(hostname) || hostname === '::1' || hostname === '0.0.0.0';
    let storageBase = null;
    try { if (files_base_url) storageBase = new URL(files_base_url); } catch (_) {}
    const basePath = storageBase?.pathname.replace(/\/+$/, '') || '';
    const isStorageUrl = storageBase && url.origin === storageBase.origin && url.pathname.startsWith(basePath + '/');
    if (!isLoopback && !isStorageUrl) return raw;
    relative = isStorageUrl ? url.pathname.slice(basePath.length + 1) : url.pathname;
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !path.isAbsolute(raw)) {
    throw new Error(`ComfyUI ${label}的图片地址不受支持，请使用本地图片或 HTTP 图片 URL`);
  }

  if (!storage_local_path) throw new Error(`ComfyUI ${label}无法读取：未配置本地图片存储目录`);
  try { relative = decodeURIComponent(relative); }
  catch (_) { throw new Error(`ComfyUI ${label}的本地图片路径编码无效`); }
  relative = relative.replace(/\\/g, '/').replace(/^\/?static\//i, '');
  if (!/^[a-z]:\//i.test(relative)) relative = relative.replace(/^\/+/, '');
  const root = path.resolve(storage_local_path);
  const target = path.resolve(root, relative);
  if (!isWithinDirectory(root, target)) throw new Error(`ComfyUI ${label}不在本地图片存储目录内，请重新上传图片`);
  let realRoot, realTarget, bytes;
  try {
    [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
    if (!isWithinDirectory(realRoot, realTarget)) throw new Error('outside storage');
    bytes = await fs.readFile(realTarget);
  } catch (_) {
    throw new Error(`ComfyUI ${label}无法读取，请确认图片仍保存在本地存储目录并重新上传`);
  }
  if (!bytes.length) throw new Error(`ComfyUI ${label}的本地图片文件为空，请重新上传图片`);
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif', '.svg': 'image/svg+xml' }[path.extname(realTarget).toLowerCase()] || 'image/png';
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

async function getConnection(config, log) {
  const { getComfyUIBridgeConnection } = require('./comfyUIBridgeProcess');
  const connection = await getComfyUIBridgeConnection({ log });
  if (!connection?.baseUrl || !connection?.token) throw new Error('本地 ComfyUI 桥接服务未返回有效连接，请检查 Python 启动日志');
  return connection;
}

async function bridgeRequest(connection, config, route, body) {
  const response = await fetch(String(connection.baseUrl).replace(/\/+$/, '') + route, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${connection.token}`, ...(body ? { 'Content-Type': 'application/json' } : (config.api_key ? { 'X-ComfyUI-Token': config.api_key } : {})) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  let data;
  try { data = JSON.parse(await response.text()); }
  catch (_) { throw new Error(`本地 ComfyUI 桥接服务返回非 JSON 响应（HTTP ${response.status}）`); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('本地 ComfyUI 桥接服务返回无效响应');
  if (!response.ok) {
    throw new Error(`本地 ComfyUI 请求失败（HTTP ${response.status}）：${safeMessage(data.error || data.message || '请检查桥接服务', [config.api_key, connection.token])}`);
  }
  return data;
}

/** Preview validates actual workflow dependencies without uploading images or submitting a prompt. */
async function validateComfyUIVideoConnection(config, log, modelHint) {
  let connection;
  try {
    const model = pickModelId(modelHint) || pickModelId(config.default_model) || flattenModelIds(config.model)[0] || '';
    if (!getComfyUIVideoCapabilities(model)) throw new Error('请选择已适配的火宝 MiniMax H3 或 Wan2.2 5B 模型再测试连接');
    let nativeUrl;
    try {
      nativeUrl = new URL(String(config.base_url || '').trim());
      if (!['http:', 'https:'].includes(nativeUrl.protocol)) throw new Error('invalid protocol');
    } catch (_) { throw new Error('ComfyUI 地址无效，请填写原生 ComfyUI 的 HTTP 地址（例如 http://127.0.0.1:8188）'); }
    connection = await getConnection(config, log);
    const data = await bridgeRequest(connection, config, '/video/validate', {
      model,
      comfyui_url: nativeUrl.toString().replace(/\/+$/, ''),
      ...(config.api_key ? { comfyui_token: config.api_key } : {}),
      prompt: 'Connection dependency check',
      duration: 1,
      seed: 42,
    });
    if (data.valid !== true || data.model !== model) {
      throw new Error(safeMessage(data.error || 'ComfyUI 未确认所选工作流依赖可用，请检查火宝节点和模型文件', [config.api_key, connection.token]));
    }
    return { valid: true, model, capabilities: data.capabilities };
  } catch (error) {
    throw new Error(safeMessage(error, [config?.api_key, connection?.token]));
  }
}

async function callComfyUIVideoApi(config, log, opts = {}) {
  let connection;
  const model = String(opts.model || '').trim();
  const capabilities = getComfyUIVideoCapabilities(model);
  try {
    if (!capabilities) return { error: `本地 ComfyUI 尚未适配模型 ${model || '（未选择）'}，请选择火宝 MiniMax H3 或 Wan2.2 5B 工作流` };
    if (opts.reference_urls != null && !Array.isArray(opts.reference_urls)) throw new Error('ComfyUI 参考图列表格式无效，请重新选择参考图');
    const refs = opts.reference_urls || [];
    const explicitFirst = String(opts.first_frame_url || opts.first_frame_local_path || '').trim();
    const primary = String(opts.image_url || '').trim();
    const last = String(opts.last_frame_url || opts.last_frame_local_path || '').trim();
    if (!capabilities.supports_last_frame && last) throw new Error('Wan2.2 5B 工作流不支持尾帧约束，请移除尾帧或改用支持首尾帧的 MiniMax H3 模型');
    if (capabilities.supports_references && refs.length > capabilities.max_reference_images) throw new Error(`MiniMax H3 工作流最多支持 ${capabilities.max_reference_images} 张参考图，请减少参考图后重试`);

    // Keep references in their original order and frame roles separate, including equal images.
    const referenceUrls = [];
    for (let index = 0; index < refs.length; index++) {
      referenceUrls.push(await resolveComfyUIImage(refs[index], opts, `第 ${index + 1} 张参考图`));
    }
    const firstFrameUrl = explicitFirst ? await resolveComfyUIImage(explicitFirst, opts, '首帧') : null;
    const lastFrameUrl = last ? await resolveComfyUIImage(last, opts, '尾帧') : null;
    const primaryUrl = primary ? await resolveComfyUIImage(primary, opts, '输入图片') : null;
    if (capabilities.supports_references) {
      if (primaryUrl && referenceUrls.length && !referenceUrls.includes(primaryUrl)) {
        throw new Error('MiniMax H3 请将所有参考图片按提示词编号放入参考图列表，输入图片不能与参考图列表不一致');
      }
      if (primaryUrl && !referenceUrls.length) referenceUrls.push(primaryUrl);
    } else {
      const uniqueImages = new Set([firstFrameUrl, primaryUrl, ...referenceUrls].filter(Boolean));
      if (uniqueImages.size > 1) throw new Error(`Wan2.2 5B 工作流只支持一张首帧图，当前收到 ${uniqueImages.size} 张不同图片。请保留一张完整首帧，或改用支持多参考图的 MiniMax H3 模型`);
    }
    let comfyuiUrl;
    try {
      comfyuiUrl = new URL(String(config.base_url || '').trim());
      if (!['http:', 'https:'].includes(comfyuiUrl.protocol)) throw new Error('invalid protocol');
    } catch (_) { throw new Error('ComfyUI 地址无效，请在 AI 配置中填写原生 ComfyUI 的 HTTP 地址（例如 http://127.0.0.1:8188）'); }
    const body = {
      model,
      prompt: String(opts.prompt || ''),
      ...(opts.duration != null ? { duration: opts.duration } : {}),
      aspect_ratio: opts.aspect_ratio || '16:9',
      ...(opts.resolution ? { resolution: opts.resolution } : {}),
      ...(opts.seed != null ? { seed: opts.seed } : {}),
      reference_urls: referenceUrls,
      ...(primaryUrl ? { image_url: primaryUrl } : {}),
      ...(firstFrameUrl ? { first_frame_url: firstFrameUrl } : {}),
      ...(lastFrameUrl ? { last_frame_url: lastFrameUrl } : {}),
      comfyui_url: comfyuiUrl.toString().replace(/\/+$/, ''),
      ...(config.api_key ? { comfyui_token: config.api_key } : {}),
    };
    connection = await getConnection(config, log);
    log?.info?.('[ComfyUI] 提交本地工作流', { video_gen_id: opts.video_gen_id, model, reference_count: referenceUrls.length, has_image: !!primaryUrl, has_first_frame: !!firstFrameUrl, has_last_frame: !!lastFrameUrl });
    const data = await bridgeRequest(connection, config, '/video/generations', body);
    if (data.status === 'failed' || data.error) throw new Error(safeMessage(data.error || 'ComfyUI 视频任务失败', [config.api_key, connection.token]));
    if (data.status === 'completed') {
      if (!/^https?:\/\//i.test(String(data.video_url || ''))) throw new Error('ComfyUI 任务完成但未返回可下载的视频地址');
      return { video_url: data.video_url, status: 'completed', ...(data.prompt_id ? { prompt_id: data.prompt_id } : {}) };
    }
    if (data.status !== 'processing' || !isComfyUITaskId(data.task_id)) throw new Error('ComfyUI 桥接服务未返回有效的本地任务 ID 和处理状态');
    return { task_id: data.task_id, status: 'processing', ...(data.prompt_id ? { prompt_id: data.prompt_id } : {}) };
  } catch (error) {
    return { error: safeMessage(error, [config.api_key, connection?.token]), ...(capabilities ? { capabilities } : {}) };
  }
}

async function pollComfyUIVideoTask(config, log, taskId, maxAttempts = 300, intervalMs = 10000, { video_gen_id, onProgress } = {}) {
  let connection;
  try {
    if (!isComfyUITaskId(taskId)) throw new Error('无效的本地 ComfyUI 任务 ID，请重新生成视频');
    const attempts = Number.isFinite(Number(maxAttempts)) ? Math.max(0, Math.min(10000, Math.floor(Number(maxAttempts)))) : 300;
    const interval = Number.isFinite(Number(intervalMs)) ? Math.max(0, Math.min(2147483647, Number(intervalMs))) : 10000;
    if (!attempts) return { error: '本地 ComfyUI 视频生成查询超时，可稍后继续查询已有任务' };
    connection = await getConnection(config, log);
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt && interval) await new Promise((resolve) => setTimeout(resolve, interval));
      const data = await bridgeRequest(connection, config, `/video/task/${encodeURIComponent(taskId)}`);
      log?.info?.('[ComfyUI] 本地任务状态', { video_gen_id, task_id: taskId, attempt: attempt + 1, status: ['processing', 'completed', 'failed'].includes(data.status) ? data.status : 'unknown', progress: typeof data.progress === 'number' ? data.progress : undefined });
      if (data.status === 'failed' || data.error) throw new Error(safeMessage(data.error || '本地 ComfyUI 视频任务失败', [config.api_key, connection.token]));
      if (data.status === 'completed') {
        if (!/^https?:\/\//i.test(String(data.video_url || ''))) throw new Error('ComfyUI 任务完成但未返回可下载的视频地址');
        return { video_url: data.video_url, ...(data.prompt_id ? { prompt_id: data.prompt_id } : {}) };
      }
      if (data.status !== 'processing') throw new Error('本地 ComfyUI 桥接服务返回未知任务状态');
      if (onProgress) onProgress(data.progress);
    }
    return { error: '本地 ComfyUI 视频生成查询超时，可稍后继续查询已有任务' };
  } catch (error) {
    return { error: safeMessage(error, [config?.api_key, connection?.token]) };
  }
}

module.exports = { isNativeComfyUIConfig, isComfyUITaskId, getComfyUIVideoCapabilities, resolveComfyUIImage, validateComfyUIVideoConnection, callComfyUIVideoApi, pollComfyUIVideoTask };
