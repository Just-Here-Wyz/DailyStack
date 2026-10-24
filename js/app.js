/* ==========================================================================
   app.js —— 启动、跨天刷新调度、模块装配
   --------------------------------------------------------------------------
   启动顺序：① 页面壳已有 → ② 各模块 init → ③ 首屏渲染 → ④ 挂定时器
   跨天刷新（P0）：
     a) 先算「距下一个本地 00:00 还有多少毫秒」，setTimeout 到点触发；
     b) 每 30 秒比对一次当前日期，兜住休眠 / 节流导致的定时器丢失；
     c) visibilitychange / window focus 时补一次比对。
   ========================================================================== */
(function (global) {
  'use strict';

  var DS = global.DS = global.DS || {};
  var u = DS.util;

  var SCHEDULER = {
    CHECK_INTERVAL: 30000,   // 30s 轻量轮询
    EARLY_TOLERANCE: 800,    // setTimeout 可能提前几毫秒触发，留一点余量
    MIN_DELAY: 1000
  };

  /* ------------------------------------------------------------ 状态 */

  var state = {
    today: u.todayStr(),
    selectedDate: u.todayStr(),
    booted: false,
    bootError: null,
    rolloverCount: 0
  };

  var midnightTimer = null;
  var checkTimer = null;
  var listenersBound = false;

  /* ------------------------------------------------------------ 工具 */

  /** 距下一个本地 00:00 的毫秒数（已预留公差，避免边界抖动） */
  function msUntilNextMidnight(from) {
    var now = from instanceof Date ? from : new Date();
    var next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    return Math.max(SCHEDULER.MIN_DELAY, next.getTime() - now.getTime() + SCHEDULER.EARLY_TOLERANCE);
  }

  /* ------------------------------------------------------------ 刷新 */

  /**
   * 统一刷新入口
   * @param {{stats?:boolean,lists?:boolean,calendar?:boolean,detail?:boolean}} [parts]
   */
  function refresh(parts) {
    var p = parts || { stats: true, lists: true, calendar: true, detail: true };

    if (p.calendar) DS.calendar.invalidateMarks();
    if (p.stats) DS.stats.renderLoading();

    var jobs = [];

    if (p.stats) {
      jobs.push(DS.util.safe(DS.stats.render(state.today)).then(function (res) {
        if (!res.ok) {
          DS.stats.renderError(res.error);
          reportError('统计卡读取失败', res.error);
        }
        return res;
      }));
    }

    if (p.lists) {
      jobs.push(DS.lists.renderAll(state.today));
    }

    if (p.calendar) {
      jobs.push(DS.calendar.refresh());
    }

    if (p.detail) {
      jobs.push(DS.detail.render(state.selectedDate));
    }

    if (p.extension) {
      DS.extension.render();
    }

    return Promise.all(jobs);
  }

  function notifyDataChanged() {
    // 增删改之后：统计 / 列表 / 日历角标 / 详情面板 / 扩展模块一起跟着动
    return refresh({ stats: true, lists: true, calendar: true, detail: true, extension: true });
  }

  var lastErrorToast = { message: '', at: 0 };

  /** 出错提示做去重，避免一个错误连弹十条 */
  function reportError(prefix, error) {
    var message = (error && error.message) || '未知错误';
    var text = prefix + '：' + message;
    var now = Date.now();
    if (lastErrorToast.message === text && now - lastErrorToast.at < 5000) return;
    lastErrorToast = { message: text, at: now };
    DS.toast.error(text);
  }

  /* ------------------------------------------------------------ 跨天 */

  /** 执行一次日期比对；跨天则推进「今天」并整体刷新 */
  function checkDateRollover(options) {
    var opts = options || {};
    var actual = u.todayStr();
    if (actual === state.today) return false;

    var previous = state.today;
    state.today = actual;
    state.rolloverCount += 1;

    // 用户当时正停在上一个「今天」→ 跟随跳到新的一天；否则保留他正在看的日期
    var follow = opts.follow === true || state.selectedDate === previous;
    if (follow) state.selectedDate = actual;

    DS.calendar.refreshToday(actual, { follow: follow });

    return refresh({ stats: true, lists: true, calendar: !follow, detail: true, extension: true }).then(function () {
      DS.toast.info('已跨到新的一天 · ' + u.longDate(actual), 2600);
      return true;
    });
  }

  /** 排下一次 00:00 定时器（每次触发后重排，避免长定时器漂移） */
  function scheduleMidnight() {
    if (midnightTimer) clearTimeout(midnightTimer);
    midnightTimer = setTimeout(function () {
      // 定时器可能被浏览器节流/休眠吞掉，到点先比对再重排
      Promise.resolve(checkDateRollover({ follow: true })).then(scheduleMidnight, scheduleMidnight);
    }, msUntilNextMidnight());
  }

  function bindLifecycle() {
    if (listenersBound) return;
    listenersBound = true;

    // 轻量轮询：兜住标签页休眠吞掉定时器的情况
    checkTimer = setInterval(function () {
      if (document.hidden) return;    // 后台不做事，等可见时补刷
      checkDateRollover({});
    }, SCHEDULER.CHECK_INTERVAL);

    // 页面重新可见 / 窗口重新聚焦：补一次日期比对
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        checkDateRollover({});
        scheduleMidnight();
      }
    }, false);

    global.addEventListener('focus', function () { checkDateRollover({}); }, false);

    // 某些环境（如手动改系统时间）不一定触发 focus，页面点击也补一次
    document.addEventListener('click', u.debounce(function () { checkDateRollover({}); }, 1000), true);

    // 关页面前清理，避免残留定时器（file:// 下也安全）
    global.addEventListener('beforeunload', function () {
      if (midnightTimer) clearTimeout(midnightTimer);
      if (checkTimer) clearInterval(checkTimer);
    });
  }

  /* ------------------------------------------------------------ 日历/详情联动 */

  function bindCalendar() {
    DS.calendar.subscribe(function (date, meta) {
      state.selectedDate = date;
      DS.detail.render(date);
      // 记录列表始终跟着「今天」；待办同理。选中日期只影响右栏详情与日历高亮。
      void meta;
    });
  }

  /* ------------------------------------------------------------ 首屏错误 */

  function renderBootError(error) {
    state.bootError = error;
    var message = (error && error.message) || '本地数据库初始化失败';

    DS.stats.renderError(error);
    DS.lists.renderError(error);
    DS.detail.renderError(error);

    var grid = u.$('#calendar-grid');
    if (grid) {
      u.clear(grid);
      grid.appendChild(u.el('div', { class: 'state state--error' }, [
        u.el('p', { text: message }),
        u.el('div', { class: 'state__actions' }, [
          u.el('button', {
            type: 'button', class: 'btn btn--ghost btn--sm', text: '重试',
            onclick: function () { global.location.reload(); }
          })
        ])
      ]));
    }
  }

