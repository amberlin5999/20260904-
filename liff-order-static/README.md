# 數倍DTF · LIFF 下單 MVP

一個可掛在 LINE@ 上的線上下單小程序，取代目前 LINE / Email / GDrive 混合下單流程。

## 檔案結構

```
liff-order/
├─ index.html       前端頁面（4 步驟：客戶資料 → 規格 → 檔案 → 確認）
├─ style.css        樣式（行動裝置優先，適配 LINE 內建瀏覽器）
├─ app.js           前端邏輯 + LIFF SDK 整合
├─ server.js        Node.js 後端（收單、存檔）
├─ package.json     Node 依賴
└─ uploads/         上傳檔案存放（自動建立，依訂單編號分資料夾）
```

## 本機測試（先驗證功能，不需 LINE）

```bash
cd liff-order
npm install
npm start
# → 開啟 http://localhost:3000
```

在瀏覽器直接下單即可測試。訂單會存到 `orders.json`，檔案存到 `uploads/<訂單編號>/01_original/`。

## 上線給客戶用（LINE LIFF 設定）

### 1. 部署你的網站到公開網域（必須 HTTPS）
- 推薦：Cloudflare Pages / Vercel / Zeabur / 自己的伺服器 + Nginx + Let's Encrypt
- 假設部署後網址是 `https://order.yourdomain.com`

### 2. 到 LINE Developers 建立 LIFF App
1. 開啟 https://developers.line.biz/console/
2. 選擇你的 Provider（若沒有先新建）→ 建立一個 **LINE Login channel**
3. 進到該 channel → 上方分頁選 **LIFF** → **Add**
4. 填入：
   - LIFF app name：`數倍DTF 下單`
   - Size：**Full**（全螢幕）
   - Endpoint URL：`https://order.yourdomain.com/`
   - Scopes：勾選 **profile**、**openid**、**chat_message.write**（後兩者讓小程序能發訊息回聊天室）
   - Bot link feature：Aggressive（可自動加好友）
5. 建立後會拿到一組 **LIFF ID**（形如 `1234567890-abcdefgh`）

### 3. 把 LIFF ID 填入前端
編輯 `app.js`：
```js
const CONFIG = {
  LIFF_ID: "1234567890-abcdefgh",  // ← 填這裡
  ...
};
```
或不改程式碼，用網址參數：`https://order.yourdomain.com/?liffId=1234567890-abcdefgh`

### 4. 把 LIFF URL 掛到你的 LINE@
1. 到 https://manager.line.biz/ 進入你的官方帳號
2. 主頁 → 圖文選單（Rich Menu）→ 新增一個「線上下單」按鈕
3. 動作設為 **URI**，貼上 LIFF URL：`https://liff.line.me/1234567890-abcdefgh`
4. 儲存並套用 → 客戶在 LINE@ 就會看到「線上下單」按鈕

也可以直接把 `https://liff.line.me/xxx` 傳給客戶，他們一點就會在 LINE 內開啟。

## 後續要接的（本 MVP 之後的擴充點）

以下都是**未來要接就換掉某個檔案/端點**的位置，不影響前端：

| 功能 | 現在（MVP） | 之後正式版 |
|---|---|---|
| 訂單存放 | `orders.json` | PostgreSQL（Django ORM） |
| 檔案儲存 | 本機 `uploads/` | MinIO / Google Cloud Storage / S3 |
| 訂單通知 | `console.log` | LINE Messaging API 推內部群組 + Email |
| 客戶識別 | LINE profile 記錄在訂單內 | 綁定既有客戶資料庫（130 筆） |
| 檔案預檢 | 無 | 上傳完自動觸發 Python 印前腳本（尺寸/DPI/白墨層） |
| 對稿 | 無 | 產生對稿連結，客戶線上簽核 |

## API 端點清單（給後端替換參考）

- `POST /api/orders` — body: 訂單欄位 JSON → 回 `{ ok, order_no }`
- `POST /api/orders/:no/files` — multipart, field `file` → 回 `{ ok, file }`
- `POST /api/orders/:no/complete` — 通知全部檔案上傳完 → 回 `{ ok }`
- `GET /api/orders` — 列出所有訂單（後台用，正式版請加驗證）

## 訂單編號規則

沿用你 Excel 的規則：`YYYYMMDD` + `3 碼流水號`，例：`20260904001`
工單編號規則（第二期實作）：`<產品類型>-YYYYMMDD-###`，例：`DTF-20260904-001`
