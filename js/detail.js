/* ==========================================================================
   detail.js —— 当日详情面板
   --------------------------------------------------------------------------
   展示日历选中日期的完整数据：标题「10月11日 · 当日详情」、右上角结余、
   收入/支出两个小卡、当天记录与收支流水、底部引导文案。
   注意：永远显示「被选中那一天」的数据，不是今天的数据。
   ========================================================================== */
(function (global) {
  'use strict';

  var DS = global.DS = global.DS || {};
  var u = DS.util;

  var currentDate = null;
  var lastStats = null;

  /* ------------------------------------------------------------ 图标 */

  var ICON = {
    edit: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4l10-10-4-4L4 16v4Z"></path><path d="m13.5 6.5 4 4"></path></svg>',
    del:  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 7h14"></path><path d="M9 7V5h6v2"></path><path d="M7 7l1 12h8l1-12"></path><path d="M10.5 10.5v5M13.5 10.5v5"></path></svg>'
  };

  /* ------------------------------------------------------------ 元素 */

  function els() {
    return {
      title: u.$('#detail-title'),
      balance: u.$('#detail-balance'),
      income: u.$('#detail-income'),
      expense: u.$('#detail-expense'),
      list: u.$('#detail-list'),
      incomeCard: u.$('#detail-income') && u.$('#detail-income').closest('.mini-card'),
      expenseCard: u.$('#detail-expense') && u.$('#detail-expense').closest('.mini-card')
    };
  }

  function setBalance(n) {
    var node = u.$('#detail-balance');
    if (!node) return;
    var v = Number(n) || 0;
    u.setText(node, '结余 ' + u.formatMoney(v));
    node.className = 'detail__balance tnum'
      + (v > 0 ? ' detail__balance--positive' : v < 0 ? ' detail__balance--negative' : '');
  }

  function paintMoney(stats) {
    var e = els();
    u.setText(e.income, u.formatMoney(stats.income));
    u.setText(e.expense, u.formatMoney(stats.expense));
    setBalance(stats.balance);
    if (e.incomeCard) e.incomeCard.classList.add('mini-card--income');
    if (e.expenseCard) e.expenseCard.classList.add('mini-card--expense');
  }

  /* ------------------------------------------------------------ 状态 */

  function loadingNode() {
    return u.el('div', { class: 'skeleton', 'aria-busy': 'true' }, [
      u.el('div', { class: 'skeleton__row' }),
      u.el('div', { class: 'skeleton__row' })
    ]);
  }

  function emptyNode(date) {
    var isToday = date === u.todayStr();
    return u.el('div', { class: 'state' }, [
      u.el('p', { text: isToday ? '今天还没有任何记录' : u.shortDate(date) + ' 没有留下记录' })
    ]);
  }

  function errorNode(error) {
    return u.el('div', { class: 'state state--error' }, [
      u.el('p', { text: (error && error.message) || '读取当天数据失败' }),
      u.el('div', { class: 'state__actions' }, [
        u.el('button', {
          type: 'button', class: 'btn btn--ghost btn--sm', text: '重试',
          onclick: function () { render(currentDate); }
        })
      ])
    ]);
  }

  function paintList(node) {
    var e = els();
    if (!e.list) return;
    u.clear(e.list);
    e.list.appendChild(node);
  }

  /* ------------------------------------------------------------ 渲染 */

  /** 绑定面板上的常驻按钮（只绑一次） */
  function bindActions() {
    var btn = u.$('#detail-add-finance');
    if (!btn || btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', function () {
      if (DS.lists && typeof DS.lists.openForm === 'function') {
        DS.lists.openForm('finance', null, currentDate || u.todayStr());
      }
    });
  }

  /** 「记一笔」下方的日期提示，跟着当前选中的那一天走 */
  function updateAddHint(date) {
    var hint = u.$('#detail-add-hint');
    if (!hint) return;
    u.setText(hint, '记在 ' + (date === u.todayStr() ? '今天' : u.shortDate(date)));
  }

  function render(dateStr) {
    var date = u.normalizeDateStr(dateStr);
    if (!date) return Promise.resolve(null);
    currentDate = date;

    bindActions();
    updateAddHint(date);

    var e = els();
    u.setText(e.title, u.shortDate(date) + ' · 当日详情');
    paintList(loadingNode());

    return Promise.all([
      DS.store.listByDate('records', date),
      DS.store.listByDate('todos', date),
      DS.store.listByDate('finances', date),
      DS.store.statsOfDate(date)
    ]).then(function (res) {
      var records = res[0] || [];
      var todos = res[1] || [];
      var finances = res[2] || [];
      var stats = res[3];
      lastStats = stats;

      paintMoney(stats);

      if (!records.length && !todos.length && !finances.length) {
        paintList(emptyNode(date));
        return stats;
      }

      var wrap = u.el('div', { 'data-testid': 'detail-body', dataset: { date: date } });

      // 收支流水（按金额展示 +|-）；始终显示分组，空时给出「记一笔」的落点
      var sortedFinances = finances.slice().sort(function (a, b) {
        return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
      });
      wrap.appendChild(financeGroup(sortedFinances));

      // 当天记录（默认都是已完成，不再按完成态分组）
      if (records.length) {
        wrap.appendChild(group('记录（' + records.length + ' 条）', records.map(recordRow)));
      }

      // 当天待办
      if (todos.length) {
        var sortedTodos = todos.slice().sort(function (a, b) {
          if (!!a.done !== !!b.done) return a.done ? 1 : -1;
          return u.compareByCreatedDesc(a, b);
        });
        wrap.appendChild(group('待办（' + todos.filter(function (t) { return t.done; }).length + '/' + todos.length + ' 已完成）',
          sortedTodos.map(todoRow)));
      }

      paintList(wrap);
      return stats;
    }, function (error) {
      paintList(errorNode(error));
      setBalance(0);
      var el2 = els();
      u.setText(el2.income, '—');
      u.setText(el2.expense, '—');
      return null;
    });
  }

  function group(title, rows) {
    return u.el('div', { class: 'detail__group' }, [
      u.el('p', { class: 'detail__group-title', text: title })
    ].concat(rows));
  }

  function recordRow(item) {
    // 记录默认即完成，不显示「（未完成）」之类的状态标记
    return u.el('div', { class: 'detail__row' }, [
      u.el('div', { class: 'detail__row-main' }, [
        u.el('p', { class: 'detail__row-text', text: item.content }),
        u.el('p', {
          class: 'detail__row-meta',
          text: '添加于 ' + u.timeOfDay(item.createdAt)
        })
      ])
    ]);
  }

  function todoRow(item) {
    var pm = u.priorityMeta(item.priority);
    var overdue = !item.done && item.date < u.todayStr();
    return u.el('div', { class: 'detail__row' }, [
      u.el('div', { class: 'detail__row-main' }, [
        u.el('p', { class: 'detail__row-text', text: item.content }),
        u.el('p', { class: 'detail__row-meta', text: [
          pm.label + '优先级',
          item.done ? '已完成' : (overdue ? '已逾期' : '未完成')
        ].join(' · ') })
      ])
    ]);
  }

  /* ------------------------------------------------------------ 收支操作 */

  function editFinance(item) {
    if (DS.lists && typeof DS.lists.openForm === 'function') {
      DS.lists.openForm('finance', item, item.date || currentDate);
    }
  }

  function removeFinance(item) {
    var label = item.note || item.category || '这笔收支';
    var ok = global.confirm('确定删除「' + label + ' ' + u.formatMoney(item.amount) + '」吗？\n删除后无法恢复。');
    if (!ok) return;
    u.safe(DS.store.remove('finances', item.id)).then(function (res) {
      if (!res.ok) {
        DS.toast.error((res.error && res.error.message) || '删除失败');
        return;
      }
      DS.toast.success('已删除');
      // 统计卡也要跟着变，所以走全局刷新而不是只重画本面板
      if (DS.app && typeof DS.app.notifyDataChanged === 'function') DS.app.notifyDataChanged();
      else if (currentDate) render(currentDate);
    });
  }

  function financeRow(item) {
    var isIncome = item.type === 'income';
    var label = item.note || item.category || (isIncome ? '收入' : '支出');
    return u.el('div', { class: 'detail__row' }, [
      u.el('div', { class: 'detail__row-main' }, [
        u.el('p', { class: 'detail__row-text', text: label }),
        u.el('p', {
          class: 'detail__row-meta',
          text: [item.category, u.timeOfDay(item.createdAt)].filter(Boolean).join(' · ')
        })
      ]),
      u.el('span', {
        class: 'detail__row-amount detail__row-amount--' + (isIncome ? 'income' : 'expense'),
        text: (isIncome ? '+' : '-') + u.formatMoney(item.amount)
      }),
      u.el('div', { class: 'detail__row-actions' }, [
        u.el('button', {
          type: 'button', class: 'icon-btn', title: '编辑', 'aria-label': '编辑这笔收支',
          html: ICON.edit, onclick: function () { editFinance(item); }
        }),
        u.el('button', {
          type: 'button', class: 'icon-btn icon-btn--danger', title: '删除', 'aria-label': '删除这笔收支',
          html: ICON.del, onclick: function () { removeFinance(item); }
        })
      ])
    ]);
  }

  /** 收支分组：即使一笔都没有也要显示，否则用户找不到「记一笔」在哪 */
  function financeGroup(finances) {
    var rows = finances.map(financeRow);
    if (!finances.length) {
      rows.push(u.el('div', { class: 'state state--thin' }, [
        u.el('p', { text: '这一天还没有记账' })
      ]));
    }
    return group('收支', rows);
  }

  function refresh() {
    if (currentDate) return render(currentDate);
    return Promise.resolve(null);
  }

  DS.detail = {
    init: function () { /* 面板由 app 驱动，无需自身初始化 */ },
    render: render,
    refresh: refresh,
    showLoading: function () { paintList(loadingNode()); },
    renderError: function (error) { paintList(errorNode(error)); },
    getCurrentDate: function () { return currentDate; },
    getLastStats: function () { return lastStats; }
  };
})(window);
