/* 數倍DTF · LIFF 下單 MVP 後端
 * 提供三個 API：
 *   POST /api/orders                    → 建立訂單，回傳 order_no
 *   POST /api/orders/:no/files          → 逐檔上傳（multipart/form-data, field: file）
 *   POST /api/orders/:no/complete       → 通知已上傳完
 *
 * 訂單資料：orders.json（單機 MVP 用，之後可換成 PostgreSQL / Google Sheet）
 * 檔案儲存：uploads/<order_no>/01_original/<檔名>
 *
 * 需要：npm i express multer cors
 */
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, "orders.json");
const UPLOAD_ROOT = path.join(ROOT, "uploads");

fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]", "utf8");

function loadOrders() { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
function saveOrders(list) { fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2), "utf8"); }

// 產生訂單編號：YYYYMMDD### （沿用你 Excel 現在的規則）
function genOrderNo() {
  const now = new Date();
  const ymd =
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0");
  const list = loadOrders();
  const todayCount = list.filter(o => o.order_no.startsWith(ymd)).length + 1;
  return `${ymd}${String(todayCount).padStart(3, "0")}`;
}

// multer：檔案存放 uploads/<order_no>/01_original/
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const orderNo = req.params.no;
    const dir = path.join(UPLOAD_ROOT, orderNo, "01_original");
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    // 保留原檔名（可自行改為 orderNo_序號_原名）
    const safe = Buffer.from(file.originalname, "latin1").toString("utf8");
    cb(null, safe);
  },
});
const upload = multer({ storage, limits: { fileSize: 300 * 1024 * 1024 } });

/* =========================================================
 * 順豐速運 API 下單（EXP_RECE_CREATE_ORDER）
 * 官網文件：https://open.sf-express.com/developSupport/195960
 * 簽名：msgDigest = base64( MD5( bytes( urlEncodeJava( msgData + timestamp + checkWord ) ) ) )
 * 憑證需在順豐開放平台／豐橋申請，見下方 SF_CONFIG：
 *   SF_PARTNER_ID   顧客編碼（clientCode）
 *   SF_CHECK_WORD   校驗碼（checkWord）
 *   SF_MONTHLY_CARD 月結卡號（寄方付必要，需與順豐簽約，向順豐業務申請）
 *   SF_ENV          sandbox（預設）| prod
 * 環境位址：沙箱 https://sfapi-sbox.sf-express.com/std/service
 *           生產 https://sfapi.sf-express.com/std/service
 * ========================================================= */
const https = require("https");
const crypto = require("crypto");

const SF_CONFIG = {
  SF_PARTNER_ID: process.env.SF_PARTNER_ID || "",      // 顧客編碼（順豐配發）
  SF_CHECK_WORD: process.env.SF_CHECK_WORD || "",      // 校驗碼（簽名用）
  SF_MONTHLY_CARD: process.env.SF_MONTHLY_CARD || "",  // 月結卡號；沙箱測試請留空
  SF_ENV: process.env.SF_ENV || "sandbox",             // sandbox | prod
  SF_EXPRESS_TYPE_ID: Number(process.env.SF_EXPRESS_TYPE_ID || 1), // 1=順豐特快（依合約品項調整）
  SF_SENDER: {  // 寄件人（公司）資訊，依實際收件地址填寫
    company: process.env.SF_SENDER_COMPANY || "數倍DTF",
    contact: process.env.SF_SENDER_CONTACT || "",      // 寄件聯絡人
    mobile: process.env.SF_SENDER_MOBILE || "",        // 寄件電話
    province: process.env.SF_SENDER_PROVINCE || "",    // 例：台北市、新北市
    city: process.env.SF_SENDER_CITY || "",            // 例：(區/鄉/鎮) 大安區
    county: "",
    address: process.env.SF_SENDER_ADDRESS || "",      // 例：復興南路一段 100 號
  },
};
const SF_ENDPOINTS = {
  sandbox: "https://sfapi-sbox.sf-express.com/std/service",
  prod: "https://sfapi.sf-express.com/std/service",
};

