// ==UserScript==
// @name         順豐網上寄件 自動填寫收件資料
// @namespace    aceeprint-dtf
// @version      0.4
// @description  admin「複製寄件資料」後，到順豐網上寄件頁隨處點一下，自動填入姓名/手機/詳細地址
// @match        https://htm.sf-express.com/*
// @match        https://*.sf-express.com/we/ow/*
// @match        http://htm.sf-express.com/*
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const CLIP_RE = /收件人：([^\n]*)[\s\S]*?收件電話：([^\n]*)[\s\S]*?收件地址：([^\n]*)/;

  function isShipPage() {
    return /we\/ow|#\/tw\/tc\/ship|ship\//.test(location.href);
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

  function readClipboardPromise() {
    const w = unsafeWindow || window;
    if (w.navigator && w.navigator.clipboard && w.navigator.clipboard.readText) {
      return w.navigator.clipboard.readText().catch(() => '');
    }
    return Promise.resolve('');
  }

  let attempting = false;
  let retries = 0;
  function autoFill() {
    if (attempting) return;
    attempting = true;
    readClipboardPromise().then((raw) => {
      if (!raw || raw.indexOf('收件人：') === -1) { attempting = false; return; }
      const r = fillFrom(raw);
      if (!r.done && retries < 3) {
        retries++;
        attempting = false;
        setTimeout(autoFill, 600);
        return;
      }
      attempting = false;
      if (r.done) alert('已自動填入：' + r.name + ' ／ ' + r.phone + '\n請確認「省市區」與詳細地址後送出。');
    });
  }

  function onGesture() {
    if (!isShipPage()) return;
    document.removeEventListener('pointerdown', onGesture, true);
    document.removeEventListener('keydown', onGesture, true);
    setTimeout(autoFill, 350);
  }
  document.addEventListener('pointerdown', onGesture, true);
  document.addEventListener('keydown', onGesture, true);

  GM_registerMenuCommand('填入收件資料（順豐）', () => {
    autoFill();
  });
})();