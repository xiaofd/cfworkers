/* eslint-disable @typescript-eslint/no-unused-vars */

export interface Env {
  UD_BUCKET: R2Bucket;
  UD_STATE: DurableObjectNamespace;

  // secrets / vars:
  UD_API_KEY?: string;     // optional
  UD_BASE_PATH?: string;   // optional, e.g. "/relay"
  UD_MAX_MB?: string;      // optional, default 50
  UD_RATE_LIMIT_SEC?: string; // optional, default 10
  UD_MAX_PENDING?: string; // optional, default 10
  UD_TTL_SEC?: string;     // optional, default 86400
}

type TokenMeta = {
  token: string;
  objectKey: string;       // key in R2
  filename: string;        // original filename
  contentType: string;
  size: number;
  createdAt: number;       // epoch seconds
  expiresAt: number;       // epoch seconds (0 means never)
  status: "reserved" | "ready" | "claimed";
  uploaderIp: string;
  // 已成功传完的字节区间（闭区间，已合并排序），用于"完整下载才失效"
  ranges?: [number, number][];
  // 是否为三位数字短码
  short?: boolean;
};

type StateData = {
  // token -> meta
  tokens: Record<string, TokenMeta>;
  // filename -> token (for overwrite semantics)
  byName: Record<string, string>;
  // queue of tokens (oldest -> newest) for eviction
  queue: string[];
  // rate limit: ip -> last upload epoch seconds
  lastUpload: Record<string, number>;
  metrics: {
    hcCount: number;
  };
  // 短码猜错的计数：ip -> { n: 次数, t: 窗口起点 }
  shortFail?: Record<string, { n: number; t: number }>;
  // R2 用量缓存（避免每次 /hc 都全量 list）
  r2Cache?: { objects: number; bytes: number; at: number };
};

const DEFAULTS = {
  MAX_MB: 100,
  RATE_LIMIT_SEC: 2,
  MAX_PENDING: 10,
  TTL_SEC: 24 * 3600,
};

// 三位数字短码相关
const SHORT_CODE_MAX = 1000;          // 000-999
const SHORT_FAIL_WINDOW = 60;         // 统计窗口（秒）
const SHORT_FAIL_LIMIT = 20;          // 窗口内猜错上限
const SHORT_FAIL_GC = 600;            // 失败记录保留多久（秒）
const SHORT_FAIL_MAX_ENTRIES = 500;   // 失败记录最多存多少条（防 DO 状态膨胀）

// /hc 里 R2 用量的缓存时间（秒）
const R2_CACHE_SEC = 60;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function empty404(): Response {
  return new Response("", { status: 404 });
}

function isBrowser(req: Request): boolean {
  const ua = (req.headers.get("User-Agent") || "").toLowerCase();
  const accept = (req.headers.get("Accept") || "").toLowerCase();
  const fmt = new URL(req.url).searchParams.get("format");
  if (fmt === "text" || fmt === "plain") return false;
  if (fmt === "html") return true;
  return accept.includes("text/html") && !ua.includes("curl") && !ua.includes("wget") && !ua.includes("httpie");
}

// 链接预览/爬虫类 UA：抓 OG 卡片用，不能让它把文件"下载"掉
// 注意：故意不含 MicroMessenger —— 那是微信内置浏览器，是真实用户
function isPreviewBot(req: Request): boolean {
  const ua = (req.headers.get("User-Agent") || "").toLowerCase();
  return /telegrambot|whatsapp|facebookexternalhit|slackbot|discordbot|twitterbot|linkedinbot|embedly|pinterest|skypeuripreview|vkshare|quora link preview|googlebot|bingbot|baiduspider|yandexbot|bytespider|duckduckbot|applebot/.test(
    ua,
  );
}

// 浏览器预取/预渲染提示
function isPrefetch(req: Request): boolean {
  const p = (
    req.headers.get("Sec-Purpose") ||
    req.headers.get("X-Purpose") ||
    req.headers.get("Purpose") ||
    ""
  ).toLowerCase();
  return p.includes("prefetch") || p.includes("preview") || p.includes("prerender");
}

function basePath(env: Env): string {
  const p = (env.UD_BASE_PATH || "").trim();
  if (!p) return "";
  if (p === "/") return "";
  return p.startsWith("/") ? p.replace(/\/+$/, "") : `/${p.replace(/\/+$/, "")}`;
}

function stripBase(pathname: string, env: Env): string | null {
  const bp = basePath(env);
  if (!bp) return pathname;
  if (pathname === bp) return "/";
  if (pathname.startsWith(bp + "/")) return pathname.slice(bp.length);
  return null; // not under base
}

function withBase(path: string, env: Env): string {
  const bp = basePath(env);
  if (!bp) return path;
  if (path === "/") return bp;
  return bp + path;
}

// 下载路径：短码走 /s/<code>，否则 /ud/f/<token>/<filename>
function downloadPath(token: string, filename: string, env: Env): string {
  if (isShortCode(token)) return withBase(`/s/${token}`, env);
  return withBase(`/ud/f/${encodeURIComponent(token)}/${encodeURIComponent(filename)}`, env);
}

function getClientIp(req: Request): string {
  return (
    req.headers.get("CF-Connecting-IP") ||
    req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function getApiKeyFromReq(req: Request): string {
  const u = new URL(req.url);
  const q = u.searchParams.get("key") || "";
  if (q) return q.trim();

  const h = req.headers.get("X-API-Key") || "";
  if (h) return h.trim();

  // multipart form key is checked inside handler; for DO we pass it explicitly
  return "";
}

function parseContentLength(req: Request): number | null {
  const v = req.headers.get("Content-Length") || "";
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function parseContentDispositionFilename(cd: string): string {
  if (!cd) return "";
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(cd);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      return star[1];
    }
  }
  const quoted = /filename\s*=\s*"([^"]+)"/i.exec(cd);
  if (quoted?.[1]) return quoted[1];
  const bare = /filename\s*=\s*([^;]+)/i.exec(cd);
  if (bare?.[1]) return bare[1].trim().replace(/^"+|"+$/g, "");
  return "";
}

function rawUploadFilename(req: Request, path: string): string {
  const u = new URL(req.url);
  const fromQuery = u.searchParams.get("name") || u.searchParams.get("filename") || "";
  const fromHeader = req.headers.get("X-Filename") || req.headers.get("X-File-Name") || "";
  const fromCd = parseContentDispositionFilename(req.headers.get("Content-Disposition") || "");
  let fromPath = "";
  const parts = path.split("/").filter(Boolean); // ["ud", "..."]
  if (parts.length >= 2 && parts[0] === "ud") {
    fromPath = parts.slice(1).join("/");
  }
  const raw = fromQuery || fromHeader || fromCd || fromPath;
  return sanitizeFilename(raw);
}

function maxBytes(env: Env): number {
  const mb = parseInt(env.UD_MAX_MB || "", 10);
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULTS.MAX_MB) * 1024 * 1024;
}

