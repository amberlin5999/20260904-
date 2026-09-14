// ==UserScript==
// @name         順豐網上寄件 自動填寫收件資料
// @namespace    aceeprint-dtf
// @version      0.3
// @description  admin「複製寄件資料」之後，在順豐網上寄件頁面點浮動按鈕（或 Tampermonkey 選單），自動填入姓名/手機/詳細地址
// @match        https://htm.sf-express.com/*
// @match        https://*.sf-express.com/we/ow/*
// @match        http://htm.sf-express.com/*
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const CLIP_RE = /收件人：([^\n]*)[\s\S]*?收件電話：([^\n]*)[\s\S]*?收件地址：([^\n]*)/;

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function findInput(keyword) {
    return Array.from(document.querySelectorAll('input, textarea')).find((el) =>
      (el.placeholder || '').indexOf(keyword) !== -1
    );
  }

  function readClipboardViaPaste() {
    const ta = document.createElement('textarea');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta);
    ta.focus();
    try { document.execCommand('paste'); } catch (e) {}
    const clip = ta.value;
    document.body.removeChild(ta);
    return clip;
  }

  function readClipboardPromise() {
    const w = unsafeWindow || window;
    if (w.navigator && w.navigator.clipboard && w.navigator.clipboard.readText) {
      return w.navigator.clipboard.readText().catch(() => readClipboardViaPaste());
    }
    return Promise.resolve(readClipboardViaPaste());
  }

  function fillFrom(text) {
    const m = String(text || '').match(CLIP_RE);
    if (!m) return { done: false };
    const name = m[1].trim();
    const phone = m[2].trim();
    const addr = m[3].trim();
    let filled = 0;
    const n1 = findInput('聯繫人姓名');
    const p1 = findInput('手機號碼');
    const a1 = findInput('所在街道');
    if (n1 && name) { setNativeValue(n1, name); filled++; }
    if (p1 && phone) { setNativeValue(p1, phone); filled++; }
    if (a1 && addr) { setNativeValue(a1, addr); filled++; }
    return { done: filled > 0, filled, name, phone, addr };
  }

  function runFill() {
    return readClipboardPromise().then((raw) => {
      let r = fillFrom(raw);
      if (!r.done) {
        const pasted = window.prompt('沒讀到收件資料。請手動貼上 admin「複製寄件資料」的內容：', raw || '');
        if (pasted) r = fillFrom(pasted);
      }
      if (r.done) alert('已填入：' + r.name + ' ／ ' + r.phone + '\n請確認「省市區」並送出。');
      else alert('沒找到可填的欄位（姓名/手機/詳細地址）。');
      return r;
    });
  }

  function isShipPage() {
    return /we\/ow|#\/tw\/tc\/ship|ship\//.test(location.href);
  }

  let btn;
  function ensureButton() {
    if (btn && document.body && btn.isConnected) return;
    if (!isShipPage()) return;
    if (!btn) {
      btn = document.createElement('button');
      btn.textContent = '填入收件資料';
      btn.style.cssText = 'position:fixed;right:18px;bottom:90px;z-index:2147483647;background:#2a7d3f;color:#fff;border:0;border-radius:8px;padding:12px 16px;font-size:15px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.35)';
      btn.addEventListener('click', () => { runFill(); });
    }
    if (document.body) document.body.appendChild(btn);
  }

  GM_registerMenuCommand('填入收件資料（順豐）', () => { runFill(); });

  ensureButton();
  new MutationObserver(ensureButton).observe(document.documentElement, { childList: true, subtree: true });

  const orderNo = new URLSearchParams(location.search).get('order_no') || '';
  if (orderNo) {
    let tag;
    function ensureTag() {
      if (tag && document.body && tag.isConnected) return;
      if (!isShipPage()) return;
      if (!tag) {
        tag = document.createElement('div');
        tag.textContent = '訂單 ' + orderNo;
        tag.style.cssText = 'position:fixed;right:18px;bottom:140px;z-index:2147483647;background:rgba(15,37,55,.85);color:#fff;border-radius:6px;padding:6px 10px;font-size:13px';
      }
      if (document.body) document.body.appendChild(tag);
    }
    ensureTag();
    new MutationObserver(ensureTag).observe(document.documentElement, { childList: true, subtree: true });
  }
})();