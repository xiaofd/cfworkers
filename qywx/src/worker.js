/**
 * Cloudflare Worker：企业微信群机器人 Webhook 网关。
 * 通过机器人 Webhook key/URL 转发消息，支持 Token 校验、多种消息类型，并提供上传文件获取 media_id 的代理。
 *
 * 环境变量：
 * - WEBHOOK_URL：完整群机器人 URL（可选）
 * - QYWX_ROBOT_KEY：机器人 key，若未提供 WEBHOOK_URL 则自动拼接
 * - ALLOW_TOKENS：可选，逗号分隔。Authorization Bearer 或 ?token / ?access_token。
 */
export default {
  /**
   * @param {Request} request
   * @param {Record<string, string>} env
   */
  async fetch(request, env) {
    // 处理 CORS 预检
    if (request.method === "OPTIONS") {
      return corsResponse(new Response(null, { status: 204 }));
    }
    const contentType = request.headers.get("Content-Type") || "";
    const isMultipart = contentType.toLowerCase().includes("multipart/form-data");
    const url = new URL(request.url);

    // Token 校验
    const allowedTokens = parseTokens(env.ALLOW_TOKENS || "");
    const token = extractToken(request);
    if (allowedTokens.length > 0 && !allowedTokens.includes(token || "")) {
      return corsResponse(jsonResponse({ error: "未授权" }, 401));
    }

    // 上传并发送文件：直接使用 multipart/form-data
    if (isMultipart) {
      return handleUploadAndSend(request, env);
    }

    if (request.method !== "POST") {
      return corsResponse(jsonResponse({ error: "仅支持 POST JSON 请求" }, 405));
    }

    let input;
    if (contentType.toLowerCase().includes("application/json")) {
      try {
        input = await request.json();
      } catch (err) {
        return corsResponse(jsonResponse({ error: "JSON 解析失败" }, 400));
      }
    } else {
      // 简化调用：纯文本 body，type 可在 query 参数指定（默认 text，可设 type=markdown）
      const textBody = await request.text();
      const simpleType = (url.searchParams.get("type") || "text").toLowerCase();
      input = { type: simpleType, content: textBody };
    }

    // 若为 image 且未提供 md5，则自动计算
    if (
      input &&
      typeof input === "object" &&
      (input.type || "").toLowerCase() === "image" &&
      input.base64 &&
      !input.md5
    ) {
      try {
        input.md5 = await md5FromBase64(input.base64);
      } catch (err) {
        return corsResponse(
          jsonResponse({ error: "计算图片 md5 失败", detail: err.message }, 400)
        );
      }
    }

    let payload;
    try {
      payload = buildRobotPayload(input);
    } catch (err) {
      return corsResponse(jsonResponse({ error: err.message }, 400));
    }

    const webhook = buildWebhook(env);
    if (!webhook) {
      return corsResponse(
        jsonResponse(
          { error: "缺少 WEBHOOK_URL 或 QYWX_ROBOT_KEY 环境变量" },
          500
        )
      );
    }

    const upstream = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    let upstreamBody = {};
    try {
      upstreamBody = await upstream.json();
    } catch (err) {
      // ignore parse error
    }

    const ok =
      upstream.ok && typeof upstreamBody.errcode === "number"
        ? upstreamBody.errcode === 0
        : upstream.ok;

    const status = ok ? 200 : 502;
    return corsResponse(
      jsonResponse(
        {
          ok,
          upstream_status: upstream.status,
          errcode: upstreamBody.errcode,
          errmsg: upstreamBody.errmsg || upstream.statusText,
        },
        status
      )
    );
  },
};

/**
 * 上传文件到机器人并立即发送 file 或 image 消息（multipart/form-data，字段 file；可选 type=image）
 */
async function handleUploadAndSend(request, env) {
  if (request.method !== "POST") {
    return corsResponse(jsonResponse({ error: "仅支持 POST 上传" }, 405));
  }

  const key = getRobotKey(env);
  const webhook = buildWebhook(env);
  if (!key || !webhook) {
    return corsResponse(
      jsonResponse({ error: "缺少 WEBHOOK_URL 或 QYWX_ROBOT_KEY，无法上传/发送" }, 500)
    );
  }

  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return corsResponse(
      jsonResponse({ error: "上传需使用 multipart/form-data，字段名 file" }, 400)
    );
  }

  let form;
  try {
    form = await request.formData();
  } catch (err) {
    return corsResponse(jsonResponse({ error: "解析表单失败" }, 400));
  }
  const file = form.get("file") || form.get("media");
  if (!(file instanceof File)) {
    return corsResponse(jsonResponse({ error: "缺少 file/media 字段" }, 400));
  }
  const kind = (form.get("type") || form.get("msgtype") || "file").toLowerCase();

  if (kind === "image") {
    return handleImageFromFile(file, webhook);
  }
  return handleFileUploadThenSend(file, key, webhook);
}

