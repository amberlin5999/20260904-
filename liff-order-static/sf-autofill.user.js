// ==UserScript==
// @name         順豐網上寄件 自動填寫收件資料
// @namespace    aceeprint-dtf
// @version      0.5
// @description  admin「複製寄件資料」後，到順豐網上寄件頁點到表單處，自動填入姓名/手機/詳細地址
// @match        https://htm.sf-express.com/*
// @match        https://*.sf-express.com/we/ow/*
// @match        http://htm.sf-express.com/*
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const CLIP_RE = /收件人：([^\n]*)[\s\S]*?收件電話：([^\n]*)[\s\S]*?收件地址：([^\n]*)/;

  function flash(msg, color) {
    try {
      const bar = document.createElement('div');
      bar.textContent = msg;
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:' + (color || '#ffd400') + ';color:#333;font:16px/1.4 system-ui,sans-serif;font-weight:700;padding:10px 14px;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,.3)';
      document.documentElement.appendChild(bar);
      setTimeout(() => bar.remove(), 2500);
    } catch (e) { console.log('SF-AUTOFILL flash:', msg); }
  }

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

  function readClipboardViaPaste() {
    const ta = document.createElement('textarea');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta);
    ta.focus();
    let txt = '';
    try { document.execCommand('paste'); txt = ta.value; } catch (e) {}
    document.body.removeChild(ta);
    return txt;
  }

  function readClipboardPromise() {
    const w = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
    if (w.navigator && w.navigator.clipboard && w.navigator.clipboard.readText) {
      return w.navigator.clipboard.readText().catch(() => readClipboardViaPaste());
    }
    return Promise.resolve(readClipboardViaPaste());
  }

  let attempting = false;
  let retries = 0;
  function autoFill() {
    if (attempting) return;
    attempting = true;
    readClipboardPromise().then((raw) => {
      if (!raw || raw.indexOf('收件人：') === -1) {
        attempting = false;
        return;
      }
      const r = fillFrom(raw);
      if (!r.done && retries < 6) {
        retries++;
        attempting = false;
        setTimeout(autoFill, 800);
        return;
      }
      attempting = false;
      if (r.done) {
        flash('已填入：' + r.name + ' ｜ ' + r.phone, '#6fdc8c');
        alert('已自動填入：' + r.name + ' ／ ' + r.phone + '\n請確認「省市區」與詳細地址後送出。');
      }
    });
  }

  function onGesture() {
    document.removeEventListener('pointerdown', onGesture, true);
    document.removeEventListener('keydown', onGesture, true);
    setTimeout(autoFill, 350);
  }
  document.addEventListener('pointerdown', onGesture, true);
  document.addEventListener('keydown', onGesture, true);

  try {
    console.log('[SF-AUTOFILL] v0.5 active on', location.href);
    if (/we\/ow|ship/.test(location.href)) flash('SF 自填腳本 v0.5 已載入');
  } catch (e) {}

  GM_registerMenuCommand('填入收件資料（順豐）', () => {
    autoFill();
  });
})();