#!/usr/bin/env bash
set -euo pipefail

# 一键测试 Worker 网关的所有消息类型，包括上传文件并发送。
# 环境变量：
#   WORKER_URL=...   # 你的 Worker 入口，例如 https://your-worker.workers.dev
#   TOKEN=...        # 可选，若 Worker 开启 ALLOW_TOKENS，可用 Bearer 传递
# 用法：
#   chmod +x test_all.sh
#   WORKER_URL="https://your-worker.workers.dev" ./test_all.sh

WORKER_URL="${WORKER_URL:-}"
TOKEN_HEADER=()
if [[ -n "${TOKEN:-}" ]]; then
  TOKEN_HEADER=(-H "Authorization: Bearer ${TOKEN}")
fi

if [[ -z "${WORKER_URL}" ]]; then
  echo "请设置 WORKER_URL 环境变量后再执行" >&2
  exit 1
fi

post() {
  local payload="$1"
  echo "==> 发送：$2"
  curl -sS -X POST "${TOKEN_HEADER[@]}" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    "$WORKER_URL" | tee /dev/stderr
  echo -e "\n"
}

# 文本（纯文本）
echo "==> 发送：text (纯文本)"
curl -sS -X POST "${TOKEN_HEADER[@]}" \
  -H "Content-Type: text/plain" \
  -d "文本消息测试 @all" \
  "$WORKER_URL" | tee /dev/stderr
echo -e "\n"

# Markdown（纯文本 + type=markdown，自动处理是否已有 query）
MD_URL="$WORKER_URL"
if [[ "$MD_URL" == *\?* ]]; then
  MD_URL="${MD_URL}&type=markdown"
else
  MD_URL="${MD_URL}?type=markdown"
fi
echo "==> 发送：markdown (纯文本 + type=markdown)"
curl -sS -X POST "${TOKEN_HEADER[@]}" \
  -H "Content-Type: text/plain" \
  --data-binary $'**Markdown 测试**\n> 来自 test_all.sh' \
  "$MD_URL" | tee /dev/stderr
echo -e "\n"

# 图文 / 链接
post '{
  "type": "link",
  "title": "产品更新",
  "description": "查看最新版本",
  "url": "https://example.com/changelog",
  "picurl": "https://example.com/cover.png"
}' "news/link"

# 用 Python 生成带滤波字节的 1x1 RGBA PNG，确保格式正确
TMP_FILE="$(mktemp /tmp/qywx-file-XXXXXX.png)"
python - "$TMP_FILE" <<'PY'
import struct,zlib,base64,sys
path=sys.argv[1]
width=1;height=1
color=b'\xff\x00\x00\xff'  # red rgba
def chunk(t,data):
    return struct.pack(">I", len(data))+t+data+struct.pack(">I", zlib.crc32(t+data)&0xffffffff)
ihdr=struct.pack(">IIBBBBB", width,height,8,6,0,0,0)
raw_row=b'\x00'+color  # filter byte + pixel
idat=zlib.compress(raw_row)
png=b"\x89PNG\r\n\x1a\n"+chunk(b'IHDR', ihdr)+chunk(b'IDAT', idat)+chunk(b'IEND', b'')
with open(path,"wb") as f:
    f.write(png)
print(base64.b64encode(png).decode())
PY
IMG_BASE64=$(python - "$TMP_FILE" <<'PY'
import base64,sys
with open(sys.argv[1],"rb") as f:
    print(base64.b64encode(f.read()).decode())
PY
)
echo "==> 发送：image (JSON base64，如有 40123 可换真实图片)"
post "{\"type\":\"image\",\"base64\":\"${IMG_BASE64}\"}" "image"

# 上传并发送文件或图片（使用内置 PNG；type=image 触发图片通道）
echo "==> 上传并发送文件（默认 file）；如需走 image 通道请传 type=image"
UPLOAD_RESP=$(curl -sS -X POST "${TOKEN_HEADER[@]}" \
  -F "file=@${TMP_FILE}" \
  "$WORKER_URL")
echo "$UPLOAD_RESP"
echo "==> 上传并发送图片（type=image，经 Worker 计算 base64+md5）"
UPLOAD_RESP=$(curl -sS -X POST "${TOKEN_HEADER[@]}" \
  -F "file=@${TMP_FILE}" \
  -F "type=image" \
  "$WORKER_URL")
echo "$UPLOAD_RESP"
rm -f "$TMP_FILE"

# 生成并上传 12MB 文件测试大文件上传（file 通道）
BIG_FILE="$(mktemp /tmp/qywx-big-XXXXXX.bin)"
dd if=/dev/zero of="$BIG_FILE" bs=1M count=12 status=none
echo "==> 上传并发送 12MB 文件（file 通道）"
UPLOAD_RESP=$(curl -sS -X POST "${TOKEN_HEADER[@]}" \
  -F "file=@${BIG_FILE}" \
  "$WORKER_URL")
echo "$UPLOAD_RESP"
rm -f "$BIG_FILE"

# 模板卡片示例（text_notice）
post '{
  "type": "template_card",
  "template_card": {
    "card_type": "text_notice",
    "source": { "desc": "通知" },
    "main_title": { "title": "模板卡片", "desc": "text_notice 示例" },
    "emphasis_content": { "title": "重点", "desc": "内容" },
    "horizontal_content_list": [
      { "keyname": "链接", "value": "点击查看", "type": 1, "url": "https://example.com" }
    ],
    "card_action": { "type": 1, "url": "https://example.com" },
    "jump_list": [
      { "type": 1, "title": "查看详情", "url": "https://example.com" }
    ]
  }
}' "template_card"