function cfg(env: Env) {
  const MAX_MB = Number.parseInt(env.UD_MAX_MB || "", 10);
  const RATE_LIMIT_SEC = Number.parseInt(env.UD_RATE_LIMIT_SEC || "", 10);
  const MAX_PENDING = Number.parseInt(env.UD_MAX_PENDING || "", 10);
  const TTL_SEC = Number.parseInt(env.UD_TTL_SEC || "", 10);
  return {
    MAX_MB: Number.isFinite(MAX_MB) && MAX_MB > 0 ? MAX_MB : DEFAULTS.MAX_MB,
    RATE_LIMIT_SEC: Number.isFinite(RATE_LIMIT_SEC) && RATE_LIMIT_SEC >= 0 ? RATE_LIMIT_SEC : DEFAULTS.RATE_LIMIT_SEC,
    MAX_PENDING: Number.isFinite(MAX_PENDING) && MAX_PENDING >= 0 ? MAX_PENDING : DEFAULTS.MAX_PENDING,
    TTL_SEC: Number.isFinite(TTL_SEC) && TTL_SEC >= 0 ? TTL_SEC : DEFAULTS.TTL_SEC,
    REQUIRE_KEY: !!(env.UD_API_KEY && env.UD_API_KEY.trim()),
  };
}

function sanitizeFilename(input: string): string {
  // support Chinese; block path traversal and weird control chars
  let s = (input || "").trim();
  s = s.replaceAll("\\", "/");
  s = s.split("/").pop() || "";
  s = s.replace(/[\r\n\t]/g, " ").trim();
  s = s.replace(/[<>:"|?*]/g, "_"); // Windows-illegal
  s = s.replace(/\u0000/g, "");
  s = s.replace(/[^\S ]+/g, " ");
  s = s.replace(/[. ]+$/g, ""); // trim trailing dots/spaces
  if (!s || s === "." || s === "..") return "";

  // limit UTF-8 byte length ~200 (soft)
  const enc = new TextEncoder();
  let bytes = enc.encode(s);
  if (bytes.length <= 200) return s;
  // truncate bytes safely
  let cut = bytes.slice(0, 200);
  while (cut.length > 0) {
    try {
      s = new TextDecoder("utf-8", { fatal: true }).decode(cut);
      return s.trim();
    } catch {
      cut = cut.slice(0, cut.length - 1);
    }
  }
  return "";
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomName8(): string {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  let out = "";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  for (const b of bytes) out += letters[b % letters.length];
  return out;
}

function newToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}

// 三位数字短码：000-999
function newShortCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % SHORT_CODE_MAX;
  return String(n).padStart(3, "0");
}

function isShortCode(s: string): boolean {
  return /^\d{3}$/.test(s);
}

// 把新区间并入已有序区间列表（相邻/重叠合并），返回新的列表
function mergeRange(list: [number, number][], start: number, end: number): [number, number][] {
  const all = [...list, [start, end] as [number, number]]
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e >= s)
    .sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [s, e] of all) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + 1) {
      last[1] = Math.max(last[1], e);
    } else {
      out.push([s, e]);
    }
  }
  return out;
}

// 区间是否完整覆盖 [0, size)
function rangesComplete(list: [number, number][], size: number): boolean {
  if (size <= 0) return false;
  let covered = 0;
  for (const [s, e] of list) {
    if (s > covered) return false; // 中间有空洞
    covered = Math.max(covered, e + 1);
    if (covered >= size) return true;
  }
  return covered >= size;
}

function contentDisposition(filename: string): string {
  // RFC 5987 filename*=UTF-8''...
  const fallback = filename
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_")
    .slice(0, 120) || "download";

  const utf8 = encodeURIComponent(filename).replace(/%20/g, "+");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${utf8}`;
}

function noStoreHeaders(h: Headers) {
  h.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  h.set("Pragma", "no-cache");
  h.set("Expires", "0");
  h.set("X-Content-Type-Options", "nosniff");
}

async function bucketUsage(bucket: R2Bucket): Promise<{ objects: number; bytes: number }> {
  let cursor: string | undefined;
  let objects = 0;
  let bytes = 0;
  do {
    const page = await bucket.list({ prefix: "obj/", cursor });
    cursor = page.cursor;
    for (const obj of page.objects) {
      objects += 1;
      bytes += obj.size || 0;
    }
    if (!page.truncated) break;
  } while (cursor);
  return { objects, bytes };
}

function helpText(origin: string, env: Env): string {
  const c = cfg(env);
  const bp = basePath(env);
  const base = origin + (bp || "");
  const curlKey = c.REQUIRE_KEY ? "YOUR_KEY" : "";
  const keyParam = c.REQUIRE_KEY ? `&key=${curlKey}` : "";
  const keyOnly = c.REQUIRE_KEY ? `?key=${curlKey}` : "";
  const curlMultipart = c.REQUIRE_KEY
    ? `curl -sS -F "file=@/path/to/file" "${base}/ud?key=${curlKey}"`
    : `curl -sS -F "file=@/path/to/file" "${base}/ud"`;
  const curlPut = `curl -sS -T "/path/to/file" "${base}/ud?name=yourfile.ext${keyParam}"   # 不指定 name 则保存为随机 8 位 .bin`;
  const curlText = `curl -sS -d "hello" "${base}/ud${keyOnly}"   # 保存为 <timestamp>.txt`;

  return `UD Relay 说明（Workers + R2 + Durable Objects）

用途
- 一次性文件传输：上传后生成下载链接，成功下载 1 次后即失效。
- 对外仅暴露最少接口，其余路径均返回空 404；如部署在子路径，请使用 ${bp || "/"} 前缀。

接口
- GET  ${base}/hc                健康检查；返回调用次数、待下载数量/体积、R2 使用量
- GET  ${base}/hp                帮助文档（本页）
- GET  ${base}/ud                浏览器上传页；命令行访问时返回本说明
- POST ${base}/ud                上传文件（multipart/form-data，字段名 file；可选字段 key）
- PUT  ${base}/ud                直传文件（需提供文件名，见示例）
- POST ${base}/ud                直传文本（非 multipart；保存为 <timestamp>.txt）
- GET  ${base}/ud/f/<token>/<filename>   一次性下载，成功后该 token 失效并删除对象
- GET  ${base}/s/<code>          短链接下载（三位数字，需上传时勾选"短链接"）
- GET  ${base}/hc?full=1         健康检查；加 full=1 则重新遍历 R2 统计（默认读 60s 缓存）

上传示例
  ${curlMultipart}
  ${curlPut}
  ${curlText}

规则
- 最大上传：${c.MAX_MB}MB
- 速率限制：同一 IP 每 ${c.RATE_LIMIT_SEC}s 1 次（0 关闭）
- 待下载上限：${c.MAX_PENDING} 份（0 关闭；超出会从最旧的 ready 起淘汰）
- 链接 TTL：${c.TTL_SEC}s（0 关闭；超时会清理）
- 上传鉴权：${c.REQUIRE_KEY ? "需要 key（UD_API_KEY 已配置）" : "无需 key"}
- 直传文件名：PUT 可用 name / filename、X-Filename 或 /ud/<filename>；缺省则随机 8 位 .bin
- 同名覆盖：同一个文件名再次上传会覆盖并删除旧对象
- 下载一次性：整份文件被完整传完（覆盖全部字节）后，token 立即失效并删除对象
- 支持 Range：多线程/断点续传可用；只有"完整下载完成"才算消费，探测性请求不会失效
- 短链接：上传时加 short=1（或页面勾选），生成 ${base}/s/<三位数字>；可枚举，勿用于敏感文件
- 预览保护：HEAD、Range 探测、链接预览机器人（Telegram/Slack/Discord 等抓取器）、浏览器预取都不会消费链接
- 短码防猜：同一 IP 每 ${SHORT_FAIL_WINDOW}s 猜错超过 ${SHORT_FAIL_LIMIT} 次返回 429

环境变量 / Secrets
- UD_API_KEY        可选；设置后上传需提供 key
- UD_BASE_PATH      可选；部署在子路径时设置（如 /relay）
- UD_MAX_MB         可选；默认 50
- UD_RATE_LIMIT_SEC 可选；默认 10
- UD_MAX_PENDING    可选；默认 10
- UD_TTL_SEC        可选；默认 86400
`;
}

