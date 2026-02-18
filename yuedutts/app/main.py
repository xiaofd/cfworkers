import asyncio
import base64
from datetime import datetime
from email.utils import formatdate
import hashlib
import hmac
import json
import logging
import os
import re
import threading
import time
import uuid
import zlib
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, quote_plus

import aiohttp
from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="Legado Edge-TTS Gateway", version="3.0.0")
BASE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BASE_DIR.parent
STATIC_DIR = PROJECT_ROOT / "web" / "static"
DATA_DIR = PROJECT_ROOT / "data"
STATS_FILE = DATA_DIR / "runtime_stats.json"
logger = logging.getLogger("uvicorn.error")
PROCESS_STARTED_AT = time.time()

ENGINE_EDGE = "edge"
DEFAULT_ENGINE = ENGINE_EDGE
DEFAULT_EDGE_VOICE = "zh-CN-YunxiNeural"
DEFAULT_EDGE_PITCH_HZ = 0
DEFAULT_EDGE_VOLUME_PERCENT = 0

MIN_SPEAK_SPEED = 5
MAX_SPEAK_SPEED = 50
MIN_EDGE_PITCH_HZ = -100
MAX_EDGE_PITCH_HZ = 100
MIN_EDGE_VOLUME_PERCENT = -100
MAX_EDGE_VOLUME_PERCENT = 100
BASE_SPEED = int(os.getenv("EDGE_TTS_BASE_SPEED", "10"))
SPEED_STEP_PERCENT = int(os.getenv("EDGE_TTS_STEP_PERCENT", "4"))
MIN_EDGE_RATE_PERCENT = -10
MAX_EDGE_RATE_PERCENT = 200


