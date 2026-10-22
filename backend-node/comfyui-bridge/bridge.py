#!/usr/bin/env python3
"""LocalMiniDrama's managed, stdlib-only adapter for native ComfyUI image/video jobs."""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import re
import secrets
import signal
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlencode, urlparse
from urllib.request import Request, urlopen

SERVICE = "localminidrama-comfyui-bridge"
VERSION = 1
ROOT = Path(__file__).resolve().parent
MAX_IMAGE = 32 * 1024 * 1024
MAX_BODY = 128 * 1024 * 1024
MODEL_H3 = "huobao_minimax_h3_reference_turbo_api"
MODEL_WAN = "huobao_wan22_5b_t2v_32gb_api"
MODEL_QWEN_REFERENCE = "huobao_qwen_image_2_1_reference_api"
IMAGE_MODELS = {
    MODEL_QWEN_REFERENCE: {"name": "Qwen-Image 2.1 多参考图", "max_reference_images": 16,
                           "reference_mode": "ordered_independent_references", "supports_text_to_image": True},
}
MODELS = {
    MODEL_H3: {"name": "MiniMax H3 Turbo", "max_reference_images": 9,
               "supports_first_frame": True, "supports_last_frame": True,
               "reference_mode": "independent_references", "fps": 24},
    MODEL_WAN: {"name": "Wan 2.2 TI2V 5B", "max_reference_images": 1,
                "supports_first_frame": True, "supports_last_frame": False,
                "reference_mode": "single_first_frame", "fps": 24},
}


class BridgeError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def native_url(value):
    value = str(value or "").strip().rstrip("/")
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
        raise BridgeError("ComfyUI 地址必须是有效的 HTTP(S) 服务地址")
    if parsed.query or parsed.fragment:
        raise BridgeError("ComfyUI 基础地址不能带查询参数或片段")
    return value


def read_limited(response, limit):
    if int(response.headers.get("Content-Length", "0") or 0) > limit:
        raise BridgeError("响应文件超过允许大小")
    chunks, size = [], 0
    while True:
        chunk = response.read(min(65536, limit + 1 - size))
        if not chunk:
            return b"".join(chunks)
        size += len(chunk)
        if size > limit:
            raise BridgeError("响应文件超过允许大小")
        chunks.append(chunk)


def image_bytes(value):
    if not isinstance(value, str) or not value.strip():
        raise BridgeError("参考图地址不能为空")
    if value.lower().startswith("data:image/"):
        match = re.fullmatch(r"data:image/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)", value)
        if not match or len(match[1]) > MAX_IMAGE * 4 // 3 + 16:
            raise BridgeError("参考图 Base64 无效或超过 32MB")
        try:
            data = base64.b64decode(re.sub(r"\s", "", match[1]), validate=True)
        except ValueError as error:
            raise BridgeError("参考图 Base64 无效") from error
    elif urlparse(value).scheme in ("http", "https"):
        try:
            with urlopen(Request(value, headers={"User-Agent": SERVICE}), timeout=30) as response:
                data = read_limited(response, MAX_IMAGE)
        except (OSError, URLError) as error:
            raise BridgeError("无法读取参考图，请确认图片地址可访问") from error
    else:
        raise BridgeError("桥接参考图需要图片 data URL 或 HTTP(S) 地址")
    if not data or len(data) > MAX_IMAGE:
        raise BridgeError("参考图为空或超过 32MB")
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return data, "image/png", "png"
    if data.startswith(b"\xff\xd8\xff"):
        return data, "image/jpeg", "jpg"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return data, "image/webp", "webp"
    raise BridgeError("参考图必须是 PNG、JPEG 或 WebP 图片")


