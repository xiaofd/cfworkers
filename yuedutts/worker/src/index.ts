/*
 * Cloudflare Worker: Edge TTS gateway for Legado audiobook API.
 * Routes:
 * - GET  /healthz
 * - GET  /engines
 * - GET  /legado-config
 * - GET/POST /tts
 * - GET  /stats
 *
 * UI page is served from worker/static/index.html via Wrangler assets.
 */

interface Env {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  TTS_MAX_TEXT_LEN?: string;
  TTS_MAX_BODY_BYTES?: string;
  ENGINE_STATUS_CACHE_TTL_SEC?: string;
  EDGE_TOKEN_REFRESH_BEFORE_EXPIRY_SEC?: string;
  EDGE_FETCH_TIMEOUT_MS?: string;
  EDGE_MAX_CONCURRENCY?: string;
}

type Counter = {
  requests: number;
  success: number;
  failed: number;
  audioBytes: number;
  textChars: number;
};

type EngineCounter = Counter & { lastError: string };

type EndpointToken = {
  r: string;
  t: string;
};

const ENGINE_EDGE = "edge";
const DEFAULT_EDGE_VOICE = "zh-CN-YunxiNeural";
const DEFAULT_STYLE = "general";

const MIN_SPEAK_SPEED = 5;
const MAX_SPEAK_SPEED = 50;
const BASE_SPEED = 10;
const SPEED_STEP_PERCENT = 4;
const MIN_EDGE_RATE_PERCENT = -10;
const MAX_EDGE_RATE_PERCENT = 200;

const MIN_EDGE_PITCH_HZ = -100;
const MAX_EDGE_PITCH_HZ = 100;
const MIN_EDGE_VOLUME_PERCENT = -100;
const MAX_EDGE_VOLUME_PERCENT = 100;

const DEFAULT_MAX_TEXT_LEN = 20000;
const DEFAULT_MAX_BODY_BYTES = 512 * 1024;
const DEFAULT_ENGINE_STATUS_CACHE_TTL_MS = 30_000;
const DEFAULT_TOKEN_REFRESH_BEFORE_EXPIRY_SEC = 3 * 60;
const DEFAULT_EDGE_FETCH_TIMEOUT_MS = 180_000;
const DEFAULT_EDGE_MAX_CONCURRENCY = 16;

const ENGINE_CONFIG = {
  [ENGINE_EDGE]: {
    label: "Edge",
    contentType: "audio/mpeg",
    defaultVoice: DEFAULT_EDGE_VOICE,
  },
};
const VOICE_LABELS: Record<string, string> = {
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
};
const VOICE_OPTIONS = Object.entries(VOICE_LABELS).map(([voice, label]) => ({ voice, label }));
const SSML_TOKEN_RE = /^[A-Za-z0-9_-]{1,64}$/;

const runtimeStats = {
  startedAt: Date.now() / 1000,
  todayKey: dateKey(new Date()),
  monthKey: monthKey(new Date()),
  inFlight: 0,
  maxConcurrent: 0,
  total: newCounter(),
  today: newCounter(),
  month: newCounter(),
  engines: {
    [ENGINE_EDGE]: newEngineCounter(),
  } as Record<string, EngineCounter>,
};

const tokenInfo: {
  endpoint: EndpointToken | null;
  token: string | null;
  expiredAt: number | null;
} = {
  endpoint: null,
  token: null,
  expiredAt: null,
};

const engineAvailabilityCache: {
  at: number;
  ok: boolean;
  reason: string;
} = {
  at: 0,
  ok: false,
  reason: "not checked",
};

type RuntimeConfig = {
  maxTextLen: number;
  maxBodyBytes: number;
  statusCacheTtlMs: number;
  tokenRefreshBeforeExpirySec: number;
  edgeFetchTimeoutMs: number;
  edgeMaxConcurrency: number;
};

function envInt(env: Env, key: keyof Env, fallback: number, minValue: number): number {
  const raw = env[key];
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(minValue, n);
}