function udHtml(origin: string, env: Env, message = "", ok = true, link = ""): string {
  const c = cfg(env);
  const bp = basePath(env);
  const base = origin + (bp || "");
  const needKey = c.REQUIRE_KEY;
  const color = ok ? "#42f7bf" : "#ff7b7b";
  const msgBlock = message
    ? `<div class="alert ${ok ? "ok" : "err"}">
        <div class="alert-title">${escapeHtml(message)}</div>
        ${
          link
            ? `<div class="muted">下载链接（一次性；wget 不加参数也会落地成原文件名）：</div>
               <div class="link-row"><a href="${link}">${link}</a></div>`
            : ""
        }
      </div>`
    : "";

  const keyParam = needKey ? `&key=YOUR_KEY` : "";
  const keyOnly = needKey ? `?key=YOUR_KEY` : "";
  const curlMultipart = needKey
    ? `curl -sS -F "file=@/path/to/file" "${base}/ud?key=YOUR_KEY"`
    : `curl -sS -F "file=@/path/to/file" "${base}/ud"`;
  const curlPut = `curl -sS -T "/path/to/file" "${base}/ud?name=yourfile.ext${keyParam}"   # 不指定 name 则保存为随机 8 位 .bin`;
  const curlText = `curl -sS -d "hello" "${base}/ud${keyOnly}"   # 保存为 <timestamp>.txt`;

  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>UD Relay</title>
<style>
:root{--bg:#0c1224;--card:rgba(14,19,33,.85);--stroke:rgba(255,255,255,.08);--muted:#b9c7e3;--accent:#6de9c5;--accent2:#7db2ff}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;font-family:"Space Grotesk","IBM Plex Sans","PingFang SC","Microsoft YaHei",system-ui,sans-serif;background:
radial-gradient(circle at 10% 20%,rgba(93,173,255,.2),transparent 25%),
radial-gradient(circle at 80% 0%,rgba(86,255,189,.18),transparent 25%),
radial-gradient(circle at 50% 80%,rgba(133,99,255,.12),transparent 30%),
linear-gradient(135deg,#0b1220 0%,#0f1a33 100%);color:#eaf0ff;}
.wrap{max-width:940px;margin:0 auto;padding:40px 18px;}
.card{background:var(--card);border:1px solid var(--stroke);border-radius:18px;padding:22px 20px;box-shadow:0 18px 50px rgba(0,0,0,.35);backdrop-filter:blur(8px);}
.title{font-size:22px;font-weight:800;letter-spacing:0.2px;margin:0 0 6px;}
.muted{color:var(--muted);font-size:13px;line-height:1.6;}
.row{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-top:10px;}
.field-label{margin:12px 0 6px;font-weight:700;font-size:13px;color:#dbe6ff;}
input[type=file],input[type=text]{width:100%;padding:12px;border-radius:12px;border:1px solid var(--stroke);background:rgba(255,255,255,.04);color:#eaf0ff;outline:none;}
input[type=text]:focus,input[type=file]:focus{border-color:var(--accent2);box-shadow:0 0 0 3px rgba(125,178,255,.18);}
button{padding:12px 18px;border-radius:12px;border:0;cursor:pointer;font-weight:800;background:linear-gradient(135deg,var(--accent),#50c7ff);color:#061123;transition:transform .1s ease,box-shadow .2s ease;}
button:hover{transform:translateY(-1px);box-shadow:0 10px 30px rgba(80,199,255,.3);}
.alert{margin-top:16px;padding:14px;border-radius:14px;border:1px solid var(--stroke);background:rgba(0,0,0,.25);}
.alert.ok{border-color:rgba(110,233,197,.55);box-shadow:0 0 0 1px rgba(110,233,197,.2);}
.alert.err{border-color:rgba(255,123,123,.55);box-shadow:0 0 0 1px rgba(255,123,123,.15);}
.alert-title{color:${color};font-weight:800;margin-bottom:6px;}
.link-row{margin-top:6px;word-break:break-all;font-size:13px;}
a{color:var(--accent2);text-decoration:none;}
a:hover{text-decoration:underline;}
.code{background:rgba(0,0,0,.35);padding:14px;border-radius:12px;overflow:auto;border:1px solid var(--stroke);color:#d9e7ff;}
.section{margin-top:18px;}
.section-title{font-weight:700;font-size:14px;color:#dbe6ff;margin-bottom:6px;}
.textarea{width:100%;min-height:140px;resize:vertical;padding:12px;border-radius:12px;border:1px solid var(--stroke);background:rgba(255,255,255,.04);color:#eaf0ff;outline:none;}
.textarea:focus{border-color:var(--accent2);box-shadow:0 0 0 3px rgba(125,178,255,.18);}
.row.tight{gap:8px;}
.pill{display:inline-block;padding:2px 8px;border:1px solid var(--stroke);border-radius:999px;font-size:12px;color:#cfe0ff;background:rgba(255,255,255,.04);}
.result{margin-top:10px;font-size:13px;word-break:break-all;}
.check{display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13px;color:#dbe6ff;cursor:pointer;user-select:none;}
.check input[type=checkbox]{width:auto;margin:0;accent-color:#6de9c5;}
.hint{font-size:12px;color:#8fa3c9;margin-top:2px;}
@media (max-width:640px){.wrap{padding:26px 14px;}button{width:100%;text-align:center;}}
</style></head><body>
<div class="wrap"><div class="card">
<div class="title">UD Relay 上传 ${needKey ? "（需要 key）" : "（无需 key）"}</div>
<div class="muted">仅开放 /hc /hp /ud（其余均为空 404）。本页提交文件后返回一次性下载链接，成功下载后立即失效。</div>

<form action="${base}/ud" method="post" enctype="multipart/form-data" style="margin-top:16px;">
  ${needKey ? `<div class="field-label">Key</div>
  <input type="text" name="key" placeholder="填入 key（错了会在本页提示）"/>` : ""}
  <div class="field-label">选择文件</div>
  <input type="file" name="file" required/>
  <label class="check"><input type="checkbox" name="short" value="1"/> 生成短链接（三位数字，好记但可能被猜到）</label>
  <div class="row">
    <button type="submit">立即上传</button>
    <div class="muted">最大 ${c.MAX_MB}MB；单 IP ${c.RATE_LIMIT_SEC}s 1 次；待下载最多 ${c.MAX_PENDING} 份；TTL ${c.TTL_SEC}s。</div>
  </div>
</form>

<div class="section">
  <div class="section-title">直接发送文本 <span class="pill">-d</span></div>
  ${needKey ? `<div class="field-label">Key</div>
  <input type="text" id="rawKey" placeholder="填入 key（错了会在本页提示）"/>` : ""}
  <div class="field-label">文本内容</div>
  <textarea id="rawText" class="textarea" placeholder="在这里输入要传的文本..."></textarea>
  <label class="check"><input type="checkbox" id="rawShort"/> 生成短链接（三位数字）</label>
  <div class="row tight">
    <button type="button" id="rawSend">提交文本</button>
    <div class="muted">以 text/plain 直传，保存为 &lt;timestamp&gt;.txt</div>
  </div>
  <div id="rawResult" class="result muted"></div>
</div>

${msgBlock}

<div class="section">
  <div class="section-title">curl 示例</div>
  <pre class="code">${curlMultipart}
${curlPut}
${curlText}</pre>
</div>

<div class="muted" style="margin-top:14px;">帮助：<a href="${base}/hp">${base}/hp</a></div>
<div class="muted">健康检查：<a href="${base}/hc">${base}/hc</a></div>
</div></div>
<script>
(() => {
  const btn = document.getElementById("rawSend");
  if (!btn) return;
  const result = document.getElementById("rawResult");
  const textEl = document.getElementById("rawText");
  const keyEl = document.getElementById("rawKey");
  const shortEl = document.getElementById("rawShort");
  const baseUrl = "${base}/ud";
  const setResult = (msg, ok) => {
    if (!result) return;
    result.textContent = msg;
    result.style.color = ok ? "#6de9c5" : "#ff7b7b";
  };
  btn.addEventListener("click", async () => {
    const text = (textEl && textEl.value || "").trim();
    if (!text) {
      setResult("请输入文本内容。", false);
      return;
    }
    const headers = { "Content-Type": "text/plain; charset=utf-8" };
    const key = keyEl && keyEl.value ? keyEl.value.trim() : "";
    if (key) headers["X-API-Key"] = key;
    try {
      setResult("正在上传…", true);
      const resp = await fetch(shortEl && shortEl.checked ? (baseUrl + "?short=1") : baseUrl, { method: "POST", headers, body: text });
      const body = await resp.text();
      if (!resp.ok) {
        setResult(body.trim() || ("上传失败，HTTP " + resp.status), false);
        return;
      }
      const lines = body.trim().split(/\\n/);
      const dl = lines[lines.length - 1] || body.trim();
      setResult("上传成功！下载链接：" + dl, true);
    } catch (e) {
      setResult("上传失败：网络错误。", false);
    }
  });
})();
</script>
</body></html>`;
}

function helpPageHtml(origin: string, env: Env, text: string): string {
  const bp = basePath(env);
  const base = origin + (bp || "");
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>UD Relay 帮助</title>
<style>
:root{--bg:#0c1224;--card:rgba(14,19,33,.85);--stroke:rgba(255,255,255,.08);--muted:#b9c7e3;--accent:#6de9c5;--accent2:#7db2ff}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;font-family:"Space Grotesk","IBM Plex Sans","PingFang SC","Microsoft YaHei",system-ui,sans-serif;background:
radial-gradient(circle at 10% 20%,rgba(93,173,255,.2),transparent 25%),
radial-gradient(circle at 80% 0%,rgba(86,255,189,.18),transparent 25%),
radial-gradient(circle at 50% 80%,rgba(133,99,255,.12),transparent 30%),
linear-gradient(135deg,#0b1220 0%,#0f1a33 100%);color:#eaf0ff;}
.wrap{max-width:940px;margin:0 auto;padding:40px 18px;}
.card{background:var(--card);border:1px solid var(--stroke);border-radius:18px;padding:22px 20px;box-shadow:0 18px 50px rgba(0,0,0,.35);backdrop-filter:blur(8px);}
.title{font-size:22px;font-weight:800;margin:0 0 6px;}
.muted{color:var(--muted);font-size:13px;line-height:1.6;}
a{color:var(--accent2);text-decoration:none;}
a:hover{text-decoration:underline;}
.code{background:rgba(0,0,0,.35);padding:14px;border-radius:12px;overflow:auto;border:1px solid var(--stroke);color:#d9e7ff;white-space:pre-wrap;}
@media (max-width:640px){.wrap{padding:26px 14px;}}
</style></head><body>
<div class="wrap"><div class="card">
<div class="title">UD Relay 帮助</div>
<div class="muted" style="margin-bottom:12px;">上传入口：<a href="${base}/ud">${base}/ud</a></div>
<pre class="code">${escapeHtml(text)}</pre>
</div></div></body></html>`;
}

function hcHtml(origin: string, env: Env, stats: Record<string, number | string>): string {
  const bp = basePath(env);
  const base = origin + (bp || "");
  const fmtNum = (n: any) => (typeof n === "number" ? n : "-");
  const fmtBytes = (n: any) => {
    if (typeof n !== "number" || n < 0) return "未知";
    if (n < 1024) return `${n} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let v = n / 1024;
    let idx = 0;
    while (v >= 1024 && idx < units.length - 1) {
      v /= 1024;
      idx += 1;
    }
    return `${v.toFixed(2)} ${units[idx]}`;
  };

  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>UD Relay 健康检查</title>
<style>
:root{--bg:#0c1224;--card:rgba(14,19,33,.85);--stroke:rgba(255,255,255,.08);--muted:#b9c7e3;--accent:#6de9c5;--accent2:#7db2ff}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;font-family:"Space Grotesk","IBM Plex Sans","PingFang SC","Microsoft YaHei",system-ui,sans-serif;background:
radial-gradient(circle at 10% 20%,rgba(93,173,255,.2),transparent 25%),
radial-gradient(circle at 80% 0%,rgba(86,255,189,.18),transparent 25%),
radial-gradient(circle at 50% 80%,rgba(133,99,255,.12),transparent 30%),
linear-gradient(135deg,#0b1220 0%,#0f1a33 100%);color:#eaf0ff;}
.wrap{max-width:940px;margin:0 auto;padding:40px 18px;}
.card{background:var(--card);border:1px solid var(--stroke);border-radius:18px;padding:22px 20px;box-shadow:0 18px 50px rgba(0,0,0,.35);backdrop-filter:blur(8px);}
.title{font-size:22px;font-weight:800;margin:0 0 6px;}
.muted{color:var(--muted);font-size:13px;line-height:1.6;}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-top:14px;}
.tile{border:1px solid var(--stroke);border-radius:14px;padding:14px 12px;background:rgba(0,0,0,.2);}
.tile h3{margin:0 0 6px;font-size:15px;}
.value{font-size:20px;font-weight:800;}
a{color:var(--accent2);text-decoration:none;}
a:hover{text-decoration:underline;}
.code{background:rgba(0,0,0,.35);padding:14px;border-radius:12px;overflow:auto;border:1px solid var(--stroke);color:#d9e7ff;white-space:pre-wrap;}
@media (max-width:640px){.wrap{padding:26px 14px;}}
</style></head><body>
<div class="wrap"><div class="card">
<div class="title">UD Relay 健康检查</div>
<div class="muted">上传入口：<a href="${base}/ud">${base}/ud</a></div>
<div class="muted">帮助文档：<a href="${base}/hp">${base}/hp</a></div>
<div class="grid">
  <div class="tile"><h3>调用次数</h3><div class="value">${fmtNum(stats.hc_calls)}</div><div class="muted">hc 自部署以来的累计调用</div></div>
  <div class="tile"><h3>待下载文件</h3><div class="value">${fmtNum(stats.pending_tokens)}</div><div class="muted">尚未被消费的一次性链接数量</div></div>
  <div class="tile"><h3>待下载体积</h3><div class="value">${fmtBytes(stats.pending_bytes)}</div><div class="muted">元数据中的 size 汇总</div></div>
  <div class="tile"><h3>R2 对象数</h3><div class="value">${fmtNum(stats.r2_objects)}</div><div class="muted">obj/ 前缀下的对象数量</div></div>
  <div class="tile"><h3>R2 存储量</h3><div class="value">${fmtBytes(stats.r2_bytes)}</div><div class="muted">obj/ 前缀下对象的总大小</div></div>
</div>
<div class="section" style="margin-top:16px;">
  <div class="muted">原始 JSON：</div>
  <pre class="code">${escapeHtml(JSON.stringify(stats, null, 2))}</pre>
</div>
</div></div></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

async function callStateDO(env: Env, payload: any): Promise<Response> {
  const id = env.UD_STATE.idFromName("global");
  const stub = env.UD_STATE.get(id);
  return stub.fetch("https://do/ud", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    const stripped = stripBase(url.pathname, env);
    if (stripped === null) return empty404(); // not under base path
    const path = stripped;

    // Root & everything else should look like no website
    if (path === "/" && request.method === "GET") return empty404();

    if (path === "/hc" && request.method === "GET") {
      const full = url.searchParams.get("full") === "1";
      let hcCount = -1;
      let pendingTokens = 0;
      let pendingBytes = 0;
      let r2Objects = -1;
      let r2Bytes = -1;
      let cached = false;
      try {
        const metaResp = await callStateDO(env, { op: "hc", full });
        if (metaResp.ok) {
          const meta = (await metaResp.json()) as {
            hcCount: number;
            pendingTokens: number;
            pendingBytes: number;
            r2Objects: number;
            r2Bytes: number;
            cached: boolean;
          };
          hcCount = meta.hcCount ?? -1;
          pendingTokens = meta.pendingTokens ?? 0;
          pendingBytes = meta.pendingBytes ?? 0;
          r2Objects = meta.r2Objects ?? -1;
          r2Bytes = meta.r2Bytes ?? -1;
          cached = !!meta.cached;
        }
      } catch {}

      const body = {
        ok: true,
        ts: nowSec(),
        hc_calls: hcCount,
        pending_tokens: pendingTokens,
        pending_bytes: pendingBytes,
        r2_objects: r2Objects,
        r2_bytes: r2Bytes,
        r2_cached: cached,
      };
      if (isBrowser(request)) {
        return new Response(hcHtml(url.origin, env, body), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return new Response(`${JSON.stringify(body, null, 2)}\n`, { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
    }

    if (path === "/hp" && request.method === "GET") {
      const text = helpText(url.origin, env);
      if (!isBrowser(request)) {
        return new Response(text, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
      return new Response(helpPageHtml(url.origin, env, text), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // /ud GET -> page/help
    if (path === "/ud" && request.method === "GET") {
      if (!isBrowser(request)) {
        const text = helpText(url.origin, env);
        return new Response(text, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
      return new Response(udHtml(url.origin, env), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    const contentTypeHeader = (request.headers.get("Content-Type") || "").toLowerCase();
    const isMultipart = contentTypeHeader.includes("multipart/form-data");
    const isRawText = request.method === "POST" && !isMultipart && path === "/ud";
    const isRawFile =
      request.method === "PUT" &&
      (path === "/ud" || (path.startsWith("/ud/") && !path.startsWith("/ud/f/")));

    if (isRawText || isRawFile) {
      const c = cfg(env);
      const ip = getClientIp(request);
      const key = getApiKeyFromReq(request).trim();

      const size = parseContentLength(request);
      if (size === null) {
        return isBrowser(request)
          ? new Response(udHtml(url.origin, env, "请求缺少 Content-Length，无法确定文件大小。", false), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } })
          : new Response("Length Required\n", { status: 411 });
      }

      if (size > maxBytes(env)) {
        return isBrowser(request)
          ? new Response(udHtml(url.origin, env, `文件过大：最大 ${c.MAX_MB}MB。`, false), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } })
          : new Response(`File too large (max ${c.MAX_MB}MB)\n`, { status: 413 });
      }

      let filename = "";
      let contentType = "";
      if (isRawText) {
        filename = `${nowSec()}.txt`;
        contentType = "text/plain; charset=utf-8";
      } else {
        filename = rawUploadFilename(request, path);
        if (!filename) filename = `${randomName8()}.bin`;
        contentType = (request.headers.get("Content-Type") || "application/octet-stream").slice(0, 200);
      }

      const reserveResp = await callStateDO(env, {
        op: "reserve",
        ip,
        key,
        filename,
        size,
        contentType,
        short: url.searchParams.get("short") === "1",
      });

      if (!reserveResp.ok) {
        if (reserveResp.status === 401) {
          const msg = "Key 错误或缺失，上传未执行。";
          return isBrowser(request)
            ? new Response(udHtml(url.origin, env, msg, false), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } })
            : new Response("Unauthorized\n", { status: 401 });
        }
        if (reserveResp.status === 429) {
          const msg = `上传过于频繁：每 ${c.RATE_LIMIT_SEC}s 仅允许 1 次。`;
          return isBrowser(request)
            ? new Response(udHtml(url.origin, env, msg, false), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } })
            : new Response("Too Many Requests\n", { status: 429 });
        }
        return empty404();
      }

      const reserved = (await reserveResp.json()) as { token: string; objectKey: string };
      const token = reserved.token;
      const objectKey = reserved.objectKey;

      try {
        await env.UD_BUCKET.put(objectKey, request.body, {
          httpMetadata: {
            contentType,
          },
          customMetadata: {
            filename,
            uploaded_at: String(nowSec()),
          },
        });
      } catch {
        ctx.waitUntil(callStateDO(env, { op: "abort", token }).catch(() => undefined));
        return isBrowser(request)
          ? new Response(udHtml(url.origin, env, "上传失败：写入存储异常。", false), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } })
          : new Response("Upload failed\n", { status: 500 });
      }

      ctx.waitUntil(callStateDO(env, { op: "commit", token }).catch(() => undefined));

      const dlUrl = `${url.origin}${downloadPath(token, filename, env)}`;

      if (isBrowser(request)) {
        return new Response(udHtml(url.origin, env, "上传成功！", true, dlUrl), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return new Response(`OK\n${dlUrl}\n`, { status: 201, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    // /ud POST -> upload
    if (path === "/ud" && request.method === "POST") {
      const c = cfg(env);

      const ip = getClientIp(request);
      let form: FormData;
      try {
        form = await request.formData();
      } catch {
        // not multipart, refuse (keeps behavior strict)
        return isBrowser(request)
          ? new Response(udHtml(url.origin, env, "请求格式错误：请使用 multipart/form-data（例如 curl -F）。", false), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } })
          : new Response("Bad Request\n", { status: 400 });
      }

      const keyFromForm = (form.get("key") as string | null) || "";
      const key = (getApiKeyFromReq(request) || keyFromForm).trim();

      const f = form.get("file");
      if (!(f instanceof File)) {
        return isBrowser(request)
          ? new Response(udHtml(url.origin, env, "未选择文件（字段名必须为 file）。", false), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } })
          : new Response("No file part\n", { status: 400 });
      }

      const filename = sanitizeFilename(f.name);
      if (!filename) {
        return isBrowser(request)
          ? new Response(udHtml(url.origin, env, "文件名不合法（支持中文，但禁止路径/控制字符）。", false), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } })
          : new Response("Invalid filename\n", { status: 400 });
      }

      if (f.size > maxBytes(env)) {
        return isBrowser(request)
          ? new Response(udHtml(url.origin, env, `文件过大：最大 ${c.MAX_MB}MB。`, false), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } })
          : new Response(`File too large (max ${c.MAX_MB}MB)\n`, { status: 413 });
      }

      const contentType = (f.type || "application/octet-stream").slice(0, 200);

      // 1) reserve with DO (auth + rate limit + overwrite old same-name + eviction)
      const reserveResp = await callStateDO(env, {
        op: "reserve",
        ip,
        key,
        filename,
        size: f.size,
        contentType,
        short: url.searchParams.get("short") === "1" || String(form.get("short") || "") !== "",
      });

      if (!reserveResp.ok) {
        if (reserveResp.status === 401) {
          const msg = "Key 错误或缺失，上传未执行。";
          return isBrowser(request)
            ? new Response(udHtml(url.origin, env, msg, false), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } })
            : new Response("Unauthorized\n", { status: 401 });
        }
        if (reserveResp.status === 429) {
          const msg = `上传过于频繁：每 ${c.RATE_LIMIT_SEC}s 仅允许 1 次。`;
          return isBrowser(request)
            ? new Response(udHtml(url.origin, env, msg, false), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } })
            : new Response("Too Many Requests\n", { status: 429 });
        }
        return empty404();
      }

      const reserved = (await reserveResp.json()) as { token: string; objectKey: string; evicted?: string[] };
      const token = reserved.token;
      const objectKey = reserved.objectKey;

      // 2) put into R2 (streaming)
      try {
        await env.UD_BUCKET.put(objectKey, f.stream(), {
          httpMetadata: {
            contentType,
          },
          customMetadata: {
            filename,
            uploaded_at: String(nowSec()),
          },
        });
      } catch (e) {
        // abort reservation if upload fails
        ctx.waitUntil(callStateDO(env, { op: "abort", token }).catch(() => undefined));
        return isBrowser(request)
          ? new Response(udHtml(url.origin, env, "上传失败：写入存储异常。", false), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } })
          : new Response("Upload failed\n", { status: 500 });
      }

      // 3) commit reservation
      ctx.waitUntil(callStateDO(env, { op: "commit", token }).catch(() => undefined));

      const dlUrl = `${url.origin}${downloadPath(token, filename, env)}`;

      if (isBrowser(request)) {
        return new Response(udHtml(url.origin, env, "上传成功！", true, dlUrl), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return new Response(`OK\n${dlUrl}\n`, { status: 201, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    // 下载：/ud/f/<token>/<filename> 或 /s/<code>
    const isLongDl = path.startsWith("/ud/f/");
    const isShortDl = path.startsWith("/s/");
    if ((isLongDl || isShortDl) && (request.method === "GET" || request.method === "HEAD")) {
      let token = "";
      let reqName = "";
      if (isLongDl) {
        const parts = path.split("/").filter(Boolean); // ["ud","f",token,filename...]
        if (parts.length < 4) return empty404();
        try {
          token = decodeURIComponent(parts[2] || "");
          reqName = sanitizeFilename(decodeURIComponent(parts.slice(3).join("/")));
        } catch {
          return empty404();
        }
        if (!reqName) return empty404();
      } else {
        const parts = path.split("/").filter(Boolean); // ["s", code]
        if (parts.length !== 2) return empty404();
        try {
          token = decodeURIComponent(parts[1] || "");
        } catch {
          return empty404();
        }
        if (!isShortCode(token)) return empty404();
      }
      if (!token) return empty404();

      // 链接预览/预取：直接给个空壳页面，不碰 token，不消耗
      if (isPreviewBot(request) || isPrefetch(request)) {
        const ph = new Headers({ "Content-Type": "text/html; charset=utf-8" });
        noStoreHeaders(ph);
        return new Response("<!doctype html><html><head><meta charset=\"utf-8\"/><title>UD Relay</title></head><body></body></html>", {
          status: 200,
          headers: ph,
        });
      }

      const ip = getClientIp(request);

      // 读取元信息（不消费；短码猜错会在这里被限流）
      const metaResp = await callStateDO(env, { op: "meta", token, ip, name: reqName });
      if (metaResp.status === 429) return new Response("Too Many Requests\n", { status: 429 });
      if (!metaResp.ok) return empty404();
      const meta = (await metaResp.json()) as { objectKey: string; filename: string; contentType: string; size: number };

      const total = Number(meta.size) || 0;

      // Range 解析（支持多线程/断点续传）
      let offset = 0;
      let length = total;
      let status = 200;
      const rangeHeader = request.headers.get("Range");
      if (rangeHeader && total > 0) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
        if (m) {
          const hasStart = m[1] !== "";
          const hasEnd = m[2] !== "";
          let s = hasStart ? parseInt(m[1], 10) : -1;
          let e = hasEnd ? parseInt(m[2], 10) : -1;
          if (!hasStart && hasEnd) {
            s = Math.max(0, total - e);
            e = total - 1;
          } else if (hasStart && !hasEnd) {
            e = total - 1;
          }
          if (s >= 0 && e >= s && s < total) {
            if (e >= total) e = total - 1;
            offset = s;
            length = e - s + 1;
            status = 206;
          } else {
            return new Response("", { status: 416, headers: { "Content-Range": `bytes */${total}` } });
          }
        }
      }

      const h = new Headers();
      h.set("Content-Type", meta.contentType || "application/octet-stream");
      h.set("Content-Disposition", contentDisposition(meta.filename));
      h.set("Accept-Ranges", "bytes");
      if (status === 206) h.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${total}`);
      h.set("Content-Length", String(length));
      noStoreHeaders(h);

      // HEAD：只回头，不算下载，不消费
      if (request.method === "HEAD") {
        return new Response(null, { status, headers: h });
      }

      const obj = await env.UD_BUCKET.get(
        meta.objectKey,
        status === 206 ? { range: { offset, length } } : undefined,
      );
      if (!obj || !obj.body) {
        ctx.waitUntil(callStateDO(env, { op: "finalize", token }).catch(() => undefined));
        return empty404();
      }

      // 数据真正传完之后才上报"这一段传完了"；断开/取消则不上报
      const { readable, writable } = new TransformStream();
      const pump = obj.body.pipeTo(writable);
      ctx.waitUntil(
        pump
          .then(async () => {
            try {
              const r = await callStateDO(env, {
                op: "report",
                token,
                start: offset,
                end: offset + length - 1,
              });
              if (r.ok) {
                const j = (await r.json()) as { complete?: boolean };
                if (j.complete) {
                  try {
                    await env.UD_BUCKET.delete(meta.objectKey);
                  } catch {}
                }
              }
            } catch {}
          })
          .catch(() => undefined),
      );

      return new Response(readable, { status, headers: h });
    }

    // everything else
    return empty404();
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // periodic cleanup (TTL, orphan reserved, enforce cap)
    ctx.waitUntil(callStateDO(env, { op: "cleanup" }).catch(() => undefined));
  },
};

// =============================================================================
// Durable Object: stores all state atomically (rate limit + tokens + cap + TTL)
// =============================================================================
export class UDState implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private async load(): Promise<StateData> {
    const data = (await this.state.storage.get<StateData>("data")) || {
      tokens: {},
      byName: {},
      queue: [],
      lastUpload: {},
      metrics: { hcCount: 0 },
    };
    if (!data.metrics) data.metrics = { hcCount: 0 };
    return data;
  }

  private async save(data: StateData) {
    await this.state.storage.put("data", data);
  }

  private requireKeyOK(key: string): boolean {
    const api = (this.env.UD_API_KEY || "").trim();
    if (!api) return true;
    return (key || "").trim() === api;
  }

  private async cleanupLocked(data: StateData, deleteKeys: string[]): Promise<{ evicted: string[] }> {
    const evicted: string[] = [];
    const t = nowSec();
    const c = cfg(this.env);

    // remove expired or stuck reserved (reserved older than 10min)
    for (const [token, meta] of Object.entries(data.tokens)) {
      const expired = meta.expiresAt > 0 && meta.expiresAt < t;
      const stuckReserved = meta.status === "reserved" && (t - meta.createdAt) > 600;
      if (expired || stuckReserved) {
        // delete mapping and queue
        delete data.tokens[token];
        if (data.byName[meta.filename] === token) delete data.byName[meta.filename];
        data.queue = data.queue.filter((x) => x !== token);
        evicted.push(token);
        deleteKeys.push(meta.objectKey);
      }
    }

    // enforce max pending count (ready only)
    if (c.MAX_PENDING > 0) {
      // build list of ready tokens in queue order
      const ready = data.queue.filter((tok) => data.tokens[tok]?.status === "ready");
      while (ready.length > c.MAX_PENDING) {
        const oldest = ready.shift()!;
        const meta = data.tokens[oldest];
        if (!meta) continue;
        delete data.tokens[oldest];
        if (data.byName[meta.filename] === oldest) delete data.byName[meta.filename];
        data.queue = data.queue.filter((x) => x !== oldest);
        evicted.push(oldest);
        deleteKeys.push(meta.objectKey);
      }
    }

    // rate-limit map GC: drop entries unused for a long window
    const cutoff = t - Math.max(86400, c.RATE_LIMIT_SEC);
    for (const [ip, ts] of Object.entries(data.lastUpload)) {
      if (ts < cutoff) delete data.lastUpload[ip];
    }

    // 短码失败记录 GC（过期 + 控制条数，防止 DO 状态膨胀）
    if (data.shortFail) {
      for (const [ip, rec] of Object.entries(data.shortFail)) {
        if (t - rec.t > SHORT_FAIL_GC) delete data.shortFail[ip];
      }
      const keys = Object.keys(data.shortFail);
      if (keys.length > SHORT_FAIL_MAX_ENTRIES) {
        keys.sort((a, b) => (data.shortFail![a]?.t || 0) - (data.shortFail![b]?.t || 0));
        for (const k of keys.slice(0, keys.length - SHORT_FAIL_MAX_ENTRIES)) delete data.shortFail![k];
      }
    }

    return { evicted };
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("", { status: 404 });

    const deleteKeys: string[] = [];

    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response("", { status: 404 });
    }

    const op = body?.op;
    if (!op) return new Response("", { status: 404 });

    const response = await this.state.blockConcurrencyWhile(async () => {
      const data = await this.load();
      const c = cfg(this.env);

      // small cleanup on every op
      await this.cleanupLocked(data, deleteKeys);

      if (op === "hc") {
        data.metrics.hcCount = (data.metrics.hcCount || 0) + 1;
        const pending = Object.values(data.tokens).filter((m) => m.status !== "claimed");
        const pendingBytes = pending.reduce((sum, m) => sum + (m.size || 0), 0);

        // R2 用量：默认读缓存，?full=1 才重新遍历
        const wantFull = !!body?.full;
        let r2 = data.r2Cache;
        if (wantFull || !r2 || nowSec() - r2.at > R2_CACHE_SEC) {
          try {
            const usage = await bucketUsage(this.env.UD_BUCKET);
            r2 = { objects: usage.objects, bytes: usage.bytes, at: nowSec() };
            data.r2Cache = r2;
          } catch {
            r2 = r2 || { objects: -1, bytes: -1, at: 0 };
          }
        }

        await this.save(data);
        return Response.json({
          hcCount: data.metrics.hcCount,
          pendingTokens: pending.length,
          pendingBytes,
          r2Objects: r2?.objects ?? -1,
          r2Bytes: r2?.bytes ?? -1,
          cached: !wantFull && !!r2 && nowSec() - r2.at <= R2_CACHE_SEC,
        });
      }

      if (op === "reserve") {
        const { ip, key, filename, size, contentType } = body || {};
        if (!this.requireKeyOK(key || "")) return new Response("Unauthorized", { status: 401 });

        // rate limit
        if (c.RATE_LIMIT_SEC > 0) {
          const last = data.lastUpload[ip] || 0;
          if ((nowSec() - last) < c.RATE_LIMIT_SEC) return new Response("Too Many Requests", { status: 429 });
          data.lastUpload[ip] = nowSec();
        }

        const safeName = sanitizeFilename(String(filename || ""));
        if (!safeName) return new Response("", { status: 404 });

        // 短码：勾选 short 时用三位数字，冲突自动重试；都撞车则退回长 token
        let token = "";
        let short = false;
        if (body?.short) {
          for (let i = 0; i < 30; i++) {
            const code = newShortCode();
            if (!data.tokens[code]) {
              token = code;
              short = true;
              break;
            }
          }
        }
        if (!token) token = newToken();
        const ext = (() => {
          const idx = safeName.lastIndexOf(".");
          return idx >= 0 ? safeName.slice(idx) : "";
        })();
        const objectKey = `obj/${token}${ext}`;

        // overwrite semantic: if same filename exists, evict old one
        const prev = data.byName[safeName];
        if (prev && data.tokens[prev]) {
          const metaPrev = data.tokens[prev];
          delete data.tokens[prev];
          data.queue = data.queue.filter((x) => x !== prev);
          if (data.byName[safeName] === prev) delete data.byName[safeName];
          deleteKeys.push(metaPrev.objectKey);
        }

        const expiresAt = c.TTL_SEC > 0 ? nowSec() + c.TTL_SEC : 0;

        data.tokens[token] = {
          token,
          objectKey,
          filename: safeName,
          contentType: String(contentType || "application/octet-stream").slice(0, 200),
          size: Number(size || 0) || 0,
          createdAt: nowSec(),
          expiresAt,
          status: "reserved",
          uploaderIp: String(ip || "unknown"),
          ranges: [],
          short,
        };
        data.byName[safeName] = token;
        data.queue.push(token);

        // enforce cap early
        const { evicted } = await this.cleanupLocked(data, deleteKeys);

        await this.save(data);
        return Response.json({ token, objectKey, evicted });
      }

      if (op === "abort") {
        const token = String(body?.token || "");
        const meta = data.tokens[token];
        if (meta) {
          delete data.tokens[token];
          if (data.byName[meta.filename] === token) delete data.byName[meta.filename];
          data.queue = data.queue.filter((x) => x !== token);
          deleteKeys.push(meta.objectKey);
          await this.save(data);
        }
        return Response.json({ ok: true });
      }

      if (op === "commit") {
        const token = String(body?.token || "");
        const meta = data.tokens[token];
        if (!meta) return new Response("", { status: 404 });
        if (meta.status !== "reserved") return Response.json({ ok: true });
        meta.status = "ready";
        data.tokens[token] = meta;

        // enforce cap
        await this.cleanupLocked(data, deleteKeys);
        await this.save(data);
        return Response.json({ ok: true });
      }

      // 读取元信息：不消费；短码猜错在这里限流
      if (op === "meta") {
        const token = String(body?.token || "");
        const ip = String(body?.ip || "unknown");
        const reqName = sanitizeFilename(String(body?.name || ""));
        const t = nowSec();
        const meta = data.tokens[token];

        if (!meta) {
          if (isShortCode(token)) {
            data.shortFail = data.shortFail || {};
            const rec = data.shortFail[ip] || { n: 0, t };
            if (t - rec.t > SHORT_FAIL_WINDOW) {
              rec.n = 0;
              rec.t = t;
            }
            rec.n += 1;
            data.shortFail[ip] = rec;
            await this.save(data);
            if (rec.n > SHORT_FAIL_LIMIT) return new Response("Too Many Requests", { status: 429 });
          }
          return new Response("", { status: 404 });
        }

        // 猜对了：清掉这个 IP 的失败计数
        if (data.shortFail && data.shortFail[ip]) {
          delete data.shortFail[ip];
          await this.save(data);
        }

        if (meta.status !== "ready") return new Response("", { status: 404 });

        if (meta.expiresAt > 0 && meta.expiresAt < t) {
          delete data.tokens[token];
          if (data.byName[meta.filename] === token) delete data.byName[meta.filename];
          data.queue = data.queue.filter((x) => x !== token);
          deleteKeys.push(meta.objectKey);
          await this.save(data);
          return new Response("", { status: 404 });
        }

        if (reqName && meta.filename !== reqName) return new Response("", { status: 404 });

        return Response.json({
          objectKey: meta.objectKey,
          filename: meta.filename,
          contentType: meta.contentType || "application/octet-stream",
          size: meta.size || 0,
        });
      }

      // 上报"这一段字节已经完整传给客户端了"；覆盖 [0,size) 则消费掉
      if (op === "report") {
        const token = String(body?.token || "");
        const t = nowSec();
        const meta = data.tokens[token];
        if (!meta || meta.status !== "ready") return Response.json({ complete: false });

        if (meta.expiresAt > 0 && meta.expiresAt < t) {
          delete data.tokens[token];
          if (data.byName[meta.filename] === token) delete data.byName[meta.filename];
          data.queue = data.queue.filter((x) => x !== token);
          deleteKeys.push(meta.objectKey);
          await this.save(data);
          return Response.json({ complete: false });
        }

        const size = Number(meta.size) || 0;

        if (size <= 0) {
          // 空文件：一次成功传输就算消费
          delete data.tokens[token];
          if (data.byName[meta.filename] === token) delete data.byName[meta.filename];
          data.queue = data.queue.filter((x) => x !== token);
          deleteKeys.push(meta.objectKey);
          await this.save(data);
          return Response.json({ complete: true });
        }

        const start = Math.max(0, Math.floor(Number(body?.start) || 0));
        const end = Math.floor(Number(body?.end));
        if (!Number.isFinite(end) || end < start) return Response.json({ complete: false });

        meta.ranges = mergeRange(meta.ranges || [], start, Math.min(end, size - 1));

        if (rangesComplete(meta.ranges, size)) {
          delete data.tokens[token];
          if (data.byName[meta.filename] === token) delete data.byName[meta.filename];
          data.queue = data.queue.filter((x) => x !== token);
          deleteKeys.push(meta.objectKey);
          await this.save(data);
          return Response.json({ complete: true });
        }

        data.tokens[token] = meta;
        await this.save(data);
        return Response.json({ complete: false, segments: meta.ranges.length });
      }

      if (op === "finalize") {
        const token = String(body?.token || "");
        const meta = data.tokens[token];
        if (meta) {
          delete data.tokens[token];
          if (data.byName[meta.filename] === token) delete data.byName[meta.filename];
          data.queue = data.queue.filter((x) => x !== token);
          // object already deleted by worker, but best-effort
          deleteKeys.push(meta.objectKey);
          await this.save(data);
        }
        return Response.json({ ok: true });
      }

      if (op === "cleanup") {
        await this.cleanupLocked(data, deleteKeys);
        await this.save(data);
        return Response.json({ ok: true });
      }

      return new Response("", { status: 404 });
    });

    if (deleteKeys.length) {
      this.state.waitUntil(Promise.all(deleteKeys.map((k) => this.env.UD_BUCKET.delete(k).catch(() => undefined))));
    }

    return response;
  }
}