def image_sources(model, options):
    if model not in MODELS:
        raise BridgeError("不支持的 ComfyUI 视频模型，请选择项目内置的 H3 或 Wan 工作流")
    refs = options.get("reference_urls") or []
    if not isinstance(refs, list) or any(not isinstance(ref, str) or not ref.strip() for ref in refs):
        raise BridgeError("reference_urls 必须是非空图片地址数组")
    first = options.get("first_frame_url")
    legacy_image = options.get("image_url")
    last = options.get("last_frame_url")
    if any(value is not None and (not isinstance(value, str) or not value.strip())
           for value in (first, legacy_image, last)):
        raise BridgeError("首尾帧和图片地址必须是非空字符串")
    if model == MODEL_WAN:
        if last:
            raise BridgeError("Wan 2.2 5B 不支持尾帧约束，请清空尾帧或切换到 H3")
        sources = list(dict.fromkeys(value for value in [first, legacy_image, *refs] if value))
        if len(sources) > 1:
            raise BridgeError("Wan 2.2 5B 只支持一张完整首帧图；多张人物/场景参考图请使用 H3")
        return sources, []
    if legacy_image:
        if not refs:
            refs = [legacy_image]
        elif legacy_image not in refs:
            raise BridgeError("H3 的 image_url 必须已包含在 reference_urls 中，以保留提示词参考图编号")
    if len(refs) > MODELS[model]["max_reference_images"]:
        raise BridgeError("H3 最多支持 9 张独立参考图，请减少绑定素材")
    # Keep positions, including duplicates: <Picture N> must never shift.
    guides = [(first, 0)] if first else []
    if last:
        guides.append((last, -1))
    return list(refs), guides


def dimensions(options, model):
    ratio = str(options.get("aspect_ratio") or "16:9")
    match = re.fullmatch(r"(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)", ratio)
    if not match or min(map(float, match.groups())) <= 0:
        raise BridgeError("视频比例必须是有效的宽:高，例如 16:9 或 9:16")
    aspect = float(match[1]) / float(match[2])
    resolution = str(options.get("resolution") or "").lower().strip()
    explicit = re.fullmatch(r"(\d+)[x×](\d+)", resolution)
    if explicit:
        width, height = map(int, explicit.groups())
    elif resolution:
        preset = re.fullmatch(r"(480|540|544|576|720|768|1080)p?", resolution)
        if not preset:
            raise BridgeError("本地视频分辨率请使用 480p、720p 或明确的宽x高")
        side = int(preset[1])
        width, height = (side * aspect, side) if aspect >= 1 else (side, side / aspect)
    else:
        area = 0.5 * 1024 * 1024 if model == MODEL_H3 else 832 * 480
        width, height = math.sqrt(area * aspect), math.sqrt(area / aspect)
    width, height = (max(32, math.floor(value / 32 + 0.5) * 32) for value in (width, height))
    if min(width, height) < 128 or max(width, height) > 2048:
        raise BridgeError("本地视频宽高需在 128~2048 像素内")
    return width, height


def load_workflow(model):
    if model not in MODELS and model not in IMAGE_MODELS:
        raise BridgeError("未知 ComfyUI 工作流")
    with (ROOT / "workflows" / f"{model}.json").open(encoding="utf-8") as source:
        value = json.load(source)
    if not isinstance(value, dict) or not value or any(not isinstance(node, dict) or "class_type" not in node for node in value.values()):
        raise BridgeError("内置工作流不是有效的 ComfyUI API 格式", 500)
    return value


