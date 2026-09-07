/* =========================================================
 * 數倍DTF · LIFF 下單小程序 MVP
 * - 讀取網址參數 ?liffId=xxxxx 或用預設 LIFF_ID
 * - 讀取網址參數 ?api=https://your-api.example.com 覆蓋後端網址
 * - 未設定 LIFF_ID 或非 LINE 環境時，會以「訪客模式」執行，方便本機/預覽測試
 * ========================================================= */

/* ==========================
 * 全域設定
 * ========================== */
const CONFIG = {
  // TODO：申請 LIFF 後填入預設 LIFF_ID，或直接用 ?liffId= 傳入
  LIFF_ID: "",
  // 後端接收訂單 API；
  //   - 本機：空字串（用相對路徑）
  //   - 平台預覽：__PORT_3000__ 佔位符會被替換成代理路徑
  API_BASE: (() => {
    const placeholder = "__PORT_3000__";
    return placeholder.startsWith("__") ? "" : placeholder;
  })(),
  MAX_FILE_MB: 200,  // 單一檔案大小上限（MB）
};

// 從網址參數覆蓋設定（方便切換環境）
// 例：?api=https://my-server.com  可臨時指定後端位址
(function readParams() {
  const p = new URLSearchParams(window.location.search);
  if (p.get("liffId")) CONFIG.LIFF_ID = p.get("liffId");
  if (p.get("api") !== null) CONFIG.API_BASE = p.get("api");
})();

/* ==========================
 * 全域狀態（前端共用資料）
 * ========================== */
const state = {
  step: 1,             // 目前步驟（1~4）
  files: [],           // 已選擇的檔案清單 [{ id, file, name, size, type, thumb }]
  lineProfile: null,   // LINE 用戶資料 { userId, displayName, pictureUrl }，非 LINE 環境為 null
  isInLine: false,     // 是否在 LINE 內建瀏覽器中開啟
};

/* ==========================
 * 產品類型三層連動下拉選單
 * 結構：大類 → 子類 → 規格（可選）
 *
 * 例如：
 *   紡織 > DTF > 60cm R to R / A3
 *   紡織 > 直噴（無第三層）
 *   UV   > 一般水晶標 / 燙金水晶標 / 直噴（均無第三層）
 * ========================== */
const PRODUCT_TREE = {
  "紡織": {
    "DTF": ["60cm R to R", "A3"],  // DTF 有兩種規格
    "直噴": []                      // 直噴無第三層，選完子類即完成
  },
  "UV": {
    "一般水晶標": [],               // 無第三層
    "燙金水晶標": [],              // 無第三層
    "直噴": []                      // 無第三層
  }
};

/**
 * 初始化三層連動下拉選單
 * - 大類 change → 動態載入子類選項
 * - 子類 change → 有規格則載入規格，沒有則直接組合 product_type
 * - 規格 change → 組合 product_type 到 hidden 欄位
 * - 組合格式：「大類 - 子類 - 規格」或「大類 - 子類」
 */
