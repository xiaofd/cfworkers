/* eslint-disable @typescript-eslint/no-unused-vars */

export interface Env {
  UD_BUCKET: R2Bucket;
  UD_STATE: DurableObjectNamespace;

  // secrets / vars:
  UD_API_KEY?: string;     // optional
  UD_BASE_PATH?: string;   // optional, e.g. "/relay"
  UD_MAX_MB?: string;      // optional, default 100
  UD_RATE_LIMIT_SEC?: string; // optional, default 2
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
  const keyParam = c.REQUIRE_KEY ? "&key=YOUR_KEY" : "";
  const keyOnly = c.REQUIRE_KEY ? "?key=YOUR_KEY" : "";

  return `UD Relay 使用说明（Cloudflare Workers + R2 + Durable Objects）

用途
- 一次性文件中转：上传后生成下载链接，整份文件被完整下载一次后即失效。
- 只开放 ${bp || "/"} 下的少量路径，其余一律空 404。

快速上手
1) 浏览器：打开 ${base}/ud ，选择文件或拖进去，点上传
2) 命令行：curl -sS -F "file=@/path/to/file" "${base}/ud"
3) 拿到链接后发给对方；完整下载一次后链接失效（中途断开不算）

接口
- GET  ${base}/ud                      浏览器上传页（命令行访问时返回本说明）
- POST ${base}/ud                      multipart/form-data 上传文件，字段名 file
- POST ${base}/ud                      text/plain 直传文本（保存为 <时间戳>.txt）
- PUT  ${base}/ud                      裸流直传，文件名取自 name/filename 或 X-Filename
- GET  ${base}/ud/f/<token>/<文件名>     下载（一次性）
- GET  ${base}/s/<三位数字>              短链接下载（上传时加 short=1 生成）
- GET  ${base}/hc                      健康检查（JSON）
- GET  ${base}/hc?full=1               强制重新遍历 R2 统计用量
- GET  ${base}/hp                      本说明

命令行示例
  上传文件        curl -sS -F "file=@/path/to/file" "${base}/ud"
  上传并生成短链  curl -sS -F "file=@/path/to/file" "${base}/ud?short=1"
  裸流直传        curl -sS -T "/path/to/file" "${base}/ud?name=filename.ext"
  直传文本        curl -sS -d "hello" "${base}/ud"
  下载            curl -O -J "<下载链接>"
  断点续传        curl -C - -O -J "<下载链接>"
  健康检查        curl "${base}/hc"

规则
- 单文件上限：${c.MAX_MB}MB
- 速率限制：同一 IP 每 ${c.RATE_LIMIT_SEC} 秒 1 次（0 关闭）
- 待下载上限：${c.MAX_PENDING} 份（0 关闭；超出从最旧的开始淘汰）
- 链接有效期：${c.TTL_SEC} 秒（0 关闭）
- 上传鉴权：${c.REQUIRE_KEY ? "需要 key（UD_API_KEY 已配置）" : "无需 key"}
- 直传文件名：PUT 可用 name / filename / X-Filename / /ud/<文件名>；缺省为随机 8 位 .bin
- 同名覆盖：同一文件名再次上传会覆盖并删除旧对象
- 一次性判定：整份文件完整传完（覆盖全部字节）才失效，中途断开可重新下载
- 支持 Range：多线程下载 / 断点续传可用
- 预览保护：HEAD、Range 探测、链接预览机器人、浏览器预取都不会消耗链接
- 短链接：可枚举，勿用于敏感文件；同一 IP 每 ${SHORT_FAIL_WINDOW} 秒猜错超过 ${SHORT_FAIL_LIMIT} 次返回 429

环境变量 / Secrets
- UD_API_KEY        可选；设置后上传需提供 key
- UD_BASE_PATH      可选；部署在子路径时设置（如 /re）
- UD_MAX_MB         可选；默认 ${DEFAULTS.MAX_MB}
- UD_RATE_LIMIT_SEC 可选；默认 ${DEFAULTS.RATE_LIMIT_SEC}
- UD_MAX_PENDING    可选；默认 ${DEFAULTS.MAX_PENDING}
- UD_TTL_SEC        可选；默认 ${DEFAULTS.TTL_SEC}
`;
}

// ============================================================================
// ============================================================================
// 前端页面：共用样式 + 三个页面（上传 / 帮助 / 健康检查）
// 设计要点：移动优先、亮暗色自适应、分区卡片、一键复制、拖拽上传、上传进度
// ============================================================================