def build_workflow(model, options, uploaded_names, task_id):
    refs, guides = image_sources(model, options)
    expected = len(refs) + len(guides)
    if len(uploaded_names) != expected:
        raise BridgeError("图片上传数量与工作流输入不一致", 500)
    graph = load_workflow(model)
    prompt = str(options.get("prompt") or "").strip()
    if not prompt:
        raise BridgeError("视频提示词不能为空")
    duration = options.get("duration") if options.get("duration") is not None else 5
    try:
        duration = float(duration)
    except (ValueError, TypeError) as error:
        raise BridgeError("视频时长必须是数字") from error
    if not math.isfinite(duration) or duration <= 0 or duration > 60:
        raise BridgeError("本地视频时长必须大于 0 且不超过 60 秒")
    seed = options.get("seed")
    if seed is None or seed == -1:
        seed = secrets.randbits(48)
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 2**53 - 1:
        raise BridgeError("seed 必须为 -1 或非负安全整数")
    width, height = dimensions(options, model)
    prefix = f"video/localminidrama/{task_id}/clip"
    ids = []
    for index, name in enumerate(uploaded_names):
        node_id = f"lmd_image_{index + 1}"
        graph[node_id] = {"class_type": "LoadImage", "inputs": {"image": name},
                          "_meta": {"title": f"LocalMiniDrama image {index + 1}"}}
        ids.append(node_id)
    if model == MODEL_H3:
        prompt = re.sub(r"@图片(\d+)", r"<Picture \1>", prompt)
        for number in re.findall(r"<Picture (\d+)>", prompt):
            if not 1 <= int(number) <= len(refs):
                raise BridgeError(f"提示词中的 <Picture {number}> 没有对应参考图")
        graph["136"]["inputs"]["value"] = prompt
        graph["133"]["inputs"]["value"] = duration
        graph["129"]["inputs"]["noise_seed"] = seed
        root = graph["131"]["inputs"]
        root.update(width=width, height=height)
        for index in range(len(refs)):
            root[f"ref_images.ref_image_{index}"] = [ids[index], 0]
        # Same conditioning chain as Firebao's proven comfyui-reference adapter.
        consumers = [(node, key) for node in list(graph.values()) for key, value in node["inputs"].items()
                     if value == ["131", 0]]
        positive = "131"
        for index, (_, frame) in enumerate(guides):
            guide_id = f"lmd_guide_{index + 1}"
            graph[guide_id] = {"class_type": "MiniMaxH3AddGuide", "inputs": {
                "positive": [positive, 0], "latent": ["131", 1], "vae": root["vae"],
                "image": [ids[len(refs) + index], 0], "frame_idx": frame},
                "_meta": {"title": "LocalMiniDrama first frame" if frame == 0 else "LocalMiniDrama last frame"}}
            positive = guide_id
        if guides:
            for node, key in consumers:
                node["inputs"][key] = [positive, 0]
        graph["92"]["inputs"]["filename_prefix"] = prefix
        # This stays identical to the template's Python ComfyMathExpression.
        base_length = max(5, round(duration * 24))
        length = base_length + (5 - base_length % 17) % 17
    else:
        graph["5"]["inputs"]["text"] = re.sub(r"@图片\d+", "", prompt)
        length = 1 + 4 * max(1, math.floor(duration * 24 / 4 + 0.5))
        graph["7"]["inputs"].update(width=width, height=height, length=length)
        if ids:
            graph["7"]["inputs"]["start_image"] = [ids[0], 0]
        graph["8"]["inputs"]["seed"] = seed
        graph["11"]["inputs"]["filename_prefix"] = prefix
    return graph, {"width": width, "height": height, "fps": 24, "frame_count": length,
                   "requested_duration": duration, "seed": seed}


def qwen_image_sources(options):
    refs = options.get("reference_urls") or []
    if not isinstance(refs, list) or any(not isinstance(ref, str) or not ref.strip() for ref in refs):
        raise BridgeError("reference_urls 必须是非空图片地址数组")
    # Do not deduplicate: prompt image numbers must match the submitted order.
    return list(refs), []


def image_dimensions(options):
    size = options.get("size") or "1536x864"
    if options.get("width") is not None or options.get("height") is not None:
        size = f"{options.get('width')}x{options.get('height')}"
    match = re.fullmatch(r"(\d+)[x×](\d+)", str(size).strip())
    if not match:
        raise BridgeError("图片尺寸必须是宽x高，例如 1536x864")
    width, height = map(int, match.groups())
    if min(width, height) < 1 or max(width, height) > 16384:
        raise BridgeError("图片宽高需在原生 ImageScale 节点支持的 1~16384 像素范围内")
    aspect = width / height
    native_width = max(32, round(math.sqrt(1024 * 1024 * aspect) / 32) * 32)
    native_height = max(32, round(math.sqrt(1024 * 1024 / aspect) / 32) * 32)
    if max(native_width, native_height) > 16384:
        raise BridgeError("图片比例超出原生参考图处理节点的尺寸范围，请调整宽高比")
    return width, height, native_width, native_height