function initCascadeSelects() {
  const catEl = document.getElementById("productCategory");   // 大類 <select>
  const subEl = document.getElementById("productSub");        // 子類 <select>
  const specEl = document.getElementById("productSpec");      // 規格 <select>
  const hiddenEl = document.getElementById("productTypeHidden"); // 組合後的值（hidden input）

  // === 大類變動：重置子類和規格 ===
  catEl.addEventListener("change", () => {
    // 清空子類和規格的選項
    subEl.innerHTML = '<option value="">子類</option>';
    specEl.innerHTML = '<option value="">規格</option>';
    specEl.disabled = true;
    hiddenEl.value = "";

    const cat = catEl.value;
    // 如果沒選大類，或 tree 中找不到對應資料，則停用子類
    if (!cat || !PRODUCT_TREE[cat]) { subEl.disabled = true; return; }

    // 啟用子類 → 動態建立子類選項
    subEl.disabled = false;
    const subs = Object.keys(PRODUCT_TREE[cat]);
    for (const s of subs) {
      const opt = document.createElement("option");
      opt.value = s; opt.textContent = s;
      subEl.appendChild(opt);
    }
    // 如果子類只有一個選項，自動選取並觸發 change
    if (subs.length === 1) { subEl.value = subs[0]; subEl.dispatchEvent(new Event("change")); }
  });

  // === 子類變動：判斷是否有規格層 ===
  subEl.addEventListener("change", () => {
    specEl.innerHTML = '<option value="">規格</option>';
    hiddenEl.value = "";
    const cat = catEl.value;
    const sub = subEl.value;
    if (!cat || !sub) { specEl.disabled = true; updateProductHidden(); return; }

    const specs = PRODUCT_TREE[cat][sub] || [];
    if (specs.length === 0) {
      // 沒有規格（如「直噴」、「一般水晶標」），直接組合 product_type
      specEl.disabled = true;
      updateProductHidden();
    } else {
      // 有規格，載入規格選項供使用者選擇
      specEl.disabled = false;
      for (const sp of specs) {
        const opt = document.createElement("option");
        opt.value = sp; opt.textContent = sp;
        specEl.appendChild(opt);
      }
    }
  });

  // === 規格變動：更新組合值 ===
  specEl.addEventListener("change", updateProductHidden);

  /** 將大類、子類、規格組合成 product_type 字串，寫入 hidden 欄位 */
  function updateProductHidden() {
    const cat = catEl.value;
    const sub = subEl.value;
    const spec = specEl.value;
    const parts = [cat, sub, spec].filter(Boolean);
    hiddenEl.value = parts.join(" - ");
  }
}

/* ==========================
 * LINE LIFF 初始化
 * 如果有設定 LIFF_ID 就嘗試登入 LINE，
 * 否則以訪客模式執行（方便本機測試）
 * ========================== */
async function initLiff() {
  if (!CONFIG.LIFF_ID) {
    console.info("[LIFF] 未設定 LIFF_ID，以訪客模式執行");
    return;
  }
  try {
    await liff.init({ liffId: CONFIG.LIFF_ID });
    state.isInLine = liff.isInClient();
    if (!liff.isLoggedIn()) {
      // 外部瀏覽器開啟時導向登入；LINE 內建瀏覽器會自動已登入
      liff.login({ redirectUri: window.location.href });
      return;
    }
    // 取得 LINE 用戶頭像和名稱，顯示在頁面右上角
    const profile = await liff.getProfile();
    state.lineProfile = profile;
    const chip = document.getElementById("userChip");
    document.getElementById("userAvatar").src = profile.pictureUrl || "";
    document.getElementById("userName").textContent = profile.displayName || "";
    chip.hidden = false;
  } catch (err) {
    console.error("[LIFF] init error", err);
    toast("LINE 登入初始化失敗，將以訪客模式繼續。", true);
  }
}

/* ==========================
 * 步驟導覽（4 步驟表單向導）
 * Step 1: 客戶資料
 * Step 2: 訂單規格
 * Step 3: 上傳檔案
 * Step 4: 確認送出
 * ========================== */

