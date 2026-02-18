# Cloudflare Worker (TypeScript)

本目录是基于本项目听书 API 需求的 Worker 实现。

## 路由
- `GET /healthz`
- `GET /engines`
- `GET /legado-config`
- `GET|POST /tts`
- `GET /stats`

## 本地调试
```bash
cd worker
npx wrangler dev
```

## 部署
```bash
cd worker
npx wrangler deploy
```

## 说明
- 仅支持 `edge` 引擎。
- `/tts` 支持参数：`engine,speakText,text,speakSpeed,rate,voice,style,pitch,volume`。
- `/stats` 为 Worker 进程内统计，实例重启或冷启动后会重置。
