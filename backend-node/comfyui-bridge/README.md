# 项目内置 ComfyUI 图片与视频桥接

LocalMiniDrama 随后端启动 Python 桥接，直接连接原生 ComfyUI。Qwen 多参考图生图和两套视频工作流随项目维护，无需另行启动 8080 端口的 Rust 代理。

```text
前端 3013 → 后端 5680 → 项目 Python 桥接 5681 → 原生 ComfyUI 8188
```

## 多参考图生成图片

在 **图片生成** 或 **分镜图生成** AI 配置中选择 Qwen-Image2.1 多参考图预设，使用以下配置：

- 服务商、协议：`comfyui`。
- 原生地址：`http://127.0.0.1:8188`；API Key 在原生服务未启用鉴权时留空。
- 模型、默认模型：`huobao_qwen_image_2_1_reference_api`。
- 创建接口、查询接口留空；桥接地址和本地令牌由后端管理。

维护模板为 [Qwen 多参考图 API 工作流](workflows/huobao_qwen_image_2_1_reference_api.json)。它将每张参考图分别接入 `TextEncodeQwenImage21`，配合 Qwen3-VL 编码器和 Qwen-Image2.1 VAE，再由原生 `/prompt` 生成、`/history` 查询、`SaveImage` 输出。模型文件为 `qwen_image_2.1_int8_convrot.safetensors`、`qwen3vl_8b_int8_convrot.safetensors`、`qwen_image_2.1_vae_bf16.safetensors`；CLIP 类型为 `qwen_image`。画幅适配依赖已安装的 KJNodes `ImagePadForOutpaintTargetSize`。

分镜首帧、尾帧沿用项目的场景 → 所选角色 → 道具参考图收集及身份描述；尾帧启用首帧站位锁时，该首帧也计入总数。也可通过已有图片 API 明确传入有序参考图：

```http
POST http://127.0.0.1:5680/api/v1/images
Content-Type: application/json

{
  "drama_id": 1,
  "provider": "comfyui",
  "model": "huobao_qwen_image_2_1_reference_api",
  "prompt": "Image 1 是场景，Image 2 是角色，Image 3 是道具。保留角色外貌和道具形状，生成角色在此场景手持该道具的新镜头，单人、单一连续画面。",
  "reference_images": ["http://127.0.0.1:5680/static/场景.png", "http://127.0.0.1:5680/static/角色.png", "http://127.0.0.1:5680/static/道具.png"],
  "size": "1536x864"
}
```

将示例 URL 换为实际素材地址。返回记录 `id` 后，通过 `GET /api/v1/images/{id}` 查询，直到 `status` 为 `completed` 或 `failed`；成功时返回项目保存的 `image_url` 和 `local_path`。绑定现有分镜时另传 `storyboard_id` 和 `frame_type: "storyboard_first"` 或 `"storyboard_last"`，项目会按原规则回写分镜。只传 `drama_id` 的独立生成不会替换已有分镜图。

参考图按顺序独立上传，不拼接、不静默截断。当前原生节点的 Autogrow 解析契约支持 16 张；17 张及以上会明确报错，桥接还会检查实时输入 schema，防止原生节点忽略未声明的输入。零张参考图走文生图。图片可来自应用存储、`/static/`、HTTP(S) URL 或 data URL。

默认使用约 1MP 原生采样、40 步、CFG 1、euler/simple、denoise 1。第一张图通过等比缩放和补边确定目标画幅，随后缩放交付至请求的精确 `size`；交付尺寸不代表原生采样分辨率。CFG 1 时负面提示词不生效，应将关键约束写入正面提示词。

内部桥接提供 `GET /image/models`、`POST /image/validate`、`POST /image/generations`、`GET /image/task/{task_id}`。生成请求字段为 `model`、`comfyui_url`、`prompt`、有序 `reference_urls`，可选 `comfyui_token`、`size`、`seed`。所有内部接口都需要后端管理的 Bearer 令牌；查询原生受保护任务时通过 `X-ComfyUI-Token` 传原生令牌。验证只检查依赖，不上传或排队。生成只提交一次，随后查询同一任务；失败不会自动重提。

## 视频启动与 AI 配置

1. 先启动已有的原生 ComfyUI，确认它的工作流节点和模型文件已经安装。
2. 按原有方式启动本项目，例如在 `backend-node` 执行 `npm run dev`。后端自动寻找 Python 3.10 或更新版本、启动桥接，并在退出时清理自己启动的进程。
3. 在视频 AI 配置中选择服务商预设 **ComfyUI 本地（火宝工作流）**，自动填入原生地址 `http://127.0.0.1:8188`、协议 `comfyui` 和两套工作流名称。已有配置也可继续使用：服务商 `ComfyUI` 或原有 `ComfuUI` 拼写均兼容，创建接口和查询接口留空。未启用原生鉴权时，API Key 可留空。
4. 默认模型选择下面任意一个完整工作流名称，不带 `.json` 后缀。连接测试会使用所选默认模型，并检查相应节点和模型文件；不会提交视频生成。