/** 切換到指定步驟，更新面板顯示和進度指示器 */
function goToStep(n) {
  // 顯示對應步驟的面板，隱藏其他面板
  const panels = document.querySelectorAll("[data-panel]");
  panels.forEach(p => (p.hidden = Number(p.dataset.panel) !== n));

  // 更新步驟指示器的 active / done 狀態
  document.querySelectorAll(".steps li").forEach(li => {
    const idx = Number(li.dataset.step);
    li.classList.toggle("active", idx === n);   // 目前步驟高亮
    li.classList.toggle("done", idx < n);       // 已完成步驟打勾
  });
  state.step = n;

  // 進入第 4 步時，渲染訂單摘要
  if (n === 4) renderSummary();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/**
 * 驗證指定步驟的所有必填欄位
 * - 檢查所有 [required] 的 input / select / textarea 是否有值
 * - Step 2 額外檢查產品類型 hidden 欄位
 * - Step 3 要求至少上傳一個檔案
 * @returns {boolean} 驗證是否通過
 */
function validateStep(n) {
  const panel = document.querySelector(`[data-panel="${n}"]`);
  // 檢查所有標記 required 的欄位
  const inputs = panel.querySelectorAll("input[required], select[required], textarea[required]");
  for (const el of inputs) {
    if (!el.value.trim()) {
      el.focus();
      toast(`請填寫「${el.previousElementSibling?.firstChild?.textContent?.replace("*","").trim() || "必填欄位"}」`, true);
      return false;
    }
  }
  // 產品類型：檢查 hidden 欄位（三層連動下拉的組合值）
  if (n === 2) {
    const hidden = document.getElementById("productTypeHidden");
    if (!hidden.value) {
      toast("請選擇產品類型", true);
      return false;
    }
  }
  // 統編格式驗證（選填，但填了就要 8 碼數字）
  const taxId = panel.querySelector('[name="tax_id"]');
  if (taxId && taxId.value && !/^\d{8}$/.test(taxId.value)) {
    taxId.focus();
    toast("統編需為 8 碼數字", true);
    return false;
  }
  // Step 3 至少要有一個檔案
  if (n === 3 && state.files.length === 0) {
    toast("請至少上傳一個檔案", true);
    return false;
  }
  return true;
}

// 全域點擊事件：處理「下一步」和「上一步」按鈕
document.addEventListener("click", (e) => {
  const nextBtn = e.target.closest("[data-next]");  // 下一步按鈕（data-next="2" 等）
  const prevBtn = e.target.closest("[data-prev]");  // 上一步按鈕（data-prev="1" 等）
  if (nextBtn) {
    const cur = state.step;
    if (!validateStep(cur)) return;  // 驗證不通過則不前進
    goToStep(Number(nextBtn.dataset.next));
  } else if (prevBtn) {
    goToStep(Number(prevBtn.dataset.prev));
  }
});

/* ==========================
 * 檔案上傳區塊
 * 支援拖曳上傳和點擊選擇檔案
 * ========================== */
const dz = document.getElementById("dropzone");        // 拖曳上傳區域
const fileInput = document.getElementById("fileInput"); // 隱藏的檔案選擇 input
const fileList = document.getElementById("fileList");   // 已選檔案清單 <ul>

// 點擊拖曳區域 → 開啟檔案選擇器
dz.addEventListener("click", () => fileInput.click());

// 拖曳進入 / 懸停時加上高亮樣式
["dragenter", "dragover"].forEach(ev =>
  dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); })
);

// 拖曳離開 / 放下時移除高亮樣式
["dragleave", "drop"].forEach(ev =>
  dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); })
);

// 放下檔案 → 加入清單
dz.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));
// 點擊選擇檔案 → 加入清單
fileInput.addEventListener("change", (e) => addFiles(e.target.files));

/**
 * 將選擇的檔案加入上傳清單
 * - 檢查檔案大小是否超過上限
 * - 為每個檔案建立唯一 ID
 * - 圖片格式自動產生縮圖
 * @param {FileList} fileListObj - 使用者選擇的檔案列表
 */
function addFiles(fileListObj) {
  const arr = Array.from(fileListObj || []);
  for (const f of arr) {
    // 檔案大小檢查
    if (f.size > CONFIG.MAX_FILE_MB * 1024 * 1024) {
      toast(`${f.name} 超過 ${CONFIG.MAX_FILE_MB}MB，未加入`, true);
      continue;
    }
    // 建立檔案物件並加入全域狀態
    const id = crypto.randomUUID();  // 產生唯一 ID
    const item = { id, file: f, name: f.name, size: f.size, type: f.type, thumb: null };
    state.files.push(item);
    renderFileItem(item);  // 在畫面上顯示檔案項目

    // 只有圖片格式（PNG / JPG / GIF / WebP / SVG）才產縮圖
    if (/^image\/(png|jpe?g|gif|webp|svg\+xml)$/.test(f.type)) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        item.thumb = ev.target.result;  // 儲存 base64 縮圖
        const el = fileList.querySelector(`[data-id="${id}"] .thumb`);
        if (el) el.innerHTML = `<img src="${item.thumb}" alt="" />`;
      };
      reader.readAsDataURL(f);
    }
  }
  fileInput.value = "";  // 清空 input，允許重複選同檔案
}

/**
 * 在畫面上渲染一個檔案項目（<li>）
 * 顯示：副檔名縮圖 / 檔名 / 檔案大小 / 移除按鈕
 */
