#!/usr/bin/env python3
"""
requests 示例：调用企业微信群机器人 Worker。

准备：
- pip install requests
- 设置环境变量 WORKER_URL，例如 https://your-worker.workers.dev
- 可选 TOKEN，用于 Authorization: Bearer <TOKEN>
- 可选 SAMPLE_FILE，指定本地文件用于上传/转 base64（未提供则使用内置 1x1 PNG）
"""

from __future__ import annotations

import base64
import json
import os
import struct
import sys
import zlib

import requests

WORKER_URL = os.getenv("WORKER_URL", "").strip()
TOKEN = os.getenv("TOKEN", "").strip()


def add_auth(headers: dict[str, str]) -> dict[str, str]:
    if TOKEN:
        headers["Authorization"] = f"Bearer {TOKEN}"
    return headers


def build_sample_png() -> bytes:
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


def show_response(label: str, resp: requests.Response) -> None:
    print(f"\n== {label} ==")
    try:
        print(resp.status_code, json.dumps(resp.json(), ensure_ascii=False))
    except Exception:
        print(resp.status_code, resp.text)


def post_text(session: requests.Session) -> None:
    resp = session.post(
        WORKER_URL,
        data="你好，群机器人（requests 纯文本）",
        headers=add_auth({"Content-Type": "text/plain"}),
        timeout=15,
    )
    show_response("text (纯文本)", resp)


def post_markdown(session: requests.Session) -> None:
    resp = session.post(
        WORKER_URL,
        params={"type": "markdown"},
        data="**Markdown** 示例\n> requests 纯文本 + type=markdown",
        headers=add_auth({"Content-Type": "text/plain"}),
        timeout=15,
    )
    show_response("markdown (纯文本 + type=markdown)", resp)


def post_link(session: requests.Session) -> None:
    payload = {
        "type": "link",
        "title": "产品更新",
        "description": "来自 requests 的链接/图文示例",
        "url": "https://example.com/changelog",
        "picurl": "https://example.com/cover.png",
    }
    resp = session.post(WORKER_URL, json=payload, headers=add_auth({}), timeout=15)
    show_response("news/link (JSON)", resp)


def post_image_base64(session: requests.Session, content_bytes: bytes) -> None:
    img_b64 = base64.b64encode(content_bytes).decode()
    payload = {"type": "image", "base64": img_b64}
    resp = session.post(WORKER_URL, json=payload, headers=add_auth({}), timeout=15)
    show_response("image (JSON base64)", resp)


def upload_file(session: requests.Session, content_bytes: bytes, as_image: bool = False) -> None:
    data = {"type": "image"} if as_image else None
    resp = session.post(
        WORKER_URL,
        data=data,
        files={"file": ("sample.png", content_bytes, "image/png")},
        headers=add_auth({}),
        timeout=30,
    )
    label = "multipart upload (type=image)" if as_image else "multipart upload (file)"
    show_response(label, resp)


def main() -> None:
    if not WORKER_URL:
        print("请先设置 WORKER_URL 环境变量", file=sys.stderr)
        sys.exit(1)

    sample_bytes = load_sample_bytes()
    with requests.Session() as session:
        post_text(session)
        post_markdown(session)
        post_link(session)
        post_image_base64(session, sample_bytes)
        upload_file(session, sample_bytes, as_image=False)
        upload_file(session, sample_bytes, as_image=True)


if __name__ == "__main__":
    main()