def build_image_workflow(model, options, uploaded_names, task_id):
    refs, _ = qwen_image_sources(options)
    if len(uploaded_names) != len(refs):
        raise BridgeError("图片上传数量与参考图输入不一致", 500)
    prompt = str(options.get("prompt") or "").strip()
    if not prompt:
        raise BridgeError("图片提示词不能为空")
    width, height, native_width, native_height = image_dimensions(options)
    seed = options.get("seed")
    if seed is None or seed == -1:
        seed = secrets.randbits(63)
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 0xffffffffffffffff:
        raise BridgeError("seed 必须是 0~18446744073709551615 的整数或 -1")
    graph = load_workflow(model)
    # The maintained template is directly runnable with three example references.
    # Replace its loaders and links with the exact request, never a stitched contact sheet.
    graph = {key: node for key, node in graph.items() if node["class_type"] != "LoadImage"}
    encode = graph["5"]["inputs"]
    for key in list(encode):
        if key.startswith("images."):
            del encode[key]
    encode.update(prompt=prompt, negative_prompt=str(options.get("negative_prompt") or ""), resolution=1024)
    for index, name in enumerate(uploaded_names, 1):
        node_id = f"lmd_image_{index}"
        graph[node_id] = {"class_type": "LoadImage", "inputs": {"image": name},
                          "_meta": {"title": f"参考图 {index}"}}
        encode[f"images.image_{index}"] = [node_id, 0]
    if refs:
        # Only the first reference determines the native latent's aspect ratio.
        # Fit it onto the requested canvas without cropping or stretching the subject.
        graph["10"]["inputs"].update(image=["lmd_image_1", 0], target_width=native_width,
                                      target_height=native_height)
        encode["images.image_1"] = ["10", 0]
        graph["7"]["inputs"]["latent_image"] = ["5", 2]
    else:
        del graph["10"]
        graph["lmd_empty"] = {"class_type": "EmptyLatentImage", "inputs": {
            "width": native_width, "height": native_height, "batch_size": 1}}
        graph["7"]["inputs"]["latent_image"] = ["lmd_empty", 0]
    graph["7"]["inputs"]["seed"] = seed
    graph["11"]["inputs"].update(width=width, height=height)
    graph["9"]["inputs"]["filename_prefix"] = "image/localminidrama/" + task_id
    return graph, {"seed": seed, "width": width, "height": height,
                   "native_width": native_width, "native_height": native_height,
                   "reference_count": len(refs), "steps": graph["7"]["inputs"]["steps"],
                   "cfg": graph["7"]["inputs"]["cfg"]}


def validate_image_inputs(graph, object_info):
    # Autogrow expands ONLY names declared by the live schema. Extra names would
    # otherwise be silently ignored by ComfyUI even if /prompt accepts the graph.
    schema = object_info.get("TextEncodeQwenImage21", {}).get("input", {})
    fields = {**schema.get("required", {}), **schema.get("optional", {})}
    field = fields.get("images")
    if not field or len(field) < 2:
        raise BridgeError("ComfyUI 未提供 Qwen 多参考图输入契约，请更新原生 Qwen 节点", 422)
    template = field[1].get("template", {})
    names = template.get("names")
    if names is None and "prefix" in template:
        names = [f"{template['prefix']}{index}" for index in range(template.get("max", 0))]
    allowed = {"images." + name for name in names or []}
    supplied = {key for key in graph["5"]["inputs"] if key.startswith("images.")}
    if supplied - allowed:
        raise BridgeError(f"当前 ComfyUI 原生 Qwen 节点实际支持 {len(allowed)} 张独立参考图，"
                          f"本次传入 {len(supplied)} 张；请减少参考图或扩展原生输入契约，所有图片均未提交", 422)