| 模型 | 人物、场景等独立参考图 | 首帧 | 尾帧 |
| --- | --- | --- | --- |
| `huobao_minimax_h3_reference_turbo_api` | 最多 9 张，保留顺序和 `<Picture N>` 编号 | 支持位置约束 | 支持位置约束 |
| `huobao_wan22_5b_t2v_32gb_api` | 仅支持一张完整首帧图 | 支持 | 不支持 |

H3 的独立参考图和首尾帧分别接入工作流；一张图同时承担两种角色时，两种输入都会保留。提示词中的 `@图片1` 自动转换为 `<Picture 1>`。单独传入 `image_url` 时作为第一张独立参考图；显式 `first_frame_url` 才作为首帧约束。已有独立参考图列表时，不会偷偷增删图片或改变编号。

Wan 的首帧、输入图片和参考图列表可以指向同一张图片；传入多张不同图片或尾帧时会明确报错，请改用 H3 或只保留一张完整首帧。

原生 ComfyUI 未启用鉴权时，桥接调用不需要原生 API Key；启用了鉴权时，视频配置中的 API Key 会传给 ComfyUI。桥接自身的本地令牌由后端管理，无需填入 AI 配置。原有明确配置其他协议或代理接口的服务仍走原有路径。

## 工作流及输入输出

工作流来自火宝的 `huobao_32gb` API 模板，核对版本为提交 `8d139e27715bc6916920f71f20778bb6d975ba00`，并与本机已有 `toonflow_api` 模板一致。保留模型加载、采样、负面提示词及视频音频链路；仅注入提示词、图片、尺寸、时长、随机种子和唯一输出路径。

- H3：`MiniMaxH3ReferenceToVideo` 接收有序独立参考图；显式首尾帧通过串联的 `MiniMaxH3AddGuide` 连接到真实 conditioning 消费节点，位置分别为 `0` 和 `-1`。保留原工作流音频链。
- Wan：单张图片连接 `Wan22ImageToVideoLatent.start_image`；保留原负面提示词、采样和输出链。
- 本地、`/static/` 和应用存储地址由后端直接读取后上传到 ComfyUI `/upload/image`。采用上传响应返回的真实文件名与子目录，不经过外部图床。
- `/prompt` 返回的原生任务 ID 会持久化。通过 `/history/{prompt_id}` 和 `/queue` 查询任务，不重新提交已存在的任务。
- 从原生 `SaveVideo` 输出的 `images`、`videos` 或 `gifs` 集合中定位实际视频文件，构造 `/view` 地址，交给项目原有下载与分镜回写流程。成片必须成功保存为非空本地文件才会标记完成；下载或写入失败会明确报错，可修复连接、访问令牌或存储权限后继续查询已有任务。
- 桥接重启后，可从 `backend-node/data/comfyui-bridge` 恢复任务。该目录不保存密钥、提示词或图片字节，请保留它直到任务结束。

## Python 和端口

无需安装 Python 第三方包。寻找顺序为：配置指定解释器、`LMD_COMFYUI_PYTHON`、项目根目录 `.venv\Scripts\python.exe`、系统 `python3` / `python`、Windows `py -3`。

默认无需新增配置。需要指定解释器或修改桥接端口时，可在已有 `configs/config.yaml` 中添加：

```yaml
comfyui_bridge:
  enabled: true
  port: 5681
  python: 'C:\Python313\python.exe'
```

解释器路径必须指向实际安装的 Python，可省略 `python` 让项目自动查找。`enabled: false` 会关闭本地图片与视频桥接。桥接只能监听本机回环地址；端口被其他进程占用时会说明原因，不会结束或接管无关进程。Windows 虚拟环境的 Python 启动器通过挑战证明核验实际工作进程，退出时同时监控后端和启动器，避免残留进程占用端口。

## 检查与排错

- 后端健康检查：`http://127.0.0.1:5680/health`。
- 桥接健康检查：`http://127.0.0.1:5681/health`，返回服务名、版本和 PID，不返回密钥。
- 视频 AI 配置的连接测试只检查节点和模型依赖，不上传图片或提交生成任务。
- 缺少节点或模型时，连接测试与生成操作都会指出具体名称；请在现有 ComfyUI 安装对应依赖。
- 提示无法连接原生服务时，检查 ComfyUI 是否启动，以及 AI 配置中的原生地址。
- Wan 提示不支持尾帧或多图时，选择 H3 或减少输入，不会静默丢弃图片。
- 旧的 405 失败记录未成功创建原生任务，修复后需要重新生成；已有 `lmd-comfy-` 任务可继续查询。
- 返回视频不代表模型质量已验收；采样耗时和显存需求由当前模型、尺寸与时长决定。

## 回归验证

在 `backend-node` 运行：

```powershell
node --test test/*.test.js
..\.venv\Scripts\python.exe -m unittest discover -s comfyui-bridge -p test_bridge.py
```

Python 测试使用本地模拟 ComfyUI，覆盖真实 HTTP 上传字节、参考顺序、首尾帧、依赖校验、排队、执行错误、图片/视频输出和持久化恢复，以及 Qwen 的零图、16/17 张边界、实时 Autogrow 契约和交付尺寸；不会提交真实 GPU 生成任务。
