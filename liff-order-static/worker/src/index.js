// 數倍DTF · 訂單後端（Cloudflare Workers + D1 + R2）
// D1 = 訂單資料庫，R2 = 印刷檔（10GB 免費、下載免流量）
// 路由與 liff-order-static/server.js 相容：
//   POST /api/orders                          → 建立訂單，回傳 order_no
//   POST /api/orders/:no/files                → 上傳單檔（raw body；X-File-Name、X-File-Qty 表頭）
//   POST /api/orders/:no/complete             → 通知已上傳完
//   GET  /api/orders                          → 後台列表（需 admin token）
//   GET  /api/orders/:no/download             → 後台打包 zip（小於 ZIP_MAX_MB）
//   GET  /api/orders/:no/files/:index/download→ 後台單檔下載
//   POST /api/orders/:no/sf-waybill           → 順豐運單（憑證齊全後啟用）
//   GET  /api/health                          → 健康檢查
//   POST /webhook/line                         → LINE Messaging API webhook（200 收受，暫不回應）

const SHARED = {
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-token, Authorization, X-File-Name, X-File-Qty",
};

// Rate limiting: sliding window via KV (max 20 requests per minute per IP)
async function checkRateLimit(env, key, limit = 20, windowMs = 60000) {
  const now = Date.now();
  const windowStart = now - windowMs;
  const kvKey = `ratelimit:${key}`;
  const data = await env.RATE_LIMIT.get(kvKey, { type: "json" }) || { timestamps: [] };
  const timestamps = data.timestamps.filter((ts) => ts > windowStart);
  if (timestamps.length >= limit) {
    return { allowed: false, retryAfter: Math.ceil((timestamps[0] + windowMs - now) / 1000) };
  }
  timestamps.push(now);
  await env.RATE_LIMIT.put(kvKey, JSON.stringify({ timestamps }), { expirationTtl: 120 });
  return { allowed: true, remaining: limit - timestamps.length };
}

function cors(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allow = (env.CORS_ORIGINS || "*").split(",").map((s) => s.trim());
  if (allow.includes("*")) return { ...SHARED, "Access-Control-Allow-Origin": "*" };
  if (allow.includes(origin)) return { ...SHARED, "Access-Control-Allow-Origin": origin };
  return SHARED;
}

// JWT helpers (Web Crypto API)
function b64UrlEncode(str) {
  // UTF-8 安全：先編碼成 bytes 再 base64url，避免 btoa 對非 ASCII 拋錯
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function b64UrlDecode(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function jwtSign(payload, secret, expMinutes = 480) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claims = { ...payload, iat: now, exp: now + expMinutes * 60 };
  const unsigned = b64UrlEncode(JSON.stringify(header)) + "." + b64UrlEncode(JSON.stringify(claims));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned));
  const sigBytes = new Uint8Array(sig);
  let bin = "";
  for (const b of sigBytes) bin += String.fromCharCode(b);
  const sigB64 = btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return unsigned + "." + sigB64;
}

async function jwtVerify(token, secret) {
  try {
    const [headerB64, payloadB64, sigB64] = token.split(".");
    if (!headerB64 || !payloadB64 || !sigB64) return null;
    const unsigned = headerB64 + "." + payloadB64;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const sig = new Uint8Array(atob(sigB64.replace(/-/g, "+").replace(/_/g, "/")).split("").map((c) => c.charCodeAt(0)));
    const valid = await crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(unsigned));
    if (!valid) return null;
    const payload = JSON.parse(b64UrlDecode(payloadB64));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// 驗證密碼 (PBKDF2-SHA256)
async function verifyPassword(password, storedHash) {
  const [saltB64, hashB64] = storedHash.split(":");
  if (!saltB64 || !hashB64) return false;
  const salt = new Uint8Array(atob(saltB64).split("").map((c) => c.charCodeAt(0)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  const derivedB64 = btoa(String.fromCharCode(...new Uint8Array(derived)));
  return derivedB64 === hashB64;
}

// 產生密碼 hash (PBKDF2-SHA256)
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  const saltB64 = btoa(String.fromCharCode(...salt));
  const hashB64 = btoa(String.fromCharCode(...new Uint8Array(derived)));
  return saltB64 + ":" + hashB64;
}

// 寫入操作日誌
async function writeAudit(env, username, action, order_no, detail, ip) {
  try {
    await env.DB.prepare(
      "INSERT INTO admin_audit (username, action, order_no, detail, ip, created_at) VALUES (?,?,?,?,?,?)"
    )
      .bind(username, action, order_no || null, detail || null, ip || null, new Date().toISOString())
      .run();
  } catch (e) { /* 日誌失敗不阻斷主流程 */ }
}

function reply(data, status, hdrs) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...hdrs },
  });
}