function envFloatMs(env: Env, key: keyof Env, fallbackMs: number, minMs: number): number {
  const raw = env[key];
  if (typeof raw !== "string" || raw.trim() === "") return fallbackMs;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return fallbackMs;
  return Math.max(minMs, Math.round(n * 1000));
}

function getRuntimeConfig(env: Env): RuntimeConfig {
  return {
    maxTextLen: envInt(env, "TTS_MAX_TEXT_LEN", DEFAULT_MAX_TEXT_LEN, 1),
    maxBodyBytes: envInt(env, "TTS_MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES, 1024),
    statusCacheTtlMs: envFloatMs(env, "ENGINE_STATUS_CACHE_TTL_SEC", DEFAULT_ENGINE_STATUS_CACHE_TTL_MS, 1000),
    tokenRefreshBeforeExpirySec: envInt(env, "EDGE_TOKEN_REFRESH_BEFORE_EXPIRY_SEC", DEFAULT_TOKEN_REFRESH_BEFORE_EXPIRY_SEC, 30),
    edgeFetchTimeoutMs: envInt(env, "EDGE_FETCH_TIMEOUT_MS", DEFAULT_EDGE_FETCH_TIMEOUT_MS, 1000),
    edgeMaxConcurrency: envInt(env, "EDGE_MAX_CONCURRENCY", DEFAULT_EDGE_MAX_CONCURRENCY, 1),
  };
}

function newCounter(): Counter {
  return { requests: 0, success: 0, failed: 0, audioBytes: 0, textChars: 0 };
}

function newEngineCounter(): EngineCounter {
  return { ...newCounter(), lastError: "" };
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}

function rollPeriods(): void {
  const now = new Date();
  const t = dateKey(now);
  const m = monthKey(now);
  if (runtimeStats.todayKey !== t) {
    runtimeStats.todayKey = t;
    runtimeStats.today = newCounter();
  }
  if (runtimeStats.monthKey !== m) {
    runtimeStats.monthKey = m;
    runtimeStats.month = newCounter();
  }
}

function markStart(): void {
  rollPeriods();
  runtimeStats.inFlight += 1;
  if (runtimeStats.inFlight > runtimeStats.maxConcurrent) {
    runtimeStats.maxConcurrent = runtimeStats.inFlight;
  }
  runtimeStats.total.requests += 1;
  runtimeStats.today.requests += 1;
  runtimeStats.month.requests += 1;
  runtimeStats.engines[ENGINE_EDGE].requests += 1;
}

function markFinish(ok: boolean, audioBytes: number, textChars: number, error = ""): void {
  rollPeriods();
  runtimeStats.inFlight = Math.max(0, runtimeStats.inFlight - 1);
  const key = ok ? "success" : "failed";

  runtimeStats.total[key] += 1;
  runtimeStats.today[key] += 1;
  runtimeStats.month[key] += 1;
  runtimeStats.engines[ENGINE_EDGE][key] += 1;

  if (ok) {
    runtimeStats.total.audioBytes += audioBytes;
    runtimeStats.today.audioBytes += audioBytes;
    runtimeStats.month.audioBytes += audioBytes;
    runtimeStats.engines[ENGINE_EDGE].audioBytes += audioBytes;

    runtimeStats.total.textChars += textChars;
    runtimeStats.today.textChars += textChars;
    runtimeStats.month.textChars += textChars;
    runtimeStats.engines[ENGINE_EDGE].textChars += textChars;
    runtimeStats.engines[ENGINE_EDGE].lastError = "";
  } else if (error) {
    runtimeStats.engines[ENGINE_EDGE].lastError = error;
  }
}

function snapshotStats() {
  rollPeriods();
  return {
    startedAt: runtimeStats.startedAt,
    uptimeSec: Math.max(0, Math.floor(Date.now() / 1000 - runtimeStats.startedAt)),
    inFlight: runtimeStats.inFlight,
    maxConcurrent: runtimeStats.maxConcurrent,
    todayKey: runtimeStats.todayKey,
    monthKey: runtimeStats.monthKey,
    total: { ...runtimeStats.total },
    today: { ...runtimeStats.today },
    month: { ...runtimeStats.month },
    engines: {
      [ENGINE_EDGE]: { ...runtimeStats.engines[ENGINE_EDGE] },
    },
  };
}

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(),
      ...(extraHeaders ?? {}),
    },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-request-id",
    "access-control-max-age": "86400",
  };
}