def validate_dependencies(graph, object_info):
    missing = sorted({node["class_type"] for node in graph.values()} - object_info.keys())
    if missing:
        raise BridgeError("ComfyUI 缺少工作流节点：" + "、".join(missing), 422)
    loaders = {"UNETLoader", "CLIPLoader", "VAELoader", "MiniMaxH3TurboLoRA"}
    for node in graph.values():
        if node["class_type"] not in loaders:
            continue
        inputs = object_info[node["class_type"]].get("input", {})
        schema = {**inputs.get("required", {}), **inputs.get("optional", {})}
        for key, value in node["inputs"].items():
            field = schema.get(key)
            if field and isinstance(field[0], list) and isinstance(value, str) and value not in field[0]:
                raise BridgeError(f"ComfyUI 缺少模型文件：{value}（{node['class_type']}.{key}）", 422)


class ComfyClient:
    def __init__(self, base_url, token=""):
        self.base_url = native_url(base_url)
        self.token = token or ""

    def request(self, route, data=None, content_type="application/json"):
        headers = {"User-Agent": SERVICE}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        if data is not None:
            headers["Content-Type"] = content_type
            if not isinstance(data, bytes):
                data = json.dumps(data, ensure_ascii=False).encode("utf-8")
        try:
            with urlopen(Request(self.base_url + route, data=data, headers=headers), timeout=30) as response:
                raw = read_limited(response, 32 * 1024 * 1024)
            return json.loads(raw)
        except HTTPError as error:
            with error:
                raw = error.read(4096).decode("utf-8", "replace")
            try:
                detail = json.loads(raw)
                detail = json.dumps(detail.get("node_errors") or detail.get("error") or detail, ensure_ascii=False)
            except ValueError:
                detail = raw
            if self.token:
                detail = detail.replace(self.token, "[redacted]")
            raise BridgeError(f"ComfyUI 返回 HTTP {error.code}：{detail[:1500]}", 502) from error
        except (URLError, OSError) as error:
            raise BridgeError("无法连接 ComfyUI，请确认配置的原生 ComfyUI 服务已启动", 503) from error
        except ValueError as error:
            raise BridgeError("ComfyUI 没有返回有效 JSON，请检查服务地址", 502) from error

    def upload(self, image, index):
        data, mime, extension = image
        filename = f"lmd-{hashlib.sha256(data).hexdigest()[:24]}.{extension}"
        boundary = "----LocalMiniDrama" + secrets.token_hex(16)
        parts = []
        for key, value in (("type", "input"), ("subfolder", "localminidrama/refs"), ("overwrite", "true")):
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
        parts.extend([f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{filename}"\r\nContent-Type: {mime}\r\n\r\n'.encode(),
                      data, f"\r\n--{boundary}--\r\n".encode()])
        result = self.request("/upload/image", b"".join(parts), "multipart/form-data; boundary=" + boundary)
        name, folder = result.get("name"), str(result.get("subfolder") or "").replace("\\", "/")
        if not isinstance(name, str) or not name or "/" in name or "\\" in name or result.get("type") != "input":
            raise BridgeError(f"第 {index + 1} 张图片上传结果无效", 502)
        path = "/".join(part for part in (folder, name) if part)
        if path.startswith("/") or ".." in path.split("/"):
            raise BridgeError("ComfyUI 上传返回了无效路径", 502)
        return path


def find_video(entry, base_url, output_ids=None):
    outputs = entry.get("outputs") or {}
    order = list(output_ids or []) + [key for key in outputs if key not in (output_ids or [])]
    for node_id in order:
        value = outputs.get(node_id) or {}
        for field in ("videos", "gifs", "images"):
            for item in value.get(field, []) or []:
                if not isinstance(item, dict):
                    continue
                name = item.get("filename")
                if not isinstance(name, str) or not re.search(r"\.(mp4|webm|mov|mkv|m4v)$", name, re.I):
                    continue
                folder = str(item.get("subfolder") or "").replace("\\", "/")
                if "/" in name or "\\" in name or ".." in folder.split("/") or folder.startswith("/"):
                    raise BridgeError("ComfyUI 视频输出路径无效", 502)
                kind = item.get("type") or "output"
                if kind not in ("output", "temp"):
                    continue
                query = urlencode({"filename": name, "subfolder": folder, "type": kind})
                return {"video_url": base_url + "/view?" + query,
                        "output": {"filename": name, "subfolder": folder, "type": kind,
                                   "metadata": item.get("metadata") or {}}}
    return None