function forbid(c) {
  return reply({ ok: false, error: "未授權（需要 ADMIN_TOKEN）" }, 401, c);
}

// LINE Messaging API 簽章驗證：HMAC-SHA256(Channel Secret, body) base64 與 X-Line-Signature 比較
// 未設定 CHANNEL_SECRET（如本機開發）時跳過驗證
async function lineSignatureOk(request, env, bodyText) {
  const secret = env.CHANNEL_SECRET;
  if (!secret) return true;
  const sig = (request.headers.get("X-Line-Signature") || "").trim();
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(bodyText));
  const expect = btoa(String.fromCharCode(...new Uint8Array(mac)));
  if (expect.length !== sig.length) return false;
  let d = 0;
  for (let i = 0; i < sig.length; i++) d |= expect.charCodeAt(i) ^ sig.charCodeAt(i);
  return d === 0;
}

async function getAuthUser(request, env) {
  const auth = request.headers.get("authorization") || "";
  let token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    const url = new URL(request.url);
    token = url.searchParams.get("token") || "";
  }
  if (!token) return null;
  const payload = await jwtVerify(token, env.JWT_SECRET);
  return payload && payload.role === "admin" ? payload : null;
}

async function isAdmin(request, env) {
  return !!(await getAuthUser(request, env));
}

// 人天角色是否為超管（從 DB 讀，避免權限變更後舊 token 仍有效）
async function isSuperAdmin(request, env) {
  const user = await getAuthUser(request, env);
  if (!user) return false;
  const row = await env.DB.prepare("SELECT role FROM admin_users WHERE username = ?").bind(user.user).first();
  return (row && row.role === "admin") || false;
}

function sanitizeName(n) {
  return (
    String(n)
      .replace(/^\.+/, "")
      .replace(/\.\.+/g, "_")
      .replace(/[\\/\0]/g, "_")
      .replace(/[\u0000-\u001f]/g, "")
      .slice(0, 200) || "untitled"
  );
}

// 正規化取得副檔名（忽略尾端空白／隱形字元、大小寫，限制長度 ≤ 5）
function extOf(name) {
  const m = String(name).toLowerCase().trim().match(/\.([a-z0-9]{1,5})$/);
  return m ? "." + m[1] : "";
}

// Magic bytes for allowed file types
const MAGIC_BYTES = {
  ".png":  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  ".pdf":  [0x25, 0x50, 0x44, 0x46],
  ".ai":   [0x25, 0x50, 0x44, 0x46], // AI files are PDF-based
  ".psd":  [0x38, 0x42, 0x50, 0x53],
};

