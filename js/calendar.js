/* ==========================================================================
   calendar.js —— 月视图日历
   --------------------------------------------------------------------------
   · 页面加载 / 跨天时自动定位「今天」所在月份
   · 上一月 / 下一月 / 回到今天
   · 日期格按当前月动态生成（不写死 1–31；处理 2 月、大小月、1 号星期偏移）
   · 今天 = 实心圆角块（日历里唯一强对比元素）
   · 点击任意日期 → 通知订阅者（app 转发给详情面板）
   ========================================================================== */
(function (global) {
  'use strict';

  var DS = global.DS = global.DS || {};
  var u = DS.util;

  var WEEK_START_MONDAY = true;   // 周一起始（列头：一 二 三 四 五 六 日）

  var state = {
    year: 0,
    month: 0,          // 1-12
    selectedDate: '',
    todayStr: '',
    marks: null        // 当月每日数据角标
  };

  var subscribers = [];
  var marksCache = null;   // { key: 'YYYY-M', marks: {...} }

  /* ------------------------------------------------------------ 初始化 */

  function init(options) {
    var opts = options || {};
    state.todayStr = u.normalizeDateStr(opts.today) || u.todayStr();
    state.selectedDate = u.normalizeDateStr(opts.selected) || state.todayStr;

    var anchor = u.strToDate(state.selectedDate) || new Date();
    state.year = anchor.getFullYear();
    state.month = anchor.getMonth() + 1;

    renderWeekdays();
    bindNav();

    // 事件委托：点日期
    var grid = u.$('#calendar-grid');
    if (grid) {
      grid.addEventListener('click', function (e) {
        var cell = e.target.closest ? e.target.closest('.day') : null;
        if (!cell || !grid.contains(cell)) return;
        var date = cell.dataset.date;
        if (!date) return;
        selectDate(date, { silent: false });
      });
    }
  }

  function bindNav() {
    var prev = u.$('#calendar-prev');
    var next = u.$('#calendar-next');
    var today = u.$('#calendar-today');

    if (prev) prev.addEventListener('click', function () { shiftMonth(-1); });
    if (next) next.addEventListener('click', function () { shiftMonth(1); });
    if (today) today.addEventListener('click', function () {
      var t = u.todayStr();
      state.todayStr = t;
      // 必须把日期作为第三个参数传进去：两参数调用时 selectedDate 是 undefined，
      // 会走到 new Date(NaN, NaN, 0) 这条死路。
      goToMonth(t, t, t);
      emit(t, { reason: 'today' });
    });
  }

  /* ------------------------------------------------------------ 订阅 */

  function subscribe(fn) {
    if (typeof fn === 'function') subscribers.push(fn);
    return function unsubscribe() {
      var i = subscribers.indexOf(fn);
      if (i >= 0) subscribers.splice(i, 1);
    };
  }

  function emit(date, meta) {
    subscribers.forEach(function (fn) {
      try { fn(date, meta || {}); } catch (e) { /* 单个订阅者出错不影响其他 */ }
    });
  }

  /* ------------------------------------------------------------ 周期与数据 */

  function monthKey(year, month) { return year + '-' + month; }

  function invalidateMarks() { marksCache = null; }

  function loadMarks(year, month) {
    var key = monthKey(year, month);
    if (marksCache && marksCache.key === key) return Promise.resolve(marksCache.marks);
    return DS.store.monthDayMarks(year, month).then(function (marks) {
      marksCache = { key: key, marks: marks };
      return marks;
    }, function () {
      return {};   // 角标失败不影响日历主体
    });
  }

  /* ------------------------------------------------------------ 渲染 */

  function renderWeekdays() {
    var host = u.$('#calendar-weekdays');
    if (!host) return;
    u.clear(host);

    var order = WEEK_START_MONDAY ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];
    order.forEach(function (w) {
      var weekend = (w === 0 || w === 6);
      host.appendChild(u.el('div', {
        class: 'calendar__weekday' + (weekend ? ' calendar__weekday--weekend' : ''),
        text: u.WEEKDAY_CN[w]
      }));
    });
  }

  /** 计算当月 6×7 网格的起始日 */
  function gridStart(year, month) {
    var first = new Date(year, month - 1, 1);
    var jsDay = first.getDay();                       // 0=周日
    var offset = WEEK_START_MONDAY ? (jsDay === 0 ? 6 : jsDay - 1) : jsDay;
    var start = new Date(year, month - 1, 1 - offset);
    start.setHours(0, 0, 0, 0);
    return start;
  }

  function render() {
    var title = u.$('#calendar-title');
    u.setText(title, u.monthLabel(state.year, state.month));

    var grid = u.$('#calendar-grid');
    if (!grid) return Promise.resolve();

    return loadMarks(state.year, state.month).then(function (marks) {
      state.marks = marks || {};
      u.clear(grid);

      var start = gridStart(state.year, state.month);
      var today = u.todayStr();
      state.todayStr = today;

      for (var i = 0; i < 42; i++) {
        var d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        grid.appendChild(dayCell(d, today));
      }
      return state;
    }, function () {
      u.clear(grid);
      grid.appendChild(u.el('p', { class: 'state state--error', text: '日历渲染失败，请刷新页面' }));
    });
  }

  function dayCell(dateObj, today) {
    var dateStr = u.dateToStr(dateObj);
    var inMonth = dateObj.getMonth() + 1 === state.month && dateObj.getFullYear() === state.year;
    var isToday = dateStr === today;
    var isSelected = dateStr === state.selectedDate;
    var isWeekend = dateObj.getDay() === 0 || dateObj.getDay() === 6;

    var cls = ['day'];
    if (!inMonth) cls.push('is-outside');
    if (isWeekend) cls.push('is-weekend');
    if (isToday) cls.push('is-today');
    if (isSelected) cls.push('is-selected');

    var mark = state.marks && state.marks[dateStr];
    var dots = u.el('div', { class: 'day__dots' });
    if (mark) {
      if (mark.records > 0) dots.appendChild(u.el('span', { class: 'day__dot', title: '有记录' }));
      if (mark.todos > 0) dots.appendChild(u.el('span', { class: 'day__dot day__dot--todo', title: '有待办' }));
      if (mark.income > 0) dots.appendChild(u.el('span', { class: 'day__dot day__dot--income', title: '有收入' }));
      if (mark.expense > 0) dots.appendChild(u.el('span', { class: 'day__dot day__dot--expense', title: '有支出' }));
    }

    var label = u.longDate(dateStr)
      + (mark ? '，有记录' : '')
      + (isToday ? '（今天）' : '');

    return u.el('button', {
      type: 'button',
      class: cls.join(' '),
      role: 'gridcell',
      dataset: { date: dateStr },
      'aria-label': label,
      'aria-current': isToday ? 'date' : null,
      'aria-selected': isSelected ? 'true' : 'false'
    }, [
      u.el('span', { class: 'day__num', text: String(dateObj.getDate()) }),
      dots
    ]);
  }

  /* ------------------------------------------------------------ 交互 */

  /**
   * 翻到相邻月份。
   * 注意不能简单用 new Date(y, m-1+delta, 1) 再读回原「日」——
   * 1 月 31 日往后翻会得到不存在的 2 月 31 日。这里把「日」夹到目标月的最后一天。
   */
  function shiftMonth(delta) {
    var anchor = u.strToDate(state.selectedDate) || new Date(state.year, state.month - 1, 1);
    var day = anchor.getDate();
    var target = new Date(state.year, state.month - 1 + delta, 1);
    var lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();

    state.year = target.getFullYear();
    state.month = target.getMonth() + 1;
    state.selectedDate = u.dateToStr(new Date(state.year, state.month - 1, Math.min(day, lastDay)));
    render();
  }

  /**
   * 跳到指定月份。
   * goToMonth(y, m, dateStr)   —— 跳到该年月并选中 dateStr（「回到今天」用）
   * goToMonth(y, m)            —— 跳到该年月，保持当前选中日期
   * 注意：不能只靠 selectedDate 推年月，两参数调用时它是 undefined，
   * 会把 year/month 算成 NaN；这里只采信真正的数字。
   */
  function goToMonth(year, month, selectedDate) {
    var y = Number(year);
    var m = Number(month);

    var target = u.normalizeDateStr(selectedDate);
    if (target) {
      var anchor = u.strToDate(target);
      if (anchor) {
        y = anchor.getFullYear();
        m = anchor.getMonth() + 1;
      }
    }

    if (!isFinite(y) || !isFinite(m) || m < 1 || m > 12) {
      var fallback = new Date();
      y = fallback.getFullYear();
      m = fallback.getMonth() + 1;
    }

    state.year = y;
    state.month = m;
    if (target) {
      var day = u.strToDate(target).getDate();
      var lastDay = new Date(y, m, 0).getDate();
      state.selectedDate = u.dateToStr(new Date(y, m - 1, Math.min(day, lastDay)));
    }
    return render();
  }

  /** 选中某个日期：更新选中态 + 通知订阅者 */
  function selectDate(dateStr, options) {
    var date = u.normalizeDateStr(dateStr);
    if (!date) return;

    var changed = state.selectedDate !== date;
    state.selectedDate = date;

    // 选中了非本月日期 → 翻到该月
    var d = u.strToDate(date);
    if (d && (d.getFullYear() !== state.year || d.getMonth() + 1 !== state.month)) {
      state.year = d.getFullYear();
      state.month = d.getMonth() + 1;
      render();
    } else {
      updateSelection();
    }

    if (!options || options.silent !== true || changed) emit(date, { reason: 'select' });
  }

  /** 只切换选中样式，避免整月重绘 */
  function updateSelection() {
    var grid = u.$('#calendar-grid');
    if (!grid) return;
    u.$$('.day', grid).forEach(function (cell) {
      var on = cell.dataset.date === state.selectedDate;
      cell.classList.toggle('is-selected', on);
      cell.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  /**
   * 跨天刷新：推进「今天」指针。
   * 如果用户当时正停在上一个「今天」，跟随跳到新月份；否则只更新高亮。
   */
  function refreshToday(newToday, options) {
    var opts = options || {};
    var oldToday = state.todayStr;
    var next = u.normalizeDateStr(newToday) || u.todayStr();
    state.todayStr = next;
    invalidateMarks();

    var follow = opts.follow === true ||
      (opts.follow !== false && state.selectedDate === oldToday && oldToday !== next);

    if (follow) {
      state.selectedDate = next;
      state.year = u.strToDate(next).getFullYear();
      state.month = u.strToDate(next).getMonth() + 1;
      return render().then(function () {
        emit(next, { reason: 'rollover' });
        return state;
      });
    }

    return render().then(function () { return state; });
  }

  /** 数据变动后重画角标（保持当前月份与选中态） */
  function refresh() {
    invalidateMarks();
    return render();
  }

  /* ------------------------------------------------------------ 导出 */

  DS.calendar = {
    init: init,
    render: render,
    refresh: refresh,
    refreshToday: refreshToday,
    selectDate: selectDate,
    shiftMonth: shiftMonth,
    goToMonth: goToMonth,
    subscribe: subscribe,
    invalidateMarks: invalidateMarks,
    getState: function () {
      return {
        year: state.year,
        month: state.month,
        selectedDate: state.selectedDate,
        todayStr: state.todayStr
      };
    }
  };
})(window);
