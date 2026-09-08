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
  // LINE LIFF App ID（LINE Developers 主控台建立；也可被 ?liffId= 網址參數覆蓋）
  LIFF_ID: "2011509391-nPhkZAro",
  // 後端接收訂單 API（Cloudflare Workers：D1 存訂單、R2 存印刷檔）
  // 網址參數 ?api=https://... 可臨時覆蓋
  API_BASE: "https://shubei-liff-order.shubei-liff-worker.workers.dev",
  MAX_FILE_MB: 95,  // 單一檔案大小上限（MB）；與後端 MAX_FILE_MB 一致
  MAX_FILE_COUNT: 40,  // 單筆訂單檔案數量上限
  // 超商取貨：ezShip（台灣便利配）賣家帳號，需先在 ezShip 開通「網站串接」服務
  EZSIP_SUID: "aceeprint@gmail.com",
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
  step: 1,             // 目前步驟（1~3）
  files: [],           // 已選擇的檔案清單 [{ id, file, name, size, type, thumb, qty }]
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
 *
 * 計價單位（依產品自動帶入）：
 *   R to R            → 次
 *   DTF A3 / 水晶標   → 張
 *   直噴              → 件
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

/* ==========================
 * 依產品限制可上傳的檔類型
 * 組合格式＼「大類 - 子類 - 規格」，須與 PRODUCT_TREE 一致
 * ========================== */
const EXT_LABELS = {
  ".ai": "AI", ".psd": "PSD", ".pdf": "PDF", ".png": "PNG",
  ".jpg": "JPG", ".jpeg": "JPG", ".tif": "TIFF", ".tiff": "TIFF",
  ".svg": "SVG", ".eps": "EPS", ".zip": "ZIP",
};

const PRODUCT_FILE_TYPES = {
  "紡織 - DTF - 60cm R to R": [".png", ".ai", ".pdf", ".psd"],
  "紡織 - DTF - A3": [".png"],
  "紡織 - 直噴": [".png"],
  "UV - 一般水晶標": [".pdf", ".ai", ".psd"],
  "UV - 燙金水晶標": [".pdf", ".ai", ".psd"],
  "UV - 直噴": [".pdf", ".ai", ".psd"],
};

// 全部產品共通的可用類型（未選產品或未定義規則時的預設）
const ALL_FILE_TYPES = [...new Set(Object.values(PRODUCT_FILE_TYPES).flat())];

/** 依目前選擇的產品回傳允許的副檔名清單（未選齊產品 → 全部類型） */
function currentAllowedExts() {
  const pt = document.getElementById("productTypeHidden")?.value || "";
  return PRODUCT_FILE_TYPES[pt] || ALL_FILE_TYPES;
}

/** 把副檔名清單轉成顯示名稱，例如：["PNG", "AI", "PDF"] */
function fmtExts(list) {
  return [...new Set(list)].map((e) => EXT_LABELS[e] || e.slice(1).toUpperCase()).join(" / ");
}

/** 依產品更新檔案選擇器的 accept 與提示文字 */
function updateFileTypes() {
  const ext = currentAllowedExts();
  fileInput.accept = ext.join(",");
  const hint = document.getElementById("fileHint");
  if (hint) hint.textContent = `此產品僅接受 ${fmtExts(ext)}；單檔最大 ${CONFIG.MAX_FILE_MB}MB、一單最多 ${CONFIG.MAX_FILE_COUNT} 個，可一次多選；上傳後可設定每個檔案的印製數量（預設 1）。`;
}

/** 依目前所選的產品組合，回傳計價單位 */
function getUnit() {
  const cat = document.getElementById("productCategory")?.value || "";
  const sub = document.getElementById("productSub")?.value || "";
  const spec = document.getElementById("productSpec")?.value || "";
  if (cat === "紡織" && sub === "DTF") {
    if (spec === "60cm R to R") return "次";
    if (spec === "A3") return "張";
    return "";  // 規格尚未選齊
  }
  if (cat === "紡織" && sub === "直噴") return "件";
  if (cat === "UV" && sub === "直噴") return "件";
  if (cat === "UV" && (sub === "一般水晶標" || sub === "燙金水晶標")) return "張";
  return "";
}

