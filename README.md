# cfworkers

这是一个由 AI 生成并持续迭代的工具仓库，主要包含 Python 服务与 Cloudflare Worker 小工具。

## 仓库定位
- 面向个人效率和自动化场景的轻量工具集合
- 以“能快速部署、能直接使用”为目标
- 覆盖 Python 后端与 Cloudflare Edge 能力

## 当前子项目
- `yuedutts`：面向阅读 App（Legado）的 Edge TTS 网关，提供 Python FastAPI 与 Cloudflare Worker 两种部署形态。
- `qywx`：面向企业微信群机器人的消息推送网关，统一多消息类型调用并支持 Token 鉴权与文件上传转发。
- `ud-worker`：面向一次性文件分享场景的中转服务，基于 Worker、R2 与 Durable Objects 实现单次下载失效与自动清理。

## 说明
本仓库内容会根据实际需求持续调整，欢迎按需取用与二次修改。
