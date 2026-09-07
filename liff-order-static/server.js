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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ 數倍DTF · LIFF 下單伺服器啟動於 http://localhost:${PORT}`);
});
