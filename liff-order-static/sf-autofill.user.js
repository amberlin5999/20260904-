// ==UserScript==
// @name         順豐網上寄件 自動填寫收件資料
// @namespace    aceeprint-dtf
// @version      0.1
// @description  admin「複製寄件資料」之後，在順豐網上寄件頁面點浮動按鈕，自動填入姓名/手機/詳細地址
// @match        https://htm.sf-express.com/we/ow/*
// @grant        none
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

  function readClipboard(rawFallback) {
    return navigator.clipboard.readText().catch(() => rawFallback || "");
  }

  function makeButton() {
    const btn = document.createElement('button');
    btn.textContent = '填入收件資料';
    btn.style.cssText = 'position:fixed;right:18px;bottom:90px;z-index:2147483647;background:#2a7d3f;color:#fff;border:0;border-radius:8px;padding:12px 16px;font-size:15px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.35)';
    document.body.appendChild(btn);
    return btn;
  }

  const orderNo = new URLSearchParams(location.search).get('order_no') || '';

  function fill() {
    const ta = document.createElement('textarea');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta);
    ta.focus();
    document.execCommand('paste');
    const clip = ta.value;
    document.body.removeChild(ta);
    return clip;
  }

  function fillFrom(text) {
    const m = text.match(CLIP_RE);
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
    return { done: filled > 0, filled };
  }

  const btn = makeButton();
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    let raw = '';
    try { raw = await readClipboard(); }
    catch (e) { /* 著手動貼 */ }
    if (!raw) raw = fill();
    const r = fillFrom(raw);
    if (!r.done) {
      const pasted = window.prompt('沒讀到收件資料。請手動貼上 admin 複製的內容：', raw || '');
      if (pasted) fillFrom(pasted);
    }
    btn.disabled = false;
  });

  if (orderNo) {
    const tag = document.createElement('div');
    tag.textContent = '訂單 ' + orderNo;
    tag.style.cssText = 'position:fixed;right:18px;bottom:140px;z-index:2147483647;background:rgba(15,37,55,.85);color:#fff;border-radius:6px;padding:6px 10px;font-size:13px';
    document.body.appendChild(tag);
  }
})();