// 模擬 Java URLEncoder.encode() 的 URL 編碼（順豐簽名規範用）
function urlEncodeJava(s) {
  return encodeURIComponent(s)
    .replace(/%20/g, "+")
    .replace(/!/g, "%21")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/~/g, "%7E");
}

// 順豐簽名：base64( MD5( urlEncode( msgData + timestamp + checkWord ) ) )
function sfMsgDigest(msgData, timestamp, checkWord) {
  return crypto.createHash("md5")
    .update(urlEncodeJava(msgData + timestamp + checkWord), "utf8")
    .digest("base64");
}

// 送出 x-www-form-urlencoded 的 POST 並解析 JSON 回應
function postJson(url, form) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(form).toString();
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname, port: 443, path: u.pathname, method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error("順豐回應非 JSON：" + data)); }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// 粗略拆解台灣地址前綴（縣市／區），拆不出來就整段傳出
function parseTwAddress(addr) {
  const s = String(addr || "").trim();
  const m = s.match(/^(臺?[^縣市]{1,3}[縣市])([^鄉鎮市區]{1,4}[鄉鎮市區])?(.*)$/);
  if (!m) return { province: "", city: "", county: "", line: s };
  return { province: m[1] || "", city: m[2] || "", county: "", line: (m[3] || "").trim() };
}

// 建立順豐下單訊息（EXP_RECE_CREATE_ORDER 的 msgData）
function buildSfOrderPayload(order) {
  const s = SF_CONFIG.SF_SENDER;
  const r = parseTwAddress(order.recipient_address || "");
  const fileCount = (order.files || [])
    .reduce((sum, f) => sum + (Number(f.qty) || 1), 0) || 1;  // 大約件數
  return {
    language: "zh-CN",
    orderId: order.order_no,
    cargoDetails: [
      { name: "影印打印成品", count: fileCount, unit: "件", weight: 1 },
    ],
    contactInfoList: [
      { contactType: 1, country: "TW", company: s.company, contact: s.contact,
        mobile: s.mobile, province: s.province, city: s.city, county: s.county, address: s.address },
      { contactType: 2, country: "TW", contact: order.recipient_name || "",
        mobile: order.recipient_phone || "", province: r.province, city: r.city,
        county: r.county, address: order.recipient_address || "" },
    ],
    expressTypeId: SF_CONFIG.SF_EXPRESS_TYPE_ID,
    payMethod: 1,                            // 1=寄方付（店家付）
    monthlyCard: SF_CONFIG.SF_MONTHLY_CARD,  // 沙箱留空；生產填有效月結卡號
    parcelQty: 1,
    totalWeight: 1,
    isDocall: 1,                             // 通知順豐收派員上門收件
  };
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(ROOT)); // 直接把當前資料夾當成靜態網站發布 index.html

// 建立訂單
app.post("/api/orders", (req, res) => {
  const body = req.body || {};
  const required = ["customer_name", "contact_name", "phone", "product_type", "quantity"];
  for (const k of required) {
    if (!body[k] || !String(body[k]).trim()) return res.status(400).json({ ok: false, error: `缺少欄位 ${k}` });
  }
  const list = loadOrders();
  const order_no = genOrderNo();
  const order = {
    order_no,
    status: "received",
    created_at: new Date().toISOString(),
    ...body,
    files: [],
  };
  list.push(order);
  saveOrders(list);
  console.log(`[新訂單] ${order_no} · ${body.customer_name} · ${body.product_type} · ${body.quantity}`);
  res.json({ ok: true, order_no });
});

