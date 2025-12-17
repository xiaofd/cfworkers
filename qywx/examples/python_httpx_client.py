#!/usr/bin/env python3
"""
httpx 示例：调用企业微信群机器人 Worker。

准备：
- pip install httpx
- 设置环境变量 WORKER_URL，例如 https://your-worker.workers.dev
- 可选 TOKEN，用于 Authorization: Bearer <TOKEN>
- 可选 SAMPLE_FILE，指定本地文件用于上传/转 base64（若未提供则使用内置 1x1 PNG）
"""

from __future__ import annotations

import base64
import os
import struct
import sys
import zlib

import httpx

WORKER_URL = os.getenv("WORKER_URL", "").strip()
TOKEN = os.getenv("TOKEN", "").strip()
TIMEOUT = httpx.Timeout(15.0)


def add_auth(headers: dict[str, str]) -> dict[str, str]:
    if TOKEN:
        headers["Authorization"] = f"Bearer {TOKEN}"
    return headers


def build_sample_png() -> bytes:
    """生成带滤波字节的 1x1 RGBA PNG，与 test_all.sh 一致。"""
    width, height = 1, 1
    color = b"\xff\x00\x00\xff"  # red rgba

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    raw_row = b"\x00" + color  # filter byte + pixel
    idat = zlib.compress(raw_row)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def load_sample_bytes() -> bytes:
    sample_file = os.getenv("SAMPLE_FILE")
    if sample_file and os.path.exists(sample_file):
        with open(sample_file, "rb") as f:
            return f.read()
    return build_sample_png()


def show_response(label: str, resp: httpx.Response) -> None:
    print(f"\n== {label} ==")
    try:
        print(resp.status_code, resp.json())
    except Exception:
        print(resp.status_code, resp.text)


def post_text(client: httpx.Client) -> None:
    resp = client.post(
        WORKER_URL,
        content="你好，群机器人（httpx 纯文本）",
        headers=add_auth({"Content-Type": "text/plain"}),
    )
    show_response("text (纯文本)", resp)


def post_markdown(client: httpx.Client) -> None:
    resp = client.post(
        WORKER_URL,
        params={"type": "markdown"},
        content="**Markdown** 示例\n> httpx 纯文本 + type=markdown",
        headers=add_auth({"Content-Type": "text/plain"}),
    )
    show_response("markdown (纯文本 + type=markdown)", resp)


def post_link(client: httpx.Client) -> None:
    payload = {
        "type": "link",
        "title": "产品更新",
        "description": "来自 httpx 的链接/图文示例",
        "url": "https://example.com/changelog",
        "picurl": "https://example.com/cover.png",
    }
    resp = client.post(WORKER_URL, json=payload, headers=add_auth({}))
    show_response("news/link (JSON)", resp)


def post_image_base64(client: httpx.Client, content_bytes: bytes) -> None:
    img_b64 = base64.b64encode(content_bytes).decode()
    payload = {"type": "image", "base64": img_b64}  # md5 由 Worker 自动计算
    resp = client.post(WORKER_URL, json=payload, headers=add_auth({}))
    show_response("image (JSON base64)", resp)


def upload_file(client: httpx.Client, content_bytes: bytes, as_image: bool = False) -> None:
    data = {"type": "image"} if as_image else None
    resp = client.post(
        WORKER_URL,
        data=data,
        files={"file": ("sample.png", content_bytes, "image/png")},
        headers=add_auth({}),
        timeout=30.0,
    )
    label = "multipart upload (type=image)" if as_image else "multipart upload (file)"
    show_response(label, resp)


def main() -> None:
    if not WORKER_URL:
        print("请先设置 WORKER_URL 环境变量", file=sys.stderr)
        sys.exit(1)

    sample_bytes = load_sample_bytes()
    with httpx.Client(timeout=TIMEOUT) as client:
        post_text(client)
        post_markdown(client)
        post_link(client)
        post_image_base64(client, sample_bytes)
        upload_file(client, sample_bytes, as_image=False)
        upload_file(client, sample_bytes, as_image=True)


if __name__ == "__main__":
    main()