/** 同步更新畫面上的計價單位（欄位 + 提示文字 + 每個檔案的單位標籤） */
function updateUnit() {
  const unit = getUnit();
  const unitInput = document.getElementById("unitInput");
  if (unitInput) unitInput.value = unit;
  const hint = document.getElementById("unitHint");
  if (hint) hint.textContent = unit ? `計價單位：${unit}` : "計價單位將依產品類型自動帶入";
  document.querySelectorAll("[data-unit-label]").forEach(el => { el.textContent = unit || ""; });
}

/**
 * 初始化三層連動下拉選單
 * - 大類 change → 動態載入子類選項，並更新計價單位
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
    updateFileTypes();

    const cat = catEl.value;
    // 如果沒選大類，或 tree 中找不到對應資料，則停用子類
    if (!cat || !PRODUCT_TREE[cat]) { subEl.disabled = true; updateUnit(); return; }

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
    updateUnit();
  });

  // === 子類變動：判斷是否有規格層 ===
  subEl.addEventListener("change", () => {
    specEl.innerHTML = '<option value="">規格</option>';
    hiddenEl.value = "";
    updateFileTypes();
    const cat = catEl.value;
    const sub = subEl.value;
    if (!cat || !sub) { specEl.disabled = true; updateProductHidden(); updateUnit(); return; }

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
    updateUnit();
  });

  // === 規格變動：更新組合值與計價單位 ===
  specEl.addEventListener("change", () => { updateProductHidden(); updateUnit(); });

  /** 將大類、子類、規格組合成 product_type 字串，寫入 hidden 欄位 */
  function updateProductHidden() {
    const cat = catEl.value;
    const sub = subEl.value;
    const spec = specEl.value;
    const parts = [cat, sub, spec].filter(Boolean);
    hiddenEl.value = parts.join(" - ");
    updateFileTypes();
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
 * 步驟導覽（3 步驟表單向導）
 * Step 1: 客戶資料
 * Step 2: 訂單規格 + 檔案上傳
 * Step 3: 確認 + 物流 + 送出
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

  // 進入最後一步時，渲染訂單摘要 + 更新物流欄位顯示
  if (n === 3) { renderSummary(); syncLogisticsFields(); }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/**
 * 驗證指定步驟的所有必填欄位
 * - 檢查所有 [required] 的 input / select / textarea 是否有值
 * - Step 2 檢查產品類型、至少要一個檔案、每個檔案數量 ≥ 1
 * - Step 3 檢查物流方式與其對應欄位、要勾選同意
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

  // Step 2：產品類型 + 檔案數量
  if (n === 2) {
    const hidden = document.getElementById("productTypeHidden");
    if (!hidden.value) {
      toast("請選擇產品類型", true);
      return false;
    }
    if (state.files.length === 0) {
      toast("請至少上傳一個檔案", true);
      return false;
    }
    for (const f of state.files) {
      if (!(Number(f.qty) >= 1)) {
        toast("請確認每個檔案的印製數量", true);
        return false;
      }
    }
  }

  // 統編格式驗證（選填，但填了就要 8 碼數字）
  const taxId = panel.querySelector('[name="tax_id"]');
  if (taxId && taxId.value && !/^\d{8}$/.test(taxId.value)) {
    taxId.focus();
    toast("統編需為 8 碼數字", true);
    return false;
  }

  // Step 3：物流方式 + 收件資訊 + 同意勾選
  if (n === 3) {
    const method = document.getElementById("logisticsMethod").value;
    if (!method) {
      toast("請選擇物流方式", true);
      document.getElementById("logisticsMethod").focus();
      return false;
    }
    if (method !== "自取") {
      const nameEl = panel.querySelector('[name="recipient_name"]');
      const phoneEl = panel.querySelector('[name="recipient_phone"]');
      if (!nameEl.value.trim()) { toast("請填寫收件人", true); nameEl.focus(); return false; }
      if (!phoneEl.value.trim()) { toast("請填寫收件電話", true); phoneEl.focus(); return false; }
      if (method === "順豐") {
        const addrEl = panel.querySelector('[name="recipient_address"]');
        if (!addrEl.value.trim()) { toast("請填寫收件地址", true); addrEl.focus(); return false; }
      } else if (method === "超商取貨") {
        const storeEl = panel.querySelector('[name="store_name"]');
        if (!storeEl.value.trim()) { toast("請填寫取貨門市", true); storeEl.focus(); return false; }
      }
    }
    if (!document.getElementById("agree").checked) {
      toast("請勾選「確認資訊無誤」", true);
      return false;
    }
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
 * 物流方式連動顯示
 * 順豐 → 收件人 + 電話 + 地址
 * 超商取貨 → 收件人 + 電話 + 門市
 * 自取 → 不需要收件資料
 * ========================== */
function syncLogisticsFields() {
  const method = document.getElementById("logisticsMethod").value;
  const recipient = document.getElementById("recipientFields");
  const address = document.getElementById("addressField");
  const store = document.getElementById("storeField");
  recipient.hidden = method === "自取" || !method;
  address.hidden = method !== "順豐";
  store.hidden = method !== "超商取貨";
}

document.addEventListener("change", (e) => {
  if (e.target.id === "logisticsMethod") syncLogisticsFields();
});

/* ==========================
 * 超商取貨：門市選擇（ezShip 電子地圖）
 * 流程：點「選擇門市」→ 開新視窗連到 https://map.ezship.com.tw
 *   → 消費者選好門市 → ezShip 導回 ezship-return.html
 *   → 回傳頁把門市資料透過 postMessage + localStorage 交回主視窗
 * 開新視窗是為了避免整個下單頁被跳走、已填的資料與檔案遺失。
 * 參考：ezShip 參數版說明（程式碼說明：連結電子地圖）
 * ========================== */
function openStoreMap() {
  if (!CONFIG.EZSIP_SUID) {
    toast("尚未設定超商取貨帳號（CONFIG.EZSIP_SUID）", true);
    return;
  }
  // 處理序號：ezShip 原值回傳，用來辨識是哪一次選擇
  const pid = "st" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  localStorage.removeItem("ezship_store_pending");
  // 回傳端點：ezShip 選完門市用 POST 轉頁回來，Vercel 靜態檔不收 POST，
  // 所以指向 serverless 函式 api/ezship-return（GET/POST 皆可）
  const rtURL = "https://aceeprint.vercel.app/api/ezship-return";
  const url =
    "https://map.ezship.com.tw/ezship_map_web.jsp?suID=" + encodeURIComponent(CONFIG.EZSIP_SUID) +
    "&processID=" + encodeURIComponent(pid) +
    "&rtURL=" + encodeURIComponent(rtURL) +
    "&webPara=" + encodeURIComponent(pid);
  const win = window.open(url, "_blank");
  if (!win) toast("請允許開啟新視窗，才能連結便利配門市地圖", true);
  // localStorage 輪詢備援（某些環境 postMessage 不可靠）
  let tries = 0;
  clearInterval(window._ezshipPoll);
  window._ezshipPoll = setInterval(() => {
    tries++;
    const raw = localStorage.getItem("ezship_store_pending");
    if (raw) {
      clearInterval(window._ezshipPoll);
      localStorage.removeItem("ezship_store_pending");
      try { applyEzShipStore(JSON.parse(raw)); } catch (err) {
        toast("門市資料解析失敗，請重試", true);
      }
    } else if (tries > 120) {
      clearInterval(window._ezshipPoll);
    }
  }, 500);
}

// ezShip 回傳門市資料，填入表單
function applyEzShipStore(s) {
  if (!s || !s.code) { toast("門市選擇失敗，請重試", true); return; }
  document.getElementById("storeName").value = s.name + "（" + s.cate + " " + s.code + "）";
  document.getElementById("stCate").value = s.cate || "";
  document.getElementById("stCode").value = s.code || "";
  document.getElementById("stAddr").value = s.addr || "";
  document.getElementById("stTel").value = s.tel || "";
  const hint = document.getElementById("storeAddr");
  if (hint) hint.textContent = s.addr || "已選擇門市";
  toast("已選擇門市：" + s.name);
}

// 接收 ezship-return.html 的 postMessage
window.addEventListener("message", (e) => {
  if (e.data && e.data.type === "EZShipStoreSelected") applyEzShipStore(e.data.store);
});

document.getElementById("storePickBtn").addEventListener("click", openStoreMap);

/* ==========================
 * 檔案上傳區塊
 * 支援拖曳上傳和點擊選擇檔案
 * 每個檔案可設定各自的印製數量（預設 1）
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
 * - 為每個檔案建立唯一 ID，數量預設 1
 * - 圖片格式自動產生縮圖
 * @param {FileList} fileListObj - 使用者選擇的檔案列表
 */
function addFiles(fileListObj) {
  const arr = Array.from(fileListObj || []);
  // 需先選擇產品類型，才能依產品過濾檔名格式
  if (!document.getElementById("productTypeHidden")?.value) {
    toast("請先選擇產品類型", true);
    fileInput.value = "";
    return;
  }
  const allowed = currentAllowedExts();
  for (const f of arr) {
    // 檔案數量檢查：單筆訂單最多 MAX_FILE_COUNT 個
    if (state.files.length >= CONFIG.MAX_FILE_COUNT) {
      toast(`單筆訂單最多上傳 ${CONFIG.MAX_FILE_COUNT} 個檔案，已停止加入`, true);
      break;
    }
    // 檔案大小檢查
    if (f.size > CONFIG.MAX_FILE_MB * 1024 * 1024) {
      toast(`${f.name} 超過 ${CONFIG.MAX_FILE_MB}MB，未加入`, true);
      continue;
    }
    // 副檔名檢查：此產品僅接受特定格式
    const ext = "." + (f.name.split(".").pop() || "").toLowerCase();
    if (!allowed.includes(ext)) {
      toast(`${f.name} 不是此產品可接受的格式（僅接受 ${fmtExts(allowed)}）`, true);
      continue;
    }
    // 建立檔案物件並加入全域狀態
    const id = crypto.randomUUID();  // 產生唯一 ID
    const item = { id, file: f, name: f.name, size: f.size, type: f.type, thumb: null, qty: 1 };
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
  updateUnit();          // 同步更新單位標籤
}

/**
 * 在畫面上渲染一個檔案項目（<li>）
 * 顯示：副檔名縮圖 / 檔名 / 檔案大小 / 印製數量控制器 / 移除按鈕
 */
function renderFileItem(item) {
  const li = document.createElement("li");
  li.className = "file-item";
  li.dataset.id = item.id;
  // 取副檔名作為縮圖文字（截取前 4 字元）
  const ext = (item.name.split(".").pop() || "").toUpperCase().slice(0, 4);
  const unit = getUnit() || "";
  li.innerHTML = `
    <div class="thumb">${ext}</div>
    <div class="meta">
      <div class="name">${escapeHtml(item.name)}</div>
      <div class="sub">${formatSize(item.size)} · <span class="status">待送出</span></div>
      <div class="progress-bar" hidden><i></i></div>
    </div>
    <div class="qty">
      <button type="button" class="qty-btn qty-dec" title="減少">−</button>
      <input type="number" class="qty-input" value="${item.qty}" min="1" inputmode="numeric" aria-label="印製數量" />
      <button type="button" class="qty-btn qty-inc" title="增加">+</button>
      <span class="qty-unit" data-unit-label>${unit}</span>
    </div>
    <button type="button" class="remove" aria-label="移除" title="移除">&times;</button>
  `;

  const updateQty = (v) => {
    v = Math.max(1, Math.floor(Number(v) || 1));
    item.qty = v;
    qtyInput.value = v;
  };

  const qtyInput = li.querySelector(".qty-input");
  // 減少數量（最低 1）
  li.querySelector(".qty-dec").addEventListener("click", () => updateQty((Number(qtyInput.value) || 1) - 1));
  // 增加數量
  li.querySelector(".qty-inc").addEventListener("click", () => updateQty((Number(qtyInput.value) || 1) + 1));
  // 直接輸入數量
  qtyInput.addEventListener("change", () => updateQty(qtyInput.value));

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
 * 訂單摘要（Step 3）
 * ========================== */

/** 從表單收集所有欄位資料，回傳物件 */
function collectFormData() {
  const fd = new FormData(document.getElementById("orderForm"));
  const obj = {};
  fd.forEach((v, k) => (obj[k] = v));
  return obj;
}

/** 加總所有檔案的印製數量 */
function totalQty() {
  return state.files.reduce((s, f) => s + (Number(f.qty) || 0), 0);
}

/** 渲染 Step 3 的訂單摘要，包含所有欄位和已選檔案清單 */
function renderSummary() {
  const d = collectFormData();
  const unit = getUnit() || d.unit || "";
  // 要顯示的欄位列表（標籤, 值）
  const rows = [
    ["客戶", d.customer_name],
    ["聯絡人", d.contact_name],
    ["電話", d.phone],
    ["統編", d.tax_id || "—"],
    ["產品類型", d.product_type],
["材質", d.material || "—"],
    ["後加工", d.finish || "—"],
    ["緊急", d.priority || "—"],
    ["交貨日", d.due_date || "—"],
    ["備註", d.notes || "—"],
  ];
  // 產生 <dl> 摘要 HTML
  const dlHtml = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v || "—"))}</dd>`).join("");
  // 產生檔案清單 HTML（每個檔案顯示 ×印製數量）
  const filesHtml = state.files.length
    ? state.files.map(f => `• ${escapeHtml(f.name)} <span style="color:var(--ink-3)">× ${f.qty} ${unit} · ${formatSize(f.size)}</span>`).join("<br />")
    : "（無檔案）";

  document.getElementById("summary").innerHTML = `
    <dl>${dlHtml}</dl>
    <div class="files"><strong>檔案（${state.files.length} 個 · 共計 ${totalQty()} ${unit}）</strong><br />${filesHtml}</div>
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
 * 3. 逐檔上傳（POST /api/orders/:no/files，附帶該檔印製數量）
 * 4. 通知後端上傳完成（POST /api/orders/:no/complete）
 * 5. 若在 LINE 內，發送摘要訊息到聊天室
 * 6. 顯示成功畫面
 * ========================== */
document.getElementById("orderForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  // 驗證所有步驟的必填欄位
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
    // 總印製數量 = 所有檔案數量加總；計價單位依產品帶入
    orderPayload.quantity = totalQty();
    orderPayload.unit = getUnit() || "";

    // Step 1：建立訂單，取得訂單編號
    const orderRes = await postJSON(`${CONFIG.API_BASE}/api/orders`, orderPayload);
    if (!orderRes.ok) throw new Error(orderRes.error || "建立訂單失敗");
    const orderNo = orderRes.order_no;

    // Step 2：逐檔上傳（每個檔案附帶印製數量，上傳完成才上下一個）
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
          text: `【已下單】${orderPayload.customer_name}\n訂單編號：${orderNo}\n產品：${orderPayload.product_type}\n印製量：${totalQty()} ${orderPayload.unit || ""}\n物流：${orderPayload.logistics_method}\n預定交貨：${orderPayload.due_date || "未指定"}\n檔案：${state.files.length} 個`
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
 * Cloudflare Workers 不接受 multipart，直接以 raw body 送上傳，
 * 檔名走 X-File-Name 表頭（URI 編碼）、印製數量走 X-File-Qty
 * @param {string}   orderNo   - 訂單編號
 * @param {object}   item      - 檔案物件 { file, name, qty, ... }
 * @param {function} onProgress - 進度回呼（參數為 0~100 的百分比）
 * @returns {Promise<object>} 上傳成功的回應
 */
function uploadFile(orderNo, item, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${CONFIG.API_BASE}/api/orders/${encodeURIComponent(orderNo)}/files`);
    xhr.setRequestHeader("Content-Type", item.file.type || "application/octet-stream");
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(item.name));
    xhr.setRequestHeader("X-File-Qty", String(item.qty || 1));
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
    xhr.send(item.file);
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
updateFileTypes();     // 依產品初始化檔案格式限制
updateUnit();          // 初始化計價單位顯示
initLiff();            // 初始化 LINE LIFF（非 LINE 環境會自動跳過）
goToStep(1);           // 從第 1 步開始