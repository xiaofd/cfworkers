# VoiceCraft 阅读听书网关（Edge TTS）

这是一个面向阅读 App（Legado）的 TTS 网关项目，当前仅保留 `edge` 引擎。  
项目目标是提供稳定、可部署、可观测的中文听书服务。

## 项目特性
- 阅读网络导入配置（单条与批量）
- 在线试听（音色 / 风格 / 速度 / 音调 / 音量）
- 运行统计（并发、调用量、流量、成功失败）
- 统计持久化（`data/runtime_stats.json`）
- 支持本地部署、Docker 部署、Cloudflare Worker 部署

## 参考项目
- 前端风格参考：<https://github.com/wangwangit/tts>

## 目录结构
```text
.
├── app/main.py                        # FastAPI 服务入口
├── app/requirements.txt               # Python 依赖
├── web/static/index.html              # 前端页面
├── deploy/docker/Dockerfile           # Docker 镜像构建
├── deploy/docker/docker-compose.yml   # Compose 启动文件
├── deploy/scripts/update_and_restart.sh
├── worker/src/index.ts                # Cloudflare Worker 代码
├── worker/wrangler.toml               # Worker 配置
├── data/runtime_stats.json            # 统计持久化（运行后生成）
└── README.md
```

## 本地运行（Python）
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r app/requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 18080 --reload
```

访问：
- <http://127.0.0.1:18080/>

## 一键更新并重启（Python）
```bash
bash deploy/scripts/update_and_restart.sh
```

## Docker 部署
```bash
docker build -f deploy/docker/Dockerfile -t legado-tts:latest .
docker run --rm -p 18080:8080 legado-tts:latest
```

## Docker Compose 部署
```bash
docker compose -f deploy/docker/docker-compose.yml up -d --build
docker compose -f deploy/docker/docker-compose.yml ps
docker compose -f deploy/docker/docker-compose.yml logs -f
```

## Cloudflare Worker 一键部署
一键部署到 `xiaofd/cfworkers` 仓库中的 `yuedutts` 子目录：

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xiaofd/cfworkers/tree/main/yuedutts/worker)

本地调试 Worker：
```bash
cd worker
npx wrangler dev --ip 0.0.0.0 --port 18787
```

发布 Worker：
```bash
cd worker
npx wrangler deploy
```

## 接口说明

### 健康检查
```bash
curl http://127.0.0.1:18080/healthz
```

### 引擎状态
```bash
curl http://127.0.0.1:18080/engines
```

### 音色列表
```bash
curl http://127.0.0.1:18080/voices
```

### 阅读单条配置
```bash
curl "http://127.0.0.1:18080/legado-config?engine=edge&voice=zh-CN-XiaoxiaoNeural"
```

### 阅读批量配置
```bash
curl "http://127.0.0.1:18080/legado-configs?engine=edge&voices=zh-CN-XiaoxiaoNeural,zh-CN-YunxiNeural"
```

### TTS 合成
```bash
curl "http://127.0.0.1:18080/tts?engine=edge&speakText=你好&speakSpeed=20&voice=zh-CN-XiaoxiaoNeural&style=general&pitch=0&volume=0" -o edge.mp3
```

`/tts` 支持：
- GET 查询参数
- POST `application/json`
- POST `application/x-www-form-urlencoded`
- 不支持 `multipart/form-data`

### 运行统计
```bash
curl http://127.0.0.1:18080/stats
```

## 环境变量
- `TTS_MAX_TEXT_LEN`：文本最大长度（默认 `20000`）
- `TTS_MAX_BODY_BYTES`：POST Body 最大字节（默认 `524288`）
- `ENGINE_STATUS_CACHE_TTL_SEC`：引擎状态缓存秒数（默认 `30`）
- `EDGE_MAX_CONCURRENCY`：并发上限（默认 `16`）
- `EDGE_TOKEN_REFRESH_BEFORE_EXPIRY_SEC`：Token 提前刷新秒数（默认 `180`）
- `EDGE_HTTP_TIMEOUT_SEC`：Python 上游请求总超时秒数（默认 `180`）
- `EDGE_HTTP_CONNECT_TIMEOUT_SEC`：Python 上游连接超时秒数（默认 `20`）
- `EDGE_FETCH_TIMEOUT_MS`：Worker 上游请求超时毫秒（默认 `180000`）
- `EDGE_TTS_BASE_SPEED`：速度基准（默认 `10`）
- `EDGE_TTS_STEP_PERCENT`：速度步进映射百分比（默认 `4`）

## 说明与注意事项
- 当前仅支持 `edge` 引擎。
- Python 与 Worker 共享同一套核心环境变量命名，未配置时均使用内置默认值。
- `/tts` 的 `style` 可用性与具体音色组合相关，建议按实际效果选择。
- 统计为服务维度统计，不区分用户身份。

## License
按你的发布计划自行补充 License 文件。
