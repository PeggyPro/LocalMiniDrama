# ComfyUI 视频配置

当前项目已内置随后端启动的 Python 桥接。视频 AI 配置使用原生地址 `http://127.0.0.1:8188`，服务商填写 `ComfyUI`（兼容已有 `ComfuUI`），创建和查询接口留空。

支持两套随项目保存的火宝工作流：

- `huobao_minimax_h3_reference_turbo_api`：最多 9 张独立参考图，并支持首尾帧约束。
- `huobao_wan22_5b_t2v_32gb_api`：支持文生视频或一张首帧图，不支持尾帧和多张不同参考图。

启动原有 ComfyUI，再正常启动本项目即可。完整配置、依赖检查及排错见 [项目内置桥接说明](../backend-node/comfyui-bridge/README.md)。

以下为历史外部 Rust 代理方案，仅适用于仍自行使用该代理的部署。

# 使用系统自带的PowerShell执行
# 1.将ComfyUI包装成标准的OpenAI API接口
CD C:\ComfyUI
git clone https://github.com/pnyxai/comfyui-openai-api.git
# 2.进入目录
CD C:\ComfyUI\comfyui-openai-api\apps\rust\comfyui-openai-api
# 3.安装ComFyUI OpenAI API代理环境支持-Rust 
https://rust-lang.org/zh-CN/tools/install/
#4.编译ComFyUI OpenAI API代理程序代码-Rust
cargo clean
cargo build --release
# 5.启动组件 终端显示 Proxy server listening on 0.0.0.0:8080为成功。
./target/release/comfyui-openai-api

# 生成的OpenAI API接口地址http://127.0.0.1:8080/v1/images/generations 

感谢群友 欧先生@全力以赴  整理的教程