/* ==========================================================================
   test/ui.test.js —— 界面层集成自测（Node 运行，AI 自检用，非交付物）
   加载真实的 index.html 与全部 js/*，用极简 DOM 驱动真实交互路径：
     记一笔记录 / 金额校验 / 编辑 / 删除二次确认 / 勾选完成
     日历 42 格与今天高亮 / 点日期看的那一天 / 翻月 / 回到今天
     00:00 跨天刷新 / 预留扩展区 registerModule
   运行：node test/ui.test.js
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { createDocument } = require('./minidom.js');
const { FakeIndexedDB, FakeKeyRange } = require('./fake-idb.js');

const ROOT = path.join(__dirname, '..');

/* ------------------------------------------------------------ 断言框架 */

let passed = 0;
const failures = [];
let currentGroup = '(未分组)';

function group(name) { currentGroup = name; }

function ok(cond, message) {
  if (cond) { passed++; return; }
  failures.push({ group: currentGroup, message });
}

function eq(actual, expected, message) {
  if (actual === expected) { passed++; return; }
  failures.push({
    group: currentGroup,
    message: message + '（期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + '）'
  });
}

function throws(fn, message) {
  try { fn(); failures.push({ group: currentGroup, message: message + '（没有抛错）' }); }
  catch (e) { passed++; }
}

const flush = () => new Promise(r => setTimeout(r, 0));

/**
 * 夹具里的 setTimeout 只登记不执行（否则跨天定时器会乱跑），
 * 这里按需把「某个延时」的回调手动跑掉 —— 主要用来突破 debounce。
 */
function runTimeouts(ms) {
  const pending = timers.timeouts.filter(t => t.ms === ms && timers.cleared.indexOf(t) < 0);
  timers.timeouts = timers.timeouts.filter(t => !(t.ms === ms && timers.cleared.indexOf(t) < 0));
  pending.forEach(t => t.fn());
  return pending.length;
}

/* ------------------------------------------------------------ 环境装配 */

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const document = createDocument(html);

const timers = { intervals: [], timeouts: [], cleared: [] };
const storage = {};

