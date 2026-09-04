/* =========================================================
 * 數倍DTF · LIFF 下單小程序 MVP
 * - 讀取網址參數 ?liffId=xxxxx 或用預設 LIFF_ID
 * - 讀取網址參數 ?api=https://your-api.example.com 覆蓋後端網址
 * - 未設定 LIFF_ID 或非 LINE 環境時，會以「訪客模式」執行，方便本機/預覽測試
 * ========================================================= */

const CONFIG = {
  // TODO：申請 LIFF 後填入預設 LIFF_ID，或直接用 ?liffId= 傳入
  LIFF_ID: "",
  // 後端接收訂單 API；
  //   - 本機：空字串（用相對路徑）
  //   - 平台預覽：port/3000 佔位符會被替換成代理路徑
  API_BASE: (() => {
    const placeholder = "port/3000";
    return placeholder.startsWith("__") ? "" : placeholder;
  })(),
  MAX_FILE_MB: 200,
};

// 從網址參數覆蓋設定（方便切換環境）
(function readParams() {
  const p = new URLSearchParams(window.location.search);
  if (p.get("liffId")) CONFIG.LIFF_ID = p.get("liffId");
  if (p.get("api") !== null) CONFIG.API_BASE = p.get("api");
})();

const state = {
  step: 1,
  files: [],           // { id, file, name, size, type, thumb }
  lineProfile: null,   // { userId, displayName, pictureUrl }
  isInLine: false,
};

// ------- 產品類型三層連動 ----------------------------------------
const PRODUCT_TREE = {
  "紡織": {
    "DTF": ["60cm R to R", "A3"],
    "直噴": []
  },
  "UV": {
    "一般水晶標": [],
    "燙金水晶標": [],
    "直噴": []
  }
};

function initCascadeSelects() {
  const catEl = document.getElementById("productCategory");
  const subEl = document.getElementById("productSub");
  const specEl = document.getElementById("productSpec");
  const hiddenEl = document.getElementById("productTypeHidden");

  catEl.addEventListener("change", () => {
    subEl.innerHTML = '<option value="">子類</option>';
    specEl.innerHTML = '<option value="">規格</option>';
    specEl.disabled = true;
    hiddenEl.value = "";
    const cat = catEl.value;
    if (!cat || !PRODUCT_TREE[cat]) { subEl.disabled = true; return; }
    subEl.disabled = false;
    const subs = Object.keys(PRODUCT_TREE[cat]);
    for (const s of subs) {
      const opt = document.createElement("option");
      opt.value = s; opt.textContent = s;
      subEl.appendChild(opt);
    }
    if (subs.length === 1) { subEl.value = subs[0]; subEl.dispatchEvent(new Event("change")); }
  });

  subEl.addEventListener("change", () => {
    specEl.innerHTML = '<option value="">規格</option>';
    hiddenEl.value = "";
    const cat = catEl.value;
    const sub = subEl.value;
    if (!cat || !sub) { specEl.disabled = true; updateProductHidden(); return; }
    const specs = PRODUCT_TREE[cat][sub] || [];
    if (specs.length === 0) {
      specEl.disabled = true;
      updateProductHidden();
    } else {
      specEl.disabled = false;
      for (const sp of specs) {
        const opt = document.createElement("option");
        opt.value = sp; opt.textContent = sp;
        specEl.appendChild(opt);
      }
    }
  });

  specEl.addEventListener("change", updateProductHidden);

  function updateProductHidden() {
    const cat = catEl.value;
    const sub = subEl.value;
    const spec = specEl.value;
    const parts = [cat, sub, spec].filter(Boolean);
    hiddenEl.value = parts.join(" - ");
  }
}

// ------- LIFF init ------------------------------------------------
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

// ------- Steps ----------------------------------------------------
function goToStep(n) {
  const panels = document.querySelectorAll("[data-panel]");
  panels.forEach(p => (p.hidden = Number(p.dataset.panel) !== n));

  document.querySelectorAll(".steps li").forEach(li => {
    const idx = Number(li.dataset.step);
    li.classList.toggle("active", idx === n);
    li.classList.toggle("done", idx < n);
  });
  state.step = n;

  if (n === 4) renderSummary();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function validateStep(n) {
  const panel = document.querySelector(`[data-panel="${n}"]`);
  const inputs = panel.querySelectorAll("input[required], select[required], textarea[required]");
  for (const el of inputs) {
    if (!el.value.trim()) {
      el.focus();
      toast(`請填寫「${el.previousElementSibling?.firstChild?.textContent?.replace("*","").trim() || "必填欄位"}」`, true);
      return false;
    }
  }
  // 產品類型：檢查 hidden 欄位
  if (n === 2) {
    const hidden = document.getElementById("productTypeHidden");
    if (!hidden.value) {
      toast("請選擇產品類型", true);
      return false;
    }
  }
  const taxId = panel.querySelector('[name="tax_id"]');
  if (taxId && taxId.value && !/^\d{8}$/.test(taxId.value)) {
    taxId.focus();
    toast("統編需為 8 碼數字", true);
    return false;
  }
  if (n === 3 && state.files.length === 0) {
    toast("請至少上傳一個檔案", true);
    return false;
  }
  return true;
}

document.addEventListener("click", (e) => {
  const nextBtn = e.target.closest("[data-next]");
  const prevBtn = e.target.closest("[data-prev]");
  if (nextBtn) {
    const cur = state.step;
    if (!validateStep(cur)) return;
    goToStep(Number(nextBtn.dataset.next));
  } else if (prevBtn) {
    goToStep(Number(prevBtn.dataset.prev));
  }
});

// ------- Files ----------------------------------------------------
const dz = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const fileList = document.getElementById("fileList");

dz.addEventListener("click", () => fileInput.click());
["dragenter", "dragover"].forEach(ev =>
  dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); })
);
["dragleave", "drop"].forEach(ev =>
  dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); })
);
dz.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));
fileInput.addEventListener("change", (e) => addFiles(e.target.files));