function checkMagicBytes(bytes, ext) {
  const magic = MAGIC_BYTES[ext];
  if (!magic) return true; // no validation for unknown ext
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

// 依產品限制可上傳的副檔名（與前台 app.js 保持一致）
const PRODUCT_FILE_TYPES = {
  "紡織 - DTF - 60cm R to R": [".png", ".ai", ".pdf", ".psd"],
  "紡織 - DTF - A3": [".png"],
  "紡織 - 直噴": [".png"],
  "UV - 一般水晶標": [".ai", ".pdf", ".psd", ".png"],
  "UV - 一般水晶標 - A3": [".ai", ".pdf", ".psd", ".png"],
  "UV - 燙金水晶標": [".ai", ".pdf", ".psd", ".png"],
  "UV - 燙金水晶標 - A3": [".ai", ".pdf", ".psd", ".png"],
  "UV - 燙金水晶標 - A4": [".ai", ".pdf", ".psd", ".png"],
  "UV - 直噴": [".ai", ".pdf", ".psd", ".png"],
};

// 訂單編號：YYYYMMDD###（依台灣時區，“當天第幾筆”遞增，PK 衝突重試）
async function genOrderNo(env) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const t = new Date(Date.now() + 8 * 3600 * 1000);
    const ymd = t.toISOString().slice(0, 10).replace(/-/g, "");
    const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM orders WHERE order_no LIKE ?")
      .bind(ymd + "%")
      .first();
    const c = Number((row && row.c) || 0) + 1;
    const orderNo = ymd + String(c).padStart(3, "0");
    try {
      await env.DB.prepare("INSERT INTO orders (order_no, status, data, created_at) VALUES (?,?,?,?)")
        .bind(orderNo, "reserved", "{}", new Date().toISOString())
        .run();
      return orderNo;
    } catch (e) {
      if (String(e).includes("UNIQUE") || String(e).includes("PRIMARY KEY")) {
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  throw new Error("訂單編號產生失敗（重試耗盡）");
}

// 合併 DB 列 + data JSON + 檔案清單 → 與舊版 server.js 的回傳形狀一致
async function hydrate(row, env) {
  let data = {};
  try {
    data = JSON.parse(row.data);
  } catch (e) {
    data = {};
  }
  const files = (
    await env.DB.prepare(
      "SELECT id, name, size, qty, uploaded_at FROM order_files WHERE order_no = ? ORDER BY id ASC"
    )
      .bind(row.order_no)
      .all()
  ).results;
  return {
    order_no: row.order_no,
    status: row.status,
    created_at: row.created_at,
    manage_status: row.manage_status || "pending",
    followup_at: row.followup_at || null,
    note: row.note || "",
    ...data,
    files,
  };
}

// 依建立日期（order_no 前 8 碼 YYYYMMDD）/狀態/管理狀態篩選
async function loadOrders(env, q = {}) {
  const where = [];
  const bind = [];
  if (q.from) {
    const f = q.from.replace(/-/g, "");
    if (/^\d{8}$/.test(f)) { where.push("substr(order_no,1,8) >= ?"); bind.push(f); }
  }
  if (q.to) {
    const t = q.to.replace(/-/g, "");
    if (/^\d{8}$/.test(t)) { where.push("substr(order_no,1,8) <= ?"); bind.push(t); }
  }
  if (q.status) { where.push("status = ?"); bind.push(q.status); }
  if (q.manage) { where.push("manage_status = ?"); bind.push(q.manage); }
  let sql = "SELECT order_no, status, created_at, data, manage_status, followup_at, note FROM orders";
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY created_at DESC";
  const { results } = await env.DB.prepare(sql).bind(...bind).all();
  const out = [];
  for (const row of results) out.push(await hydrate(row, env));
  return out;
}

async function createOrder(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    body = null;
  }
  if (!body || typeof body !== "object") return [{ ok: false, error: "JSON 解析失敗" }, 400];
  const required = ["customer_name", "contact_name", "phone", "product_type", "quantity"];
  for (const k of required)
    if (!body[k] || !String(body[k]).trim())
      return [{ ok: false, error: `缺少欄位 ${k}` }, 400];
  const order_no = await genOrderNo(env);
  await env.DB.prepare("UPDATE orders SET status = ?, data = ?, created_at = ? WHERE order_no = ?")
    .bind("received", JSON.stringify(body), new Date().toISOString(), order_no)
    .run();
  return [{ ok: true, order_no }, 200];
}

async function uploadFile(request, env, no) {
  const maxMb = Number(env.MAX_FILE_MB || 50);
  const limit = maxMb * 1024 * 1024;
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > limit)
    return [{ ok: false, error: `檔案超過 ${maxMb}MB 上限` }, 413];

  const orderRow = await env.DB.prepare("SELECT data FROM orders WHERE order_no = ?").bind(no).first();
  if (!orderRow) return [{ ok: false, error: "訂單不存在" }, 404];

  const nameRaw = request.headers.get("x-file-name") || "";
  let name;
  try {
    name = sanitizeName(decodeURIComponent(nameRaw));
  } catch (e) {
    name = sanitizeName(nameRaw);
  }
  if (!name) return [{ ok: false, error: "缺少檔名（X-File-Name）" }, 400];

  // 依該訂單的產品類型檢查副檔名是否允許（與前台規則一致）
  let ptype = "";
  try {
    ptype = String((JSON.parse(orderRow.data) || {}).product_type || "");
  } catch (e) {}
  const allowed = PRODUCT_FILE_TYPES[ptype];
  if (allowed) {
    const ext = extOf(name);
    if (ext && !allowed.includes(ext))
      return [
        { ok: false, error: `此產品不接受 ${ext} 格式（僅接受 ${allowed.map((e) => e.toUpperCase()).join(" / ")}）` },
        400,
      ];
  }
  const qty = Number(request.headers.get("x-file-qty") || 1) || 1;

  const bodyBytes = new Uint8Array(await request.arrayBuffer());
  const ext = extOf(name);
  if (ext && !checkMagicBytes(bodyBytes, ext)) {
    return [{ ok: false, error: `檔案內容與副檔名 ${ext} 不符，疑似偽裝檔案` }, 400];
  }

  const key = `orders/${no}/01_original/${name}`;
  const contentType = request.headers.get("content-type") || "application/octet-stream";
  await env.R2.put(key, bodyBytes, {
    httpMetadata: {
      contentType,
      contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    },
  });

  const head = await env.R2.head(key);
  const size = (head && head.size) || contentLength;
  const uploaded_at = new Date().toISOString();
  const ins = await env.DB.prepare(
    "INSERT INTO order_files (order_no, name, size, qty, object_key, uploaded_at) VALUES (?,?,?,?,?,?) RETURNING id"
  )
    .bind(no, name, size, qty, key, uploaded_at)
    .all();
  const id = (ins.results && ins.results[0] && ins.results[0].id) || null;
  return [{ ok: true, file: name, id }, 200];
}

