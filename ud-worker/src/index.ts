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
};

const DEFAULTS = {
  MAX_MB: 50,
  RATE_LIMIT_SEC: 10,
  MAX_PENDING: 10,
  TTL_SEC: 24 * 3600,
};

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
- 下载一次性：token 在 claim 成功后立即标记为已领取

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
  <div class="row">
    <button type="submit">立即上传</button>
    <div class="muted">最大 ${c.MAX_MB}MB；单 IP ${c.RATE_LIMIT_SEC}s 1 次；待下载最多 ${c.MAX_PENDING} 份；TTL ${c.TTL_SEC}s。</div>
  </div>
</form>

${msgBlock}

<div class="section">
  <div class="section-title">curl 示例</div>
  <pre class="code">${curlMultipart}
${curlPut}
${curlText}</pre>
</div>

<div class="muted" style="margin-top:14px;">帮助：<a href="${base}/hp">${base}/hp</a></div>
<div class="muted">健康检查：<a href="${base}/hc">${base}/hc</a></div>
</div></div></body></html>`;
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
      let hcCount = -1;
      let pendingTokens = 0;
      let pendingBytes = 0;
      try {
        const metaResp = await callStateDO(env, { op: "hc" });
        if (metaResp.ok) {
          const meta = (await metaResp.json()) as { hcCount: number; pendingTokens: number; pendingBytes: number };
          hcCount = meta.hcCount ?? -1;
          pendingTokens = meta.pendingTokens ?? 0;
          pendingBytes = meta.pendingBytes ?? 0;
        }
      } catch {}

      let usage: { objects: number; bytes: number } | null = null;
      try {
        usage = await bucketUsage(env.UD_BUCKET);
      } catch {}

      const body = {
        ok: true,
        ts: nowSec(),
        hc_calls: hcCount,
        pending_tokens: pendingTokens,
        pending_bytes: pendingBytes,
        r2_objects: usage?.objects ?? -1,
        r2_bytes: usage?.bytes ?? -1,
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

      const dlPath = withBase(`/ud/f/${encodeURIComponent(token)}/${encodeURIComponent(filename)}`, env);
      const dlUrl = `${url.origin}${dlPath}`;

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

      const dlPath = withBase(`/ud/f/${encodeURIComponent(token)}/${encodeURIComponent(filename)}`, env);
      const dlUrl = `${url.origin}${dlPath}`;

      if (isBrowser(request)) {
        return new Response(udHtml(url.origin, env, "上传成功！", true, dlUrl), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return new Response(`OK\n${dlUrl}\n`, { status: 201, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    // /ud/f/<token>/<filename>
    if (path.startsWith("/ud/f/") && request.method === "GET") {
      // path: /ud/f/<token>/<filename...>
      const parts = path.split("/").filter(Boolean); // ["ud","f",token,filename...]
      if (parts.length < 4) return empty404();
      let token = "";
      let rawName = "";
      try {
        token = decodeURIComponent(parts[2] || "");
        rawName = decodeURIComponent(parts.slice(3).join("/")); // should not contain "/" normally
      } catch {
        return empty404();
      }
      const filename = sanitizeFilename(rawName);

      if (!token || !filename) return empty404();

      const ip = getClientIp(request);

      // claim once from DO (mark claimed immediately)
      const claimResp = await callStateDO(env, { op: "claim", token, filename, ip });
      if (!claimResp.ok) return empty404();
      const claim = (await claimResp.json()) as { objectKey: string; filename: string; contentType: string };

      // get object
      const obj = await env.UD_BUCKET.get(claim.objectKey);
      if (!obj || !obj.body) {
        // finalize anyway (token already claimed) to avoid dangling meta
        ctx.waitUntil(callStateDO(env, { op: "finalize", token }).catch(() => undefined));
        return empty404();
      }

      // build response headers
      const h = new Headers();
      h.set("Content-Type", claim.contentType || "application/octet-stream");
      h.set("Content-Disposition", contentDisposition(claim.filename));
      noStoreHeaders(h);

      // stream response; after response completes, delete object + finalize meta
      ctx.waitUntil(
        (async () => {
          try {
            await env.UD_BUCKET.delete(claim.objectKey);
          } catch {}
          try {
            await callStateDO(env, { op: "finalize", token });
          } catch {}
        })()
      );

      return new Response(obj.body, { status: 200, headers: h });
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
        await this.save(data);
        return Response.json({
          hcCount: data.metrics.hcCount,
          pendingTokens: pending.length,
          pendingBytes,
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

        const token = newToken();
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

      if (op === "claim") {
        const token = String(body?.token || "");
        const filename = sanitizeFilename(String(body?.filename || ""));
        const meta = data.tokens[token];
        if (!meta) return new Response("", { status: 404 });
        if (meta.status !== "ready") return new Response("", { status: 404 });
        if (meta.filename !== filename) return new Response("", { status: 404 });

        const t = nowSec();
        if (meta.expiresAt > 0 && meta.expiresAt < t) {
          // expired
          delete data.tokens[token];
          if (data.byName[meta.filename] === token) delete data.byName[meta.filename];
          data.queue = data.queue.filter((x) => x !== token);
          deleteKeys.push(meta.objectKey);
          await this.save(data);
          return new Response("", { status: 404 });
        }

        // mark claimed immediately => one-time
        meta.status = "claimed";
        data.tokens[token] = meta;
        await this.save(data);

        return Response.json({
          objectKey: meta.objectKey,
          filename: meta.filename,
          contentType: meta.contentType || "application/octet-stream",
        });
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