function baseCss(): string {
  return `
:root{
  --bg:#f5f7fb;--bg2:#eef1f8;--card:#ffffff;--line:rgba(15,23,42,.09);
  --fg:#0f172a;--muted:#5b6b85;--accent:#2563eb;--accent2:#0d9488;
  --ok:#0f9d58;--okbg:rgba(15,157,88,.09);--err:#dc2626;--errbg:rgba(220,38,38,.08);
  --shadow:0 10px 30px rgba(15,23,42,.07);--shadow2:0 2px 8px rgba(15,23,42,.05);
  --r:16px;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0a1120;--bg2:#0f1728;--card:rgba(20,28,45,.82);--line:rgba(255,255,255,.10);
    --fg:#e9eefb;--muted:#95a6c4;--accent:#5b9dff;--accent2:#2dd4bf;
    --ok:#34d399;--okbg:rgba(52,211,153,.10);--err:#f87171;--errbg:rgba(248,113,113,.10);
    --shadow:0 12px 40px rgba(0,0,0,.45);--shadow2:0 2px 10px rgba(0,0,0,.3);
  }
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
[hidden]{display:none!important}
html,body{margin:0;padding:0}
body{
  min-height:100dvh;color:var(--fg);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;
  font-size:15px;line-height:1.6;
  background:
    radial-gradient(1000px 500px at 12% -10%,rgba(37,99,235,.10),transparent 60%),
    radial-gradient(900px 500px at 95% 0%,rgba(13,148,136,.09),transparent 55%),
    var(--bg);
  background-attachment:fixed;
}
.wrap{max-width:980px;margin:0 auto;padding:clamp(16px,4vw,36px) clamp(14px,3.2vw,24px) 56px}

/* 顶部 */
.top{display:flex;flex-direction:column;gap:12px;margin-bottom:20px}
@media(min-width:720px){.top{flex-direction:row;align-items:center;justify-content:space-between}}
.brand{display:flex;align-items:center;gap:12px}
.logo{width:42px;height:42px;border-radius:12px;flex:0 0 auto;display:grid;place-items:center;
  background:linear-gradient(135deg,var(--accent),var(--accent2));box-shadow:0 6px 18px rgba(37,99,235,.28)}
.logo svg{width:22px;height:22px;display:block}
h1{margin:0;font-size:20px;font-weight:800;letter-spacing:.2px}
.sub{margin:2px 0 0;font-size:13px;color:var(--muted)}
.badges{display:flex;flex-wrap:wrap;gap:6px}
.badge{font-size:12px;padding:4px 10px;border-radius:999px;border:1px solid var(--line);
  background:var(--card);color:var(--muted);white-space:nowrap;box-shadow:var(--shadow2)}
.badge.warn{color:#b45309;border-color:rgba(180,83,9,.35);background:rgba(245,158,11,.10)}
@media (prefers-color-scheme:dark){.badge.warn{color:#fbbf24;border-color:rgba(251,191,36,.3)}}

/* 结果提示 */
.result{margin:0 0 18px;padding:16px;border-radius:var(--r);border:1px solid var(--line);
  background:var(--card);box-shadow:var(--shadow);animation:pop .22s ease}
.result.ok{border-color:rgba(15,157,88,.35);background:linear-gradient(180deg,var(--okbg),transparent)}
.result.err{border-color:rgba(220,38,38,.35);background:linear-gradient(180deg,var(--errbg),transparent)}
.result-title{font-weight:800;font-size:15px;margin-bottom:2px;display:flex;align-items:center;gap:8px}
.result-title .ico{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;
  font-size:11px;font-weight:800;color:#fff;flex:0 0 auto;line-height:1}
.result.ok .result-title .ico{background:var(--ok)}
.result.err .result-title .ico{background:var(--err)}
.result.ok .result-title{color:var(--ok)}
.result.err .result-title{color:var(--err)}
.result .hint{font-size:12.5px;color:var(--muted)}
@keyframes pop{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}

/* 卡片 */
.grid{display:grid;gap:16px}
@media(min-width:860px){.grid{grid-template-columns:1fr 1fr;align-items:start}}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);
  padding:18px;box-shadow:var(--shadow);backdrop-filter:blur(8px)}
.card h2{margin:0 0 4px;font-size:15px;font-weight:800;display:flex;align-items:center;gap:8px}
.card h2 .dot{width:8px;height:8px;border-radius:50%;background:var(--accent);flex:0 0 auto}
.card .desc{margin:0 0 14px;font-size:12.5px;color:var(--muted)}

/* 拖拽区 */
.drop{position:relative;display:block;border:2px dashed var(--line);border-radius:14px;
  padding:26px 14px;text-align:center;cursor:pointer;transition:border-color .18s,background .18s,transform .18s;
  background:var(--bg2)}
.drop:hover{border-color:var(--accent)}
.drop.over{border-color:var(--accent);background:rgba(37,99,235,.07);transform:scale(.995)}
.drop input[type=file]{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}
.drop .ico{width:38px;height:38px;margin:0 auto 8px;color:var(--accent);opacity:.9}
.drop .main{font-weight:700;font-size:14px}
.drop .tip{font-size:12px;color:var(--muted);margin-top:2px}
@media(max-width:520px){.drop{padding:20px 12px}.drop .ico{width:32px;height:32px;margin-bottom:6px}}
.fileinfo{display:flex;align-items:center;gap:10px;margin-top:12px;padding:10px 12px;border-radius:12px;
  background:var(--bg2);border:1px solid var(--line);font-size:13px}
.fileinfo .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.fileinfo .size{color:var(--muted);flex:0 0 auto}

/* 表单元素 */
.check{display:flex;align-items:center;gap:9px;margin:14px 0 0;font-size:13.5px;cursor:pointer;user-select:none;color:var(--fg)}
.check input{width:18px;height:18px;margin:0;accent-color:var(--accent);flex:0 0 auto}
.field{margin-top:12px}
.field label{display:block;font-size:12.5px;color:var(--muted);margin-bottom:6px}
input[type=text],textarea{width:100%;font:inherit;color:var(--fg);background:var(--bg2);
  border:1px solid var(--line);border-radius:12px;padding:11px 13px;outline:none;transition:border-color .15s,box-shadow .15s}
input[type=text]:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(37,99,235,.14)}
textarea{min-height:132px;resize:vertical;line-height:1.55}

.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;width:100%;
  font:inherit;font-weight:700;font-size:15px;padding:13px 18px;border-radius:12px;border:0;
  cursor:pointer;transition:transform .12s,box-shadow .2s,opacity .2s;margin-top:14px}
.btn.primary{color:#fff;background:linear-gradient(135deg,var(--accent),var(--accent2));
  box-shadow:0 8px 22px rgba(37,99,235,.26)}
.btn.primary:hover{transform:translateY(-1px)}
.btn.ghost{background:var(--bg2);color:var(--fg);border:1px solid var(--line)}
.btn:disabled{opacity:.45;cursor:not-allowed;transform:none;box-shadow:none}
.btn.small{width:auto;margin:0;padding:10px 14px;font-size:13.5px;border-radius:10px}

/* 进度条 */
.prog{margin-top:12px;height:8px;border-radius:999px;background:var(--bg2);overflow:hidden;border:1px solid var(--line)}
.prog .bar{height:100%;width:0%;border-radius:999px;background:linear-gradient(90deg,var(--accent),var(--accent2));
  transition:width .18s ease}
.prog-text{font-size:12px;color:var(--muted);margin-top:6px;text-align:center}

/* 链接行 */
.linkrow{display:flex;gap:8px;margin-top:10px}
.linkrow input{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}
.copybtn{flex:0 0 auto;width:auto;margin:0;padding:0 16px;font-size:14px;font-weight:700;border-radius:12px;
  border:1px solid var(--line);background:var(--bg2);color:var(--fg);cursor:pointer;transition:.15s;white-space:nowrap}
.copybtn:hover{border-color:var(--accent);color:var(--accent)}
.copybtn.done{background:var(--okbg);color:var(--ok);border-color:rgba(15,157,88,.4)}

/* 页脚 */
footer{margin-top:26px;padding-top:16px;border-top:1px solid var(--line);
  display:flex;flex-wrap:wrap;gap:14px;font-size:13px;color:var(--muted)}
footer a{color:var(--accent);text-decoration:none}
footer a:hover{text-decoration:underline}

/* 统计格子 */
.tiles{display:grid;gap:12px;margin-top:16px}
@media(min-width:640px){.tiles{grid-template-columns:repeat(2,1fr)}}
.tile{border:1px solid var(--line);border-radius:14px;padding:14px;background:var(--bg2)}
.tile h3{margin:0 0 4px;font-size:12.5px;font-weight:600;color:var(--muted)}
.tile .val{font-size:22px;font-weight:800;letter-spacing:.3px}
.tile .note{font-size:12px;color:var(--muted);margin-top:2px}
pre.code{margin:14px 0 0;padding:14px;border-radius:12px;background:var(--bg2);border:1px solid var(--line);
  overflow:auto;font-size:12.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}

/* 步骤 */
.steps{counter-reset:s;display:grid;gap:12px;margin-top:14px}
.step{position:relative;padding-left:38px;font-size:13.5px;line-height:1.55}
.step::before{counter-increment:s;content:counter(s);position:absolute;left:0;top:-2px;width:24px;height:24px;
  border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:800;color:#fff;
  background:linear-gradient(135deg,var(--accent),var(--accent2))}
.step .t{font-weight:700;display:block;margin-bottom:2px}
.step .d{color:var(--muted);font-size:12.5px}
.step code,.kv code{background:var(--bg2);border:1px solid var(--line);padding:1px 6px;border-radius:6px;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;word-break:break-all}

/* 表格 */
.tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch;margin-top:14px;border-radius:12px;
  border:1px solid var(--line);background:var(--bg2)}
table.api{width:100%;border-collapse:collapse;font-size:13px;min-width:560px}
table.api th,table.api td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}
table.api th{font-weight:700;font-size:12px;color:var(--muted);white-space:nowrap;letter-spacing:.3px}
table.api tr:last-child td{border-bottom:0}
table.api td.m{white-space:nowrap;font-weight:800;font-size:12px;color:var(--accent);
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
table.api td.p{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;
  word-break:break-all;color:var(--fg)}
table.api td.n{color:var(--muted);font-size:12.5px}
/* 窄屏：表格改为堆叠卡片，避免横向滚动 */
@media(max-width:600px){
  .tablewrap{border:0;background:transparent;overflow:visible}
  table.api{min-width:0;display:block}
  table.api thead{display:none}
  table.api tbody{display:block}
  table.api tr{display:block;border:1px solid var(--line);border-radius:12px;background:var(--bg2);
    padding:10px 12px;margin-bottom:10px}
  table.api td{display:block;border:0;padding:0}
  table.api td.m{display:inline-block;margin-right:8px;vertical-align:top}
  table.api td.p{display:inline;vertical-align:top}
  table.api td.n{display:block;margin-top:6px}
}

/* 代码块 + 复制 */
.codeblock{position:relative;margin-top:12px}
.codeblock pre{margin:0;padding:12px 78px 12px 14px;border-radius:12px;background:var(--bg2);
  border:1px solid var(--line);overflow-x:auto;font-size:12.5px;line-height:1.65;white-space:pre-wrap;
  word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--fg)}
.codeblock .copybtn{position:absolute;top:8px;right:8px;padding:5px 10px;font-size:12px;border-radius:8px}
.exlabel{font-size:12.5px;font-weight:700;color:var(--fg);margin:16px 0 -4px}
.exlabel:first-of-type{margin-top:6px}

/* 规则列表 */
.kv{list-style:none;padding:0;margin:14px 0 0;display:grid;gap:9px}
.kv li{display:flex;gap:12px;font-size:13.5px;line-height:1.55;align-items:baseline}
.kv li .k{flex:0 0 auto;font-weight:700;min-width:104px}
.kv li .v{color:var(--muted);min-width:0}
@media(max-width:560px){.kv li{flex-direction:column;gap:1px}.kv li .k{min-width:0}}
`;
}

function pageShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<meta name="color-scheme" content="light dark"/>
<meta name="theme-color" media="(prefers-color-scheme:light)" content="#f5f7fb"/>
<meta name="theme-color" media="(prefers-color-scheme:dark)" content="#0a1120"/>
<meta name="robots" content="noindex,nofollow"/>
<title>${escapeHtml(title)}</title>
<style>${baseCss()}</style>
</head><body>
${body}
</body></html>`;
}

function logoMark(): string {
  return `<div class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg></div>`;
}

function resultBlock(message: string, ok: boolean, link: string): string {
  if (!message) return "";
  const linkHtml = link
    ? `<div class="linkrow">
        <input type="text" readonly value="${escapeHtml(link)}" onclick="this.select()"/>
        <button type="button" class="copybtn" data-copy="${escapeHtml(link)}">复制</button>
      </div>
      <div class="hint" style="margin-top:8px">下载一次后失效；支持多线程 / 断点续传，中途断开不算消耗。</div>`
    : "";
  return `<div id="result" class="result ${ok ? "ok" : "err"}">
    <div class="result-title"><span class="ico">${ok ? "✓" : "!"}</span><span class="txt">${escapeHtml(message)}</span></div>
    ${linkHtml}
  </div>`;
}

function udHtml(origin: string, env: Env, message = "", ok = true, link = ""): string {
  const c = cfg(env);
  const bp = basePath(env);
  const base = origin + (bp || "");
  const needKey = c.REQUIRE_KEY;

  const keyField = needKey
    ? `<div class="field"><label for="keyInput">Key（必填）</label>
       <input id="keyInput" type="text" name="key" autocomplete="off" placeholder="填写上传密钥"/></div>`
    : "";

  const body = `<div class="wrap">
  <header class="top">
    <div class="brand">
      ${logoMark()}
      <div>
        <h1>UD Relay</h1>
        <p class="sub">一次性文件中转 · 完整下载一次后失效</p>
      </div>
    </div>
    <div class="badges">
      <span class="badge ${needKey ? "warn" : ""}">${needKey ? "需要 Key" : "无需 Key"}</span>
      <span class="badge">最大 ${c.MAX_MB}MB</span>
      <span class="badge">TTL ${Math.round(c.TTL_SEC / 3600)}h</span>
      <span class="badge">限速 ${c.RATE_LIMIT_SEC}s/次</span>
    </div>
  </header>

  ${resultBlock(message, ok, link)}

  <main class="grid">
    <section class="card">
      <h2><span class="dot"></span>上传文件</h2>
      <p class="desc">点击选择，或把文件拖到这里</p>
      <form id="upForm" action="${base}/ud" method="post" enctype="multipart/form-data">
        <label class="drop" id="drop">
          <input type="file" name="file" id="fileInput" required/>
          <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 9l5-5 5 5"/><path d="M12 4v12"/></svg>
          <div class="main">选择文件</div>
          <div class="tip">单个文件 · 不超过 ${c.MAX_MB}MB</div>
        </label>
        <div class="fileinfo" id="fileInfo" hidden>
          <span class="name" id="fileName"></span>
          <span class="size" id="fileSize"></span>
        </div>
        ${keyField}
        <label class="check"><input type="checkbox" name="short" value="1" id="shortFile"/>生成短链接（三位数字，好记但可能被猜到）</label>
        <button class="btn primary" type="submit" id="btnUpload">开始上传</button>
        <div class="prog" id="prog" hidden><div class="bar" id="progBar"></div></div>
        <div class="prog-text" id="progText" hidden></div>
      </form>
    </section>

    <section class="card">
      <h2><span class="dot"></span>发送文本</h2>
      <p class="desc">直接贴一段文字，保存为 txt</p>
      <textarea id="rawText" placeholder="在这里输入要传的文本…"></textarea>
      ${needKey ? `<div class="field"><label for="rawKey">Key（必填）</label>
        <input id="rawKey" type="text" autocomplete="off" placeholder="填写上传密钥"/></div>` : ""}
      <label class="check"><input type="checkbox" id="shortText"/>生成短链接（三位数字）</label>
      <button class="btn ghost" type="button" id="btnText">发送文本</button>
    </section>
  </main>

  <footer>
    <a href="${base}/hp">使用说明</a>
    <a href="${base}/hc">健康检查</a>
    <span style="margin-left:auto">下载即失效 · 预览/预取不会消耗</span>
  </footer>