function renderFileItem(item) {
  const li = document.createElement("li");
  li.className = "file-item";
  li.dataset.id = item.id;
  // 取副檔名作為縮圖文字（截取前 4 字元）
  const ext = (item.name.split(".").pop() || "").toUpperCase().slice(0, 4);
  li.innerHTML = `
    <div class="thumb">${ext}</div>
    <div class="meta">
      <div class="name">${escapeHtml(item.name)}</div>
      <div class="sub">${formatSize(item.size)} · <span class="status">待送出</span></div>
      <div class="progress-bar" hidden><i></i></div>
    </div>
    <button type="button" class="remove" aria-label="移除" title="移除">&times;</button>
  `;
  // 點擊 × 移除檔案
  li.querySelector(".remove").addEventListener("click", () => {
    state.files = state.files.filter(x => x.id !== item.id);
    li.remove();
  });
  fileList.appendChild(li);
}

/**
 * 更新指定檔案的上傳進度條
 * @param {string} id   - 檔案的唯一 ID
 * @param {number} pct  - 進度百分比（0~100）
 * @param {string} status - 狀態文字（如「上傳中」「已上傳」）
 */
function updateFileProgress(id, pct, status) {
  const li = fileList.querySelector(`[data-id="${id}"]`);
  if (!li) return;
  const bar = li.querySelector(".progress-bar");
  bar.hidden = false;
  bar.querySelector("i").style.width = `${Math.min(100, Math.max(0, pct))}%`;
  if (status) li.querySelector(".status").textContent = status;
}

/* ==========================
 * 訂單摘要（Step 4）
 * ========================== */

/** 從表單收集所有欄位資料，回傳物件 */
function collectFormData() {
  const fd = new FormData(document.getElementById("orderForm"));
  const obj = {};
  fd.forEach((v, k) => (obj[k] = v));
  return obj;
}

/** 渲染 Step 4 的訂單摘要，包含所有欄位和已選檔案清單 */
function renderSummary() {
  const d = collectFormData();
  // 要顯示的欄位列表（標籤, 值）
  const rows = [
    ["客戶", d.customer_name],
    ["聯絡人", d.contact_name],
    ["電話", d.phone],
    ["統編", d.tax_id || "—"],
    ["產品類型", d.product_type],
    ["數量", d.quantity],
    ["尺寸", d.size || "—"],
    ["材質", d.material || "—"],
    ["後加工", d.finish || "—"],
    ["緊急", d.priority || "—"],
    ["交貨日", d.due_date || "—"],
    ["備註", d.notes || "—"],
  ];
  // 產生 <dl> 摘要 HTML
  const dlHtml = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v || "—"))}</dd>`).join("");
  // 產生檔案清單 HTML
  const filesHtml = state.files.length
    ? state.files.map(f => `• ${escapeHtml(f.name)} <span style="color:var(--ink-3)">(${formatSize(f.size)})</span>`).join("<br />")
    : "（無檔案）";

  document.getElementById("summary").innerHTML = `
    <dl>${dlHtml}</dl>
    <div class="files"><strong>檔案（${state.files.length}）</strong><br />${filesHtml}</div>
  `;
  // 重置同意勾選和送出按鈕
  document.getElementById("agree").checked = false;
  document.getElementById("submitBtn").disabled = true;
}

// 同意勾選框：勾選後才啟用送出按鈕
document.getElementById("agree").addEventListener("change", (e) => {
  document.getElementById("submitBtn").disabled = !e.target.checked;
});

/* ==========================
 * 表單送出流程
 * 1. 驗證所有步驟
 * 2. 建立訂單（POST /api/orders）
 * 3. 逐檔上傳（POST /api/orders/:no/files）
 * 4. 通知後端上傳完成（POST /api/orders/:no/complete）
 * 5. 若在 LINE 內，發送摘要訊息到聊天室
 * 6. 顯示成功畫面
 * ========================== */
document.getElementById("orderForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  // 驗證三個步驟的必填欄位
  if (!validateStep(1) || !validateStep(2) || !validateStep(3)) return;

  const btn = document.getElementById("submitBtn");
  btn.disabled = true; btn.textContent = "送出中...";

  try {
    // 組裝訂單資料
    const orderPayload = collectFormData();
    orderPayload.line_user_id = state.lineProfile?.userId || null;
    orderPayload.line_display_name = state.lineProfile?.displayName || null;
    orderPayload.source = state.isInLine ? "LINE-LIFF" : "WEB";  // 標記訂單來源
    orderPayload.client_time = new Date().toISOString();

    // Step 1：建立訂單，取得訂單編號
    const orderRes = await postJSON(`${CONFIG.API_BASE}/api/orders`, orderPayload);
    if (!orderRes.ok) throw new Error(orderRes.error || "建立訂單失敗");
    const orderNo = orderRes.order_no;

    // Step 2：逐檔上傳（每個檔案上傳完成後才上下一個）
    for (const item of state.files) {
      updateFileProgress(item.id, 5, "上傳中");
      await uploadFile(orderNo, item, (pct) => updateFileProgress(item.id, pct, "上傳中"));
      updateFileProgress(item.id, 100, "已上傳");
    }

    // Step 3：通知後端所有檔案已上傳完成
    await postJSON(`${CONFIG.API_BASE}/api/orders/${encodeURIComponent(orderNo)}/complete`, {});

    // Step 4：若在 LINE 內，發送訂單摘要訊息到聊天室
    if (state.isInLine && window.liff && liff.isInClient()) {
      try {
        await liff.sendMessages([{
          type: "text",
          text: `【已下單】${orderPayload.customer_name}\n訂單編號：${orderNo}\n產品：${orderPayload.product_type}\n數量：${orderPayload.quantity}\n預定交貨：${orderPayload.due_date || "未指定"}\n附件：${state.files.length} 個檔案`
        }]);
      } catch (e) { /* 使用者拒絕授權也不影響下單流程 */ }
    }

    // Step 5：顯示成功畫面
    document.getElementById("orderForm").hidden = true;
    document.querySelector(".steps").hidden = true;
    const s = document.getElementById("successPanel");
    s.hidden = false;
    document.getElementById("orderNoBig").textContent = orderNo;
  } catch (err) {
    console.error(err);
    toast(err.message || "送出失敗，請稍後再試", true);
    btn.disabled = false; btn.textContent = "送出訂單";
  }
});

// 成功畫面按鈕：再下一單 / 關閉視窗
document.getElementById("newOrderBtn").addEventListener("click", () => location.reload());
document.getElementById("closeLiffBtn").addEventListener("click", () => {
  // LINE 內建瀏覽器關閉 LIFF 視窗，否則重新整理頁面
  if (window.liff && liff.isInClient()) liff.closeWindow();
  else location.reload();
});

/* ==========================
 * 工具函式
 * ========================== */

/**
 * 發送 JSON 請求（POST）
 * @param {string} url  - API 端點
 * @param {object} data - 要送出的 JSON 資料
 * @returns {Promise<object>} 回傳的 JSON 物件
 */
async function postJSON(url, data) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${txt.slice(0,120)}`);
  }
  return res.json();
}

