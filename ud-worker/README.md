# UD Relay（Cloudflare Workers + R2 + Durable Objects）

一次性文件中转：上传成功后生成下载链接，下载 1 次即失效。仅开放 `/hc /hp /ud /ud/f/...`，其他路径均为空 404。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xiaofd/cfworkers/tree/main/ud-worker)

> 一键部署会自动创建 Worker / DO / R2 绑定；需先在 Cloudflare 账号开通 R2。Secrets（如 `UD_API_KEY`）仍需部署后手动配置。

## 环境准备
- Node.js 18+，npm
- Cloudflare 账号，开启 R2 与 Durable Objects
- Wrangler CLI：`npm install -g wrangler`

## 部署步骤
1) 安装依赖  
```bash
npm install
```

2) R2 / DO 资源创建（在项目根目录执行）  
```bash
# 创建 R2 bucket（可自定义名称，但需与 wrangler.toml 对应）
wrangler r2 bucket create ud-bucket

# 发布 Durable Object
wrangler deploy --dry-run   # 预检查
wrangler deploy             # 实际部署
```

3) 配置环境变量 / Secrets  
```bash
# 必需：无

# 可选：上传鉴权 key
wrangler secret put UD_API_KEY

# 可选：挂载路径前缀（如部署在 /relay，则填 /relay）
wrangler kv:key put UD_BASE_PATH "/relay"

# 可选：上传大小/速率/待下载上限/TTL（单位见下）
wrangler kv:key put UD_MAX_MB "100"
wrangler kv:key put UD_RATE_LIMIT_SEC "2"
wrangler kv:key put UD_MAX_PENDING "10"
wrangler kv:key put UD_TTL_SEC "86400"
```
> 说明：Cloudflare 目前不支持在 Workers 上通过 KV 写入环境变量，上述命令仅示意。实际请在 `wrangler.toml` 的 `[vars]` 或线上 Dashboard → Workers → Settings → Variables 中配置字符串值。

`wrangler.toml` 中需确保：
```toml
[[r2_buckets]]
binding = "UD_BUCKET"
bucket_name = "ud-bucket"

[[durable_objects.bindings]]
name = "UD_STATE"
class_name = "UDState"
```

4) 本地开发与预览  
```bash
wrangler dev
# 浏览器访问 http://127.0.0.1:8787/ud
```

5) 正式发布  
```bash
wrangler publish
```

## 环境变量说明
- `UD_API_KEY`：可选，设置后上传必须带 key（查询参数 `?key=`、header `X-API-Key`、或表单字段 `key`）。
- `UD_BASE_PATH`：可选，部署在子路径时设置，例如 `/relay`。
- `UD_MAX_MB`：可选，最大上传 MB，默认 100。
- `UD_RATE_LIMIT_SEC`：可选，单 IP 频率（秒），默认 2，设 0 关闭。
- `UD_MAX_PENDING`：可选，待下载上限，默认 10，设 0 关闭（不淘汰）。
- `UD_TTL_SEC`：可选，链接 TTL（秒），默认 86400，设 0 关闭。

## 使用说明
- 浏览器上传：访问 `/ud`，选择文件（如需 key 则填写），提交后获得一次性下载链接，成功下载后即失效。
- 命令行上传：  
  ```bash
  # 无鉴权
  curl -sS -F "file=@/path/to/file" "https://<your-domain>/ud"
  # 需要 key
  curl -sS -F "file=@/path/to/file" "https://<your-domain>/ud?key=YOUR_KEY"
  ```
- 直传文件（保留原文件名；推荐 -T）：  
  ```bash
  # 通过 name 指定文件名
  curl -sS -T "/path/to/file" "https://<your-domain>/ud?name=filename.ext"
  # 需要 key
  curl -sS -T "/path/to/file" "https://<your-domain>/ud?name=filename.ext&key=YOUR_KEY"
  # 不指定 name 时，自动保存为随机 8 位 .bin
  ```
- 直传文本（保存为 <timestamp>.txt）：  
  ```bash
  # 无鉴权
  curl -sS -d "hello world" "https://<your-domain>/ud"
  # 需要 key
  curl -sS -d "hello world" "https://<your-domain>/ud?key=YOUR_KEY"
  ```
- 下载：使用返回的链接 `https://<domain>/ud/f/<token>/<filename>`；成功一次后 404。
- 健康检查：`/hc` 返回 JSON，包含调用次数、待下载数量/体积、R2 对象数/存储量。
- 帮助：`/hp` 返回中文说明（浏览器为美化页面，命令行为纯文本）。

## 源代码迁移
将本仓库文件复制到目标项目，并保证：
- `src/index.ts` 保持入口；`wrangler.toml` 中 R2/DO 绑定名称与代码一致（`UD_BUCKET`、`UD_STATE`）。
- `package.json`/`package-lock.json` 同步；执行 `npm install` 确保依赖完整。

## 注意事项
- 同名文件上传会覆盖旧文件并删除旧对象。
- 速率限制基于上传 IP；`lastUpload` 会定期清理旧 IP 记录。
- DO 清理任务：定时触发 `scheduled` 清理过期/卡住的 token，并淘汰超出上限的待下载对象。

## 默认值速查
Worker（Cloudflare）：
- `UD_MAX_MB=100`
- `UD_RATE_LIMIT_SEC=2`

本地 Python：
- `UD_MAX_UPLOAD_MB=100`
- `UD_RATE_LIMIT_SECONDS=2`