// 上傳單一檔案
app.post("/api/orders/:no/files", upload.single("file"), (req, res) => {
  const list = loadOrders();
  const idx = list.findIndex(o => o.order_no === req.params.no);
  if (idx < 0) return res.status(404).json({ ok: false, error: "訂單不存在" });
  const f = req.file;
  // multer 預設把 multipart 檔名當 latin1，這裡轉回 UTF-8
  const originalName = Buffer.from(f.originalname, "latin1").toString("utf8");
  // 每個檔案的印製數量（前端送出，預設 1）
  const qty = Number(req.body.qty) || 1;
  list[idx].files.push({
    name: originalName,
    size: f.size,
    mimetype: f.mimetype,
    saved_as: path.relative(ROOT, f.path).replace(/\\/g, "/"),
    uploaded_at: new Date().toISOString(),
    qty,
  });
  saveOrders(list);
  res.json({ ok: true, file: f.originalname });
});

// 上傳完成通知
app.post("/api/orders/:no/complete", (req, res) => {
  const list = loadOrders();
  const idx = list.findIndex(o => o.order_no === req.params.no);
  if (idx < 0) return res.status(404).json({ ok: false, error: "訂單不存在" });
  list[idx].status = "files_uploaded";
  list[idx].files_uploaded_at = new Date().toISOString();
  saveOrders(list);
  console.log(`[檔案完成] ${req.params.no} · ${list[idx].files.length} 個檔案`);
  res.json({ ok: true });
});

// 內部：訂單列表（給後台看用，正式版請加驗證）
app.get("/api/orders", (req, res) => res.json(loadOrders().reverse()));

// 建立順豐運單（由業務端呼叫；僅限物流 = 順豐 的訂單）
app.post("/api/orders/:no/sf-waybill", async (req, res) => {
  const list = loadOrders();
  const idx = list.findIndex(o => o.order_no === req.params.no);
  if (idx < 0) return res.status(404).json({ ok: false, error: "訂單不存在" });
  const order = list[idx];
  if (order.logistics_method !== "順豐")
    return res.status(400).json({ ok: false, error: "此訂單非順豐物流，無法建立運單" });
  if (!SF_CONFIG.SF_PARTNER_ID || !SF_CONFIG.SF_CHECK_WORD)
    return res.status(400).json({ ok: false, error: "尚未設定順豐憑證（SF_PARTNER_ID / SF_CHECK_WORD）" });

  try {
    const msgData = JSON.stringify(buildSfOrderPayload(order));
    const timestamp = String(Date.now());
    const form = {
      partnerID: SF_CONFIG.SF_PARTNER_ID,
      requestID: crypto.randomUUID().replace(/-/g, ""),
      serviceCode: "EXP_RECE_CREATE_ORDER",
      timestamp,
      msgData,
      msgDigest: sfMsgDigest(msgData, timestamp, SF_CONFIG.SF_CHECK_WORD),
    };
    const json = await postJson(SF_ENDPOINTS[SF_CONFIG.SF_ENV], form);
    const inner = (() => {
      try { return JSON.parse(json.apiResultData || "{}"); }
      catch (e) { return {}; }
    })();
    if (json.apiResultCode !== "A1000" || inner.success !== true) {
      return res.status(502).json({
        ok: false,
        error: inner.errorMsg || json.apiErrorMsg || "順豐下單失敗",
        errorCode: inner.errorCode || json.apiResultCode,
      });
    }
    const data = inner.msgData || {};
    const first = (data.waybillNoInfoList || [])[0] || {};
    list[idx].sf = {
      waybill_no: first.waybillNo || "",
      order_id: data.orderId || order.order_no,
      created_at: new Date().toISOString(),
      env: SF_CONFIG.SF_ENV,
      responses: json,
    };
    saveOrders(list);
    console.log(`[順豐運單] ${order.order_no} · ${first.waybillNo || "無運單號"}`);
    res.json({ ok: true, order_no: order.order_no, waybill_no: first.waybillNo || "", errorCode: inner.errorCode || "" });
  } catch (e) {
    console.error(e);
    res.status(502).json({ ok: false, error: e.message || "順豐 API 呼叫失敗" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ 數倍DTF · LIFF 下單伺服器啟動於 http://localhost:${PORT}`);
});
