/* ==========================================================================
   toast.js —— 轻提示（保存 / 删除 / 出错），1.5s 自动消失
   ========================================================================== */
(function (global) {
  'use strict';

  var DS = global.DS = global.DS || {};
  var u = DS.util;

  var DEFAULT_DURATION = 1500;
  var MAX_VISIBLE = 3;

  function host() {
    var node = u.$('#toast-host');
    if (!node) {
      node = u.el('div', { class: 'toast-host', id: 'toast-host', role: 'status', 'aria-live': 'polite' });
      document.body.appendChild(node);
    }
    return node;
  }

  /**
   * 显示一条轻提示
   * @param {string} message
   * @param {'info'|'success'|'error'} [tone]
   * @param {number} [duration] 毫秒
   */
  function show(message, tone, duration) {
    var text = String(message === undefined || message === null ? '' : message);
    if (!text) return null;

    var node = host();
    while (node.children.length >= MAX_VISIBLE) node.removeChild(node.firstChild);

    var cls = 'toast' + (tone === 'success' ? ' toast--success' : tone === 'error' ? ' toast--error' : '');
    var item = u.el('div', { class: cls, text: text, role: tone === 'error' ? 'alert' : 'status' });
    node.appendChild(item);

    var ms = typeof duration === 'number' ? duration : (tone === 'error' ? 2600 : DEFAULT_DURATION);
    setTimeout(function () {
      item.classList.add('is-leaving');
      setTimeout(function () { if (item.parentNode) item.parentNode.removeChild(item); }, 200);
    }, ms);

    return item;
  }

  /** 全局提示气泡（用于展示被截断的完整文本） */
  var tipNode = null;
  function tip(message, anchor) {
    if (!tipNode) tipNode = u.$('#global-tip') || u.el('div', { class: 'tip', id: 'global-tip', hidden: true });
    if (!tipNode.parentNode) document.body.appendChild(tipNode);

    if (!message) return hideTip();
    u.setText(tipNode, message);
    tipNode.hidden = false;

    if (anchor) {
      var r = anchor.getBoundingClientRect();
      var top = r.bottom + 6;
      if (top + tipNode.offsetHeight > global.innerHeight - 8) top = r.top - tipNode.offsetHeight - 6;
      tipNode.style.top = Math.max(8, top) + 'px';
      tipNode.style.left = Math.max(8, Math.min(r.left, global.innerWidth - tipNode.offsetWidth - 8)) + 'px';
    }
  }

  function hideTip() {
    if (tipNode) tipNode.hidden = true;
  }

  DS.toast = {
    show: show,
    success: function (m, d) { return show(m, 'success', d); },
    error: function (m, d) { return show(m, 'error', d); },
    info: function (m, d) { return show(m, 'info', d); },
    tip: tip,
    hideTip: hideTip
  };
})(window);
