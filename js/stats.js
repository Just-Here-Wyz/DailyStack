/* ==========================================================================
   stats.js —— 首页四张统计卡
   --------------------------------------------------------------------------
   今日已做     = 今天 done 的记录条数        （副文案：比昨天多/少几条）
   待办未完成   = 未完成待办（含逾期）        （副文案：比昨天多/少几条；有逾期时警示）
   今日收入     = 当天 type=income 求和       （副文案：本月累计）
   今日支出     = 当天 type=expense 求和      （副文案：本月累计）
   所有聚合都来自 DS.store，这里只负责渲染。
   ========================================================================== */
(function (global) {
  'use strict';

  var DS = global.DS = global.DS || {};
  var u = DS.util;

  var CARD_CONFIG = {
    done:        { selector: '[data-stat="done"]',        tone: 'default' },
    todoOpen:    { selector: '[data-stat="todoOpen"]',    tone: 'default' },
    income:      { selector: '[data-stat="income"]',      tone: 'success' },
    expense:     { selector: '[data-stat="expense"]',     tone: 'error' }
  };

  var lastRendered = null;

  function cardEl(key) {
    var cfg = CARD_CONFIG[key];
    return cfg ? u.$(cfg.selector) : null;
  }

  function paintCard(key, valueText, subText, subTone) {
    var node = cardEl(key);
    if (!node) return;
    var cfg = CARD_CONFIG[key];
    var valueNode = u.$('[data-field="value"]', node);
    var subNode = u.$('[data-field="sub"]', node);

    u.setText(valueNode, valueText);
    node.dataset.tone = cfg.tone === 'default' ? '' : cfg.tone;
    if (!cfg.tone || cfg.tone === 'default') delete node.dataset.tone;

    u.setText(subNode, subText);
    subNode.className = 'stat-card__sub tnum' + (subTone ? ' ' + subTone : '');
  }

  /** 把差值描述成副文案：「比昨天多 2 条」 */
  function deltaText(today, yesterday, unit) {
    var diff = today - yesterday;
    if (diff === 0) return { text: '与昨天持平', tone: 'sub--flat' };
    if (diff > 0) return { text: '比昨天多 ' + diff + ' ' + unit, tone: 'sub--up' };
    return { text: '比昨天少 ' + Math.abs(diff) + ' ' + unit, tone: 'sub--down' };
  }

  function renderLoading() {
    Object.keys(CARD_CONFIG).forEach(function (key) {
      paintCard(key, '—', '加载中…', '');
    });
  }

  /**
   * 渲染统计卡
   * @param {string} todayStr 'YYYY-MM-DD'
   * @returns {Promise<object>} 今日统计原始数据（供其他模块复用）
   */
  function render(todayStr) {
    var today = u.normalizeDateStr(todayStr) || u.todayStr();
    var yesterday = u.addDays(today, -1);
    var d = u.strToDate(today);
    var year = d.getFullYear();
    var month = d.getMonth() + 1;

    return Promise.all([
      DS.store.statsOfDate(today),
      DS.store.statsOfDate(yesterday),
      DS.store.monthStats(year, month),
      DS.store.monthOpenTodos(year, month)
    ]).then(function (res) {
      var todayStats = res[0];
      var yStats = res[1];
      var mStats = res[2];
      var monthTodoOpen = res[3];

      // 1. 今日已做
      var doneDelta = deltaText(todayStats.doneCount, yStats.doneCount, '条');
      paintCard('done', u.formatNumber(todayStats.doneCount, 0), doneDelta.text, doneDelta.tone);

      // 2. 待办未完成（含逾期）
      var todoDelta = deltaText(todayStats.todoOpenCount, yStats.todoOpenCount, '条');
      var todoSub = todoDelta.text;
      var todoTone = todoDelta.tone;
      if (todayStats.overdueCount > 0) {
        todoSub = todayStats.overdueCount + ' 条已逾期 · 共 ' + todayStats.todoOpenCount + ' 条';
        todoTone = 'sub--alert';
      }
      paintCard('todoOpen', u.formatNumber(todayStats.todoOpenCount, 0), todoSub, todoTone);

      // 3. 今日收入（副文案：本月累计）
      paintCard(
        'income',
        u.formatMoney(todayStats.income),
        '本月累计 ' + u.formatMoney(mStats.income),
        ''
      );

      // 4. 今日支出（副文案：本月累计 + 结余提示）
      var expenseSub = '本月累计 ' + u.formatMoney(mStats.expense);
      paintCard('expense', u.formatMoney(todayStats.expense), expenseSub, '');

      lastRendered = {
        today: today,
        todayStats: todayStats,
        yesterdayStats: yStats,
        monthStats: mStats,
        monthOpenTodos: monthTodoOpen
      };
      return lastRendered;
    });
  }

  function renderError(error) {
    var msg = error && error.message ? error.message : '数据读取失败';
    Object.keys(CARD_CONFIG).forEach(function (key) {
      paintCard(key, '—', msg, 'sub--alert');
    });
  }

  DS.stats = {
    render: render,
    renderLoading: renderLoading,
    renderError: renderError,
    getLastRendered: function () { return lastRendered; },
    deltaText: deltaText
  };
})(window);