async function completeOrder(request, env, no) {
  const row = await env.DB.prepare("SELECT data FROM orders WHERE order_no = ?").bind(no).first();
  if (!row) return [{ ok: false, error: "訂單不存在" }, 404];
  let data = {};
  try {
    data = JSON.parse(row.data);
  } catch (e) {}
  data.files_uploaded_at = new Date().toISOString();
  await env.DB.prepare("UPDATE orders SET status = ?, data = ? WHERE order_no = ?")
    .bind("files_uploaded", JSON.stringify(data), no)
    .run();
  return [{ ok: true }, 200];
}

async function orderDetail(env, no) {
  const row = await env.DB.prepare(
    "SELECT order_no, status, created_at, data, manage_status, followup_at, note FROM orders WHERE order_no = ?"
  )
    .bind(no)
    .first();
  if (!row) return [{ ok: false, error: "訂單不存在" }, 404];
  return [await hydrate(row, env), 200];
}

// 更新後台管理進度：狀態（待處理/已處理/已報價/已確認/送印中/已出貨/已結單）+ 下次跟催日 + 備註
async function updateManage(request, env, no) {
  const row = await env.DB.prepare("SELECT order_no FROM orders WHERE order_no = ?").bind(no).first();
  if (!row) return [{ ok: false, error: "訂單不存在" }, 404];
  let body;
  try { body = await request.json(); } catch (e) { body = null; }
  if (!body || typeof body !== "object") return [{ ok: false, error: "JSON 解析失敗" }, 400];
  const status = ["pending", "done", "quoted", "confirmed", "printing", "shipped", "closed"].includes(body.manage_status) ? body.manage_status : "";
  const followupAt = String(body.followup_at || "").trim() || null;
  const note = String(body.note ?? "").trim();
  if (!status) return [{ ok: false, error: "管理狀態無效" }, 400];
  if (followupAt && !/^\d{4}-\d{2}-\d{2}$/.test(followupAt))
    return [{ ok: false, error: "跟催日期格式須為 YYYY-MM-DD" }, 400];
  await env.DB.prepare("UPDATE orders SET manage_status = ?, followup_at = ?, note = ? WHERE order_no = ?")
    .bind(status, followupAt, note, no)
    .run();
  return [{ ok: true, order_no: no, manage_status: status, followup_at: followupAt, note }, 200];
}