</div>
<script>
(function(){
  var BASE = ${JSON.stringify(base)};
  var NEED_KEY = ${needKey ? "true" : "false"};
  var $ = function(id){ return document.getElementById(id); };
  var curFile = null;

  function fmt(n){
    if(!n && n !== 0) return '';
    if(n < 1024) return n + ' B';
    var u = ['KB','MB','GB'], i = -1;
    do { n = n / 1024; i++; } while(n >= 1024 && i < u.length - 1);
    return n.toFixed(1) + ' ' + u[i];
  }

  function ensureResult(){
    var box = $('result');
    if(box) return box;
    box = document.createElement('div');
    box.id = 'result';
    box.className = 'result ok';
    box.innerHTML = '<div class="result-title"><span class="ico"></span><span class="txt"></span></div>';
    var wrap = document.querySelector('.wrap');
    var head = wrap.querySelector('header');
    if(head && head.nextSibling) wrap.insertBefore(box, head.nextSibling);
    else wrap.insertBefore(box, wrap.firstChild);
    return box;
  }

  function toast(ok, title, url){
    var box = ensureResult();
    box.className = 'result ' + (ok ? 'ok' : 'err');
    box.querySelector('.ico').textContent = ok ? '✓' : '!';
    box.querySelector('.txt').textContent = title;
    var row = box.querySelector('.linkrow');
    if(url){
      if(!row){
        row = document.createElement('div');
        row.className = 'linkrow';
        row.innerHTML = '<input type="text" readonly onclick="this.select()"/><button type="button" class="copybtn">复制</button>';
        box.appendChild(row);
        var hint = document.createElement('div');
        hint.className = 'hint';
        hint.style.marginTop = '8px';
        hint.textContent = '下载一次后失效；支持多线程 / 断点续传，中途断开不算消耗。';
        box.appendChild(hint);
      }
      row.querySelector('input').value = url;
      row.querySelector('.copybtn').setAttribute('data-copy', url);
      row.hidden = false;
    } else if(row){ row.hidden = true; }
    box.hidden = false;
    box.scrollIntoView({behavior:'smooth', block:'nearest'});
  }

  function copyText(text, btn){
    var done = function(){
      var old = btn.textContent;
      btn.textContent = '已复制 ✓'; btn.classList.add('done');
      setTimeout(function(){ btn.textContent = old; btn.classList.remove('done'); }, 1500);
    };
    var fallback = function(){
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch(e) {}
      document.body.removeChild(ta);
    };
    if(navigator.clipboard && window.isSecureContext){
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else { fallback(); }
  }

  document.addEventListener('click', function(e){
    var b = e.target.closest ? e.target.closest('.copybtn') : null;
    if(b){ copyText(b.getAttribute('data-copy') || '', b); }
  });

  function setProg(pct, text){
    var p = $('prog'), bar = $('progBar'), t = $('progText');
    if(pct === null){ p.hidden = true; t.hidden = true; return; }
    p.hidden = false; t.hidden = false;
    bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
    t.textContent = text || (Math.round(pct) + '%');
  }

  function parseUrl(text){
    var lines = (text || '').trim().split('\\n');
    var last = lines[lines.length - 1] || '';
    return /^https?:\\/\\//.test(last) ? last : '';
  }

  function errMsg(status){
    if(status === 401) return 'Key 错误或缺失';
    if(status === 429) return '上传太频繁，稍等几秒再试';
    if(status === 413) return '文件超出大小限制';
    if(status === 400) return '请求格式不对';
    return '上传失败（HTTP ' + status + '）';
  }

  // ---- 文件选择 ----
  var fi = $('fileInput'), drop = $('drop');
  if(fi){
    fi.addEventListener('change', function(){
      curFile = fi.files && fi.files[0] ? fi.files[0] : null;
      if(curFile){
        $('fileInfo').hidden = false;
        $('fileName').textContent = curFile.name;
        $('fileSize').textContent = fmt(curFile.size);
      } else {
        $('fileInfo').hidden = true;
      }
    });
  }
  if(drop){
    ['dragenter','dragover'].forEach(function(ev){
      drop.addEventListener(ev, function(e){ e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave','dragend'].forEach(function(ev){
      drop.addEventListener(ev, function(){ drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function(e){
      e.preventDefault(); drop.classList.remove('over');
      if(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]){
        try { fi.files = e.dataTransfer.files; } catch(err) {}
        curFile = e.dataTransfer.files[0];
        $('fileInfo').hidden = false;
        $('fileName').textContent = curFile.name;
        $('fileSize').textContent = fmt(curFile.size);
      }
    });
  }

  // ---- 上传文件 ----
  var form = $('upForm');
  if(form){
    form.addEventListener('submit', function(e){
      if(!window.FormData || !window.XMLHttpRequest) return; // 交给浏览器原生提交
      e.preventDefault();
      var f = curFile || (fi.files && fi.files[0]);
      if(!f){ toast(false, '请先选择文件', ''); return; }
      if(f.size > ${c.MAX_MB} * 1024 * 1024){ toast(false, '文件超过 ${c.MAX_MB}MB', ''); return; }
      if(NEED_KEY && !($('keyInput') && $('keyInput').value.trim())){ toast(false, '请填写 Key', ''); return; }

      var fd = new FormData();
      fd.append('file', f);
      if($('keyInput')) fd.append('key', $('keyInput').value.trim());
      if($('shortFile') && $('shortFile').checked) fd.append('short', '1');

      var btn = $('btnUpload');
      btn.disabled = true; btn.textContent = '上传中…';
      setProg(0, '准备上传…');

      var xhr = new XMLHttpRequest();
      xhr.open('POST', BASE + '/ud' + ($('shortFile') && $('shortFile').checked ? '?short=1' : ''));
      xhr.upload.onprogress = function(ev){
        if(ev.lengthComputable){
          var pct = ev.loaded / ev.total * 100;
          setProg(pct, fmt(ev.loaded) + ' / ' + fmt(ev.total));
        }
      };
      xhr.onload = function(){
        btn.disabled = false; btn.textContent = '开始上传';
        setProg(null);
        var url = parseUrl(xhr.responseText);
        if(xhr.status >= 200 && xhr.status < 300 && url){ toast(true, '上传成功', url); }
        else { toast(false, errMsg(xhr.status), ''); }
      };
      xhr.onerror = function(){
        btn.disabled = false; btn.textContent = '开始上传';
        setProg(null);
        toast(false, '网络错误，请重试', '');
      };
      xhr.send(fd);
    });
  }

  // ---- 发送文本 ----
  var btnText = $('btnText');
  if(btnText){
    btnText.addEventListener('click', function(){
      var txt = ($('rawText').value || '').trim();
      if(!txt){ toast(false, '请输入文本内容', ''); return; }
      if(NEED_KEY && !($('rawKey') && $('rawKey').value.trim())){ toast(false, '请填写 Key', ''); return; }
      var headers = { 'Content-Type': 'text/plain; charset=utf-8' };
      if($('rawKey') && $('rawKey').value.trim()) headers['X-API-Key'] = $('rawKey').value.trim();
      btnText.disabled = true; btnText.textContent = '发送中…';
      fetch(BASE + '/ud' + ($('shortText') && $('shortText').checked ? '?short=1' : ''), {
        method: 'POST', headers: headers, body: txt
      }).then(function(r){
        return r.text().then(function(t){ return { s: r.status, t: t }; });
      }).then(function(res){
        btnText.disabled = false; btnText.textContent = '发送文本';
        var url = parseUrl(res.t);
        if(res.s >= 200 && res.s < 300 && url){ toast(true, '发送成功', url); }
        else { toast(false, errMsg(res.s), ''); }
      }).catch(function(){
        btnText.disabled = false; btnText.textContent = '发送文本';
        toast(false, '网络错误，请重试', '');
      });
    });
  }
})();
</script>`;

  return pageShell("UD Relay · 一次性文件中转", body);
}

function codeBlock(cmd: string): string {
  return `<div class="codeblock"><pre>${escapeHtml(cmd)}</pre><button type="button" class="copybtn" data-copy="${escapeHtml(cmd)}">复制</button></div>`;
}

// 只做"复制按钮"的轻量脚本，帮助页/健康页复用
function copyScript(): string {
  return `<script>
(function(){
  function done(b){var o=b.textContent;b.textContent='已复制 ✓';b.classList.add('done');setTimeout(function(){b.textContent=o;b.classList.remove('done')},1500)}
  function fb(t,b){var ta=document.createElement('textarea');ta.value=t;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();try{document.execCommand('copy');done(b)}catch(e){}document.body.removeChild(ta)}
  document.addEventListener('click',function(e){
    var b=e.target.closest?e.target.closest('.copybtn'):null;
    if(!b)return;
    var t=b.getAttribute('data-copy')||'';
    if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(t).then(function(){done(b)}).catch(function(){fb(t,b)})}
    else{fb(t,b)}
  });
})();
</script>`;
}

function helpPageHtml(origin: string, env: Env): string {
  const c = cfg(env);
  const bp = basePath(env);
  const base = origin + (bp || "");
  const keyNote = c.REQUIRE_KEY ? "（本实例需要 Key，示例里用 YOUR_KEY 占位）" : "";

  const p = (s: string) => `${bp || ""}${s}`;
  const apiRows = [
    ["GET", p("/ud"), "浏览器上传页；命令行访问返回纯文本说明"],
    ["POST", p("/ud"), "multipart/form-data 上传，字段名 <code>file</code>"],
    ["POST", p("/ud"), "text/plain 直传文本，保存为 &lt;时间戳&gt;.txt"],
    ["PUT", p("/ud"), "裸流直传，文件名取自 <code>name</code> / <code>X-Filename</code>"],
    ["GET", p("/ud/f/&lt;token&gt;/&lt;文件名&gt;"), "下载（一次性）"],
    ["GET", p("/s/&lt;三位数字&gt;"), "短链接下载（上传时加 <code>short=1</code>）"],
    ["GET", p("/hc"), "健康检查 JSON；<code>?full=1</code> 强制重算 R2 用量"],
    ["GET", p("/hp"), "本页"],
  ]
    .map(([m, path, n]) => `<tr><td class="m">${m}</td><td class="p">${path}</td><td class="n">${n}</td></tr>`)
    .join("");

  const body = `<div class="wrap">
  <header class="top">
    <div class="brand">
      ${logoMark()}
      <div>
        <h1>使用说明</h1>
        <p class="sub">UD Relay · 一次性文件中转</p>
      </div>
    </div>
    <div class="badges">
      <span class="badge ${c.REQUIRE_KEY ? "warn" : ""}">${c.REQUIRE_KEY ? "需要 Key" : "无需 Key"}</span>
      <span class="badge">最大 ${c.MAX_MB}MB</span>
      <span class="badge">TTL ${Math.round(c.TTL_SEC / 3600)}h</span>
    </div>
  </header>

  <section class="card">
    <h2><span class="dot"></span>三步上手</h2>
    <div class="steps">
      <div class="step"><span class="t">打开上传页，选文件</span>
        <span class="d">点击虚线框或把文件拖进去，也可以直接发送一段文本。</span></div>
      <div class="step"><span class="t">拿到一次性链接</span>
        <span class="d">默认是长链接；勾选「生成短链接」则得到 <code>/s/123</code> 这种三位数字短码。</span></div>
      <div class="step"><span class="t">发出去，下载一次即失效</span>
        <span class="d">对方完整下载一次后链接自动作废；预览卡片、断点续传、多线程下载都不会误伤。</span></div>
    </div>
  </section>

  <section class="card">
    <h2><span class="dot"></span>接口一览</h2>
    <p class="desc">基地址 <code style="word-break:break-all">${base}</code>，除下列路径外其余一律返回空 404</p>
    <div class="tablewrap">
      <table class="api">
        <thead><tr><th>方法</th><th>路径</th><th>说明</th></tr></thead>
        <tbody>${apiRows}</tbody>
      </table>
    </div>
  </section>

  <section class="card">
    <h2><span class="dot"></span>命令行示例</h2>
    <p class="desc">点右上角「复制」直接拿走 ${keyNote}</p>
    <div class="exlabel">上传文件</div>
    ${codeBlock(`curl -sS -F "file=@/path/to/file" "${base}/ud"`)}
    <div class="exlabel">上传并生成短链接</div>
    ${codeBlock(`curl -sS -F "file=@/path/to/file" "${base}/ud?short=1"`)}
    <div class="exlabel">裸流直传（保留原文件名）</div>
    ${codeBlock(`curl -sS -T "/path/to/file" "${base}/ud?name=filename.ext"`)}
    <div class="exlabel">直接发送文本</div>
    ${codeBlock(`curl -sS -d "hello" "${base}/ud"`)}
    <div class="exlabel">下载（自动用服务端文件名）</div>
    ${codeBlock(`curl -O -J "<下载链接>"`)}
    <div class="exlabel">断点续传</div>
    ${codeBlock(`curl -C - -O -J "<下载链接>"`)}
    <div class="exlabel">健康检查</div>
    ${codeBlock(`curl -sS "${base}/hc"`)}
  </section>

  <section class="card">
    <h2><span class="dot"></span>规则与限制</h2>
    <ul class="kv">
      <li><span class="k">单文件上限</span><span class="v">${c.MAX_MB} MB</span></li>
      <li><span class="k">上传频率</span><span class="v">同一 IP 每 ${c.RATE_LIMIT_SEC} 秒 1 次${c.RATE_LIMIT_SEC === 0 ? "（已关闭）" : ""}</span></li>
      <li><span class="k">待下载上限</span><span class="v">${c.MAX_PENDING} 份${c.MAX_PENDING === 0 ? "（已关闭）" : "，超出从最旧的开始淘汰"}</span></li>
      <li><span class="k">链接有效期</span><span class="v">${c.TTL_SEC} 秒${c.TTL_SEC === 0 ? "（永不过期）" : "（约 " + Math.round(c.TTL_SEC / 3600) + " 小时）"}</span></li>
      <li><span class="k">上传鉴权</span><span class="v">${c.REQUIRE_KEY ? "需要 Key（UD_API_KEY 已配置）" : "无需 Key"}</span></li>
      <li><span class="k">一次性判定</span><span class="v">整份文件完整传完才失效；中途断开可以重新下载</span></li>
      <li><span class="k">多线程 / 续传</span><span class="v">支持 Range，多段拼接覆盖完整才算下载成功</span></li>
      <li><span class="k">预览保护</span><span class="v">HEAD、Range 探测、链接预览机器人、浏览器预取都不会消耗链接</span></li>
      <li><span class="k">同名覆盖</span><span class="v">同一文件名再次上传会覆盖并删除旧对象</span></li>
      <li><span class="k">短链接风险</span><span class="v">三位数字可枚举，勿用于敏感文件；同一 IP 每 ${SHORT_FAIL_WINDOW} 秒猜错超过 ${SHORT_FAIL_LIMIT} 次返回 429</span></li>
    </ul>
  </section>

  <section class="card">
    <h2><span class="dot"></span>环境变量</h2>
    <div class="tablewrap">
      <table class="api">
        <thead><tr><th>变量</th><th>默认</th><th>说明</th></tr></thead>
        <tbody>
          <tr><td class="p">UD_API_KEY</td><td class="n">未设置</td><td class="n">设置后上传需提供 key（secret）</td></tr>
          <tr><td class="p">UD_BASE_PATH</td><td class="n">空</td><td class="n">子路径前缀，如 <code>/re</code></td></tr>
          <tr><td class="p">UD_MAX_MB</td><td class="n">${DEFAULTS.MAX_MB}</td><td class="n">单文件大小上限（MB）</td></tr>
          <tr><td class="p">UD_RATE_LIMIT_SEC</td><td class="n">${DEFAULTS.RATE_LIMIT_SEC}</td><td class="n">同 IP 上传间隔（秒），0 关闭</td></tr>
          <tr><td class="p">UD_MAX_PENDING</td><td class="n">${DEFAULTS.MAX_PENDING}</td><td class="n">待下载文件数上限，0 关闭</td></tr>
          <tr><td class="p">UD_TTL_SEC</td><td class="n">${DEFAULTS.TTL_SEC}</td><td class="n">链接有效期（秒），0 关闭</td></tr>
        </tbody>
      </table>
    </div>
  </section>

  <footer>
    <a href="${base}/ud">返回上传页</a>
    <a href="${base}/hc">健康检查</a>
    <span style="margin-left:auto">下载即失效 · 预览/预取不会消耗</span>
  </footer>
</div>
${copyScript()}`;
  return pageShell("UD Relay · 使用说明", body);
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

  const body = `<div class="wrap">
  <header class="top">
    <div class="brand">
      ${logoMark()}
      <div>
        <h1>健康检查</h1>
        <p class="sub">UD Relay · 运行状态</p>
      </div>
    </div>
    <div class="badges"><span class="badge">ok</span></div>
  </header>

  <section class="card">
    <div class="tiles">
      <div class="tile"><h3>调用次数</h3><div class="val">${fmtNum(stats.hc_calls)}</div><div class="note">hc 自部署以来累计</div></div>
      <div class="tile"><h3>待下载文件</h3><div class="val">${fmtNum(stats.pending_tokens)}</div><div class="note">尚未被消费的一次性链接</div></div>
      <div class="tile"><h3>待下载体积</h3><div class="val">${fmtBytes(stats.pending_bytes)}</div><div class="note">元数据 size 汇总</div></div>
      <div class="tile"><h3>R2 对象 / 存储</h3><div class="val">${fmtNum(stats.r2_objects)}</div><div class="note">${fmtBytes(stats.r2_bytes)}</div></div>
    </div>
    <pre class="code">${escapeHtml(JSON.stringify(stats, null, 2))}</pre>
  </section>

  <footer>
    <a href="${base}/ud">上传页</a>
    <a href="${base}/hp">使用说明</a>
  </footer>
</div>`;
  return pageShell("UD Relay · 健康检查", body);
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
      return new Response(helpPageHtml(url.origin, env), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
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