def find_image(entry, base_url, output_ids=None):
    outputs = entry.get("outputs") or {}
    for node_id in output_ids or outputs:
        for item in (outputs.get(node_id) or {}).get("images", []) or []:
            if not isinstance(item, dict):
                continue
            name = item.get("filename")
            if not isinstance(name, str) or not re.search(r"\.(png|jpe?g|webp)$", name, re.I):
                continue
            folder = str(item.get("subfolder") or "").replace("\\", "/")
            if "/" in name or "\\" in name or ".." in folder.split("/") or folder.startswith("/"):
                raise BridgeError("ComfyUI 图片输出路径无效", 502)
            if item.get("type", "output") != "output":
                continue
            output = {"filename": name, "subfolder": folder, "type": "output"}
            return {"image_url": base_url + "/view?" + urlencode(output), "output": output}
    return None


def execution_error(entry):
    status = entry.get("status") or {}
    for event in reversed(status.get("messages") or []):
        if isinstance(event, list) and len(event) > 1 and event[0] in ("execution_error", "execution_interrupted"):
            detail = event[1] if isinstance(event[1], dict) else {}
            message = detail.get("exception_message") or detail.get("message") or "ComfyUI 执行已中断"
            return f"ComfyUI 节点 {detail.get('node_id', '?')} 执行失败：{str(message)[:1000]}"
    if status.get("status_str") in ("error", "failed"):
        return "ComfyUI 工作流执行失败"
    return None