function addFiles(fileListObj) {
  const arr = Array.from(fileListObj || []);
  for (const f of arr) {
    if (f.size > CONFIG.MAX_FILE_MB * 1024 * 1024) {
      toast(`${f.name} 超過 ${CONFIG.MAX_FILE_MB}MB，未加入`, true);
      continue;
    }
    const id = crypto.randomUUID();
    const item = { id, file: f, name: f.name, size: f.size, type: f.type, thumb: null };
    state.files.push(item);
    renderFileItem(item);
    // 只有圖片格式產縮圖
    if (/^image\/(png|jpe?g|gif|webp|svg\+xml)$/.test(f.type)) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        item.thumb = ev.target.result;
        const el = fileList.querySelector(`[data-id="${id}"] .thumb`);
        if (el) el.innerHTML = `<img src="${item.thumb}" alt="" />`;
      };
      reader.readAsDataURL(f);
    }
  }
  fileInput.value = "";
}

function renderFileItem(item) {
  const li = document.createElement("li");
  li.className = "file-item";
  li.dataset.id = item.id;
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
  li.querySelector(".remove").addEventListener("click", () => {
    state.files = state.files.filter(x => x.id !== item.id);
    li.remove();
  });
  fileList.appendChild(li);
}

function updateFileProgress(id, pct, status) {
  const li = fileList.querySelector(`[data-id="${id}"]`);
  if (!li) return;
  const bar = li.querySelector(".progress-bar");
  bar.hidden = false;
  bar.querySelector("i").style.width = `${Math.min(100, Math.max(0, pct))}%`;
  if (status) li.querySelector(".status").textContent = status;
}

// ------- Summary --------------------------------------------------
function collectFormData() {
  const fd = new FormData(document.getElementById("orderForm"));
  const obj = {};
  fd.forEach((v, k) => (obj[k] = v));
  return obj;
}

function renderSummary() {
  const d = collectFormData();
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
  const dlHtml = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v || "—"))}</dd>`).join("");
  const filesHtml = state.files.length
    ? state.files.map(f => `• ${escapeHtml(f.name)} <span style="color:var(--ink-3)">(${formatSize(f.size)})</span>`).join("<br />")
    : "（無檔案）";

  document.getElementById("summary").innerHTML = `
    <dl>${dlHtml}</dl>
    <div class="files"><strong>檔案（${state.files.length}）</strong><br />${filesHtml}</div>
  `;
  document.getElementById("agree").checked = false;
  document.getElementById("submitBtn").disabled = true;
}

document.getElementById("agree").addEventListener("change", (e) => {
  document.getElementById("submitBtn").disabled = !e.target.checked;
});

// ------- Submit ---------------------------------------------------
document.getElementById("orderForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!validateStep(1) || !validateStep(2) || !validateStep(3)) return;

  const btn = document.getElementById("submitBtn");
  btn.disabled = true; btn.textContent = "送出中...";

  try {
    const orderPayload = collectFormData();
    orderPayload.line_user_id = state.lineProfile?.userId || null;
    orderPayload.line_display_name = state.lineProfile?.displayName || null;
    orderPayload.source = state.isInLine ? "LINE-LIFF" : "WEB";
    orderPayload.client_time = new Date().toISOString();

    // 1) 先建立訂單，取得訂單編號
    const orderRes = await postJSON(`${CONFIG.API_BASE}/api/orders`, orderPayload);
    if (!orderRes.ok) throw new Error(orderRes.error || "建立訂單失敗");
    const orderNo = orderRes.order_no;

    // 2) 逐檔上傳
    for (const item of state.files) {
      updateFileProgress(item.id, 5, "上傳中");
      await uploadFile(orderNo, item, (pct) => updateFileProgress(item.id, pct, "上傳中"));
      updateFileProgress(item.id, 100, "已上傳");
    }

    // 3) 告知後端上傳完成
    await postJSON(`${CONFIG.API_BASE}/api/orders/${encodeURIComponent(orderNo)}/complete`, {});

    // 4) 若在 LINE 內，發送訊息回聊天室
    if (state.isInLine && window.liff && liff.isInClient()) {
      try {
        await liff.sendMessages([{
          type: "text",
          text: `【已下單】${orderPayload.customer_name}\n訂單編號：${orderNo}\n產品：${orderPayload.product_type}\n數量：${orderPayload.quantity}\n預定交貨：${orderPayload.due_date || "未指定"}\n附件：${state.files.length} 個檔案`
        }]);
      } catch (e) { /* 使用者拒絕也不影響 */ }
    }

    // 5) 成功畫面
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

// 再下一單 / 關閉
document.getElementById("newOrderBtn").addEventListener("click", () => location.reload());
document.getElementById("closeLiffBtn").addEventListener("click", () => {
  if (window.liff && liff.isInClient()) liff.closeWindow();
  else location.reload();
});

// ------- Helpers --------------------------------------------------
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

function uploadFile(orderNo, item, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const fd = new FormData();
    fd.append("file", item.file, item.name);
    xhr.open("POST", `${CONFIG.API_BASE}/api/orders/${encodeURIComponent(orderNo)}/files`);
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

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function toast(msg, isError) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.toggle("error", !!isError);
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 2600);
}

// go
initCascadeSelects();
initLiff();
goToStep(1);