def env_int(name: str, default: int, min_value: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(min_value, value)


def env_float(name: str, default: float, min_value: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return max(min_value, value)


MAX_TEXT_LEN = env_int("TTS_MAX_TEXT_LEN", 20000, 1)
MAX_BODY_BYTES = env_int("TTS_MAX_BODY_BYTES", 512 * 1024, 1024)
ENGINE_STATUS_CACHE_TTL_SEC = env_float("ENGINE_STATUS_CACHE_TTL_SEC", 30.0, 1.0)
TOKEN_REFRESH_BEFORE_EXPIRY_SEC = env_int("EDGE_TOKEN_REFRESH_BEFORE_EXPIRY_SEC", 3 * 60, 30)
EDGE_HTTP_TIMEOUT_SEC = env_float("EDGE_HTTP_TIMEOUT_SEC", 180.0, 5.0)
EDGE_HTTP_CONNECT_TIMEOUT_SEC = env_float("EDGE_HTTP_CONNECT_TIMEOUT_SEC", 20.0, 1.0)
EDGE_ENDPOINT_URL = "https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0"
EDGE_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3"
EDGE_SIGN_SECRET_B64 = "oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw=="

ENGINE_CONFIG = {
    ENGINE_EDGE: {"label": "Edge", "content_type": "audio/mpeg", "default_voice": DEFAULT_EDGE_VOICE},
}
VOICE_LABELS = {
    "zh-CN-YunxiNeural": "云希（男，沉稳叙述）",
    "zh-CN-XiaoxiaoNeural": "晓晓（女，通用自然）",
    "zh-CN-YunyeNeural": "云野（男，新闻旁白）",
    "zh-CN-XiaoyiNeural": "晓伊（女，温和清晰）",
    "zh-CN-YunjianNeural": "云健（男，理性清楚）",
    "zh-CN-XiaochenNeural": "晓辰（女，轻快口语）",
    "zh-CN-XiaohanNeural": "晓涵（女，柔和）",
    "zh-CN-XiaomengNeural": "晓梦（女，亲和）",
    "zh-CN-XiaomoNeural": "晓墨（女，讲述感）",
    "zh-CN-XiaoqiuNeural": "晓秋（女，温柔）",
    "zh-CN-XiaoruiNeural": "晓睿（女，干练）",
    "zh-CN-XiaoshuangNeural": "晓双（女，平稳）",
    "zh-CN-XiaoxiaoDialectsNeural": "晓晓（方言混读）",
    "zh-CN-XiaoyanNeural": "晓颜（女，客服风）",
    "zh-CN-XiaoyouNeural": "晓悠（女，轻柔）",
    "zh-CN-shaanxi-XiaoniNeural": "晓妮（陕西话）",
    "zh-CN-shandong-YunxiangNeural": "云翔（山东话）",
    "zh-CN-liaoning-XiaobeiNeural": "小贝（辽宁话）",
    "zh-CN-henan-YundengNeural": "云登（河南话）",
    "zh-HK-HiuGaaiNeural": "曉佳（粤语女）",
    "zh-HK-HiuMaanNeural": "曉曼（粤语女）",
    "zh-HK-WanLungNeural": "雲龍（粤语男）",
    "zh-TW-HsiaoChenNeural": "曉臻（台湾女）",
    "zh-TW-HsiaoYuNeural": "曉雨（台湾女）",
    "zh-TW-YunJheNeural": "雲哲（台湾男）",
}
VOICE_OPTIONS = [{"voice": voice, "label": label} for voice, label in VOICE_LABELS.items()]

_engine_status_cache: dict[str, tuple[float, bool, str]] = {}
_engine_cache_lock = threading.Lock()
_edge_token_lock = asyncio.Lock()
_edge_token_info: dict[str, str | int | None] = {
    "region": None,
    "token": None,
    "expiredAt": None,
}
SSML_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def new_counter() -> dict[str, int]:
    return {"requests": 0, "success": 0, "failed": 0, "audioBytes": 0, "textChars": 0}


_stats_lock = threading.Lock()
_runtime_stats = {
    "startedAt": PROCESS_STARTED_AT,
    "todayKey": datetime.now().strftime("%Y-%m-%d"),
    "monthKey": datetime.now().strftime("%Y-%m"),
    "inFlight": 0,
    "maxConcurrent": 0,
    "total": new_counter(),
    "today": new_counter(),
    "month": new_counter(),
    "engines": {engine: {**new_counter(), "lastError": ""} for engine in ENGINE_CONFIG},
}


ENGINE_CONCURRENCY_LIMITS = {
    ENGINE_EDGE: env_int("EDGE_MAX_CONCURRENCY", 16, 1),
}
ENGINE_SEMAPHORES = {
    engine: asyncio.Semaphore(max(1, limit))
    for engine, limit in ENGINE_CONCURRENCY_LIMITS.items()
}


class GatewayError(Exception):
    def __init__(self, status_code: int, client_detail: str, log_detail: str):
        super().__init__(log_detail)
        self.status_code = status_code
        self.client_detail = client_detail
        self.log_detail = log_detail


def to_edge_rate(speak_speed: int) -> str:
    clamped = max(MIN_SPEAK_SPEED, min(MAX_SPEAK_SPEED, speak_speed))
    speed_diff = (clamped - BASE_SPEED) * SPEED_STEP_PERCENT
    speed_diff = max(MIN_EDGE_RATE_PERCENT, min(MAX_EDGE_RATE_PERCENT, speed_diff))
    return f"+{speed_diff}%" if speed_diff >= 0 else f"{speed_diff}%"


def to_edge_pitch(pitch_hz: int) -> str:
    clamped = max(MIN_EDGE_PITCH_HZ, min(MAX_EDGE_PITCH_HZ, pitch_hz))
    return f"+{clamped}Hz" if clamped >= 0 else f"{clamped}Hz"


def to_edge_volume(volume_percent: int) -> str:
    clamped = max(MIN_EDGE_VOLUME_PERCENT, min(MAX_EDGE_VOLUME_PERCENT, volume_percent))
    return f"+{clamped}%" if clamped >= 0 else f"{clamped}%"


def legado_config_id(engine: str, voice: str) -> int:
    raw = f"{engine}:{voice}".encode("utf-8")
    return 100000 + (zlib.crc32(raw) % 900000)


def normalize_voice(engine: str, voice: Optional[str]) -> str:
    default_voice = ENGINE_CONFIG[engine]["default_voice"]
    return voice or default_voice


def is_safe_ssml_token(value: str) -> bool:
    return bool(SSML_TOKEN_RE.fullmatch(value))


def voice_display_name(voice: str) -> str:
    return VOICE_LABELS.get(voice, voice)


def edge_date_format() -> str:
    return formatdate(usegmt=True).lower()


def base64url_decode(segment: str) -> bytes:
    pad = "=" * ((4 - len(segment) % 4) % 4)
    return base64.urlsafe_b64decode(segment + pad)


def build_edge_signature(url: str) -> str:
    encoded_url = quote_plus(url.split("://", 1)[1])
    uid = uuid.uuid4().hex
    formatted_date = edge_date_format()
    to_sign = f"MSTranslatorAndroidApp{encoded_url}{formatted_date}{uid}".lower().encode("utf-8")
    secret = base64.b64decode(EDGE_SIGN_SECRET_B64)
    digest = hmac.new(secret, to_sign, hashlib.sha256).digest()
    sig_b64 = base64.b64encode(digest).decode("ascii")
    return f"MSTranslatorAndroidApp::{sig_b64}::{formatted_date}::{uid}"


def build_ssml(text: str, voice: str, rate: str, pitch: str, volume: str, style: str) -> str:
    escaped = (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )
    return (
        '<speak xmlns="http://www.w3.org/2001/10/synthesis" '
        'xmlns:mstts="http://www.w3.org/2001/mstts" version="1.0" xml:lang="zh-CN">'
        f'<voice name="{voice}"><mstts:express-as style="{style}" styledegree="2.0" role="default">'
        f'<prosody rate="{rate}" pitch="{pitch}" volume="{volume}">{escaped}</prosody>'
        "</mstts:express-as></voice></speak>"
    )


def build_legado_config_payload(base_url: str, engine: str, voice: str) -> dict:
    config_id = legado_config_id(engine, voice)
    tts_url = (
        f"{base_url}/tts"
        f"?engine={quote_plus(engine)}"
        "&speakText={{java.encodeURI(speakText)}}"
        "&speakSpeed={{speakSpeed}}"
        f"&voice={quote_plus(voice)}"
        "&style=general&pitch=0&volume=0"
    )
    return {
        "concurrentRate": "0",
        "contentType": ENGINE_CONFIG[engine]["content_type"],
        "header": "",
        "id": config_id,
        "loginCheckJs": "",
        "loginui": "",
        "loginurl": "",
        "name": f"{ENGINE_CONFIG[engine]['label']}-{voice_display_name(voice)}",
        "url": tts_url,
        "urlArgs": "{\"method\":\"GET\",\"body\":\"\"}",
    }


async def get_edge_endpoint() -> tuple[str, str]:
    now = int(time.time())
    async with _edge_token_lock:
        region = _edge_token_info.get("region")
        token = _edge_token_info.get("token")
        expired_at = _edge_token_info.get("expiredAt")
        if (
            isinstance(region, str)
            and isinstance(token, str)
            and isinstance(expired_at, int)
            and now < (expired_at - TOKEN_REFRESH_BEFORE_EXPIRY_SEC)
        ):
            return region, token

        client_id = uuid.uuid4().hex
        headers = {
            "accept-language": "zh-Hans",
            "x-clientversion": "4.0.530a 5fe1dc6c",
            "x-userid": "0f04d16a175c411e",
            "x-homegeographicregion": "zh-Hans-CN",
            "x-clienttraceid": client_id,
            "x-mt-signature": build_edge_signature(EDGE_ENDPOINT_URL),
            "user-agent": "Mozilla/5.0",
            "content-type": "application/json; charset=utf-8",
            "content-length": "0",
            "accept-encoding": "gzip",
        }

        try:
            timeout = aiohttp.ClientTimeout(total=EDGE_HTTP_TIMEOUT_SEC, connect=EDGE_HTTP_CONNECT_TIMEOUT_SEC)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(EDGE_ENDPOINT_URL, headers=headers, data=b"") as resp:
                    if resp.status >= 400:
                        raise RuntimeError(f"endpoint token request failed: {resp.status}")
                    data = await resp.json()
        except Exception as exc:
            if isinstance(region, str) and isinstance(token, str):
                return region, token
            raise GatewayError(503, "Edge endpoint token unavailable", f"edge endpoint error: {exc}")

        try:
            token = str(data["t"])
            region = str(data["r"])
            payload_segment = token.split(".")[1]
            payload = json.loads(base64url_decode(payload_segment).decode("utf-8"))
            expired_at = int(payload.get("exp", 0))
        except Exception as exc:
            raise GatewayError(503, "Edge endpoint token invalid", f"invalid endpoint payload: {exc}")

        _edge_token_info["region"] = region
        _edge_token_info["token"] = token
        _edge_token_info["expiredAt"] = expired_at
        return region, token


def ensure_period_rollover_locked(now: datetime) -> None:
    today_key = now.strftime("%Y-%m-%d")
    month_key = now.strftime("%Y-%m")
    if _runtime_stats["todayKey"] != today_key:
        _runtime_stats["todayKey"] = today_key
        _runtime_stats["today"] = new_counter()
    if _runtime_stats["monthKey"] != month_key:
        _runtime_stats["monthKey"] = month_key
        _runtime_stats["month"] = new_counter()


def sanitize_counter(data: dict | None) -> dict[str, int]:
    base = new_counter()
    if not isinstance(data, dict):
        return base
    for key in base:
        try:
            base[key] = max(0, int(data.get(key, 0)))
        except (TypeError, ValueError):
            base[key] = 0
    return base


def build_persisted_snapshot_locked() -> dict:
    return {
        "schemaVersion": 1,
        "savedAt": time.time(),
        "todayKey": _runtime_stats["todayKey"],
        "monthKey": _runtime_stats["monthKey"],
        "maxConcurrent": _runtime_stats["maxConcurrent"],
        "total": dict(_runtime_stats["total"]),
        "today": dict(_runtime_stats["today"]),
        "month": dict(_runtime_stats["month"]),
        "engines": {engine: dict(data) for engine, data in _runtime_stats["engines"].items()},
    }


def save_stats_snapshot(snapshot: dict) -> None:
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp_path = STATS_FILE.with_suffix(".json.tmp")
        tmp_path.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        tmp_path.replace(STATS_FILE)
    except Exception as exc:
        logger.warning("persist stats failed: %s", exc)


def load_persisted_stats() -> None:
    if not STATS_FILE.exists():
        return
    try:
        raw = json.loads(STATS_FILE.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("load persisted stats failed: %s", exc)
        return

    with _stats_lock:
        _runtime_stats["todayKey"] = str(raw.get("todayKey") or _runtime_stats["todayKey"])
        _runtime_stats["monthKey"] = str(raw.get("monthKey") or _runtime_stats["monthKey"])
        try:
            persisted_max_concurrent = int(raw.get("maxConcurrent", 0) or 0)
        except (TypeError, ValueError):
            persisted_max_concurrent = 0
        _runtime_stats["maxConcurrent"] = max(_runtime_stats["maxConcurrent"], max(0, persisted_max_concurrent))
        _runtime_stats["total"] = sanitize_counter(raw.get("total"))
        _runtime_stats["today"] = sanitize_counter(raw.get("today"))
        _runtime_stats["month"] = sanitize_counter(raw.get("month"))

        persisted_engines = raw.get("engines", {})
        for engine in ENGINE_CONFIG:
            engine_data = persisted_engines.get(engine, {}) if isinstance(persisted_engines, dict) else {}
            _runtime_stats["engines"][engine] = {
                **sanitize_counter(engine_data),
                "lastError": str(engine_data.get("lastError", "")) if isinstance(engine_data, dict) else "",
            }

        _runtime_stats["inFlight"] = 0
        ensure_period_rollover_locked(datetime.now())


def mark_tts_start(engine: str) -> None:
    with _stats_lock:
        now = datetime.now()
        ensure_period_rollover_locked(now)
        _runtime_stats["inFlight"] += 1
        if _runtime_stats["inFlight"] > _runtime_stats["maxConcurrent"]:
            _runtime_stats["maxConcurrent"] = _runtime_stats["inFlight"]
        _runtime_stats["total"]["requests"] += 1
        _runtime_stats["today"]["requests"] += 1
        _runtime_stats["month"]["requests"] += 1
        _runtime_stats["engines"][engine]["requests"] += 1
        snapshot = build_persisted_snapshot_locked()
    save_stats_snapshot(snapshot)


def mark_tts_finish(engine: str, ok: bool, audio_bytes: int, text_chars: int, error: str = "") -> None:
    with _stats_lock:
        now = datetime.now()
        ensure_period_rollover_locked(now)
        _runtime_stats["inFlight"] = max(0, _runtime_stats["inFlight"] - 1)

        result_key = "success" if ok else "failed"
        _runtime_stats["total"][result_key] += 1
        _runtime_stats["today"][result_key] += 1
        _runtime_stats["month"][result_key] += 1
        _runtime_stats["engines"][engine][result_key] += 1

        if ok:
            _runtime_stats["total"]["audioBytes"] += audio_bytes
            _runtime_stats["today"]["audioBytes"] += audio_bytes
            _runtime_stats["month"]["audioBytes"] += audio_bytes
            _runtime_stats["engines"][engine]["audioBytes"] += audio_bytes
            _runtime_stats["total"]["textChars"] += text_chars
            _runtime_stats["today"]["textChars"] += text_chars
            _runtime_stats["month"]["textChars"] += text_chars
            _runtime_stats["engines"][engine]["textChars"] += text_chars
            _runtime_stats["engines"][engine]["lastError"] = ""
        elif error:
            _runtime_stats["engines"][engine]["lastError"] = error
        snapshot = build_persisted_snapshot_locked()
    save_stats_snapshot(snapshot)


def snapshot_stats() -> dict:
    with _stats_lock:
        now = datetime.now()
        ensure_period_rollover_locked(now)
        return {
            "startedAt": _runtime_stats["startedAt"],
            "uptimeSec": int(time.time() - PROCESS_STARTED_AT),
            "inFlight": _runtime_stats["inFlight"],
            "maxConcurrent": _runtime_stats["maxConcurrent"],
            "todayKey": _runtime_stats["todayKey"],
            "monthKey": _runtime_stats["monthKey"],
            "total": dict(_runtime_stats["total"]),
            "today": dict(_runtime_stats["today"]),
            "month": dict(_runtime_stats["month"]),
            "engines": {engine: dict(data) for engine, data in _runtime_stats["engines"].items()},
        }


async def engine_availability(engine: str) -> tuple[bool, str]:
    now = time.time()
    with _engine_cache_lock:
        cached = _engine_status_cache.get(engine)
        if cached and (now - cached[0]) < ENGINE_STATUS_CACHE_TTL_SEC:
            return cached[1], cached[2]

    if engine != ENGINE_EDGE:
        ok, reason = False, "unknown engine"
    else:
        try:
            await get_edge_endpoint()
            ok, reason = True, "ok"
        except GatewayError as exc:
            ok, reason = False, exc.client_detail

    with _engine_cache_lock:
        _engine_status_cache[engine] = (time.time(), ok, reason)
    return ok, reason


async def synthesize_edge(
    text: str,
    voice: str,
    edge_rate: str,
    edge_pitch: str,
    edge_volume: str,
    style: str,
) -> bytes:
    region, token = await get_edge_endpoint()
    url = f"https://{region}.tts.speech.microsoft.com/cognitiveservices/v1"
    ssml = build_ssml(text, voice, edge_rate, edge_pitch, edge_volume, style)

    headers = {
        "authorization": token,
        "content-type": "application/ssml+xml",
        "x-microsoft-outputformat": EDGE_OUTPUT_FORMAT,
        "user-agent": "Mozilla/5.0",
    }

    try:
        timeout = aiohttp.ClientTimeout(total=EDGE_HTTP_TIMEOUT_SEC, connect=EDGE_HTTP_CONNECT_TIMEOUT_SEC)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, headers=headers, data=ssml.encode("utf-8")) as resp:
                if resp.status >= 400:
                    body = await resp.text()
                    raise GatewayError(502, "Edge upstream synthesis failed", f"edge upstream {resp.status}: {body[:180]}")
                data = await resp.read()
    except GatewayError:
        raise
    except Exception as exc:
        raise GatewayError(502, "Edge upstream synthesis failed", f"edge synth failed: {exc}")

    if not data:
        raise GatewayError(502, "Edge returned empty audio", "edge synth returned empty audio")
    return data


load_persisted_stats()


@app.get("/healthz")
async def healthz() -> dict:
    return {"ok": True}


@app.get("/stats")
async def stats() -> dict:
    data = snapshot_stats()
    return JSONResponse(
        data,
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def index() -> Response:
    page = STATIC_DIR / "index.html"
    if page.exists():
        return FileResponse(page)
    return JSONResponse({"message": "UI not found", "docs": "/docs"}, status_code=404)


@app.get("/engines")
async def engines() -> dict:
    ok, reason = await engine_availability(ENGINE_EDGE)
    return {
        "engines": [
            {
                "engine": ENGINE_EDGE,
                "label": ENGINE_CONFIG[ENGINE_EDGE]["label"],
                "contentType": ENGINE_CONFIG[ENGINE_EDGE]["content_type"],
                "available": ok,
                "reason": reason,
                "defaultVoice": ENGINE_CONFIG[ENGINE_EDGE]["default_voice"],
            }
        ]
    }


@app.get("/voices")
async def voices() -> dict:
    return {
        "defaultVoice": ENGINE_CONFIG[ENGINE_EDGE]["default_voice"],
        "voices": VOICE_OPTIONS,
    }


@app.get("/legado-config")
async def legado_config(
    request: Request,
    engine: str = DEFAULT_ENGINE,
    voice: Optional[str] = None,
) -> dict:
    if engine != ENGINE_EDGE:
        raise HTTPException(status_code=400, detail=f"Unsupported engine: {engine}")

    base_url = str(request.base_url).rstrip("/")
    final_voice = normalize_voice(engine, voice)
    return build_legado_config_payload(base_url, engine, final_voice)


@app.get("/legado-configs")
async def legado_configs(
    request: Request,
    engine: str = DEFAULT_ENGINE,
    voices: Optional[str] = None,
    wrapped: bool = Query(default=False),
) -> list[dict] | dict:
    if engine != ENGINE_EDGE:
        raise HTTPException(status_code=400, detail=f"Unsupported engine: {engine}")

    base_url = str(request.base_url).rstrip("/")
    voice_items = []
    if voices:
        voice_items = [item.strip() for item in voices.split(",") if item.strip()]
    if not voice_items:
        voice_items = [ENGINE_CONFIG[engine]["default_voice"]]

    unique_voices = list(dict.fromkeys(voice_items))
    configs = [build_legado_config_payload(base_url, engine, v) for v in unique_voices]
    if wrapped:
        return {
            "engine": engine,
            "count": len(configs),
            "configs": configs,
        }
    return configs


@app.api_route("/tts", methods=["GET", "POST"])
async def tts_endpoint(
    request: Request,
    text: Optional[str] = Query(default=None),
    rate: Optional[int] = Query(default=None),
    voice: Optional[str] = Query(default=None),
    style: Optional[str] = Query(default=None),
    pitch: Optional[int] = Query(default=None),
    volume: Optional[int] = Query(default=None),
    engine: str = Query(default=DEFAULT_ENGINE),
) -> Response:
    request_id = request.headers.get("x-request-id", uuid.uuid4().hex[:12])

    if engine != ENGINE_EDGE:
        raise HTTPException(status_code=400, detail=f"Unsupported engine: {engine}")

    ctype = request.headers.get("content-type", "")
    payload: dict = {}

    if request.method == "POST":
        content_length = request.headers.get("content-length")
        if content_length is not None:
            try:
                if int(content_length) > MAX_BODY_BYTES:
                    raise HTTPException(status_code=413, detail=f"Request body too large (max {MAX_BODY_BYTES} bytes)")
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid content-length header")

        raw_body = await request.body()
        if len(raw_body) > MAX_BODY_BYTES:
            raise HTTPException(status_code=413, detail=f"Request body too large (max {MAX_BODY_BYTES} bytes)")

        if not raw_body:
            payload = {}
        elif "application/json" in ctype:
            try:
                payload = json.loads(raw_body.decode("utf-8")) or {}
            except Exception:
                payload = {}
        elif "application/x-www-form-urlencoded" in ctype or not ctype:
            parsed = parse_qs(raw_body.decode("utf-8", errors="replace"), keep_blank_values=False)
            payload = {k: (v[0] if v else "") for k, v in parsed.items()}
        elif "multipart/form-data" in ctype:
            raise HTTPException(status_code=415, detail="multipart/form-data is not supported, please use JSON or x-www-form-urlencoded")
        else:
            try:
                payload = json.loads(raw_body.decode("utf-8")) or {}
            except Exception:
                payload = {}

    final_text = text or request.query_params.get("speakText") or payload.get("text") or payload.get("speakText")
    if not final_text or not final_text.strip():
        raise HTTPException(status_code=400, detail="Missing text/speakText")

    cleaned_text = final_text.strip()
    if len(cleaned_text) > MAX_TEXT_LEN:
        raise HTTPException(status_code=413, detail=f"Text too long (max {MAX_TEXT_LEN} characters)")

    final_rate = (
        rate
        if rate is not None
        else request.query_params.get("speakSpeed")
        if request.query_params.get("speakSpeed") is not None
        else payload.get("rate")
        if payload.get("rate") is not None
        else payload.get("speakSpeed")
    )
    if final_rate is None:
        final_rate = BASE_SPEED

    try:
        final_rate = int(final_rate)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="rate/speakSpeed must be integer")

    final_pitch = (
        pitch
        if pitch is not None
        else request.query_params.get("pitch")
        if request.query_params.get("pitch") is not None
        else payload.get("pitch")
    )
    if final_pitch is None:
        final_pitch = DEFAULT_EDGE_PITCH_HZ
    try:
        final_pitch = int(final_pitch)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="pitch must be integer")

    final_volume = (
        volume
        if volume is not None
        else request.query_params.get("volume")
        if request.query_params.get("volume") is not None
        else payload.get("volume")
    )
    if final_volume is None:
        final_volume = DEFAULT_EDGE_VOLUME_PERCENT
    try:
        final_volume = int(final_volume)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="volume must be integer")

    final_voice = normalize_voice(engine, voice or request.query_params.get("voice") or payload.get("voice"))
    final_style = (
        style
        if style is not None
        else request.query_params.get("style")
        if request.query_params.get("style") is not None
        else payload.get("style")
    )
    if final_style is None:
        final_style = "general"
    if not is_safe_ssml_token(final_voice):
        raise HTTPException(status_code=400, detail="voice contains invalid characters")
    if not is_safe_ssml_token(final_style):
        raise HTTPException(status_code=400, detail="style contains invalid characters")

    ok, reason = await engine_availability(engine)
    if not ok:
        raise HTTPException(status_code=503, detail=f"Engine {engine} unavailable: {reason}")

    started = False
    success = False
    audio = b""
    failure_detail = ""
    try:
        async with ENGINE_SEMAPHORES[engine]:
            mark_tts_start(engine)
            started = True
            edge_rate = to_edge_rate(final_rate)
            edge_pitch = to_edge_pitch(final_pitch)
            edge_volume = to_edge_volume(final_volume)
            logger.info(
                "request_id=%s tts engine=%s speed=%s edge_rate=%s edge_pitch=%s edge_volume=%s style=%s voice=%s text_len=%s",
                request_id,
                engine,
                final_rate,
                edge_rate,
                edge_pitch,
                edge_volume,
                final_style,
                final_voice,
                len(cleaned_text),
            )
            audio = await synthesize_edge(cleaned_text, final_voice, edge_rate, edge_pitch, edge_volume, final_style)
            success = True
    except GatewayError as exc:
        failure_detail = exc.client_detail
        logger.warning("request_id=%s engine=%s upstream_error=%s", request_id, engine, exc.log_detail)
        raise HTTPException(status_code=exc.status_code, detail=exc.client_detail)
    finally:
        if started:
            mark_tts_finish(
                engine=engine,
                ok=success,
                audio_bytes=len(audio) if success else 0,
                text_chars=len(cleaned_text) if success else 0,
                error=failure_detail,
            )

    return Response(content=audio, media_type=ENGINE_CONFIG[engine]["content_type"])


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=8080, reload=False)