function toEdgeRate(speakSpeed: number): string {
  const clamped = Math.max(MIN_SPEAK_SPEED, Math.min(MAX_SPEAK_SPEED, speakSpeed));
  let speedDiff = (clamped - BASE_SPEED) * SPEED_STEP_PERCENT;
  speedDiff = Math.max(MIN_EDGE_RATE_PERCENT, Math.min(MAX_EDGE_RATE_PERCENT, speedDiff));
  return speedDiff >= 0 ? `+${speedDiff}%` : `${speedDiff}%`;
}

function toEdgePitch(pitchHz: number): string {
  const clamped = Math.max(MIN_EDGE_PITCH_HZ, Math.min(MAX_EDGE_PITCH_HZ, pitchHz));
  return clamped >= 0 ? `+${clamped}Hz` : `${clamped}Hz`;
}

function toEdgeVolume(volumePercent: number): string {
  const clamped = Math.max(MIN_EDGE_VOLUME_PERCENT, Math.min(MAX_EDGE_VOLUME_PERCENT, volumePercent));
  return clamped >= 0 ? `+${clamped}%` : `${clamped}%`;
}

function normalizeVoice(voice: string | null): string {
  return (voice && voice.trim()) || DEFAULT_EDGE_VOICE;
}

function voiceDisplayName(voice: string): string {
  return VOICE_LABELS[voice] || voice;
}