/* ------------------------------------------------------------ 启动 */

/** PWA：注册离线缓存的 service worker。仅 https / localhost 生效，file:// 或局域网 http 下静默跳过 */
function registerServiceWorker() {
  var nav = global.navigator;
  var loc = global.location;
  if (!nav || !('serviceWorker' in nav) || !loc) return;
  var secure = loc.protocol === 'https:' || loc.hostname === 'localhost' || loc.hostname === '127.0.0.1';
  if (!secure) return;
  global.addEventListener('load', function () {
    nav.serviceWorker.register('service-worker.js').catch(function () {
      /* 离线缓存不可用不影响主功能，静默忽略 */
    });
  });
}

/**
 * PWA：捕获浏览器的 beforeinstallprompt，显示一个显眼的「安装应用」按钮。
 * 原生安装提示（地址栏图标 / 菜单项）太隐蔽，很多用户找不到，这里给一个页面内入口。
 * 注意：iOS Safari 不支持 beforeinstallprompt，该按钮不会出现，iOS 走「分享 → 添加到主屏幕」。
 * 仅 https / localhost 生效；minidom 等无 DOM 环境静默跳过（守卫 document / window）。
 */
function setupInstallButton() {
  var doc = global.document;
  var win = global;
  if (!doc || !win || typeof doc.getElementById !== 'function' || typeof win.addEventListener !== 'function') return;
  var btn = doc.getElementById('pwa-install-btn');
  if (!btn) return;

  var deferred = null;

  win.addEventListener('beforeinstallprompt', function (e) {
    // 阻止浏览器默认的小气泡，改用我们自己的按钮触发，体验更可控
    e.preventDefault();
    deferred = e;
    btn.hidden = false;
  });

  btn.addEventListener('click', function () {
    if (!deferred) return;
    deferred.prompt();
    deferred.userChoice.then(function () {
      deferred = null;
      btn.hidden = true;
    }).catch(function () { /* 用户取消安装，忽略 */ });
  });

  win.addEventListener('appinstalled', function () {
    deferred = null;
    btn.hidden = true;
  });
}

function boot() {
    if (state.booted) return;
    state.booted = true;

    state.today = u.todayStr();
    state.selectedDate = state.today;

    u.setText(u.$('#topbar-date'), u.longDate(state.today) + ' · 今天');

    // 模块初始化
    DS.lists.init();
    DS.backup.init();
    DS.calendar.init({ today: state.today, selected: state.selectedDate });

    // 扩展模块：必须在 extension.init() 之前注册，首帧才会跟着一起挂载
    DS.learnings.register();
    DS.extension.init();

    // 云端同步层：初始化客户端（离线时静默降级），并绑定登录 / 同步 UI
    if (DS.cloud) { DS.cloud.init(); DS.cloud.mountUI(); }

    // 日历 ↔ 详情联动
    bindCalendar();

    // 首屏：星历渲染 + 数据加载
    DS.stats.renderLoading();
    DS.calendar.render();

    DS.util.safe(DS.store.open()).then(function (res) {
      if (!res.ok) {
        renderBootError(res.error);
        DS.toast.error('本地数据库不可用，数据无法保存', 4000);
        return null;
      }
      // 已登录云端则先同步一次，再刷新首屏；未登录 / 云不可用时直接刷新
      var afterCloud = (DS.cloud && DS.cloud.isReady())
        ? DS.util.safe(DS.cloud.ensureSynced())
        : Promise.resolve({ ok: true });
      return afterCloud.then(function () {
        return refresh({ stats: true, lists: true, calendar: true, detail: true });
      });
    });

    // 跨天调度
    bindLifecycle();
    scheduleMidnight();

    // PWA：离线缓存 / 可安装（Edge 与手机浏览器可触发「安装应用」）
    registerServiceWorker();
    setupInstallButton();
  }

  function onReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, false);
    else fn();
  }

  /* ------------------------------------------------------------ 导出 */

  DS.app = {
    boot: boot,
    refresh: refresh,
    notifyDataChanged: notifyDataChanged,
    checkDateRollover: checkDateRollover,   // 供验收测试手动调用：DS.app.checkDateRollover()
    scheduleMidnight: scheduleMidnight,
    msUntilNextMidnight: msUntilNextMidnight,
    getToday: function () { return state.today; },
    getSelectedDate: function () { return state.selectedDate; },
    getState: function () { return Object.assign({}, state); },
    setSelectedDate: function (d) { state.selectedDate = u.normalizeDateStr(d) || state.selectedDate; }
  };

  onReady(boot);
})(window);