/**
 * 拼接群机器人 Webhook
 * @param {Record<string, string>} env
 */
function buildWebhook(env) {
  if (env.WEBHOOK_URL) return env.WEBHOOK_URL;
  if (env.QYWX_ROBOT_KEY) {
    return `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(
      env.QYWX_ROBOT_KEY
    )}`;
  }
  return null;
}

/**
 * @param {string} raw
 * @returns {string[]}
 */
function parseTokens(raw) {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * 获取机器人 key（用于 upload_media），从 QYWX_ROBOT_KEY 或 WEBHOOK_URL 中提取
 * @param {Record<string, string>} env
 */
function getRobotKey(env) {
  if (env.QYWX_ROBOT_KEY) return env.QYWX_ROBOT_KEY;
  if (env.WEBHOOK_URL) {
    try {
      const u = new URL(env.WEBHOOK_URL);
      return u.searchParams.get("key");
    } catch (err) {
      return null;
    }
  }
  return null;
}

/**
 * 处理 file 类型：先上传拿 media_id，再发送 file 消息
 * @param {File} file
 * @param {string} key
 * @param {string} webhook
 */
async function handleFileUploadThenSend(file, key, webhook) {
  if (file.size <= 5) {
    return corsResponse(jsonResponse({ error: "文件需大于 5B" }, 400));
  }
  if (file.size > 20 * 1024 * 1024) {
    return corsResponse(jsonResponse({ error: "文件需不超过 20MB" }, 400));
  }

  const uploadUrl = `https://qyapi.weixin.qq.com/cgi-bin/webhook/upload_media?key=${encodeURIComponent(
    key
  )}&type=file`;

  const { body, contentType } = await buildMultipartBody(file);

  const uploadResp = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  });

  let uploadBody = {};
  try {
    uploadBody = await uploadResp.json();
  } catch (err) {
    // ignore
  }

  const uploadOk =
    uploadResp.ok && typeof uploadBody.errcode === "number"
      ? uploadBody.errcode === 0
      : uploadResp.ok;

  if (!uploadOk || !uploadBody.media_id) {
    return corsResponse(
      jsonResponse(
        {
          ok: false,
          step: "upload",
          upload_status: uploadResp.status,
          errcode: uploadBody.errcode,
          errmsg: uploadBody.errmsg || uploadResp.statusText,
        },
        502
      )
    );
  }

  const sendPayload = { msgtype: "file", file: { media_id: uploadBody.media_id } };
  const sendResp = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sendPayload),
  });

  let sendBody = {};
  try {
    sendBody = await sendResp.json();
  } catch (err) {
    // ignore parse error
  }

  const sendOk =
    sendResp.ok && typeof sendBody.errcode === "number"
      ? sendBody.errcode === 0
      : sendResp.ok;

  const status = uploadOk && sendOk ? 200 : 502;
  return corsResponse(
    jsonResponse(
      {
        ok: uploadOk && sendOk,
        media_id: uploadBody.media_id,
        upload_status: uploadResp.status,
        upload_errcode: uploadBody.errcode,
        upload_errmsg: uploadBody.errmsg || uploadResp.statusText,
        send_status: sendResp.status,
        send_errcode: sendBody.errcode,
        send_errmsg: sendBody.errmsg || sendResp.statusText,
      },
      status
    )
  );
}

/**
 * 处理图片：从 file 读取，计算 base64+md5，发送 image 消息
 * @param {File} file
 * @param {string} webhook
 */
async function handleImageFromFile(file, webhook) {
  if (file.size <= 5) {
    return corsResponse(jsonResponse({ error: "图片需大于 5B" }, 400));
  }
  if (file.size > 2 * 1024 * 1024) {
    return corsResponse(jsonResponse({ error: "图片需不超过 2MB" }, 400));
  }

  const buffer = await file.arrayBuffer();
  const md5 = await md5FromBuffer(buffer);
  const base64 = arrayBufferToBase64(buffer);

  const payload = {
    msgtype: "image",
    image: { base64, md5 },
  };

  // 再封装防止流状态问题（非必须，但保持一致）
  const upFile = new File([buffer], file.name || "image", {
    type: file.type || "application/octet-stream",
  });
  void upFile; // 占位，保留 buffer 引用

  const sendResp = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  let sendBody = {};
  try {
    sendBody = await sendResp.json();
  } catch (err) {
    // ignore parse error
  }

  const sendOk =
    sendResp.ok && typeof sendBody.errcode === "number"
      ? sendBody.errcode === 0
      : sendResp.ok;

  const status = sendOk ? 200 : 502;
  return corsResponse(
    jsonResponse(
      {
        ok: sendOk,
        send_status: sendResp.status,
        send_errcode: sendBody.errcode,
        send_errmsg: sendBody.errmsg || sendResp.statusText,
        md5,
        size: file.size,
      },
      status
    )
  );
}