class BridgeService:
    def __init__(self, data_dir, client_factory=ComfyClient):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.client_factory = client_factory
        self.lock = threading.RLock()
        self.tasks = {}
        self.tokens = {}

    def _path(self, task_id):
        if not re.fullmatch(r"lmd-comfy-[a-f0-9]{32}", task_id):
            raise BridgeError("无效的 ComfyUI 桥接任务 ID", 404)
        return self.data_dir / f"{task_id}.json"

    def save(self, task):
        # State contains no credentials, prompt text, or reference image bytes.
        destination = self._path(task["task_id"])
        temporary = destination.with_suffix(".tmp")
        with self.lock:
            temporary.write_text(json.dumps(task, ensure_ascii=False), encoding="utf-8")
            temporary.replace(destination)
            self.tasks[task["task_id"]] = task

    def get(self, task_id):
        destination = self._path(task_id)
        with self.lock:
            if task_id in self.tasks:
                return dict(self.tasks[task_id])
            try:
                task = json.loads(destination.read_text(encoding="utf-8"))
            except FileNotFoundError as error:
                raise BridgeError("未找到桥接任务，请保留 backend-node/data/comfyui-bridge 目录", 404) from error
            self.tasks[task_id] = task
            return dict(task)

    def submit(self, options, preview=False):
        model = options.get("model")
        is_image = model in IMAGE_MODELS
        refs, guides = qwen_image_sources(options) if is_image else image_sources(model, options)
        builder = build_image_workflow if is_image else build_workflow
        capabilities = IMAGE_MODELS[model] if is_image else MODELS[model]
        base = native_url(options.get("comfyui_url"))
        task_id = "lmd-comfy-" + secrets.token_hex(16)
        # Validate all parameters, node classes and model filenames BEFORE any upload/submission.
        dummy = [f"localminidrama/refs/preview-{index}.png" for index in range(len(refs) + len(guides))]
        graph, metadata = builder(model, options, dummy, task_id)
        client = self.client_factory(base, options.get("comfyui_token") or "")
        info = client.request("/object_info")
        validate_dependencies(graph, info)
        if is_image:
            validate_image_inputs(graph, info)
        if preview:
            return {"valid": True, "model": model, "capabilities": capabilities,
                    "metadata": metadata, "reference_count": len(refs), "guide_count": len(guides),
                    "workflow": graph}
        images = [image_bytes(value) for value in [*refs, *(value for value, _ in guides)]]
        names = [client.upload(image, index) for index, image in enumerate(images)]
        # Reuse resolved random seed so the prepared and submitted workflow agree.
        graph, metadata = builder(model, {**options, "seed": metadata["seed"]}, names, task_id)
        response = client.request("/prompt", {"prompt": graph, "client_id": task_id})
        if response.get("node_errors") or not response.get("prompt_id"):
            detail = json.dumps(response.get("node_errors") or response.get("error") or "缺少 prompt_id", ensure_ascii=False)
            raise BridgeError("ComfyUI 拒绝工作流：" + detail[:1500], 422)
        task = {"task_id": task_id, "prompt_id": str(response["prompt_id"]), "status": "processing",
                "model": model, "comfyui_url": base, "metadata": metadata, "created_at": time.time(),
                "output_ids": ["9"] if is_image else (["92"] if model == MODEL_H3 else ["11"]),
                "kind": "image" if is_image else "video"}
        self.tokens[task_id] = options.get("comfyui_token") or ""
        self.save(task)
        return self.public(task)

    @staticmethod
    def public(task):
        return {key: value for key, value in task.items()
                if key in ("task_id", "prompt_id", "status", "model", "metadata", "video_url", "image_url", "output", "error", "progress", "queue_position")}

    def poll(self, task_id, token=""):
        task = self.get(task_id)
        if task["status"] in ("completed", "failed"):
            return self.public(task)
        client = self.client_factory(task["comfyui_url"], token or self.tokens.get(task_id, ""))
        history = client.request("/history/" + quote(task["prompt_id"], safe=""))
        entry = history.get(task["prompt_id"])
        if entry:
            error = execution_error(entry)
            if error:
                task.update(status="failed", error=error)
            else:
                is_image = task.get("kind") == "image"
                result = (find_image if is_image else find_video)(entry, task["comfyui_url"], task["output_ids"])
                if result:
                    task.update(status="completed", progress=100, **result)
                elif (entry.get("status") or {}).get("completed"):
                    message = "未找到图片输出，请检查 SaveImage 节点" if is_image else "未找到 MP4/WebM 视频输出，请检查 SaveVideo 节点"
                    task.update(status="failed", error="ComfyUI 已完成，但" + message)
            self.save(task)
        else:
            queue = client.request("/queue")
            pending = queue.get("queue_pending") or []
            running = queue.get("queue_running") or []
            ids = [str(item[1]) for item in pending if isinstance(item, list) and len(item) > 1]
            live = [str(item[1]) for item in running if isinstance(item, list) and len(item) > 1]
            if task["prompt_id"] in ids:
                task.update(queue_position=ids.index(task["prompt_id"]) + 1, progress=0)
            elif task["prompt_id"] in live:
                task.update(queue_position=0, progress=5)
            elif time.time() - task["created_at"] > 60:
                task.update(status="failed", error="ComfyUI 队列和历史中均未找到此任务，可能已重启或任务被删除")
            self.save(task)
        return self.public(task)


