# 企业微信「群机器人」推送网关（Cloudflare Worker）

将企业微信群机器人 Webhook 包装成统一的 HTTP 接口，支持 Token 校验，消息类型覆盖 text / markdown / image / news(link) / file / template_card。文件和图片均可直接通过 multipart/form-data 上传：Worker 内部自动处理上传或计算 base64+md5，再发送到群。

## 环境变量
- `WEBHOOK_URL`：群机器人 URL（可选）
- `QYWX_ROBOT_KEY`：机器人 key，若未设置 `WEBHOOK_URL` 则自动拼接为正式地址
- `ALLOW_TOKENS`：可选，逗号分隔。请求需在 `Authorization: Bearer <token>` 或查询参数 `?token=<token>` / `?access_token=<token>` 中携带其一。留空则不校验。

## 部署
1) 安装并登录 Wrangler：`npm i -g wrangler && wrangler login`  
2) 设置环境变量（示例）：  
   - `wrangler secret put QYWX_ROBOT_KEY`  
   - `wrangler secret put ALLOW_TOKENS`  
   （已提供完整 `WEBHOOK_URL` 时可以不设 `QYWX_ROBOT_KEY`）  
3) 发布：`wrangler deploy`

默认入口：`POST https://<worker>.workers.dev/`

## 请求格式
发送接口：`POST /`（或 `/send`），Worker 使用环境变量中的 `WEBHOOK_URL` 或 `QYWX_ROBOT_KEY` 作为唯一推送目标。支持三种调用方式：
- 纯文本：默认按 `text`；若需 Markdown，URL 加 `?type=markdown`（已有 query 用 `&type=markdown`）
- JSON：`{ "type": "...", ... }`
- multipart：字段 `file` 或 `media`；可选 `type=image` 走图片通道，否则走文件通道

支持类型：
- `text`：`content`；可选 `mentioned_list`、`mentioned_mobile_list`
- `markdown`：`content`
- `image`：`base64`、`md5`（可只传 `base64`，Worker 自动计算 md5；也可用 multipart 上传文件，见下）
- `news` / `link`：`articles` 数组（字段：`title`、`url`，可选 `description`、`picurl`，最多 8 条）；可用单条简写 `title`+`url`(+`description`/`picurl`)
- `file`：两种方式  
  1) JSON：传 `media_id`（已通过机器人上传获得）  
  2) multipart/form-data：字段 `file`，Worker 内部先上传再发送；文件需大于 5B 且不超过 20MB，上传接口仅支持 `type=file`
- `template_card`：直接传官方格式的 `template_card` 对象（如 text_notice/news_notice 等），Worker 原样转发

未支持：语音等不在群机器人能力范围，需走企业应用通道。

## 调用示例

更多脚本示例：`examples/python_client.py`（标准库）、`examples/python_httpx_client.py`、`examples/python_requests_client.py`。

```bash
URL="https://<worker>.workers.dev/?token=demo"

# 文本（纯文本）
curl -X POST "$URL" \
  -H "Content-Type: text/plain" \
  -d "纯文本快速推送"

# Markdown（纯文本 + type=markdown）
curl -X POST "$URL&type=markdown" \
  -H "Content-Type: text/plain" \
  --data-binary $'**Markdown**\n> 直接发正文'

# 文本
curl -X POST "$URL" -H "Content-Type: application/json" -d '{
  "type": "text",
  "content": "你好，群机器人",
  "mentioned_list": ["@all"]
}'

# Markdown
curl -X POST "$URL" -H "Content-Type: application/json" -d '{
  "type": "markdown",
  "content": "**部署成功** ✅"
}'

# 图片：只给 base64，md5 由 Worker 自动计算
BASE64=$(base64 -w0 ./logo.png)
curl -X POST "$URL" -H "Content-Type: application/json" -d "{
  \"type\":\"image\",
  \"base64\":\"$BASE64\"
}"

# 图片：直接上传文件，Worker 自动计算 base64+md5 并发送（size ≤ 2MB）
curl -X POST "$URL" \
  -H "Authorization: Bearer demo" \
  -H "Content-Type: multipart/form-data" \
  -F "file=@/path/to/logo.png" \
  -F "type=image"

# 模板卡片（示例 text_notice，注意 card_action 必填）
curl -X POST "$URL" -H "Content-Type: application/json" -d '{
  "type": "template_card",
  "template_card": {
    "card_type": "text_notice",
    "source": { "desc": "通知" },
    "main_title": { "title": "标题", "desc": "描述" },
    "emphasis_content": { "title": "重点", "desc": "说明" },
    "horizontal_content_list": [{ "keyname": "链接", "value": "点击", "type": 1, "url": "https://example.com" }],
    "card_action": { "type": 1, "url": "https://example.com" },
    "jump_list": [{ "type": 1, "title": "查看详情", "url": "https://example.com" }]
  }
}'

# 文件：直接上传并发送（multipart/form-data，字段名 file 或 media；Worker 转发时使用字段名 media）
curl -X POST "$URL" \
  -H "Authorization: Bearer demo" \
  -F "file=@/path/to/file.pdf"
# 返回同时包含 upload/send 结果和 media_id

# 图文 / 链接
curl -X POST "$URL" -H "Content-Type: application/json" -d '{
  "type": "link",
  "title": "产品更新",
  "description": "查看最新版本",
  "url": "https://example.com/changelog",
  "picurl": "https://example.com/cover.png"
}'
```

返回示例：
```json
{
  "ok": true,
  "upstream_status": 200,
  "errcode": 0,
  "errmsg": "ok"
}
```

## 关于多个群
- 每个群的机器人都会生成独立的 webhook；一个 webhook 只对应创建它的那个群。
- 当前 Worker 使用环境变量里的单个 webhook，因此消息会推送到该 webhook 对应的群。
- 若要推送到多个群，请为每个群的 webhook 分别部署一个 Worker（或自行扩展请求体选择 webhook）。

## 说明
- 仅使用群机器人 Webhook，不需要企业应用的 corpId/agentId/corpSecret。
- Token 校验可选，便于对外暴露入口时做简单防护。
- 若需要切换回企业应用消息通道，请再告知。 
