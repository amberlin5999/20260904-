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

const SHARED = {
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-token, Authorization, X-File-Name, X-File-Qty",
};

function cors(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allow = (env.CORS_ORIGINS || "*").split(",").map((s) => s.trim());
  if (allow.includes("*")) return { ...SHARED, "Access-Control-Allow-Origin": "*" };
  if (allow.includes(origin)) return { ...SHARED, "Access-Control-Allow-Origin": origin };
  return SHARED;
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

function isAdmin(request, env) {
  const token = env.ADMIN_TOKEN || "";
  if (!token) return false;
  const h = request.headers.get("x-admin-token") || request.headers.get("authorization") || "";
  const t = h.replace(/^Bearer\s+/i, "").trim();
  const q = new URL(request.url).searchParams.get("token") || "";
  return t === token || q === token;
}

function sanitizeName(n) {
  return (
    String(n)
      .replace(/[\\/\0]/g, "_")
      .replace(/[\u0000-\u001f]/g, "")
      .slice(0, 200) || "untitled"
  );
}

// 依產品限制可上傳的副檔名（與前台 app.js 保持一致）
const PRODUCT_FILE_TYPES = {
  "紡織 - DTF - 60cm R to R": ["png", "ai", "pdf", "psd"],
  "紡織 - DTF - A3": ["png"],
  "紡織 - 直噴": ["png"],
  "UV - 一般水晶標": ["pdf", "ai", "psd"],
  "UV - 燙金水晶標": ["pdf", "ai", "psd"],
  "UV - 直噴": ["pdf", "ai", "psd"],
};

// 訂單編號：YYYYMMDD###（依台灣時區，“當天第幾筆”遞增）
async function genOrderNo(env) {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  const ymd = t.toISOString().slice(0, 10).replace(/-/g, "");
  const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM orders WHERE order_no LIKE ?")
    .bind(ymd + "%")
    .first();
  const c = Number((row && row.c) || 0) + 1;
  return ymd + String(c).padStart(3, "0");
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
  return { order_no: row.order_no, status: row.status, created_at: row.created_at, ...data, files };
}

async function loadOrders(env) {
  const { results } = await env.DB.prepare(
    "SELECT order_no, status, data, created_at FROM orders ORDER BY created_at DESC"
  ).all();
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
  await env.DB.prepare("INSERT INTO orders (order_no, status, data, created_at) VALUES (?,?,?,?)")
    .bind(order_no, "received", JSON.stringify(body), new Date().toISOString())
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
    const ext = "." + (name.split(".").pop() || "").toLowerCase();
    if (!allowed.includes(ext))
      return [
        { ok: false, error: `此產品不接受 ${ext} 格式（僅接受 ${allowed.map((e) => e.toUpperCase()).join(" / ")}）` },
        400,
      ];
  }
  const qty = Number(request.headers.get("x-file-qty") || 1) || 1;

  const key = `orders/${no}/01_original/${name}`;
  const contentType = request.headers.get("content-type") || "application/octet-stream";
  await env.R2.put(key, request.body, {
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
    "SELECT order_no, status, data, created_at FROM orders WHERE order_no = ?"
  )
    .bind(no)
    .first();
  if (!row) return [{ ok: false, error: "訂單不存在" }, 404];
  return [await hydrate(row, env), 200];
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
    if (m === "GET" && p === "/api/health") {
      data = { ok: true }; status = 200;
    } else if (m === "POST" && p === "/api/orders") {
      [data, status] = await createOrder(request, env);
    } else if (m === "GET" && p === "/api/orders") {
      if (!isAdmin(request, env)) return forbid(c);
      data = await loadOrders(env);
      status = 200;
    } else if (m === "GET" && p.startsWith("/api/orders/") && p.endsWith("/download") && p.split("/").length === 5) {
      if (!isAdmin(request, env)) return forbid(c);
      const no = p.split("/")[3];
      [data, status, rawRes] = await downloadZip(env, no);
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
        } else if (m === "POST" && sub[0] === "files") {
          [data, status] = await uploadFile(request, env, no);
        } else if (m === "GET" && sub[0] === "files" && sub[1] !== undefined && sub[2] === "download") {
          if (!isAdmin(request, env)) return forbid(c);
          [data, status, rawRes] = await downloadFile(env, no, sub[1]);
        } else if (m === "POST" && sub[0] === "sf-waybill") {
          if (!isAdmin(request, env)) return forbid(c);
          [data, status] = await sfWaybill(request, env, no);
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
};