/* ==========================================================================
   util.js —— 通用工具（日期 / 金额 / DOM / 校验）
   纯函数，无副作用，不依赖任何其他模块。全局挂载 window.DS.util
   ========================================================================== */
(function (global) {
  'use strict';

  var DS = global.DS = global.DS || {};

  var WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六'];
  var MONTH_CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];

  /* ---------------------------------------------------------------- 日期 */

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** Date -> 'YYYY-MM-DD'（按本地时区，不用 toISOString 以免时区偏移） */
  function dateToStr(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** 'YYYY-MM-DD' -> Date（本地 00:00） */
  function strToDate(s) {
    if (!s || typeof s !== 'string') return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
    if (!m) return null;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    // 回读校验，拦住 2026-02-31 这类非法日期
    if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
    return d;
  }

  /** 是否合法的 'YYYY-MM-DD' */
  function isValidDateStr(s) { return strToDate(s) !== null; }

  function todayStr() { return dateToStr(new Date()); }

  /** 在原日期上加减天数，返回新的 'YYYY-MM-DD' */
  function addDays(dateStr, delta) {
    var d = strToDate(dateStr) || new Date();
    d.setDate(d.getDate() + delta);
    return dateToStr(d);
  }

  /** 月份边界：'YYYY-MM-01' */
  function monthStart(year, month /* 1-12 */) { return year + '-' + pad2(month) + '-01'; }

  /** 月份最后一天：'YYYY-MM-DD' */
  function monthEnd(year, month /* 1-12 */) {
    var d = new Date(year, month, 0); // 下月第 0 天 = 本月最后一天
    return dateToStr(d);
  }

  /** 把任意字符串收敛成 'YYYY-MM-DD'；失败返回 null */
  function normalizeDateStr(input, fallback) {
    if (typeof input === 'string') {
      var t = input.trim();
      if (isValidDateStr(t)) return t;
      var m = /^(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})$/.exec(t);
      if (m) {
        var guess = m[1] + '-' + pad2(Number(m[2])) + '-' + pad2(Number(m[3]));
        if (isValidDateStr(guess)) return guess;
      }
    }
    if (input instanceof Date && !isNaN(input.getTime())) return dateToStr(input);
    return fallback === undefined ? null : fallback;
  }

  function isToday(dateStr) { return dateStr === todayStr(); }

  /** 相对今天的自然语言描述：今天 / 明天 / 昨天 / 3 天后 / 逾期 2 天 */
  function relativeDayLabel(dateStr) {
    var t = todayStr();
    if (dateStr === t) return '今天';
    var diff = Math.round((strToDate(dateStr) - strToDate(t)) / 86400000);
    if (diff === 1) return '明天';
    if (diff === -1) return '昨天';
    if (diff > 1) return diff + ' 天后';
    return '逾期 ' + Math.abs(diff) + ' 天';
  }

  /** 'YYYY-MM-DD' -> '10月11日' */
  function shortDate(dateStr) {
    var d = strToDate(dateStr);
    if (!d) return dateStr || '';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  /** 'YYYY-MM-DD' -> '2026年10月11日 星期六' */
  function longDate(dateStr) {
    var d = strToDate(dateStr);
    if (!d) return dateStr || '';
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 星期' + WEEKDAY_CN[d.getDay()];
  }

  /** 'YYYY-MM-DD' -> '2026年10月' */
  function monthLabel(year, month) { return year + '年' + month + '月'; }

  /** ISO 时间串 -> 'HH:MM' */
  function timeOfDay(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /** 本月第几天序号（用于月报） */
  function daysInMonth(year, month) { return new Date(year, month, 0).getDate(); }

  function isWeekend(dateStr) {
    var d = strToDate(dateStr);
    if (!d) return false;
    var w = d.getDay();
    return w === 0 || w === 6;
  }

  /* ---------------------------------------------------------------- 金额 */

  /**
   * 金额格式化：千分位 + 两位小数，如 ¥1,234.00
   * 统一出口，页面里不要自己拼字符串。
   */
  function formatMoney(n, withSymbol) {
    var v = toAmount(n);
    var neg = v < 0;
    var abs = Math.abs(v);
    var fixed = abs.toFixed(2);
    var parts = fixed.split('.');
    var intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    var out = intPart + '.' + parts[1];
    return (neg ? '-' : '') + (withSymbol === false ? '' : '¥') + out;
  }

  /** 带符号的金额（收支流水用）：+¥320.00 / -¥86.50 */
  function formatSignedMoney(n) {
    var v = toAmount(n);
    return (v > 0 ? '+' : v < 0 ? '-' : '') + formatMoney(Math.abs(v));
  }

  /**
   * 任意输入 -> 合法金额（正数，两位小数），非法返回 null
   * 存库永远用 number，不要存字符串。
   */
  function toAmount(input) {
    if (typeof input === 'number') {
      if (!isFinite(input)) return 0;
      return Math.round(input * 100) / 100;
    }
    if (input === null || input === undefined) return 0;
    var s = String(input).replace(/[¥,\s]/g, '').trim();
    if (s === '') return 0;
    var n = Number(s);
    if (!isFinite(n)) return NaN;
    return Math.round(n * 100) / 100;
  }

  /** 校验用户输入的金额：返回 { ok, value, message } */
  function validateAmount(raw) {
    if (raw === null || raw === undefined || String(raw).trim() === '') {
      return { ok: false, value: null, message: '请填写金额' };
    }
    var s = String(raw).replace(/[¥,\s]/g, '').trim();
    if (!/^\d*\.?\d*$/.test(s) || s === '.' || s === '') {
      return { ok: false, value: null, message: '金额只能是数字，例如 18.50' };
    }
    var n = Number(s);
    if (!isFinite(n)) return { ok: false, value: null, message: '金额格式不正确' };
    if (n <= 0) return { ok: false, value: null, message: '金额必须大于 0' };
    if (n > 99999999) return { ok: false, value: null, message: '金额过大，请检查是否多输了 0' };
    return { ok: true, value: Math.round(n * 100) / 100, message: '' };
  }

  /** 数字本身（无货币符号）格式化为两位小数 + 千分位 */
  function formatNumber(n, digits) {
    var d = typeof digits === 'number' ? digits : 2;
    var v = Number(n) || 0;
    return v.toFixed(d).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /* ---------------------------------------------------------------- DOM */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'dataset') Object.keys(v).forEach(function (dk) { node.dataset[dk] = v[dk]; });
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : v);
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  function setText(node, text) { if (node) node.textContent = text === null || text === undefined ? '' : String(text); }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, wait || 200);
    };
  }

  /** 转义，用于必须拼 HTML 的场合 */
  function escapeHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------------------------------------------------------------- 其他 */

  /** 唯一 ID：时间戳 + 随机（可读、可排序、无需依赖 crypto） */
  function uid() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  }

  function nowIso() { return new Date().toISOString(); }

  function clamp(n, min, max) { return Math.min(Math.max(n, min), max); }

  function compareByCreatedDesc(a, b) {
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  }

  var PRIORITY = {
    high:   { key: 'high',   label: '高', order: 0 },
    medium: { key: 'medium', label: '中', order: 1 },
    low:    { key: 'low',    label: '低', order: 2 }
  };

  function priorityMeta(p) { return PRIORITY[p] || PRIORITY.medium; }

  var FINANCE_TYPE = {
    income:  { key: 'income',  label: '收入', sign: 1 },
    expense: { key: 'expense', label: '支出', sign: -1 }
  };

  function financeTypeMeta(t) { return FINANCE_TYPE[t] || FINANCE_TYPE.expense; }

  /** 把 Promise 包成 { ok, data, error }，页面层不用写 try/catch */
  function safe(promise) {
    return Promise.resolve(promise).then(
      function (data) { return { ok: true, data: data, error: null }; },
      function (error) { return { ok: false, data: null, error: error }; }
    );
  }

  DS.util = {
    WEEKDAY_CN: WEEKDAY_CN,
    MONTH_CN: MONTH_CN,
    // 日期
    pad2: pad2,
    dateToStr: dateToStr,
    strToDate: strToDate,
    isValidDateStr: isValidDateStr,
    todayStr: todayStr,
    addDays: addDays,
    monthStart: monthStart,
    monthEnd: monthEnd,
    normalizeDateStr: normalizeDateStr,
    isToday: isToday,
    relativeDayLabel: relativeDayLabel,
    shortDate: shortDate,
    longDate: longDate,
    monthLabel: monthLabel,
    timeOfDay: timeOfDay,
    daysInMonth: daysInMonth,
    isWeekend: isWeekend,
    // 金额
    formatMoney: formatMoney,
    formatSignedMoney: formatSignedMoney,
    toAmount: toAmount,
    validateAmount: validateAmount,
    formatNumber: formatNumber,
    // DOM
    $: $,
    $$: $$,
    el: el,
    clear: clear,
    setText: setText,
    debounce: debounce,
    escapeHtml: escapeHtml,
    // 其他
    uid: uid,
    nowIso: nowIso,
    clamp: clamp,
    compareByCreatedDesc: compareByCreatedDesc,
    priorityMeta: priorityMeta,
    financeTypeMeta: financeTypeMeta,
    safe: safe
  };

  // 兼容：允许 DS.date / DS.money 直取
  DS.date = DS.util;
  DS.money = DS.util;
})(window);