// 清理長期未完成（僅限 status=received，尚未傳檔）的訂單：刪 D1 資料列
// days>0：清理建立超過 N 天且仍未完成的；預設無特別條件時清空
async function cleanupOrders(env, days, actor = "system") {
  const cutoff = new Date(Date.now() - Number(days || 0) * 86400000).toISOString();
  let rows;
  if (days > 0) {
    rows = (
      await env.DB.prepare(
        "SELECT order_no, created_at FROM orders WHERE status = 'received' AND created_at < ? ORDER BY created_at ASC"
      )
        .bind(cutoff)
        .all()
    ).results;
  } else {
    rows = (
      await env.DB.prepare("SELECT order_no, created_at FROM orders WHERE status = 'received' ORDER BY created_at ASC")
        .all()
    ).results;
  }
  for (const r of rows) {
    const files = (
      await env.DB.prepare("SELECT object_key FROM order_files WHERE order_no = ? ORDER BY id ASC")
        .bind(r.order_no)
        .all()
    ).results;
    for (const f of files) {
      try { await env.R2.delete(f.object_key); } catch (e) { /* R2 刪除失敗不阻斷 */ }
    }
    await env.DB.prepare("DELETE FROM orders WHERE order_no = ?").bind(r.order_no).run();
    await writeAudit(env, actor, "cleanup", r.order_no, `清理未完成訂單（建立於 ${r.created_at}）`, "");
  }
  return rows.length;
}

async function downloadFile(env, no, index) {
  const row = (
    await env.DB.prepare("SELECT name, object_key FROM order_files WHERE order_no = ? ORDER BY id ASC")
      .bind(no)
      .all()
  ).results;
  const f = row[Number(index)];
  if (!f) return [{ ok: false, error: "檔案不存在" }, 404];
  const obj = await env.R2.get(f.object_key);
  if (!obj) return [{ ok: false, error: "檔案不存在於儲存空間" }, 404];
  const headers = { "Content-Length": String(obj.size), "Cache-Control": "no-store" };
  if (obj.httpMetadata) headers["Content-Type"] = obj.httpMetadata.contentType || "application/octet-stream";
  headers["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`;
  return [new Response(obj.body, { headers }), null, true];
}

/* ---------- 極簡 ZIP（純 JS crc32 + CompressionStream deflate，不需單機緩衝） ---------- */
let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
      crcTable[i] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
async function deflateRaw(bytes) {
  const cs = new CompressionStream("deflate-raw");
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
function u16(v) {
  return new Uint8Array([v & 255, (v >>> 8) & 255]);
}
function u32(v) {
  return new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);
}
function concatArr(...arrs) {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}
async function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = new TextEncoder().encode(f.name);
    const crc = crc32(f.bytes);
    const comp = await deflateRaw(f.bytes);
    chunks.push(
      concatArr(
        u32(0x04034b50), u16(20), u16(0x0800), u16(8), u16(0), u16(0),
        u32(crc), u32(comp.length), u32(f.bytes.length), u16(nameBytes.length), u16(0),
        nameBytes, comp
      )
    );
    central.push(
      concatArr(
        u32(0x02014b50), u16(0x0314), u16(20), u16(0x0800), u16(8), u16(0), u16(0),
        u32(crc), u32(comp.length), u32(f.bytes.length), u16(nameBytes.length), u16(0), u16(0),
        u16(0), u16(0), u32(0), u32(offset), nameBytes
      )
    );
    offset += (chunks[chunks.length - 1]).length;
  }
  const cd = concatArr(...central);
  const end = concatArr(
    u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
    u32(cd.length), u32(offset), u16(0)
  );
  return concatArr(...chunks, cd, end);
}