def handler_for(service, secret, parent_pid=None):
    class Handler(BaseHTTPRequestHandler):
        server_version = SERVICE

        def log_message(self, *_):
            pass  # Never log credentials, prompts, or data URLs.

        def send_json(self, status, value):
            data = json.dumps(value, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def handle_request(self, method):
            parsed = urlparse(self.path)
            if parsed.path == "/health" and method == "GET":
                health = {"service": SERVICE, "version": VERSION, "pid": os.getpid(), "models": [*MODELS, *IMAGE_MODELS]}
                challenge = self.headers.get("X-LMD-Bridge-Challenge", "")
                if re.fullmatch(r"[0-9a-fA-F]{64}", challenge) and parent_pid is not None:
                    launcher_pid = os.getppid()
                    payload = f"v1:{challenge}:{os.getpid()}:{parent_pid}:{launcher_pid}".encode("utf-8")
                    health.update(parent_pid=parent_pid, launcher_pid=launcher_pid,
                                  auth_proof=hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest())
                return self.send_json(200, health)
            if not secrets.compare_digest(self.headers.get("Authorization", ""), "Bearer " + secret):
                return self.send_json(401, {"error": "桥接认证失败"})
            try:
                if method == "GET" and parsed.path in ("/video/models", "/image/models"):
                    models = IMAGE_MODELS if parsed.path.startswith("/image/") else MODELS
                    return self.send_json(200, {"models": [{"id": key, **value} for key, value in models.items()]})
                if method == "GET" and (parsed.path.startswith("/video/task/") or parsed.path.startswith("/image/task/")):
                    task_id = parsed.path.split("/task/", 1)[1]
                    return self.send_json(200, service.poll(task_id, self.headers.get("X-ComfyUI-Token", "")))
                if method == "POST" and parsed.path in ("/video/generations", "/video/validate", "/image/generations", "/image/validate"):
                    length = int(self.headers.get("Content-Length", "0"))
                    if length <= 0 or length > MAX_BODY:
                        raise BridgeError("桥接请求为空或超过 128MB", 413)
                    try:
                        options = json.loads(self.rfile.read(length))
                    except ValueError as error:
                        raise BridgeError("桥接请求必须是 JSON") from error
                    if not isinstance(options, dict):
                        raise BridgeError("桥接请求必须是 JSON 对象")
                    models = IMAGE_MODELS if parsed.path.startswith("/image/") else MODELS
                    if options.get("model") not in models:
                        raise BridgeError("此接口不支持所选 ComfyUI 模型，请选择相应的内置图片或视频工作流")
                    result = service.submit(options, preview=parsed.path.endswith("/validate"))
                    return self.send_json(200, result)
                raise BridgeError("桥接接口不存在", 404)
            except BridgeError as error:
                self.send_json(error.status, {"error": str(error)})
            except Exception as error:
                # Details remain internal; never return exception repr containing raw requests.
                self.send_json(500, {"error": "ComfyUI 桥接内部错误：" + type(error).__name__})

        def do_GET(self):
            self.handle_request("GET")

        def do_POST(self):
            self.handle_request("POST")

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5681)
    parser.add_argument("--data-dir", type=Path, default=ROOT.parent / "data" / "comfyui-bridge")
    parser.add_argument("--parent-pid", type=int)
    args = parser.parse_args()
    if args.host not in ("127.0.0.1", "::1", "localhost"):
        parser.error("桥接只允许绑定本机回环地址")
    secret = os.environ.get("LMD_COMFY_BRIDGE_TOKEN", "")
    if not secret:
        parser.error("缺少 LMD_COMFY_BRIDGE_TOKEN，请通过项目后端启动桥接")
    service = BridgeService(args.data_dir)
    server = ThreadingHTTPServer((args.host, args.port), handler_for(service, secret, args.parent_pid))
    server.daemon_threads = True

    def shutdown(*_):
        threading.Thread(target=server.shutdown, daemon=True).start()

    for name in ("SIGINT", "SIGTERM"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), shutdown)
    if args.parent_pid:
        watched_pids = {args.parent_pid}
        if os.name == "nt":
            watched_pids.add(os.getppid())

        def watch_parent():
            while True:
                time.sleep(0.25)
                try:
                    for watched_pid in watched_pids:
                        if os.name == "nt":
                            # os.kill(pid, 0) can terminate a Windows process; query a handle instead.
                            import ctypes
                            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
                            kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
                            kernel.OpenProcess.restype = ctypes.c_void_p
                            kernel.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
                            kernel.CloseHandle.argtypes = [ctypes.c_void_p]
                            handle = kernel.OpenProcess(0x1000, False, watched_pid)
                            if not handle:
                                shutdown()
                                return
                            exit_code = ctypes.c_ulong()
                            active = kernel.GetExitCodeProcess(handle, ctypes.byref(exit_code))
                            kernel.CloseHandle(handle)
                            if not active or exit_code.value != 259:
                                shutdown()
                                return
                        else:
                            os.kill(watched_pid, 0)
                except OSError:
                    shutdown()
                    return
        threading.Thread(target=watch_parent, daemon=True).start()
    print(f"[{SERVICE}] listening on http://{args.host}:{server.server_port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