/**
 * 将 ArrayBuffer 转 base64
 * @param {ArrayBuffer} buffer
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * ArrayBuffer 求 MD5
 * @param {ArrayBuffer} buffer
 */
async function md5FromBuffer(buffer) {
  const hash = await crypto.subtle.digest("MD5", buffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 构造 multipart/form-data 二进制体，字段名 media
 * @param {File} file
 * @returns {{ body: Uint8Array, contentType: string }}
 */
async function buildMultipartBody(file) {
  const boundary = "----qywx" + Math.random().toString(16).slice(2);
  const encoder = new TextEncoder();
  const filename = file.name || "file.bin";
  const contentType = file.type || "application/octet-stream";
  const prefix = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="media"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`
  );
  const fileBuffer = new Uint8Array(await file.arrayBuffer());
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);

  const body = new Uint8Array(prefix.length + fileBuffer.length + suffix.length);
  body.set(prefix, 0);
  body.set(fileBuffer, prefix.length);
  body.set(suffix, prefix.length + fileBuffer.length);

  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * 从 Header 或 Query 提取 token
 * @param {Request} request
 * @returns {string | null}
 */
function extractToken(request) {
  const auth = request.headers.get("Authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const url = new URL(request.url);
  return (
    url.searchParams.get("token") || url.searchParams.get("access_token") || null
  );
}

/**
 * 构造群机器人 payload
 * 支持 text / markdown / image(base64+md5) / news(link) / file(media_id) / template_card
 * 语音等群机器人不支持，需企业应用通道
 * @param {any} body
 */
function buildRobotPayload(body) {
  const type = (body.type || "").toLowerCase();
  switch (type) {
    case "text":
      if (!body.content) throw new Error("text 消息需要 content");
      return {
        msgtype: "text",
        text: {
          content: String(body.content),
          mentioned_list: body.mentioned_list || [],
          mentioned_mobile_list: body.mentioned_mobile_list || [],
        },
      };
    case "markdown":
      if (!body.content) throw new Error("markdown 消息需要 content");
      return {
        msgtype: "markdown",
        markdown: { content: String(body.content) },
      };
    case "image":
      if (!body.base64 || !body.md5) {
        throw new Error("image 消息需要 base64 和 md5");
      }
      return {
        msgtype: "image",
        image: { base64: String(body.base64), md5: String(body.md5) },
      };
    case "news":
    case "link": {
      const articles = buildArticles(body);
      if (articles.length === 0) {
        throw new Error("news/link 需要至少一条含 title 与 url 的 articles");
      }
      return { msgtype: "news", news: { articles } };
    }
    case "file": {
      if (!body.media_id) {
        throw new Error(
          "file 消息需要 media_id（先调用机器人 upload_media 上传，文件需大于5B且不超过20MB）"
        );
      }
      return { msgtype: "file", file: { media_id: String(body.media_id) } };
    }
    case "template_card": {
      if (!body.template_card || typeof body.template_card !== "object") {
        throw new Error("template_card 消息需要 template_card 对象");
      }
      return { msgtype: "template_card", template_card: body.template_card };
    }
    default:
      throw new Error(
        "不支持的 type，请使用 text / markdown / image / news / link / file / template_card；语音需企业应用通道"
      );
  }
}

/**
 * 计算 base64 内容的 md5（hex）
 * @param {string} base64
 */
async function md5FromBase64(base64) {
  const clean = base64.replace(/\s+/g, "");
  const binary = atob(clean);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const hash = await crypto.subtle.digest("MD5", bytes);
  const hex = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex;
}

/**
 * 归一化图文列表
 * @param {any} body
 * @returns {Array<{title: string, description?: string, url: string, picurl?: string}>}
 */
function buildArticles(body) {
  if (Array.isArray(body.articles)) {
    return body.articles
      .map((a) => ({
        title: a.title,
        description: a.description,
        url: a.url,
        picurl: a.picurl,
      }))
      .filter((a) => a.title && a.url)
      .slice(0, 8); // QYWX limit
  }

  if (body.title && body.url) {
    return [
      {
        title: body.title,
        description: body.description,
        url: body.url,
        picurl: body.picurl,
      },
    ];
  }

  return [];
}

/**
 * JSON 响应
 * @param {unknown} data
 * @param {number} status
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/**
 * 附加宽松 CORS
 * @param {Response} res
 */
function corsResponse(res) {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Headers", "*");
  headers.set("Access-Control-Allow-Methods", "POST,OPTIONS");
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(res.body, { status: res.status, headers });
}
