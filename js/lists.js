/* ==========================================================================
   lists.js —— 「今天我做了什么」+「要做什么」两个列表
   --------------------------------------------------------------------------
   职责：渲染 / 新增 / 编辑 / 删除 / 勾选完成
   数据读写一律走 DS.store；本文件不直接碰 IndexedDB。
   两个列表共用一套行渲染器与一套抽屉表单控制器。
   ========================================================================== */
(function (global) {
  'use strict';

  var DS = global.DS = global.DS || {};
  var u = DS.util;

  /* ------------------------------------------------------------ 常量 */

  var EMPTY_TEXT = {
    records: '今天还没有记录，添加第一条吧',
    todos: '暂无待办'
  };

  var PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

  var ICON = {
    check: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7"></path></svg>',
    edit:  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4l10-10-4-4L4 16v4Z"></path><path d="m13.5 6.5 4 4"></path></svg>',
    del:   '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 7h14"></path><path d="M9 7V5h6v2"></path><path d="M7 7l1 12h8l1-12"></path><path d="M10.5 10.5v5M13.5 10.5v5"></path></svg>'
  };

  /** 当前两个列表展示的是哪一天（跨天刷新时由 app 改写） */
  var contextDate = u.todayStr();
  var lastData = { records: [], todos: [] };

  /* ------------------------------------------------------------ 状态渲染 */

  function loadingState() {
    return u.el('div', { class: 'skeleton', 'aria-busy': 'true', 'aria-label': '加载中' }, [
      u.el('div', { class: 'skeleton__row' }),
      u.el('div', { class: 'skeleton__row' }),
      u.el('div', { class: 'skeleton__row' })
    ]);
  }

  function emptyState(kind) {
    var addLabel = kind === 'records' ? '添加第一条' : '添加待办';
    return u.el('div', { class: 'state' }, [
      u.el('p', { text: EMPTY_TEXT[kind] }),
      u.el('div', { class: 'state__actions', style: { marginTop: '12px' } }, [
        u.el('button', {
          type: 'button', class: 'btn btn--ghost btn--sm', text: '＋ ' + addLabel,
          onclick: function () { openForm(kind === 'records' ? 'record' : 'todo'); }
        })
      ])
    ]);
  }

  function errorState(error, onRetry) {
    return u.el('div', { class: 'state state--error' }, [
      u.el('p', { text: (error && error.message) || '数据读取失败，请重试' }),
      u.el('div', { class: 'state__actions' }, [
        u.el('button', { type: 'button', class: 'btn btn--ghost btn--sm', text: '重试', onclick: onRetry })
      ])
    ]);
  }

  function bodyOf(kind) {
    var card = kind === 'records' ? u.$('#card-records') : u.$('#card-todos');
    return card ? u.$('[data-list-body]', card) : null;
  }

  function paint(kind, node) {
    var body = bodyOf(kind);
    if (!body) return;
    u.clear(body);
    node.classList.add('card__body--filled');
    body.appendChild(node);
  }

  /* ------------------------------------------------------------ 行渲染 */

  function makeCheckbox(checked, overdue, onToggle, label) {
    var btn = u.el('button', {
      type: 'button',
      class: 'check' + (overdue ? ' check--overdue' : ''),
      role: 'checkbox',
      'aria-checked': checked ? 'true' : 'false',
      'aria-label': label,
      html: ICON.check
    });
    btn.addEventListener('click', function () { onToggle(btn); });
    return btn;
  }

  function makeActions(onEdit, onDelete, what) {
    return u.el('div', { class: 'row__actions' }, [
      u.el('button', {
        type: 'button', class: 'icon-btn', title: '编辑', 'aria-label': '编辑' + what,
        html: ICON.edit, onclick: onEdit
      }),
      u.el('button', {
        type: 'button', class: 'icon-btn icon-btn--danger', title: '删除', 'aria-label': '删除' + what,
        html: ICON.del, onclick: onDelete
      })
    ]);
  }

  /** 通用异步动作包装：出错提示 + 回滚由调用方决定 */
  function run(action, successMessage) {
    return DS.util.safe(action).then(function (res) {
      if (!res.ok) {
        DS.toast.error((res.error && res.error.message) || '操作失败，请重试');
        return null;
      }
      if (successMessage) DS.toast.success(successMessage);
      return res.data;
    });
  }

  function refill(kind) {
    return kind === 'records' ? renderRecords(contextDate) : renderTodos(contextDate);
  }

  /** 统一删除：二次确认 + 提示 */
  function confirmRemove(kind, item, what) {
    var text = item.content || item.note || '这条数据';
    var preview = text.length > 24 ? text.slice(0, 24) + '…' : text;
    var ok = global.confirm('确定删除「' + preview + '」吗？\n删除后无法恢复。');
    if (!ok) return Promise.resolve(false);
    return run(DS.store.remove(kind, item.id), '已删除').then(function (r) {
      if (r === null) return false;
      global.DS.app && DS.app.notifyDataChanged ? DS.app.notifyDataChanged() : refill(kind);
      return true;
    });
  }

  /* ------------------------------------------------------------ 记录列表 */

  function renderRecords(dateStr) {
    var date = u.normalizeDateStr(dateStr) || u.todayStr();
    contextDate = date;
    paint('records', loadingState());

    return DS.store.listByDate('records', date).then(function (rows) {
      var list = (rows || []).slice().sort(u.compareByCreatedDesc);
      lastData.records = list;

      if (!list.length) {
        paint('records', emptyState('records'));
        return list;
      }

      var ul = u.el('ul', { class: 'list', 'data-testid': 'record-list' });
      list.forEach(function (item) { ul.appendChild(recordRow(item)); });
      paint('records', ul);
      return list;
    }, function (error) {
      paint('records', errorState(error, function () { renderRecords(contextDate); }));
      return [];
    });
  }

  /**
   * 「今天我做了什么」记的本来就是已经做完的事，
   * 所以默认即完成：不摆勾选框、不给完成态打任何标记，列表回到纯文本。
   */
  function recordRow(item) {
    var row = u.el('li', {
      class: 'row',
      dataset: { id: item.id }
    });

    row.appendChild(u.el('div', { class: 'row__main' }, [
      u.el('p', { class: 'row__text', text: item.content || '（无内容）' }),
      u.el('div', { class: 'row__meta' }, [
        u.el('span', { text: '添加于 ' + u.timeOfDay(item.createdAt) })
      ])
    ]));

    row.appendChild(makeActions(
      function () { openForm('record', item); },
      function () { confirmRemove('records', item, '记录'); },
      '记录'
    ));

    return row;
  }

  /* ------------------------------------------------------------ 待办列表 */

  function renderTodos(dateStr) {
    var date = u.normalizeDateStr(dateStr) || u.todayStr();
    contextDate = date;
    paint('todos', loadingState());

    // 口径（与统计卡、档案规则一致）：未完成的待办（计划日期 ≤ 当天，含逾期）一直挂着，
    // 不随跨天消失；当天已完成的仍显示（带完成态样式），到第二天起自然归档不再出现。
    return Promise.all([
      DS.store.listByDate('todos', date),
      DS.store.openTodosUpTo(date)
    ]).then(function (res) {
      var dayRows = res[0] || [];
      var openRows = res[1] || [];
      var seen = {};
      openRows.forEach(function (t) { seen[t.id] = true; });
      var list = openRows.concat(dayRows.filter(function (t) { return t.done && !seen[t.id]; }))
        .slice().sort(function (a, b) {
          // 未完成在前 → 优先级 → 创建时间倒序
          if (!!a.done !== !!b.done) return a.done ? 1 : -1;
          var pa = PRIORITY_ORDER[a.priority] === undefined ? 1 : PRIORITY_ORDER[a.priority];
          var pb = PRIORITY_ORDER[b.priority] === undefined ? 1 : PRIORITY_ORDER[b.priority];
          if (pa !== pb) return pa - pb;
          return u.compareByCreatedDesc(a, b);
        });
      lastData.todos = list;

      if (!list.length) {
        paint('todos', emptyState('todos'));
        return list;
      }

      var ul = u.el('ul', { class: 'list', 'data-testid': 'todo-list' });
      list.forEach(function (item) { ul.appendChild(todoRow(item)); });
      paint('todos', ul);
      return list;
    }, function (error) {
      paint('todos', errorState(error, function () { renderTodos(contextDate); }));
      return [];
    });
  }

  function todoRow(item) {
    var today = u.todayStr();
    var overdue = !item.done && item.date < today;
    var pm = u.priorityMeta(item.priority);

    var row = u.el('li', {
      class: 'row' + (item.done ? ' is-done' : ''),
      dataset: { id: item.id }
    });

    row.appendChild(makeCheckbox(item.done, overdue, function (btn) {
      btn.disabled = true;
      var next = Object.assign({}, item, { done: !item.done, doneAt: !item.done ? u.nowIso() : null });
      run(DS.store.put('todos', next), item.done ? '已取消完成' : '已完成').then(function (r) {
        if (r === null) { btn.disabled = false; return; }
        afterMutation();
      });
    }, (item.done ? '取消完成：' : '标记完成：') + (item.content || '')));

    var meta = u.el('div', { class: 'row__meta' }, [
      u.el('span', { class: 'pill pill--' + pm.key, text: pm.label })
    ]);

    if (overdue) meta.appendChild(u.el('span', { class: 'pill pill--overdue', text: '逾期' }));
    if (item.date !== today) meta.appendChild(u.el('span', { text: u.shortDate(item.date) + '（' + u.relativeDayLabel(item.date) + '）' }));
    if (item.done && item.doneAt) meta.appendChild(u.el('span', { text: '完成于 ' + u.timeOfDay(item.doneAt) }));

    row.appendChild(u.el('div', { class: 'row__main' }, [
      u.el('p', { class: 'row__text', text: item.content || '（无内容）' }),
      meta
    ]));

    row.appendChild(makeActions(
      function () { openForm('todo', item); },
      function () { confirmRemove('todos', item, '待办'); },
      '待办'
    ));

    return row;
  }

  /* ------------------------------------------------------------ 变更后刷新 */

  function afterMutation() {
    if (DS.app && typeof DS.app.notifyDataChanged === 'function') DS.app.notifyDataChanged();
    else { renderRecords(contextDate); renderTodos(contextDate); }
  }

  /* ------------------------------------------------------------ 抽屉表单 */

  var FORM_META = {
    record:  { titleNew: '新增记录', titleEdit: '编辑记录', table: 'records' },
    todo:    { titleNew: '新增待办', titleEdit: '编辑待办', table: 'todos' },
    finance: { titleNew: '记一笔收支', titleEdit: '编辑收支', table: 'finances' }
  };

  var formState = { kind: null, editing: null, returnDate: null };

  function drawerEl() { return u.$('#drawer'); }
  function formEl() { return u.$('#drawer-form'); }

  /**
   * 打开新增 / 编辑抽屉
   * @param {'record'|'todo'|'finance'} kind
   * @param {object|null} [item] 传入则为编辑
   * @param {string} [dateStr] 新增时的默认归属日期
   */
  function openForm(kind, item, dateStr) {
    var meta = FORM_META[kind];
    if (!meta) return;

    formState.kind = kind;
    formState.editing = item || null;
    formState.returnDate = u.normalizeDateStr(dateStr) || (DS.app && DS.app.getSelectedDate ? DS.app.getSelectedDate() : null) || u.todayStr();

    var form = formEl();
    var drawer = drawerEl();
    if (!form || !drawer) return;

    form.reset();
    clearFieldErrors(form);

    // 只显示当前类型的字段；标了 data-hidden-field 的一律保持隐藏
    u.$$('[data-form-kind]', form).forEach(function (field) {
      if (field.getAttribute('data-hidden-field') === '1') { field.hidden = true; return; }
      field.hidden = field.getAttribute('data-form-kind') !== kind;
    });

    u.setText(u.$('#drawer-title'), item ? meta.titleEdit : meta.titleNew);
    u.setText(u.$('#drawer-submit'), item ? '保存修改' : '保存');

    if (kind === 'record') {
      u.$('#record-content').value = item ? item.content || '' : '';
      u.$('#record-date').value = item ? item.date : formState.returnDate;
      // 新增时默认已完成（编辑时沿用原值）
      u.$('#record-done').checked = item ? !!item.done : true;
    } else if (kind === 'todo') {
      u.$('#todo-content').value = item ? item.content || '' : '';
      u.$('#todo-date').value = item ? item.date : formState.returnDate;
      setRadio(form, 'priority', item ? item.priority : 'medium');
    } else {
      u.$('#finance-amount').value = item ? u.formatNumber(item.amount, 2).replace(/,/g, '') : '';
      u.$('#finance-category').value = item ? item.category || '' : '';
      u.$('#finance-note').value = item ? item.note || '' : '';
      u.$('#finance-date').value = item ? item.date : formState.returnDate;
      setRadio(form, 'type', item ? item.type : 'expense');
    }

    drawer.hidden = false;
    document.body.style.overflow = 'hidden';

    var first = u.$('input[name="content"], #finance-amount', form);
    if (first) setTimeout(function () { first.focus(); if (first.select) first.select(); }, 60);
  }

  function closeForm() {
    var drawer = drawerEl();
    if (!drawer || drawer.hidden) return;
    drawer.hidden = true;
    document.body.style.overflow = '';
    formState.kind = null;
    formState.editing = null;
    clearFieldErrors(formEl());
  }

  function setRadio(form, name, value) {
    u.$$('input[name="' + name + '"]', form).forEach(function (input) {
      input.checked = input.value === value;
    });
  }

  function clearFieldErrors(form) {
    if (!form) return;
    u.$$('[data-error-for]', form).forEach(function (n) { u.setText(n, ''); });
    u.$$('[aria-invalid]', form).forEach(function (n) { n.removeAttribute('aria-invalid'); });
  }

  function fieldError(form, name, message) {
    var node = u.$('[data-error-for="' + name + '"]', form);
    if (node) u.setText(node, message);
    var input = u.$('[name="' + name + '"]', form);
    if (input) input.setAttribute('aria-invalid', 'true');
  }

  function focusField(name) {
    var form = formEl();
    var input = form && u.$('[name="' + name + '"]', form);
    if (input && input.focus) input.focus();
  }

  /** 收集 + 校验表单，返回构造好的记录对象或 null */
  function collect(kind, form) {
    clearFieldErrors(form);
    var now = u.nowIso();

    if (kind === 'record') {
      var content = u.$('#record-content').value.trim();
      var date = u.$('#record-date').value;
      if (!content) { fieldError(form, 'content', '请填写内容'); focusField('content'); return null; }
      if (!u.isValidDateStr(date)) { fieldError(form, 'date', '请选择归属日期'); focusField('date'); return null; }
      return {
        id: formState.editing ? formState.editing.id : undefined,
        date: date,
        content: content,
        done: u.$('#record-done').checked,
        createdAt: formState.editing ? formState.editing.createdAt : now,
        updatedAt: now
      };
    }

    if (kind === 'todo') {
      var todoContent = u.$('#todo-content').value.trim();
      var todoDate = u.$('#todo-date').value;
      var priorityInput = u.$('input[name="priority"]:checked', form);
      var done = formState.editing ? !!formState.editing.done : false;
      if (!todoContent) { fieldError(form, 'content', '请填写内容'); focusField('content'); return null; }
      if (!u.isValidDateStr(todoDate)) { fieldError(form, 'date', '请选择计划日期'); focusField('date'); return null; }
      return {
        id: formState.editing ? formState.editing.id : undefined,
        date: todoDate,
        content: todoContent,
        priority: priorityInput ? priorityInput.value : 'medium',
        done: done,
        createdAt: formState.editing ? formState.editing.createdAt : now,
        doneAt: done ? (formState.editing && formState.editing.doneAt) || now : null
      };
    }

    // finance
    var amountRaw = u.$('#finance-amount').value;
    var amountCheck = u.validateAmount(amountRaw);
    var typeInput = u.$('input[name="type"]:checked', form);
    var financeDate = u.$('#finance-date').value;
    if (!amountCheck.ok) { fieldError(form, 'amount', amountCheck.message); focusField('amount'); return null; }
    if (!u.isValidDateStr(financeDate)) { fieldError(form, 'date', '请选择发生日期'); focusField('date'); return null; }
    return {
      id: formState.editing ? formState.editing.id : undefined,
      date: financeDate,
      type: typeInput ? typeInput.value : 'expense',
      amount: amountCheck.value,
      category: u.$('#finance-category').value.trim() || '未分类',
      note: u.$('#finance-note').value.trim(),
      createdAt: formState.editing ? formState.editing.createdAt : now
    };
  }

  function submitForm(event) {
    if (event) event.preventDefault();
    var form = formEl();
    var kind = formState.kind;
    if (!form || !kind) return;

    var record = collect(kind, form);
    if (!record) return;

    var isEdit = !!formState.editing;
    var table = FORM_META[kind].table;
    var action = isEdit ? DS.store.put(table, record) : DS.store.add(table, record);

    var submitBtn = u.$('#drawer-submit');
    if (submitBtn) submitBtn.disabled = true;

    run(action, isEdit ? '已保存修改' : '已保存').then(function (saved) {
      if (submitBtn) submitBtn.disabled = false;
      if (saved === null) return;
      closeForm();
      afterMutation();
    });
  }

  /* ------------------------------------------------------------ 初始化 */

  /** 把任意输入收敛成「最多两位小数」的金额串 */
  function sanitizeMoney(v) {
    var s = String(v === null || v === undefined ? '' : v).replace(/[^\d.]/g, '');
    var dot = s.indexOf('.');
    if (dot >= 0) {
      // 只保留第一个小数点，且小数点后最多两位
      s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '');
      s = s.slice(0, dot + 3);
    }
    return s;
  }

  /** 金额输入：边打边收敛到两位小数，失焦补齐成 12.30 这种样子 */
  function bindMoneyInput() {
    var input = u.$('#finance-amount');
    if (!input || input.dataset.moneyBound === '1') return;
    input.dataset.moneyBound = '1';

    input.addEventListener('input', function () {
      var cleaned = sanitizeMoney(input.value);
      if (cleaned !== input.value) input.value = cleaned;
    });

    input.addEventListener('blur', function () {
      var raw = String(input.value || '').trim();
      if (!raw) return;
      var n = u.toAmount(raw);
      if (isFinite(n)) input.value = n.toFixed(2);
    });
  }

  function init() {
    var form = formEl();
    if (form) form.addEventListener('submit', submitForm);

    bindMoneyInput();

    u.$$('[data-open-form]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var kind = btn.getAttribute('data-open-form');
        var date = DS.app && DS.app.getSelectedDate ? DS.app.getSelectedDate() : u.todayStr();
        openForm(kind, null, date);
      });
    });

    // 点击遮罩 / 关闭按钮关闭抽屉
    u.$$('[data-drawer-close]').forEach(function (node) {
      node.addEventListener('click', function () {
        var host = node.closest('.drawer');
        if (!host) return;
        host.hidden = true;
        document.body.style.overflow = '';
        if (host.id === 'drawer') { formState.kind = null; formState.editing = null; }
      });
    });

    // Esc 关闭最上层抽屉
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var open = u.$$('.drawer').filter(function (d) { return !d.hidden; });
      if (!open.length) return;
      var top = open[open.length - 1];
      top.hidden = true;
      document.body.style.overflow = '';
      if (top.id === 'drawer') { formState.kind = null; formState.editing = null; }
    });

    // 拦截空表单提交（回车）
    if (form) {
      form.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') {
          e.preventDefault();
          submitForm();
        }
      });
    }
  }

  /* ------------------------------------------------------------ 导出 */

  DS.lists = {
    init: init,
    renderRecords: renderRecords,
    renderTodos: renderTodos,
    renderAll: function (dateStr) {
      var date = u.normalizeDateStr(dateStr) || u.todayStr();
      contextDate = date;
      return Promise.all([renderRecords(date), renderTodos(date)]);
    },
    renderError: function (error) {
      paint('records', errorState(error, function () { renderRecords(contextDate); }));
      paint('todos', errorState(error, function () { renderTodos(contextDate); }));
    },
    openForm: openForm,
    closeForm: closeForm,
    getContextDate: function () { return contextDate; },
    getLastData: function () { return lastData; }
  };
})(window);