const sandbox = {
  console,
  Promise, Date, Math, JSON, Object, Array, String, Number, Boolean, Error, RegExp, Set, Map, Proxy,
  isFinite, isNaN, parseInt, parseFloat,
  queueMicrotask, structuredClone,
  IDBKeyRange: FakeKeyRange,
  indexedDB: new FakeIndexedDB(),
  document,
  confirm: () => true,          // 测试里默认点「确定」，个别用例再覆盖
  alert: () => {},
  location: { reload() {}, href: 'file:///index.html' },
  innerWidth: 1440,
  innerHeight: 900,
  FileReader: class {
    readAsText() { this.result = this._text || '{}'; if (this.onload) this.onload(); }
  },
  Blob: class { constructor(parts) { this.parts = parts; } },
  URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
  setTimeout: (fn, ms) => { const id = { fn, ms, type: 'timeout' }; timers.timeouts.push(id); return id; },
  clearTimeout: id => { timers.cleared.push(id); },
  setInterval: (fn, ms) => { const id = { fn, ms, type: 'interval' }; timers.intervals.push(id); return id; },
  clearInterval: id => { timers.cleared.push(id); },
  addEventListener() {},
  removeEventListener() {}
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
sandbox.localStorage = {
  getItem: k => (k in storage ? storage[k] : null),
  setItem: (k, v) => { storage[k] = String(v); },
  removeItem: k => { delete storage[k]; }
};
// document 需要能看到 sandbox 上的 confirm 等
document.defaultView = sandbox;

vm.createContext(sandbox);

// 顺序必须与 index.html 保持一致（learnings 依赖 extension，且须在 app 之前）
const JS_FILES = [
  'js/util.js', 'js/store.js', 'js/toast.js', 'js/stats.js', 'js/lists.js',
  'js/calendar.js', 'js/detail.js', 'js/extension.js', 'js/learnings.js',
  'js/backup.js', 'js/app.js'
];
JS_FILES.forEach(f => {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
});

const DS = sandbox.DS;
const store = DS.store;
const u = DS.util;
const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

/* ------------------------------------------------------------ 取数小工具 */

const statValue = key => ((($('[data-stat="' + key + '"] [data-field="value"]') || {}).textContent) + '');
const statSub = key => ((($('[data-stat="' + key + '"] [data-field="sub"]') || {}).textContent) + '');
const listRows = kind => $$(kind === 'records' ? '[data-testid="record-list"] .row' : '[data-testid="todo-list"] .row');
const dayCells = () => $$('#calendar-grid .day');
const dayByDate = d => dayCells().filter(c => c.dataset.date === d)[0] || null;
const toastTexts = () => $$('#toast-host .toast').map(t => t.textContent);

/** 走真实抽屉流程新增一条数据；表单字段按 data-form-kind 作用域定位 */
function fillAndSubmit(kind, values) {
  const form = $('#drawer-form');
  eq($('#drawer').hidden, false, '抽屉应当已打开');

  Object.keys(values).forEach(name => {
    const inputs = $$('#drawer-form [data-form-kind="' + kind + '"] [name="' + name + '"]');
    if (!inputs.length) throw new Error('表单里找不到字段 ' + kind + '/' + name);
    const isRadio = inputs[0].getAttribute('type') === 'radio';
    if (isRadio) {
      inputs.forEach(r => { r.checked = r.value === values[name]; });
      const hit = inputs.filter(r => r.checked).length;
      if (hit !== 1) throw new Error('单选项 ' + name + ' 没选中：' + values[name]);
    } else {
      inputs[0].value = values[name];
    }
  });

  form.dispatchEvent({ type: 'submit', bubbles: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
}

/* ==========================================================================
   首屏
   ========================================================================== */

async function bootAndWait() {
  DS.app.boot();
  // 等首屏所有异步渲染落地
  for (let i = 0; i < 40; i++) {
    await flush();
    if (statValue('done') !== '—') break;
  }
  await flush();
}

async function run() {
  group('DOM 解析自检');
  [
    '#btn-backup', '#drawer-backup', '#drawer', '#drawer-form', '#card-records', '#card-todos',
    '#calendar-grid', '#calendar-title', '#calendar-prev', '#calendar-next', '#calendar-today',
    '#detail-title', '#detail-income', '#detail-expense', '#detail-balance', '#detail-list',
    // 注：#extension-count / #extension-placeholder 已随「去掉预留扩展区」移除
    '#extension-zone', '#extension-mounted', '#detail-add-finance',
    '[data-stat="done"]', '[data-stat="todoOpen"]', '[data-stat="income"]', '[data-stat="expense"]',
    '[data-open-form="record"]', '[data-open-form="todo"]', '#record-content', '#todo-content',
    '#finance-amount', '#import-file', '#btn-export', '#btn-clear-all', '#toast-host', '#topbar-date'
  ].forEach(sel => ok($(sel) !== null, 'index.html 里必须能取到 ' + sel));

  group('首屏');
  await bootAndWait();

  ok(dayCells().length === 42, '日历应当渲染 42 个日期格（实际 ' + dayCells().length + '）');
  ok(!!dayByDate(u.todayStr()), '今天的日期格必须存在');
  ok(dayByDate(u.todayStr()).classList.contains('is-today'), '今天要有 is-today 高亮');
  eq(statValue('done'), '0', '首屏今日已做为 0');
  eq(statValue('income'), '¥0.00', '首屏今日收入格式化正确');
  eq(statValue('expense'), '¥0.00', '首屏今日支出格式化正确');
  ok($('#topbar-date').textContent.indexOf(u.longDate(u.todayStr())) === 0, '顶栏日期应为今天');
  ok($('[data-testid="card-records"] .state') !== null, '无记录时应显示空状态');
  ok(($('[data-testid="card-records"] .state') || {}).textContent.indexOf('今天还没有记录') >= 0, '空状态文案要对');
  ok(($('[data-testid="card-todos"] .state') || {}).textContent.indexOf('暂无待办') >= 0, '待办空状态文案要对');
  // 扩展区不再是「预留」，首屏就挂着「学习到了什么」，外观与普通卡片无异
  ok($('#extension-zone').textContent.indexOf('预留') < 0, '不该再出现「预留扩展区」字样');
  ok($('#extension-zone').querySelector('[data-module="learnings"]') !== null, '学习便利贴模块要出现在首页');
  eq($$('#extension-mounted .ext-module').length, 1, '首屏应挂上 1 个模块');
  eq($('#detail-title').textContent, u.shortDate(u.todayStr()) + ' · 当日详情', '详情面板标题');
  ok($('#detail-balance').textContent.indexOf('结余 ¥0.00') === 0, '详情结余初始为 0');
  ok(timers.intervals.length >= 1, '应当挂上跨天轮询定时器');
  ok(timers.timeouts.some(t => t.ms > 0 && t.ms <= 86400000 + 1000), '应当挂上到 00:00 的定时器');

  /* ---------------------------------------------------------- 记录流程 */
  group('记录 · 新增');

  $('#card-records').querySelector('[data-open-form="record"]').click();
  fillAndSubmit('record', { content: '完成简历初稿', date: u.todayStr() });
  await flush(); await flush();
  await flush();

  eq(listRows('records').length, 1, '新增后列表应有 1 条');
  eq($('#drawer').hidden, true, '保存后抽屉应关闭');
  eq(statValue('done'), '1', '「做了什么」默认就是已完成，今日已做应为 1');
  ok(listRows('records')[0].textContent.indexOf('完成简历初稿') >= 0, '列表要显示内容');
  ok(toastTexts().indexOf('已保存') >= 0, '保存后要有成功提示');

  const savedRecord = await store.listByDate('records', u.todayStr()).then(r => r[0]);
  eq(savedRecord.content, '完成简历初稿', '内容要正确落库');
  eq(savedRecord.done, true, '默认已完成');

  group('记录 · 不做完成态标记');
  // 「做了什么」记的就是做完的事：列表里不该再有勾选框，也不该有 is-done 之类的标记
  eq(listRows('records')[0].querySelector('.check'), null, '列表不应再有勾选框');
  ok(!listRows('records')[0].classList.contains('is-done'), '不应出现 is-done 标记');
  ok(listRows('records')[0].textContent.indexOf('未完成') < 0, '不应出现「未完成」字样');
  eq(statValue('done'), '1', '今日已做口径不变');

  /* ---------------------------------------------------------- 金额校验 */
  group('收支 · 金额校验');

  const recordCountBefore = (await store.listAll('finances')).length;

  $('#btn-backup').click();          // 打开备份抽屉再关掉，验证互不干扰
  eq($('#drawer-backup').hidden, false, '备份抽屉应能打开');
  $('#drawer-backup').querySelector('[data-drawer-close]').click();
  eq($('#drawer-backup').hidden, true, '备份抽屉应能关闭');

  ['-5', 'abc', '', '0'].forEach(bad => {
    DS.lists.openForm('finance', null, u.todayStr());
    fillAndSubmit('finance', { amount: bad, type: 'expense', date: u.todayStr() });
    const errNode = $('#drawer-form').querySelector('[data-error-for="amount"]');
    ok(errNode.textContent.length > 0, '非法金额「' + (bad || '空') + '」必须给出提示');
    ok($('#drawer').hidden === false, '非法金额不应关闭抽屉');
    DS.lists.closeForm();
  });

  eq((await store.listAll('finances')).length, recordCountBefore, '非法金额不能被写入');

  group('收支 · 正常记账与统计');
  DS.lists.openForm('finance', null, u.todayStr());
  fillAndSubmit('finance', { amount: '320.5', type: 'income', category: '兼职', date: u.todayStr() });
  await flush(); await flush(); await flush();
  eq(statValue('income'), '¥320.50', '今日收入应为 ¥320.50');

  DS.lists.openForm('finance', null, u.todayStr());
  fillAndSubmit('finance', { amount: '86.5', type: 'expense', category: '餐饮', date: u.todayStr() });
  await flush(); await flush(); await flush();
  eq(statValue('expense'), '¥86.50', '今日支出应为 ¥86.50');
  ok(statSub('income').indexOf('本月累计 ¥320.50') >= 0, '收入副文案要显示本月累计');

  /* ---------------------------------------------------------- 待办流程 */
  group('待办 · 优先级与日期');
  DS.lists.openForm('todo', null, u.todayStr());
  fillAndSubmit('todo', { content: '投递岗位', priority: 'high', date: u.todayStr() });
  await flush(); await flush(); await flush();

  eq(listRows('todos').length, 1, '待办列表应有 1 条');
  eq(statValue('todoOpen'), '1', '待办未完成应为 1');
  ok((listRows('todos')[0] || {}).textContent !== undefined, '待办行应存在（诊断：卡片内容=' + $('#card-todos').textContent.slice(0, 80) + '）');
  if (listRows('todos')[0]) {
    ok(listRows('todos')[0].textContent.indexOf('高') >= 0, '高优先级要显示出来');
    ok(listRows('todos')[0].querySelector('.pill--high') !== null, '高优先级要用 high 样式');
  }

  // 排到未来的待办不应计入今天的「待办未完成」
  const future = u.addDays(u.todayStr(), 3);
  DS.lists.openForm('todo', null, future);
  fillAndSubmit('todo', { content: '三天后再做的事', priority: 'low', date: future });
  await flush(); await flush(); await flush();
  eq(statValue('todoOpen'), '1', '未来日期的待办不算进今天');
  const futureCell = dayByDate(future);
  ok(!!futureCell, '未来日期格子应在当前网格里（' + future + '，标题 ' + $('#calendar-title').textContent + '，格子数 ' + dayCells().length + '）');
  if (futureCell) {
    eq(futureCell.querySelectorAll('.day__dot--todo').length, 1, '未来日期应有待办角标');
  }

  // 逾期口径：昨天的未完成待办要一直挂在「要做什么」列表里（不随跨天被刷新掉），并带逾期标记
  const yesterday = u.addDays(u.todayStr(), -1);
  await store.add('todos', { date: yesterday, content: '昨天没做完的事', priority: 'medium' });
  await DS.app.notifyDataChanged();
  await flush(); await flush(); await flush();
  const overdueRow = listRows('todos').find(r => r.textContent.indexOf('昨天没做完的事') >= 0);
  ok(!!overdueRow, '昨天未完成的待办应仍显示在列表里（不随跨天消失）');
  if (overdueRow) {
    ok(overdueRow.querySelector('.pill--overdue') !== null, '逾期待办要有「逾期」标记');
    ok(listRows('todos')[0] === overdueRow || !(listRows('todos')[0].querySelector('.pill--overdue')), '未完成（含逾期）应排在已完成之前');
  }
  eq(statValue('todoOpen'), '2', '待办未完成应含逾期共 2 条');

  /* ---------------------------------------------------------- 编辑 / 删除 */
  group('记录 · 编辑');
  listRows('records')[0].querySelectorAll('.icon-btn')[0].click();
  eq($('#drawer').hidden, false, '编辑抽屉应打开');
  eq($('#record-content').value, '完成简历初稿', '编辑时应带出原内容');
  fillAndSubmit('record', { content: '完成简历终稿', date: u.todayStr() });
  await flush(); await flush(); await flush();
  ok(listRows('records')[0].textContent.indexOf('完成简历终稿') >= 0, '内容应被更新');
  eq((await store.listByDate('records', u.todayStr())).length, 1, '编辑不应新增一条');

  group('记录 · 删除需二次确认');
  sandbox.confirm = () => false;
  listRows('records')[0].querySelectorAll('.icon-btn')[1].click();
  await flush(); await flush();
  eq((await store.listByDate('records', u.todayStr())).length, 1, '点了取消就不该删除');

  sandbox.confirm = () => true;
  listRows('records')[0].querySelectorAll('.icon-btn')[1].click();
  await flush(); await flush(); await flush();
  eq(listRows('records').length, 0, '确认后列表应清空');
  eq(statValue('done'), '0', '删除后统计要跟着回到 0');
  ok(toastTexts().indexOf('已删除') >= 0, '删除后要有提示');

  /* ---------------------------------------------------------- 日历联动 */
  group('日历 · 翻月 / 回到今天');
  const todayD = u.strToDate(u.todayStr());
  const thisMonthTitle = u.monthLabel(todayD.getFullYear(), todayD.getMonth() + 1);
  eq($('#calendar-title').textContent, thisMonthTitle, '日历默认定位当前月');
  ok(u.dateToStr(dayCells()[0].dataset.date ? u.strToDate(dayCells()[0].dataset.date) : new Date()) === dayCells()[0].dataset.date, '首格日期串合法');

  $('#calendar-next').click();
  await flush(); await flush();
  const nextMonth = new Date(todayD.getFullYear(), todayD.getMonth() + 1, 1);
  eq($('#calendar-title').textContent, u.monthLabel(nextMonth.getFullYear(), nextMonth.getMonth() + 1), '下一月标题要正确');
  eq(dayCells().length, 42, '翻月后仍是 42 格');

  $('#calendar-prev').click();
  await flush(); await flush();
  eq($('#calendar-title').textContent, thisMonthTitle, '上一月要能回到当前月');

  // 连续快速翻 12 次不应报错
  for (let i = 0; i < 12; i++) {
    $('#calendar-next').click();
    if (!u.isValidDateStr(DS.calendar.getState().selectedDate)) {
      failures.push({ group: currentGroup, message: '第 ' + (i + 1) + ' 次翻月后选中日期非法：' + DS.calendar.getState().selectedDate });
      break;
    }
  }
  await flush(); await flush();
  eq(dayCells().length, 42, '连续翻月后网格完整');
  ok(u.isValidDateStr(DS.calendar.getState().selectedDate), '翻月后选中日期仍是合法日期（实际 ' + DS.calendar.getState().selectedDate + '）');
  ok(/^\d{4}年\d{1,2}月$/.test($('#calendar-title').textContent), '翻月后标题合法（实际 ' + $('#calendar-title').textContent + '）');
  const beforeToday = DS.calendar.getState();
  $('#calendar-today').click();
  await flush(); await flush();
  eq($('#calendar-title').textContent, thisMonthTitle, '「今天」按钮要回到当前月（点之前 state=' +
    beforeToday.year + '-' + beforeToday.month + '/' + beforeToday.selectedDate + '）');
  eq(DS.calendar.getState().selectedDate, u.todayStr(), '「今天」按钮要把选中日期设成今天');

  group('日历 · 点日期看的是那一天');
  // 选一个「当月但不是今天」的日期，保证它一定在可见网格里
  const todayObj = u.strToDate(u.todayStr());
  const monthFirst = new Date(todayObj.getFullYear(), todayObj.getMonth(), 1);
  const pastObj = monthFirst.getDate() === todayObj.getDate()
    ? new Date(todayObj.getFullYear(), todayObj.getMonth(), 2)
    : monthFirst;
  const past = u.dateToStr(pastObj);
  ok(past !== u.todayStr(), '测试日期不能是今天');

  await store.add('records', { date: past, content: '五天前做的事', done: true });
  await store.add('finances', { date: past, type: 'expense', amount: 12.34, category: '交通' });
  await store.add('finances', { date: past, type: 'income', amount: 100, category: '红包' });
  await DS.app.notifyDataChanged();
  await flush(); await flush();

  const pastCell = dayByDate(past);
  ok(!!pastCell, '当月日期的格子存在（' + past + '，标题 ' + $('#calendar-title').textContent + '）');
  if (!pastCell) { failures.push({ group: currentGroup, message: '日历里找不到 ' + past + '，后续联动断言无法进行' }); return; }
  pastCell.click();
  await flush(); await flush(); await flush();

  ok(pastCell.classList.contains('is-selected'), '被点日期要有选中态');
  eq($('#detail-title').textContent, u.shortDate(past) + ' · 当日详情', '详情标题要变成被点那一天');
  eq($('#detail-income').textContent, '¥100.00', '详情收入应为那一天的 100');
  eq($('#detail-expense').textContent, '¥12.34', '详情支出应为那一天的 12.34');
  ok($('#detail-balance').textContent.indexOf('结余 ¥87.66') >= 0, '详情结余应为 87.66');
  ok($('#detail-list').textContent.indexOf('五天前做的事') >= 0, '详情要列出那天的记录');
  ok($('#detail-list').textContent.indexOf('交通') >= 0, '详情要列出那天的收支');
  eq(DS.app.getSelectedDate(), past, 'app 要记住选中日期');

  // 左栏列表仍然显示「今天」，不受选中日期影响
  eq(DS.lists.getContextDate(), u.todayStr(), '左栏列表始终是今天');
  eq(statValue('expense'), '¥86.50', '统计卡仍是今天的数字，不跟着选中日期变');

  // 点到非本月日期应自动翻到那个月
  const firstCell = dayCells()[0];
  if (firstCell.classList.contains('is-outside')) {
    const target = firstCell.dataset.date;
    const targetD = u.strToDate(target);
    firstCell.click();
    await flush(); await flush(); await flush();
    eq($('#calendar-title').textContent, u.monthLabel(targetD.getFullYear(), targetD.getMonth() + 1), '点非本月日期要翻到那个月');
    eq(DS.app.getSelectedDate(), target, '选中日期要更新');
  }

  $('#calendar-today').click();
  await flush(); await flush(); await flush();
  eq(DS.app.getSelectedDate(), u.todayStr(), '回到今天后选中日期是今天');
  eq($('#detail-title').textContent, u.shortDate(u.todayStr()) + ' · 当日详情', '详情跟着回到今天');

  /* ---------------------------------------------------------- 跨天刷新 */
  group('跨天 · 00:00 自动刷新');

  // 把「今天」指针往前挪一天，模拟已跨天
  const realToday = u.todayStr();
  const fake = DS.app.getState();
  eq(typeof fake.today, 'string', 'app 内部维护 today 指针');

  // 造一个「昨天」的记录，然后手动把 app 的 today 改成明天，触发跨天逻辑
  const tomorrow = u.addDays(realToday, 1);
  DS.app.setSelectedDate(realToday);
  const beforeRollover = DS.app.getToday();
  eq(beforeRollover, realToday, '跨天前 today 是今天');

  // 直接调用轮询用的比对函数：真实日期没变，所以不该触发
  const changed = await DS.app.checkDateRollover();
  eq(changed, false, '同一天内比对不应触发刷新');

  ok(timers.timeouts.length >= 1, '跨天定时器已排期');
  const maxDelay = Math.max(...timers.timeouts.map(t => t.ms || 0));
  ok(maxDelay > 0 && maxDelay <= 86400000 + 1000, '距下一个 00:00 的延迟应在一天以内（实际 ' + maxDelay + '）');

  /* ---------------------------------------------------------- 扩展区 */
  group('扩展区 · registerModule');
  const unmountCalls = [];
  // 首屏已挂了 learnings，这里按基线做相对断言，新增模块不用回来改数字
  const baseModules = DS.extension.listModules().length;
  const slots = () => $$('#extension-mounted .ext-module').length;
  DS.extension.registerModule({
    id: 'demo-module',
    title: '演示模块',
    order: 5,
    mount(host) {
      const p = document.createElement('p');
      p.className = 'demo-line';
      p.textContent = '挂载成功';
      host.appendChild(p);
      return function unmount() { unmountCalls.push('demo-module'); };
    }
  });
  await flush();

  eq(slots(), baseModules + 1, '挂载后槽位要 +1（实际 ' + slots() + '）');
  ok($('#extension-mounted').textContent.indexOf('挂载成功') >= 0, '模块内容要渲染出来');
  ok($('#extension-zone').querySelector('[data-module="demo-module"]') !== null, '模块容器要带 data-module');

  // 模块内部报错不能拖垮首页
  DS.extension.registerModule({
    id: 'broken-module',
    title: '会炸的模块',
    mount() { throw new Error('故意炸一下'); }
  });
  await flush();
  eq(slots(), baseModules + 2, '坏模块也要占一个槽位');
  eq(statValue('done'), '0', '坏模块不能影响统计卡');
  ok($('#extension-zone').textContent.indexOf('会炸的模块') >= 0, '坏模块要在自己的槽位里报错');
  ok(dayCells().length === 42, '坏模块不能影响日历');

  DS.extension.unregisterModule('broken-module');
  await flush();
  eq(slots(), baseModules + 1, '注销后槽位恢复');

  /* ---------------------------------------------------------- 学习便利贴 */
  group('学习便利贴 · learnings');
  {
    const slot = $('#extension-zone').querySelector('[data-module="learnings"]');
    ok(slot !== null, 'learnings 模块要在扩展区里占一个槽位');

    const root = slot.querySelector('.learn');
    const bar = slot.querySelector('.learn__bar');
    const input = slot.querySelector('.learn__compose .input');
    const addBtn = slot.querySelector('.learn__add');
    const notes = () => slot.querySelectorAll('.note');

    ok(root && bar && input && addBtn, '折叠条 / 输入框 / 贴上按钮都要有');
    eq(notes().length, 0, '初始一张便利贴都没有');

    // —— 新增 ——
    input.value = 'IndexedDB 事务空闲就会自动提交';
    addBtn.click();
    await flush();
    await flush();
    eq(notes().length, 1, '贴上后应出现一张便利贴');
    eq(slot.querySelector('.learn__count').textContent, '1', '计数徽章要跟着更新');
    eq((await store.listAll('learnings')).length, 1, '知识点要真的落库');
    ok(notes()[0].className.indexOf('note--t') >= 0, '便利贴要带纸色类');

    // —— 折叠 ——
    bar.click();
    ok(root.classList.contains('learn--collapsed'), '点标题应折叠');
    eq(bar.getAttribute('aria-expanded'), 'false', '折叠时 aria-expanded 要为 false');
    bar.click();
    ok(!root.classList.contains('learn--collapsed'), '再点应展开');
    eq(bar.getAttribute('aria-expanded'), 'true', '展开时 aria-expanded 要为 true');

    // —— 纸色/倾斜由 id 决定，同一条重绘后应保持一致 ——
    const tintBefore = notes()[0].className;
    DS.learnings.refresh();
    await flush();
    await flush();
    eq(notes()[0].className, tintBefore, '重绘后纸色不能跳');

    // —— 删除（confirm 默认点确定）——
    notes()[0].querySelector('.note__del').click();
    await flush();
    await flush();
    eq(notes().length, 0, '删除后便利贴要消失');
    eq((await store.listAll('learnings')).length, 0, '库里也要删掉');
    eq(slot.querySelector('.learn__count').textContent, '0', '计数归零');
  }

  /* ---------------------------------------------------- 标签与检索 */
  group('学习便利贴 · 标签与检索');
  {
    const slot = $('#extension-zone').querySelector('[data-module="learnings"]');
    const input = slot.querySelector('.learn__compose .input');
    const tagInput = slot.querySelector('.learn__tag-input');
    const addBtn = slot.querySelector('.learn__add');
    const search = slot.querySelector('.learn__search');
    const notes = () => slot.querySelectorAll('.note');
    const chips = () => slot.querySelectorAll('.learn__chip');
    const chipOf = t => chips().filter(c => c.textContent.indexOf('#' + t) >= 0)[0];
    const noteTexts = () => notes().map(n => n.querySelector('.note__text').textContent);
    const typeSearch = v => {
      search.value = v;
      search.dispatchEvent({ type: 'input', bubbles: true });
      runTimeouts(180);                 // 搜索走了 180ms 防抖，夹具里要手动放行
      return flush().then(flush);
    };

    ok(!!tagInput && !!search, '新增标签框与检索框都要存在');
    eq(notes().length, 0, '从空墙开始');

    // —— 带标签新增 ——
    input.value = 'CSS 层叠上下文决定谁盖住谁';
    tagInput.value = '前端 CSS';
    addBtn.click();
    await flush(); await flush();
    eq(notes().length, 1, '带标签的知识点要能贴上');
    const n1 = (await store.listAll('learnings'))[0];
    eq(n1.tags.join(','), '前端,CSS', '标签要按输入顺序落库');
    eq(notes()[0].querySelectorAll('.note__tag').length, 2, '便利贴上要渲染出两个标签 chip');
    eq(input.value + tagInput.value, '', '贴上后两个输入框都要清空');

    // —— 第二条：只带自己的标签，方便验证筛选 ——
    input.value = 'IndexedDB 的索引按 keyPath 建';
    tagInput.value = '数据库';
    addBtn.click();
    await flush(); await flush();
    eq(notes().length, 2, '第二条也要贴上');

    // —— 标签云 ——
    const cloud = chips().map(c => c.textContent);
    eq(cloud.length, 4, '标签云应为「全部」+ 3 个标签（实际 ' + cloud.join(' / ') + '）');
    ok(cloud[0].indexOf('全部 2') >= 0, '「全部」要带总条数（实际 ' + cloud[0] + '）');
    ok(cloud.join('|').indexOf('#前端 1') >= 0, '每个标签要带条数');
    ok(chips()[0].className.indexOf('is-active') >= 0, '默认选中「全部」');

    // —— 点标签筛选 / 再点取消 ——
    chipOf('前端').click();
    await flush(); await flush();
    eq(notes().length, 1, '点 #前端 后只剩一条');
    ok(noteTexts()[0].indexOf('层叠上下文') >= 0, '留下的应是带该标签的那条');
    ok(chipOf('前端').className.indexOf('is-active') >= 0, '被点的标签要高亮');
    ok(chips()[0].className.indexOf('is-active') < 0, '「全部」要取消高亮');

    chipOf('前端').click();
    await flush(); await flush();
    eq(notes().length, 2, '再点一次应取消筛选');
    ok(chips()[0].className.indexOf('is-active') >= 0, '取消后回到「全部」');

    // —— 关键词：命中正文 ——
    await typeSearch('keyPath');
    eq(notes().length, 1, '搜正文关键词应命中一条');
    ok(noteTexts()[0].indexOf('IndexedDB') >= 0, '命中的应是那一条');

    // —— 关键词：命中标签 ——
    await typeSearch('数据库');
    eq(notes().length, 1, '搜标签也要命中');
    ok(noteTexts()[0].indexOf('IndexedDB') >= 0, '按标签命中的仍应是那一条');

    // —— 标签 + 关键词叠加，且无交集 ——
    chipOf('CSS').click();
    await flush(); await flush();
    eq(notes().length, 0, '标签与关键词叠加无交集时应一张不剩');
    ok(slot.textContent.indexOf('没有匹配的知识点') >= 0, '要说清楚是筛选造成的，不是没数据');

    const resetBtn = slot.querySelectorAll('.state__actions .btn').filter(b => b.textContent === '清空筛选')[0];
    ok(!!resetBtn, '要给「清空筛选」的退路');
    resetBtn.click();
    await flush(); await flush();
    eq(notes().length, 2, '清空筛选后应恢复全部');
    eq(search.value, '', '清空筛选要把搜索框也清掉');
    ok(chips()[0].className.indexOf('is-active') >= 0, '清空后回到「全部」');

    // —— 编辑时改标签（本轮起：单击先放大预览，编辑入口收进预览层） ——
    const target = notes().filter(n => n.querySelector('.note__text').textContent.indexOf('层叠上下文') >= 0)[0];
    target.querySelector('.note__text').click();
    await flush();
    const preview = document.querySelector('.note-preview');
    ok(!!preview, '单击正文要先打开放大预览');
    const pvEdit = preview ? preview.querySelectorAll('.btn').filter(b => b.textContent === '编辑')[0] : null;
    ok(!!pvEdit, '预览层里要有「编辑」入口');
    if (pvEdit) pvEdit.click();
    await flush();
    ok(!document.querySelector('.note-preview'), '从预览进入编辑后预览层要关掉');
    const editArea = slot.querySelector('.note__edit');
    const editTags = slot.querySelector('.note__tag-input');
    ok(!!editArea && !!editTags, '点编辑要进入编辑态，并带出标签输入');
    eq(editTags.value, '前端 CSS', '编辑时要回填原标签');
    editTags.value = '前端 CSS 布局';
    document.activeElement = null;                 // 焦点没落在另一个输入框上，才算编辑结束
    editTags.dispatchEvent({ type: 'blur', bubbles: false });
    runTimeouts(0);
    await flush(); await flush(); await flush();
    const n1b = (await store.listAll('learnings')).filter(r => r.id === n1.id)[0];
    eq(n1b.tags.join(','), '前端,CSS,布局', '编辑改的标签要落库');
    eq(slot.querySelector('.learn__count').textContent, '2', '改标签不该改变条数');

    // —— 学到了什么不随时间更新 ——
    const keep = notes().length;
    const otherDay = u.addDays(u.todayStr(), -3);
    DS.app.setSelectedDate(otherDay);
    await DS.detail.render(otherDay);          // 真正把详情面板切到那一天
    await flush(); await flush();
    eq(DS.detail.getCurrentDate(), otherDay, '详情面板确实切走了');
    eq(notes().length, keep, '切到别的日期，便利贴数量不变（它是累积知识库，不按日切片）');
    await DS.app.notifyDataChanged();
    await flush(); await flush();
    eq(notes().length, keep, '数据刷新后便利贴仍然不变');
    ok(slot.querySelector('.note__meta') !== null, '便利贴仍带着日期戳，但不参与筛选');

    // —— 单独导出：JSON / Markdown 结构要能被 Python 直接消费 ——
    const expJson = DS.learnings.toJson();
    eq(expJson.schema, 'daily-stack.learnings/v1', '导出 JSON 要带 schema 标识');
    eq(expJson.count, expJson.items.length, 'count 要等于 items 条数');
    ok(Array.isArray(expJson.items[0].tags) && typeof expJson.items[0].content === 'string',
      'items 要含 content 与 tags 数组');
    const expMd = DS.learnings.toMarkdown();
    ok(expMd.indexOf('## 1.') >= 0 && expMd.indexOf('标签：') >= 0, 'Markdown 要按条分节并带标签');

    // —— 按筛选导出：勾选框默认禁用，应用筛选后可用，导出范围等于页面显示 ——
    // 注意：前面 notifyDataChanged() 会让扩展模块重新挂载，组开头取的 slot 已脱离文档，
    // 这里必须重新查询当前挂载的模块，否则拿到的是旧子树、永远不会被更新。
    const liveSlot = $('#extension-zone').querySelector('[data-module="learnings"]');
    ok(liveSlot !== null, '重新挂载后仍能取到当前 learnings 槽位');
    const scopeBox = liveSlot.querySelector('.learn__scope-input');
    ok(scopeBox !== null, '筛选栏要有「仅导出筛选结果」勾选框');
    eq(scopeBox.disabled, true, '无筛选时勾选框应禁用（避免导成不存在的空集）');
    eq(DS.learnings.hasFilter(), false, 'hasFilter 在无筛选时应为 false');

    // 点一个标签 chip 触发筛选（chip 文本以 # 开头，第一个「全部 N」除外）
    const tagChip = Array.prototype.slice.call(liveSlot.querySelectorAll('.learn__chip'))
      .find(function (b) { return String(b.textContent || '').charAt(0) === '#'; });
    ok(tagChip !== undefined, '标签云里要有真实标签 chip 可点');
    if (tagChip) {
      tagChip.click();
      // 勾选框的启用发生在 refreshWall() 的异步 load() 之后，必须 await 刷新完成
      await DS.learnings.refresh();
      await flush();
      eq(DS.learnings.hasFilter(), true, '点了标签后应处于筛选状态');
      eq(scopeBox.disabled, false, '有筛选后勾选框应可用（筛选一变就同步，不等数据加载）');

      const visible = DS.learnings.visibleRows();
      ok(visible.length > 0 && visible.length <= keep,
        '筛选结果应非空且不超过全部条数');
      eq(DS.learnings.toJson(visible).count, visible.length,
        '按筛选导出时 count 应等于筛选出的条数（不是全量）');
      ok(visible.every(function (r) { return (r.tags || []).length > 0; }),
        '筛选出的条目都应带标签（本次是按标签筛的）');

      // 取消筛选 → 勾选框应回到禁用并自动取消勾选
      const allChip = liveSlot.querySelector('.learn__chip');
      if (allChip) { allChip.click(); await DS.learnings.refresh(); await flush(); }
      eq(DS.learnings.hasFilter(), false, '点回「全部」应清除筛选');
      eq(scopeBox.disabled, true, '清除筛选后勾选框应重新禁用');
      eq(scopeBox.checked, false, '清除筛选后勾选应自动取消');
    }
  }

  /* ------------------------------------------------ 收支编辑与两位小数 */
  group('收支 · 编辑 / 删除 / 两位小数');
  {
    const finBefore = (await store.listAll('finances')).length;

    // setSelectedDate 只改状态不重渲染，详情面板要显式驱动（真实操作是点日历）
    DS.app.setSelectedDate(u.todayStr());
    await DS.detail.render(u.todayStr());
    await flush(); await flush();
    eq(DS.detail.getCurrentDate(), u.todayStr(), '详情面板应停在被选中的那一天');

    // —— 详情面板的常驻入口 ——
    ok(!!$('#detail-add-finance'), '详情面板要有常驻的「记一笔」入口');
    ok($('#detail-add-hint').textContent.indexOf('今天') >= 0, '入口要说明记在哪一天');
    $('#detail-add-finance').click();
    eq($('#drawer').hidden, false, '点「记一笔」应打开抽屉');
    const amountInput = $('#finance-amount');
    ok(amountInput && !amountInput.hidden, '打开的应是收支表单');
    eq($('#finance-date').value, u.todayStr(), '默认记在选中的那一天');

    // —— 输入收敛 ——
    amountInput.value = '12.345';
    amountInput.dispatchEvent({ type: 'input', bubbles: true });
    eq(amountInput.value, '12.34', '边打边收敛到两位小数');
    amountInput.value = '1.2.3';
    amountInput.dispatchEvent({ type: 'input', bubbles: true });
    eq(amountInput.value, '1.23', '多个小数点只保留第一个');
    amountInput.value = '12a.5';
    amountInput.dispatchEvent({ type: 'input', bubbles: true });
    eq(amountInput.value, '12.5', '字母要被过滤掉');
    amountInput.value = '12.3';
    amountInput.dispatchEvent({ type: 'input', bubbles: true });
    amountInput.dispatchEvent({ type: 'blur', bubbles: false });
    eq(amountInput.value, '12.30', '失焦补齐成两位');

    fillAndSubmit('finance', { amount: '12.34', type: 'expense', category: '测试', note: '两位小数', date: u.todayStr() });
    await flush(); await flush(); await flush();
    const created = (await store.listAll('finances')).filter(f => f.note === '两位小数')[0];
    ok(!!created, '新账要落库');
    eq(created.amount, 12.34, '金额要精确到分');
    eq($('#drawer').hidden, true, '保存后抽屉要关掉');

    // —— 详情里能编辑 ——
    const rowOf = kw => $$('#detail-list .detail__row').filter(r => r.textContent.indexOf(kw) >= 0)[0];
    await DS.app.notifyDataChanged();
    await flush(); await flush();
    const row = rowOf('两位小数');
    ok(!!row, '详情面板要列出这笔');
    ok(row.textContent.indexOf('-¥12.34') >= 0, '支出要带负号与两位小数');
    eq(row.querySelectorAll('.icon-btn').length, 2, '收支行要有编辑与删除两个操作');

    row.querySelectorAll('.icon-btn')[0].click();
    await flush();
    eq($('#drawer').hidden, false, '点编辑应打开抽屉');
    eq($('#finance-amount').value, '12.34', '编辑要回填原金额');
    eq($('#finance-note').value, '两位小数', '编辑要回填备注');
    fillAndSubmit('finance', { amount: '20.5', type: 'expense', category: '测试', note: '改过了', date: u.todayStr() });
    await flush(); await flush(); await flush();
    const edited = (await store.listAll('finances')).filter(f => f.id === created.id)[0];
    eq(edited.amount, 20.5, '编辑后的金额要落库');
    eq(edited.note, '改过了', '编辑后的备注要落库');

    // —— 详情里能删除 ——
    await DS.app.notifyDataChanged();
    await flush(); await flush();
    const row2 = rowOf('改过了');
    ok(!!row2, '改完要能在详情里看到');
    row2.querySelectorAll('.icon-btn')[1].click();
    await flush(); await flush(); await flush();
    eq((await store.listAll('finances')).filter(f => f.id === created.id).length, 0, '删除要真的从库里拿掉');
    eq((await store.listAll('finances')).length, finBefore, '删完回到原有条数');
  }

  /* ---------------------------------------------------------- 备份 */
  group('备份 · 导出与导入');
  const payload = await DS.backup.buildPayload();
  eq(payload.app, 'dailyStack', '备份要带 app 标识');
  eq(payload.version, 2, '备份要带版本号（v2 起含 learnings）');
  ok(typeof payload.counts.learnings === 'number', '备份统计要包含 learnings');
  eq(payload.counts.learnings, 2, '备份要带上刚才贴的两条知识点');
  eq(payload.tables.learnings.filter(r => (r.tags || []).length).length, 2, '导出的知识点要带着标签一起走');
  ok(payload.counts.records >= 1, '备份应包含记录');
  ok(payload.counts.finances >= 2, '备份应包含收支');

  const beforeImport = (await store.listAll('records')).length;
  const target = u.addDays(u.todayStr(), 9);
  await DS.backup.importPayload(payload.tables, { date: target, merge: true });
  const afterImport = await store.listAll('records');
  eq(afterImport.length, beforeImport + payload.counts.records, '合并导入后记录数应增加');
  eq(afterImport.filter(r => r.date === target).length, payload.counts.records, '覆盖日期后应全落在目标日期');
  eq(new Set(afterImport.map(r => r.id)).size, afterImport.length, '导入后 id 不能重复');

  // 清理掉导入的数据，避免影响后续断言
  for (const r of afterImport.filter(r => r.date === target)) await store.remove('records', r.id);
  await DS.app.notifyDataChanged();
  await flush(); await flush();
}

/* ==========================================================================
   输出
   ========================================================================== */

run().catch(e => {
  failures.push({ group: currentGroup, message: '测试中断于此处：' + (e && e.message) + '\n      ' + String(e && e.stack || '').split('\n').slice(1, 4).join('\n      ') });
}).then(() => {
  console.log('');
  console.log('  日栈 DailyStack · 界面层集成自测');
  console.log('  ' + '─'.repeat(52));

  if (failures.length) {
    console.log('  ✗ 失败 ' + failures.length + ' 项，通过 ' + passed + ' 项');
    console.log('');
    let lastGroup = null;
    failures.forEach(f => {
      if (f.group !== lastGroup) { console.log('  ▸ ' + f.group); lastGroup = f.group; }
      console.log('    ✗ ' + f.message);
    });
    process.exitCode = 1;
  } else {
    console.log('  ✓ 全部通过：' + passed + ' 项');
  }
  console.log('');
}).catch(e => {
  console.error('');
  console.error('  测试运行器自身出错：');
  console.error('  ' + (e && e.stack || e));
  process.exitCode = 1;
});