function isSafeSsmlToken(value: string): boolean {
  return SSML_TOKEN_RE.test(value);
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function getLegadoConfigId(engine: string, voice: string): number {
  const raw = `${engine}:${voice}`;
  const c = crc32(raw);
  return 100000 + (c % 900000);
}

function buildLegadoConfig(origin: string, engine: string, voice: string) {
  const id = getLegadoConfigId(engine, voice);
  const ttsUrl = `${origin}/tts?engine=${encodeURIComponent(engine)}&speakText={{java.encodeURI(speakText)}}&speakSpeed={{speakSpeed}}&voice=${encodeURIComponent(voice)}&style=general&pitch=0&volume=0`;
  return {
    concurrentRate: "0",
    contentType: ENGINE_CONFIG[ENGINE_EDGE].contentType,
    header: "",
    id,
    loginCheckJs: "",
    loginui: "",
    loginurl: "",
    name: `Edge-${voiceDisplayName(voice)}`,
    url: ttsUrl,
    urlArgs: '{"method":"GET","body":""}',
  };
}

function crc32(input: string): number {
  let crc = 0 ^ -1;
  for (let i = 0; i < input.length; i += 1) {
    let c = (crc ^ input.charCodeAt(i)) & 0xff;
    for (let j = 0; j < 8; j += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ -1) >>> 0;
}

function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function getSsml(text: string, voiceName: string, rate: string, pitch: string, volume: string, style: string): string {
  const escaped = escapeXmlText(text);
  return `<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" version="1.0" xml:lang="zh-CN"><voice name="${voiceName}"><mstts:express-as style="${style}" styledegree="2.0" role="default"><prosody rate="${rate}" pitch="${pitch}" volume="${volume}">${escaped}</prosody></mstts:express-as></voice></speak>`;
}

async function hmacSha256(key: Uint8Array, data: string): Promise<Uint8Array> {
  const rawKey = Uint8Array.from(key).buffer as ArrayBuffer;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  return new Uint8Array(signature);
}

function uuidNoDash(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let str = "";
  for (let i = 0; i < bytes.length; i += 1) str += String.fromCharCode(bytes[i]);
  return btoa(str);
}

function dateFormat(): string {
  return `${new Date().toUTCString().replace(/GMT/, "").trim()} GMT`.toLowerCase();
}

async function sign(urlStr: string): Promise<string> {
  const url = urlStr.split("://")[1];
  const encodedUrl = encodeURIComponent(url);
  const uuid = uuidNoDash();
  const formattedDate = dateFormat();
  const toSign = `MSTranslatorAndroidApp${encodedUrl}${formattedDate}${uuid}`.toLowerCase();
  const decode = base64ToBytes("oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw==");
  const sig = await hmacSha256(decode, toSign);
  return `MSTranslatorAndroidApp::${bytesToBase64(sig)}::${formattedDate}::${uuid}`;
}

async function getEndpoint(cfg: RuntimeConfig): Promise<EndpointToken> {
  const now = Date.now() / 1000;
  if (tokenInfo.endpoint && tokenInfo.token && tokenInfo.expiredAt && now < tokenInfo.expiredAt - cfg.tokenRefreshBeforeExpirySec) {
    return tokenInfo.endpoint;
  }

  const endpointUrl = "https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0";
  const clientId = uuidNoDash();

  const resp = await fetchWithTimeout(endpointUrl, {
    method: "POST",
    headers: {
      "accept-language": "zh-Hans",
      "x-clientversion": "4.0.530a 5fe1dc6c",
      "x-userid": "0f04d16a175c411e",
      "x-homegeographicregion": "zh-Hans-CN",
      "x-clienttraceid": clientId,
      "x-mt-signature": await sign(endpointUrl),
      "user-agent": "Mozilla/5.0",
      "content-type": "application/json; charset=utf-8",
      "content-length": "0",
      "accept-encoding": "gzip",
    },
  }, cfg.edgeFetchTimeoutMs);

  if (!resp.ok) {
    if (tokenInfo.endpoint) return tokenInfo.endpoint;
    throw new Error(`failed to get endpoint token: ${resp.status}`);
  }

  const data = (await resp.json()) as EndpointToken;
  const jwt = data.t.split(".")[1];
  const payload = JSON.parse(atob(jwt)) as { exp?: number };

  tokenInfo.endpoint = data;
  tokenInfo.token = data.t;
  tokenInfo.expiredAt = payload.exp ?? null;
  return data;
}

async function checkEdgeAvailable(cfg: RuntimeConfig): Promise<{ ok: boolean; reason: string }> {
  const now = Date.now();
  if (now - engineAvailabilityCache.at < cfg.statusCacheTtlMs) {
    return { ok: engineAvailabilityCache.ok, reason: engineAvailabilityCache.reason };
  }
  try {
    await getEndpoint(cfg);
    engineAvailabilityCache.at = now;
    engineAvailabilityCache.ok = true;
    engineAvailabilityCache.reason = "ok";
  } catch (err) {
    engineAvailabilityCache.at = now;
    engineAvailabilityCache.ok = false;
    engineAvailabilityCache.reason = err instanceof Error ? err.message : "token unavailable";
  }
  return { ok: engineAvailabilityCache.ok, reason: engineAvailabilityCache.reason };
}

async function synthesizeEdge(
  text: string,
  voice: string,
  rate: string,
  pitch: string,
  volume: string,
  style: string,
  cfg: RuntimeConfig,
): Promise<ArrayBuffer> {
  const endpoint = await getEndpoint(cfg);
  const url = `https://${endpoint.r}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const ssml = getSsml(text, voice, rate, pitch, volume, style);

  const resp = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      authorization: endpoint.t,
      "content-type": "application/ssml+xml",
      "x-microsoft-outputformat": "audio-24khz-48kbitrate-mono-mp3",
      "user-agent": "Mozilla/5.0",
    },
    body: ssml,
  }, cfg.edgeFetchTimeoutMs);

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`edge upstream failed: ${resp.status} ${body.slice(0, 180)}`);
  }

  const arr = await resp.arrayBuffer();
  if (arr.byteLength === 0) {
    throw new Error("edge upstream returned empty audio");
  }
  return arr;
}

async function parseRequestParams(req: Request, cfg: RuntimeConfig): Promise<{
  text: string;
  speakSpeed: number;
  voice: string;
  style: string;
  pitch: number;
  volume: number;
  engine: string;
}> {
  const url = new URL(req.url);
  const q = url.searchParams;

  let body: Record<string, unknown> = {};
  if (req.method === "POST") {
    const raw = await readBodyLimited(req, cfg.maxBodyBytes);
    const ctype = req.headers.get("content-type") || "";
    const bodyText = new TextDecoder().decode(raw);
    if (raw.byteLength === 0) {
      body = {};
    } else if (ctype.includes("application/json")) {
      try {
        body = JSON.parse(bodyText) as Record<string, unknown>;
      } catch {
        body = {};
      }
    } else if (ctype.includes("application/x-www-form-urlencoded") || ctype === "") {
      body = Object.fromEntries(new URLSearchParams(bodyText).entries());
    } else if (ctype.includes("multipart/form-data")) {
      throw new HttpError(415, "multipart/form-data is not supported, please use JSON or x-www-form-urlencoded");
    } else {
      try {
        body = JSON.parse(bodyText) as Record<string, unknown>;
      } catch {
        body = {};
      }
    }
  }

  const getVal = (...keys: string[]): string | null => {
    for (const k of keys) {
      const qv = q.get(k);
      if (qv !== null && qv !== "") return qv;
      const bv = body[k];
      if (typeof bv === "string" && bv !== "") return bv;
    }
    return null;
  };

  const text = (getVal("text", "speakText") || "").trim();
  if (!text) throw new HttpError(400, "Missing text/speakText");
  if (text.length > cfg.maxTextLen) throw new HttpError(413, `Text too long (max ${cfg.maxTextLen} characters)`);

  const engine = getVal("engine") || ENGINE_EDGE;
  if (engine !== ENGINE_EDGE) throw new HttpError(400, `Unsupported engine: ${engine}`);

  const speedRaw = getVal("rate", "speakSpeed");
  const speed = speedRaw == null ? BASE_SPEED : Number(speedRaw);
  if (!Number.isInteger(speed)) throw new HttpError(400, "rate/speakSpeed must be integer");

  const pitchRaw = getVal("pitch");
  const pitch = pitchRaw == null ? 0 : Number(pitchRaw);
  if (!Number.isInteger(pitch)) throw new HttpError(400, "pitch must be integer");

  const volumeRaw = getVal("volume");
  const volume = volumeRaw == null ? 0 : Number(volumeRaw);
  if (!Number.isInteger(volume)) throw new HttpError(400, "volume must be integer");

  const voice = normalizeVoice(getVal("voice"));
  const style = getVal("style") || DEFAULT_STYLE;
  if (!isSafeSsmlToken(voice)) throw new HttpError(400, "voice contains invalid characters");
  if (!isSafeSsmlToken(style)) throw new HttpError(400, "style contains invalid characters");

  return {
    text,
    speakSpeed: speed,
    voice,
    style,
    pitch,
    volume,
    engine,
  };
}

async function readBodyLimited(req: Request, maxBytes: number): Promise<Uint8Array> {
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      throw new HttpError(413, `Request body too large (max ${maxBytes} bytes)`);
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function noStoreHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
    pragma: "no-cache",
    expires: "0",
  };
}

function normalizeRoutePath(pathname: string): string {
  const trimSlash = (v: string): string => (v.length > 1 && v.endsWith("/") ? v.slice(0, -1) : v);
  const raw = pathname || "/";
  const base = trimSlash(raw);

  if (base === "" || base === "/" || base === "/index.html") {
    return "/";
  }

  if (base.endsWith("/index.html")) {
    return "/";
  }

  const apiRoutes = ["/healthz", "/engines", "/voices", "/legado-config", "/legado-configs", "/stats", "/tts"];
  for (const route of apiRoutes) {
    if (base === route) return route;
    if (base.endsWith(route)) {
      const prefix = base.slice(0, base.length - route.length);
      if (prefix === "" || prefix.endsWith("/")) return route;
    }
  }

  return base;
}

async function serveSharedIndex(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  u.pathname = "/index.html";
  u.search = "";
  const resp = await env.ASSETS.fetch(new Request(u.toString(), { method: "GET" }));
  if (!resp.ok) {
    return new Response("index.html not found in assets", { status: 500, headers: corsHeaders() });
  }
  const headers = new Headers(resp.headers);
  Object.entries(corsHeaders()).forEach(([k, v]) => headers.set(k, v));
  return new Response(resp.body, { status: 200, headers });
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const cfg = getRuntimeConfig(env);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const path = normalizeRoutePath(url.pathname);

    try {
      if (path === "/" || path === "") {
        return serveSharedIndex(request, env);
      }

      if (path === "/healthz") {
        return json({ ok: true });
      }

      if (path === "/engines") {
        const check = await checkEdgeAvailable(cfg);
        return json({
          engines: [
            {
              engine: ENGINE_EDGE,
              label: ENGINE_CONFIG[ENGINE_EDGE].label,
              contentType: ENGINE_CONFIG[ENGINE_EDGE].contentType,
              available: check.ok,
              reason: check.reason,
              defaultVoice: ENGINE_CONFIG[ENGINE_EDGE].defaultVoice,
            },
          ],
        });
      }

      if (path === "/voices") {
        return json({
          defaultVoice: ENGINE_CONFIG[ENGINE_EDGE].defaultVoice,
          voices: VOICE_OPTIONS,
        });
      }

      if (path === "/legado-config") {
        const engine = url.searchParams.get("engine") || ENGINE_EDGE;
        if (engine !== ENGINE_EDGE) {
          throw new HttpError(400, `Unsupported engine: ${engine}`);
        }
        const voice = normalizeVoice(url.searchParams.get("voice"));
        const origin = `${url.protocol}//${url.host}`;
        return json(buildLegadoConfig(origin, engine, voice));
      }

      if (path === "/legado-configs") {
        const engine = url.searchParams.get("engine") || ENGINE_EDGE;
        if (engine !== ENGINE_EDGE) {
          throw new HttpError(400, `Unsupported engine: ${engine}`);
        }
        const wrapped = ["1", "true", "yes", "on"].includes((url.searchParams.get("wrapped") || "").toLowerCase());
        const raw = url.searchParams.get("voices") || "";
        const items = raw
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean);
        const voices = items.length ? Array.from(new Set(items)) : [ENGINE_CONFIG[ENGINE_EDGE].defaultVoice];
        const origin = `${url.protocol}//${url.host}`;
        const configs = voices.map((voice) => buildLegadoConfig(origin, engine, voice));
        if (wrapped) {
          return json({ engine, count: configs.length, configs });
        }
        return json(configs);
      }

      if (path === "/stats") {
        return json(snapshotStats(), 200, noStoreHeaders());
      }

      if (path === "/tts") {
        if (request.method !== "GET" && request.method !== "POST") {
          throw new HttpError(405, "Method not allowed");
        }

        if (runtimeStats.inFlight >= cfg.edgeMaxConcurrency) {
          throw new HttpError(429, `Too many concurrent requests (max ${cfg.edgeMaxConcurrency})`);
        }

        const p = await parseRequestParams(request, cfg);

        markStart();
        try {
          const arr = await synthesizeEdge(
            p.text,
            p.voice,
            toEdgeRate(p.speakSpeed),
            toEdgePitch(p.pitch),
            toEdgeVolume(p.volume),
            p.style,
            cfg,
          );
          markFinish(true, arr.byteLength, p.text.length);

          return new Response(arr, {
            status: 200,
            headers: {
              "content-type": ENGINE_CONFIG[ENGINE_EDGE].contentType,
              ...corsHeaders(),
            },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "TTS synthesis failed";
          markFinish(false, 0, 0, msg);
          throw new HttpError(502, "Edge upstream synthesis failed");
        }
      }

      // Allow UI under arbitrary path prefixes (e.g. /tts/, /reader/tts/, /foo/bar/).
      if (request.method === "GET" && (request.headers.get("accept") || "").includes("text/html")) {
        return serveSharedIndex(request, env);
      }
      return json({ detail: "Not Found" }, 404);
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ detail: err.message }, err.status);
      }
      return json({ detail: "Internal Server Error" }, 500);
    }
  },
};