/**
 * 上傳單一檔案到後端（使用 XMLHttpRequest 以支援進度回報）
 * @param {string}   orderNo   - 訂單編號
 * @param {object}   item      - 檔案物件 { file, name, ... }
 * @param {function} onProgress - 進度回呼（參數為 0~100 的百分比）
 * @returns {Promise<object>} 上傳成功的回應
 */
function uploadFile(orderNo, item, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const fd = new FormData();
    fd.append("file", item.file, item.name);
    xhr.open("POST", `${CONFIG.API_BASE}/api/orders/${encodeURIComponent(orderNo)}/files`);
    // 上傳進度回報
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({ ok: true }); }
      } else reject(new Error(`檔案上傳失敗 (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("網路錯誤，檔案上傳失敗"));
    xhr.send(fd);
  });
}

/**
 * 格式化檔案大小
 * @param {number} bytes - 檔案位元組數
 * @returns {string} 格式化後的大小字串（如 "1.5 MB"）
 */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * HTML 轉義：避免 XSS 攻擊
 * @param {string} s - 原始字串
 * @returns {string} 轉義後的安全字串
 */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/**
 * 顯示提示訊息（Toast）
 * @param {string}  msg     - 訊息內容
 * @param {boolean} isError - 是否為錯誤訊息（紅色背景）
 */
function toast(msg, isError) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.toggle("error", !!isError);
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 2600);  // 2.6 秒後自動隱藏
}

/* ==========================
 * 程式啟動
 * ========================== */
initCascadeSelects();  // 初始化產品類型三層連動下拉
initLiff();            // 初始化 LINE LIFF（非 LINE 環境會自動跳過）
goToStep(1);           // 從第 1 步開始