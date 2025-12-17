#!/usr/bin/env python3
"""
Python 示例：调用企业微信群机器人 Worker。

准备：
- 设置环境变量 WORKER_URL，例如 https://your-worker.workers.dev
- 可选 TOKEN，用于 Authorization: Bearer <TOKEN>
"""

from __future__ import annotations

import json
import mimetypes
import os
import secrets
import sys
import urllib.request

WORKER_URL = os.getenv("WORKER_URL", "").strip()
TOKEN = os.getenv("TOKEN", "").strip()


def add_auth(headers: dict[str, str]) -> dict[str, str]:
    if TOKEN:
        headers["Authorization"] = f"Bearer {TOKEN}"
    return headers


def post_json(payload: dict) -> str:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        WORKER_URL,
        data=data,
        headers=add_auth({"Content-Type": "application/json"}),
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read().decode("utf-8")


def post_text(text: str, markdown: bool = False) -> str:
    url = WORKER_URL
    if markdown:
        sep = "&" if "?" in url else "?"
        url = f"{url}{sep}type=markdown"
    req = urllib.request.Request(
        url,
        data=text.encode("utf-8"),
        headers=add_auth({"Content-Type": "text/plain"}),
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read().decode("utf-8")


def post_file(path: str, as_image: bool = False) -> str:
    boundary = "----qywx" + secrets.token_hex(8)
    filename = os.path.basename(path) or "file.bin"
    content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    with open(path, "rb") as f:
        file_bytes = f.read()

    parts = []
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n"
    )
    parts.append(file_bytes)
    parts.append("\r\n")
    if as_image:
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\nimage\r\n')
    parts.append(f"--{boundary}--\r\n")

    body = b"".join(p if isinstance(p, bytes) else p.encode("utf-8") for p in parts)
    headers = add_auth(
        {"Content-Type": f"multipart/form-data; boundary={boundary}"}
    )
    req = urllib.request.Request(WORKER_URL, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8")


def main() -> None:
    if not WORKER_URL:
        print("请先设置 WORKER_URL 环境变量", file=sys.stderr)
        sys.exit(1)

    print("== 文本示例 ==")
    print(post_text("你好，群机器人"))

    print("\n== Markdown 示例 ==")
    print(post_text("**Markdown** 测试", markdown=True))

    print("\n== JSON 示例（text） ==")
    print(post_json({"type": "text", "content": "JSON 格式测试"}))

    # 如需上传图片，as_image=True，Worker 会计算 base64+md5 并走 image 通道
    sample_file = os.getenv("SAMPLE_FILE")
    if sample_file and os.path.exists(sample_file):
        print("\n== 上传文件示例 ==")
        print(post_file(sample_file, as_image=False))
        print("\n== 上传图片示例 ==")
        print(post_file(sample_file, as_image=True))
    else:
        print("\n未设置 SAMPLE_FILE，跳过上传示例", file=sys.stderr)


if __name__ == "__main__":
    main()
