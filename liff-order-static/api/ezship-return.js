/* 便利配（ezShip）電子地圖回傳端點（Vercel Serverless）
 * 選完門市後，ezShip 會以 GET 或 POST 轉頁到 rtURL（也就是本函式），
 * 並帶回 stCate / stCode / stName / stAddr / stTel。
 *
 * 回傳一份 HTML：
 *   1. 把門市資料寫進 localStorage（與下單頁同網域）
 *   2. 透過 postMessage 通知開啟此視窗的下單頁
 *   3. 自動關閉視窗
 *
 * 為何不能用靜態 ezship-return.html：
 * Vercel 靜態檔不接受 POST（會回 405），ezShip 選完門市是 POST 轉頁，
 * 所以必須用能收 POST 的 serverless 函式。
 */
module.exports = (req, res) => {
  const params = { ...(req.query || {}) };

  // POST 時補讀 body（可能 form-encoded 或 JSON）
  if (req.method === "POST" && req.body) {
    try {
      if (typeof req.body === "string") {
        if (req.body.includes("=")) Object.assign(params, Object.fromEntries(new URLSearchParams(req.body)));
        else Object.assign(params, JSON.parse(req.body));
      } else if (typeof req.body === "object") {
        Object.assign(params, req.body);
      }
    } catch (e) { /* 忽略無法解析的 body */ }
  }

  const store = {
    cate: params.stCate || "",  // TOK=OK / TLF=萊爾富 / TFM=全家
    code: params.stCode || "",  // 網站串接專用門市代碼
    name: params.stName || "",
    addr: params.stAddr || "",
    tel: params.stTel || "",
  };

  // 安全序列化：避免 </script> 被注入
  const json = JSON.stringify(store).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

  const html = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>門市選擇完成</title>
<style>
  html, body { min-height: 100%; }
  body { font-family: "Helvetica Neue", Arial, "Microsoft JhengHei", sans-serif; margin: 0;
    display: flex; align-items: center; justify-content: center; background: #f6f7f9; color: #334155; text-align: center; }
  .box { padding: 24px; font-size: 15px; line-height: 1.7; }
  .ok { font-size: 40px; }
</style>
</head>
<body>
  <div class="box">
    <div class="ok">&#10003;</div>
    <div>門市已選擇完成，此視窗即將自動關閉。</div>
    <div>若未自動關閉，請手動關閉並回到下單頁面。</div>
  </div>
  <script>
    (function () {
      var store = ${json};
      if (store.code) {
        try { localStorage.setItem("ezship_store_pending", JSON.stringify(store)); } catch (e) {}
        if (window.opener) {
          setTimeout(function () {
            try { window.opener.postMessage({ type: "EZShipStoreSelected", store: store }, "*"); } catch (e) {}
          }, 100);
        }
      }
      setTimeout(function () { window.close(); }, 400);
    })();
  </script>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(html);
};