async function downloadZip(env, no) {
  const { results } = await env.DB.prepare(
    "SELECT name, object_key, size FROM order_files WHERE order_no = ? ORDER BY id ASC"
  )
    .bind(no)
    .all();
  if (!results || !results.length) return [{ ok: false, error: "無可用檔案" }, 404];
  const maxMb = Number(env.ZIP_MAX_MB || 20);
  const total = results.reduce((s, f) => s + (Number(f.size) || 0), 0);
  if (total > maxMb * 1024 * 1024)
    return [
      {
        ok: false,
        error: `訂單檔案總共 ${(total / 1048576).toFixed(1)}MB，超過打包上限 ${maxMb}MB（免費 Worker 的 CPU 限制），請改用單檔下載`,
      },
      413,
    ];
  const collected = [];
  for (const f of results) {
    const obj = await env.R2.get(f.object_key);
    if (obj) collected.push({ name: f.name, bytes: new Uint8Array(await obj.arrayBuffer()) });
  }
  if (!collected.length) return [{ ok: false, error: "無可用檔案" }, 404];
  const zip = await buildZip(collected);
  return [
    new Response(new Blob([zip]), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="order_${no}.zip"`,
      },
    }),
    null,
    true,
  ];
}

/* ---------- 順豐速運（憑證 SF_PARTNER_ID / SF_CHECK_WORD 就緒後再完成簽名） ---------- */
async function sfWaybill(request, env, no) {
  const row = await env.DB.prepare("SELECT data FROM orders WHERE order_no = ?").bind(no).first();
  if (!row) return [{ ok: false, error: "訂單不存在" }, 404];
  const order = { order_no: no, ...JSON.parse(row.data) };
  if (order.logistics_method !== "順豐")
    return [{ ok: false, error: "此訂單非順豐物流，無法建立運單" }, 400];
  if (!env.SF_PARTNER_ID || !env.SF_CHECK_WORD)
    return [{ ok: false, error: "尚未設定順豐憑證（SF_PARTNER_ID / SF_CHECK_WORD）" }, 400];
  return [{ ok: false, error: "順豐簽名（MD5）移植尚未完成，提供憑證後可補上" }, 501];
}

/* ---------- 主路由器 ---------- */
export default {
  async fetch(request, env) {
    const c = cors(request, env);
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": c["Access-Control-Allow-Origin"] || "*", ...SHARED } });

    const url = new URL(request.url);
    const p = url.pathname;
    const m = request.method;

    let data, status, rawRes = false;
    const clientIp = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "";
    if (m === "POST" && p === "/api/admin/login") {
      let body;
      try { body = await request.json(); } catch (e) { body = null; }
      const username = body?.username?.trim();
      const password = body?.password;
      if (!username || !password) return reply({ ok: false, error: "請輸入帳號密碼" }, 400, c);
      const row = await env.DB.prepare("SELECT username, password_hash, role FROM admin_users WHERE username = ?").bind(username).first();
      if (!row || !(await verifyPassword(password, row.password_hash)))
        return reply({ ok: false, error: "帳號或密碼錯誤" }, 401, c);
      const token = await jwtSign({ role: "admin", user: username, dbrole: row.role }, env.JWT_SECRET, 480);
      await writeAudit(env, username, "login", null, "後台登入", clientIp);
      return reply({ ok: true, token, username, role: row.role }, 200, c);
    } else if (m === "POST" && p === "/api/admin/logout") {
      // Stateless JWT，前端清除即可
      return reply({ ok: true }, 200, c);
    } else if (m === "GET" && p === "/api/admin/me") {
      const user = await getAuthUser(request, env);
      if (!user) return forbid(c);
      const row = await env.DB.prepare("SELECT username, role, created_at FROM admin_users WHERE username = ?").bind(user.user).first();
      if (!row) return forbid(c);
      return reply({ ok: true, username: row.username, role: row.role }, 200, c);
    } else if (m === "POST" && p === "/api/admin/change-password") {
      const user = await getAuthUser(request, env);
      if (!user) return forbid(c);
      let body;
      try { body = await request.json(); } catch (e) { body = null; }
      const oldPass = body?.old_password;
      const newPass = body?.new_password;
      if (!oldPass || !newPass) return reply({ ok: false, error: "請輸入舊密碼與新密碼" }, 400, c);
      if (newPass.length < 8) return reply({ ok: false, error: "新密碼長度至少 8 碼" }, 400, c);
      const row = await env.DB.prepare("SELECT password_hash FROM admin_users WHERE username = ?").bind(user.user).first();
      if (!row) return forbid(c);
      if (!(await verifyPassword(oldPass, row.password_hash))) return reply({ ok: false, error: "舊密碼錯誤" }, 400, c);
      const newHash = await hashPassword(newPass);
      const now = new Date().toISOString();
      await env.DB.prepare("UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE username = ?")
        .bind(newHash, now, user.user).run();
      await writeAudit(env, user.user, "change_password", null, "修改自己的密碼", clientIp);
      return reply({ ok: true }, 200, c);
    } else if (m === "POST" && p === "/api/admin/add-user") {
      if (!await isSuperAdmin(request, env)) return reply({ ok: false, error: "僅超管可新增帳號" }, 403, c);
      const superUser = await getAuthUser(request, env);
      let body;
      try { body = await request.json(); } catch (e) { body = null; }
      const username = body?.username?.trim();
      const password = body?.password;
      const role = (body?.role === "admin") ? "admin" : "operator";
      if (!username || !password) return reply({ ok: false, error: "請輸入帳號與密碼" }, 400, c);
      if (username.length < 2) return reply({ ok: false, error: "帳號至少 2 字元" }, 400, c);
      if (password.length < 8) return reply({ ok: false, error: "密碼長度至少 8 碼" }, 400, c);
      const exist = await env.DB.prepare("SELECT username FROM admin_users WHERE username = ?").bind(username).first();
      if (exist) return reply({ ok: false, error: "帳號已存在" }, 400, c);
      const now = new Date().toISOString();
      const hash = await hashPassword(password);
      await env.DB.prepare("INSERT INTO admin_users (username, password_hash, role, created_at, updated_at) VALUES (?,?,?,?,?)")
        .bind(username, hash, role, now, now).run();
      await writeAudit(env, superUser.user, "add_user", null, `新增帳號 ${username}（${role}）`, clientIp);
      return reply({ ok: true }, 200, c);
    } else if (m === "POST" && p === "/api/admin/delete-user") {
      if (!await isSuperAdmin(request, env)) return reply({ ok: false, error: "僅超管可刪除帳號" }, 403, c);
      const superUser = await getAuthUser(request, env);
      let body;
      try { body = await request.json(); } catch (e) { body = null; }
      const username = body?.username?.trim();
      if (!username) return reply({ ok: false, error: "缺少帳號" }, 400, c);
      if (username === superUser.user) return reply({ ok: false, error: "不能刪除自己" }, 400, c);
      const head = await env.DB.prepare("SELECT role FROM admin_users WHERE username = ?").bind(username).first();
      if (!head) return reply({ ok: false, error: "帳號不存在" }, 404, c);
      if (head.role === "admin") return reply({ ok: false, error: "不能刪除超管帳號" }, 400, c);
      await env.DB.prepare("DELETE FROM admin_users WHERE username = ?").bind(username).run();
      await writeAudit(env, superUser.user, "delete_user", null, `刪除帳號 ${username}`, clientIp);
      return reply({ ok: true }, 200, c);
    } else if (m === "GET" && p === "/api/admin/list-users") {
      if (!await isSuperAdmin(request, env)) return reply({ ok: false, error: "僅超管可查看帳號" }, 403, c);
      const { results } = await env.DB.prepare("SELECT username, role, created_at, updated_at FROM admin_users ORDER BY created_at ASC").all();
      return reply({ ok: true, users: results }, 200, c);
    } else if (m === "GET" && p === "/api/admin/audit") {
      if (!await isSuperAdmin(request, env)) return reply({ ok: false, error: "僅超管可查看操作日誌" }, 403, c);
      const { results } = await env.DB.prepare("SELECT username, action, order_no, detail, ip, created_at FROM admin_audit ORDER BY id DESC LIMIT 200").all();
      return reply({ ok: true, logs: results }, 200, c);
    } else if (m === "GET" && p === "/api/health") {
      data = { ok: true }; status = 200;
    } else if ((m === "GET" || m === "POST") && p === "/webhook/line") {
      if (m === "POST") {
        const bodyText = await request.text();
        if (!(await lineSignatureOk(request, env, bodyText)))
          return reply({ ok: false, error: "簽章驗證失敗" }, 401, c);
      }
      data = { ok: true }; status = 200;
    } else if (m === "POST" && p === "/api/orders") {
      const rl = await checkRateLimit(env, `order:${request.headers.get("cf-connecting-ip") || "unknown"}`);
      if (!rl.allowed) return reply({ ok: false, error: `請求過於頻繁，請 ${rl.retryAfter} 秒後再試` }, 429, c);
      [data, status] = await createOrder(request, env);
    } else if (m === "GET" && p === "/api/orders") {
      if (!isAdmin(request, env)) return forbid(c);
      data = await loadOrders(env, {
        from: url.searchParams.get("from") || "",
        to: url.searchParams.get("to") || "",
        status: url.searchParams.get("status") || "",
        manage: url.searchParams.get("manage") || "",
      });
      status = 200;
    } else if (m === "GET" && p.startsWith("/api/orders/") && p.endsWith("/download") && p.split("/").length === 5) {
      const admin = await getAuthUser(request, env);
      if (!admin) return forbid(c);
      const no = p.split("/")[3];
      [data, status, rawRes] = await downloadZip(env, no);
      if (status < 400) await writeAudit(env, admin.user, "download_zip", no, "整包 ZIP 下載", clientIp);
    } else {
      const seg = p.split("/").filter(Boolean); // [api, orders, :no, ...]
      if (seg[0] === "api" && seg[1] === "orders" && seg[2]) {
        const no = seg[2];
        const sub = seg.slice(3);
        if (m === "GET" && sub.length === 0) {
          if (!isAdmin(request, env)) return forbid(c);
          [data, status] = await orderDetail(env, no);
        } else if (m === "POST" && sub[0] === "complete") {
          [data, status] = await completeOrder(request, env, no);
        } else if (m === "POST" && sub[0] === "manage") {
          const admin = await getAuthUser(request, env);
          if (!admin) return forbid(c);
          [data, status] = await updateManage(request, env, no);
          if (data && data.ok && status < 400)
            await writeAudit(env, admin.user, "manage", no, `管理狀態 → ${data.manage_status}` + (data.followup_at ? `、跟催 ${data.followup_at}` : "") + (data.note ? `、備註「${data.note}」` : ""), clientIp);
        } else if (m === "POST" && sub[0] === "files") {
          const rl = await checkRateLimit(env, `upload:${request.headers.get("cf-connecting-ip") || "unknown"}:${no}`, 60, 60000);
          if (!rl.allowed) return reply({ ok: false, error: `上傳過於頻繁，請 ${rl.retryAfter} 秒後再試` }, 429, c);
          [data, status] = await uploadFile(request, env, no);
        } else if (m === "GET" && sub[0] === "files" && sub[1] !== undefined && sub[2] === "download") {
          const admin = await getAuthUser(request, env);
          if (!admin) return forbid(c);
          [data, status, rawRes] = await downloadFile(env, no, sub[1]);
          if (status < 400) await writeAudit(env, admin.user, "download_file", no, `下載檔案索引 ${sub[1]}`, clientIp);
        } else if (m === "POST" && sub[0] === "sf-waybill") {
          if (!isAdmin(request, env)) return forbid(c);
          [data, status] = await sfWaybill(request, env, no);
} else if (m === "POST" && p === "/api/orders/cleanup") {
      if (!await isSuperAdmin(request, env)) return reply({ ok: false, error: "僅超管可執行清理" }, 403, c);
      const actor = (await getAuthUser(request, env)).user;
      let body;
      try { body = await request.json(); } catch (e) { body = null; }
      const days = Math.max(0, Number(body?.days) || 0);
      const cleaned = await cleanupOrders(env, days, actor);
      return reply({ ok: true, cleaned, days }, 200, c);
    } else {
          return reply({ ok: false, error: "找不到此端點" }, 404, c);
        }
      } else {
        return reply({ ok: false, error: "找不到此端點" }, 404, c);
      }
    }

    if (rawRes) {
      if (data instanceof Response) {
        for (const [k, v] of Object.entries(c)) data.headers.set(k, v);
        return data;
      }
      return reply(data || { ok: false, error: "錯誤" }, status || 500, c);
    }
    return reply(data, status || 200, c);
  },

  // 定期清理：每天自動清除超過 CLEANUP_AFTER_DAYS 天仍未上傳檔案的訂單
  async scheduled(event, env, ctx) {
    const days = Number(env.CLEANUP_AFTER_DAYS || 0);
    if (!(days > 0)) return;
    const count = await cleanupOrders(env, days, "system");
    console.log(`scheduled cleanup: removed ${count} incomplete orders (older than ${days} days)`);
  },
};