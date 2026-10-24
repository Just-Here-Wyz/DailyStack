/* ==========================================================================
   test/logic.test.js —— 核心逻辑自测（Node 运行，AI 自检用，非交付物）
   覆盖：日期/金额工具、store.js 全部契约接口、统计口径、跨天判定
   运行：node test/logic.test.js
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { FakeIndexedDB, FakeKeyRange } = require('./fake-idb.js');

/* ------------------------------------------------------------ 迷你断言框架 */

let passed = 0;
const failures = [];
const groups = [];

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push({ name, error: e });
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures.push({ name, error: e });
  }
}

function group(title) { groups.push(title); }

/* ------------------------------------------------------------ 装配运行环境 */

function loadModules(files) {
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Date, Math, JSON, Object, Array, String, Number, Boolean, Error, RegExp,
    isFinite, isNaN, parseInt, parseFloat,
    queueMicrotask, structuredClone,
    IDBKeyRange: FakeKeyRange,
    indexedDB: new FakeIndexedDB(),
    document: { createElement: () => ({ style: {}, dataset: {}, appendChild() {}, setAttribute() {} }) }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  files.forEach(f => {
    const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    vm.runInContext(code, sandbox, { filename: f });
  });
  return sandbox;
}

const W = loadModules(['js/util.js', 'js/store.js']);
const u = W.DS.util;
const store = W.DS.store;

/* ==========================================================================
   1. util —— 日期
   ========================================================================== */
group('util · 日期');

test('dateToStr / strToDate 往返一致', () => {
  const d = new Date(2026, 9, 11); // 2026-10-11
  assert.strictEqual(u.dateToStr(d), '2026-10-11');
  const back = u.strToDate('2026-10-11');
  assert.strictEqual(back.getFullYear(), 2026);
  assert.strictEqual(back.getMonth(), 9);
  assert.strictEqual(back.getDate(), 11);
});

test('strToDate 拦住非法日期', () => {
  assert.strictEqual(u.strToDate('2026-02-31'), null, '2 月 31 日不该被接受');
  assert.strictEqual(u.strToDate('2026-13-01'), null);
  assert.strictEqual(u.strToDate('2026-2-1'), null, '必须零填充 YYYY-MM-DD');
  assert.strictEqual(u.strToDate(''), null);
  assert.strictEqual(u.strToDate(null), null);
});

test('闰年 2 月 29 日合法', () => {
  assert.ok(u.isValidDateStr('2028-02-29'), '2028 是闰年');
  assert.strictEqual(u.isValidDateStr('2026-02-29'), false, '2026 不是闰年');
});

test('addDays 跨月跨年正确', () => {
  assert.strictEqual(u.addDays('2026-10-11', 1), '2026-10-12');
  assert.strictEqual(u.addDays('2026-10-31', 1), '2026-11-01');
  assert.strictEqual(u.addDays('2026-12-31', 1), '2027-01-01');
  assert.strictEqual(u.addDays('2026-01-01', -1), '2025-12-31');
  assert.strictEqual(u.addDays('2026-03-01', -1), '2026-02-28');
});

test('monthStart / monthEnd 覆盖大小月与 2 月', () => {
  assert.strictEqual(u.monthStart(2026, 10), '2026-10-01');
  assert.strictEqual(u.monthEnd(2026, 10), '2026-10-31');
  assert.strictEqual(u.monthEnd(2026, 2), '2026-02-28');
  assert.strictEqual(u.monthEnd(2028, 2), '2028-02-29');
  assert.strictEqual(u.monthEnd(2026, 4), '2026-04-30');
  assert.strictEqual(u.monthEnd(2026, 12), '2026-12-31');
});

test('normalizeDateStr 兼容斜杠与点号写法', () => {
  assert.strictEqual(u.normalizeDateStr('2026/10/11'), '2026-10-11');
  assert.strictEqual(u.normalizeDateStr('2026.10.11'), '2026-10-11');
  assert.strictEqual(u.normalizeDateStr('2026/2/1'), '2026-02-01');
  assert.strictEqual(u.normalizeDateStr('乱七八糟'), null);
  assert.strictEqual(u.normalizeDateStr('乱', '2026-01-01'), '2026-01-01');
});

test('isWeekend 判定周六周日', () => {
  assert.strictEqual(u.isWeekend('2026-10-11'), true, '2026-10-11 是周日');
  assert.strictEqual(u.isWeekend('2026-10-10'), true, '2026-10-10 是周六');
  assert.strictEqual(u.isWeekend('2026-10-12'), false, '2026-10-12 是周一');
});

test('longDate / shortDate / timeOfDay 文案', () => {
  assert.strictEqual(u.shortDate('2026-10-11'), '10月11日');
  assert.strictEqual(u.longDate('2026-10-11'), '2026年10月11日 星期日');
  assert.strictEqual(u.monthLabel(2026, 10), '2026年10月');
  const iso = new Date(2026, 9, 11, 9, 40).toISOString();
  assert.strictEqual(u.timeOfDay(iso), '09:40');
});

group('util · 金额');

test('formatMoney 千分位 + 两位小数', () => {
  assert.strictEqual(u.formatMoney(0), '¥0.00');
  assert.strictEqual(u.formatMoney(18.5), '¥18.50');
  assert.strictEqual(u.formatMoney(1234), '¥1,234.00');
  assert.strictEqual(u.formatMoney(1234567.891), '¥1,234,567.89');
  assert.strictEqual(u.formatMoney(-86.5), '-¥86.50');
});

test('formatSignedMoney 收支方向', () => {
  assert.strictEqual(u.formatSignedMoney(320), '+¥320.00');
  assert.strictEqual(u.formatSignedMoney(-86.5), '-¥86.50');
  assert.strictEqual(u.formatSignedMoney(0), '¥0.00');
});

test('validateAmount 校验非法金额', () => {
  assert.strictEqual(u.validateAmount('').ok, false, '空值要拦');
  assert.strictEqual(u.validateAmount('abc').ok, false, '非数字要拦');
  assert.strictEqual(u.validateAmount('-5').ok, false, '负数要拦');
  assert.strictEqual(u.validateAmount('0').ok, false, '0 要拦');
  assert.strictEqual(u.validateAmount('.').ok, false);
  assert.strictEqual(u.validateAmount('999999999').ok, false, '过大要拦');

  assert.strictEqual(u.validateAmount('18.50').value, 18.5);
  assert.strictEqual(u.validateAmount('¥1,234.56').value, 1234.56, '要能吃掉货币符号和千分位');
  assert.strictEqual(u.validateAmount('0.01').value, 0.01);
});

test('formatNumber 保留位数', () => {
  assert.strictEqual(u.formatNumber(3, 0), '3');
  assert.strictEqual(u.formatNumber(1234, 0), '1,234');
  assert.strictEqual(u.formatNumber(2, 2), '2.00');
});

/* ==========================================================================
   2. store —— 契约接口
   ========================================================================== */
group('store · 建表与契约');

test('契约方法齐全且签名正确', () => {
  ['add', 'put', 'remove', 'get', 'listByDate', 'listRange', 'listAll', 'statsOfDate', 'monthStats']
    .forEach(m => assert.strictEqual(typeof store[m], 'function', 'store.' + m + ' 必须存在'));
  assert.strictEqual(store.DB_NAME, 'dailyStack');
  assert.strictEqual(store.DB_VERSION, 2);            // v2 起含 learnings 表
  assert.strictEqual(store.TABLES.join(','), 'records,todos,finances,learnings');
});

async function storeTests() {
  const TODAY = u.todayStr();
  const YESTERDAY = u.addDays(TODAY, -1);
  const TOMORROW = u.addDays(TODAY, 1);

  group('store · CRUD');

  await testAsync('add 返回含 id 的完整对象', async () => {
    const r = await store.add('records', { date: TODAY, content: '写测试', done: false });
    assert.ok(r.id, '必须自动生成 id');
    assert.strictEqual(r.date, TODAY);
    assert.strictEqual(r.content, '写测试');
    assert.strictEqual(r.done, false);
    assert.ok(r.createdAt && r.updatedAt, '必须带时间戳');
  });

  await testAsync('add 缺字段时按表结构补全', async () => {
    const t = await store.add('todos', { content: '投递岗位' });
    assert.strictEqual(t.date, TODAY, '缺 date 时默认今天');
    assert.strictEqual(t.priority, 'medium', '缺 priority 时默认中');
    assert.strictEqual(t.done, false);
    assert.strictEqual(t.doneAt, null);

    const f = await store.add('finances', { amount: 18.5 });
    assert.strictEqual(f.type, 'expense', '缺 type 时默认支出');
    assert.strictEqual(f.date, TODAY);
  });

  await testAsync('金额一律存 number 且为正数', async () => {
    const f = await store.add('finances', { date: TODAY, type: 'expense', amount: '-86.5' });
    assert.strictEqual(typeof f.amount, 'number', '不能存成字符串');
    assert.strictEqual(f.amount, 86.5, '负号由 type 决定，amount 取绝对值');
  });

  await testAsync('get / put / remove 闭环', async () => {
    const r = await store.add('records', { date: TODAY, content: '初稿' });
    const got = await store.get('records', r.id);
    assert.strictEqual(got.content, '初稿');

    const updated = await store.put('records', { id: r.id, content: '二稿', done: true });
    assert.strictEqual(updated.content, '二稿');
    assert.strictEqual(updated.done, true);
    assert.strictEqual(updated.createdAt, r.createdAt, 'createdAt 不允许被改写');

    assert.strictEqual(await store.get('records', r.id).then(x => x.content), '二稿');
    await store.remove('records', r.id);
    assert.strictEqual(await store.get('records', r.id), null, '删除后 get 返回 null');
  });

  await testAsync('get 不存在的 id 返回 null（不抛错）', async () => {
    assert.strictEqual(await store.get('records', 'no-such-id'), null);
  });

  await testAsync('listByDate 只返回当天', async () => {
    const a = await store.add('records', { date: YESTERDAY, content: '昨天的事' });
    const b = await store.add('records', { date: TODAY, content: '今天的事' });
    const rows = await store.listByDate('records', TODAY);
    const ids = rows.map(r => r.id);
    assert.ok(ids.includes(b.id), '今天的要在');
    assert.ok(!ids.includes(a.id), '昨天的不能混进来');

    assert.strictEqual((await store.listByDate('records', '不是日期')).length, 0, '非法日期返回空数组');
  });

  await testAsync('listRange 闭区间', async () => {
    const from = u.addDays(TODAY, -3);
    const to = u.addDays(TODAY, 3);
    const rows = await store.listRange('finances', from, to);
    const dates = rows.map(r => r.date);
    assert.ok(dates.every(d => d >= from && d <= to), '区间外的不该出现');

    const swapped = await store.listRange('finances', to, from);
    assert.strictEqual(swapped.length, rows.length, '起止写反也要能用');
  });

  await testAsync('未知表名要报错，不能静默', async () => {
    let threw = false;
    try { await store.add('wrong_table', { content: 'x' }); } catch (e) { threw = true; }
    assert.ok(threw, '未知表名必须抛错');
  });

  await testAsync('非法表数据被拦住', async () => {
    let threw = false;
    try { await store.add('records', { date: TODAY, content: '   ' }); } catch (e) { threw = true; }
    assert.ok(threw, '空内容必须被拦住');

    threw = false;
    try { await store.add('finances', { date: TODAY, amount: 0 }); } catch (e) { threw = true; }
    assert.ok(threw, '金额 0 必须被拦住');
  });

  group('store · 统计口径');

  // 统计口径用干净的表来验证，避免被前面的用例污染
  await store.clear('records');
  await store.clear('todos');
  await store.clear('finances');

  await testAsync('statsOfDate 四数一致', async () => {
    const D = u.addDays(TODAY, 20);              // 独立日期，避免与其他用例互相干扰
    await store.add('records', { date: D, content: 'a', done: true });
    await store.add('records', { date: D, content: 'b', done: true });
    await store.add('records', { date: D, content: 'c', done: false });
    await store.add('todos', { date: D, content: 't1', done: false });
    await store.add('todos', { date: D, content: 't2', done: true });
    await store.add('finances', { date: D, type: 'income', amount: 320 });
    await store.add('finances', { date: D, type: 'income', amount: 0.5 });
    await store.add('finances', { date: D, type: 'expense', amount: 86.5 });

    const s = await store.statsOfDate(D);
    assert.strictEqual(s.doneCount, 2, '今日已做 = done 记录条数');
    assert.strictEqual(s.todoOpenCount, 1, '待办未完成 = 未完成待办条数');
    assert.strictEqual(s.income, 320.5);
    assert.strictEqual(s.expense, 86.5);
    assert.strictEqual(s.balance, 234, '结余 = 收入 - 支出');
  });

  await testAsync('待办未完成把逾期项算进来', async () => {
    // 统计口径（todoOpenCount）＝ 计划日期 ≤ 当天且未完成，逾期也算；
    // 这里单独用一段时间线验证，避免被其他用例的待办干扰。
    await store.clear('todos');
    const D = u.addDays(TODAY, 21);
    await store.add('todos', { date: u.addDays(D, -3), content: '三天前该做的', done: false });
    await store.add('todos', { date: D, content: '今天该做的', done: false });
    await store.add('todos', { date: u.addDays(D, 3), content: '三天后要做的', done: false });
    await store.add('todos', { date: D, content: '已经做完的', done: true });

    const s = await store.statsOfDate(D);
    assert.strictEqual(s.todoOpenCount, 2, '逾期 1 条 + 当天 1 条，已完成的与未来的都不算');
    assert.strictEqual(s.overdueCount, 1, '逾期计数只算日期更早的');
    assert.strictEqual(s.todoDoneCount, 1, '当天完成的单独计');
    assert.strictEqual(s.todoCount, 2, '当天待办总条数含已完成');
  });

  await testAsync('空日期返回全 0，不抛错', async () => {
    await store.clear('todos');
    const s = await store.statsOfDate('2099-01-01');
    assert.deepStrictEqual(
      { d: s.doneCount, t: s.todoOpenCount, i: s.income, e: s.expense, b: s.balance },
      { d: 0, t: 0, i: 0, e: 0, b: 0 }
    );
  });

  await testAsync('monthStats 覆盖整月与分类', async () => {
    const y = 2031, m = 3;
    await store.add('finances', { date: '2031-03-01', type: 'income', amount: 1000, category: '兼职' });
    await store.add('finances', { date: '2031-03-15', type: 'expense', amount: 200, category: '餐饮' });
    await store.add('finances', { date: '2031-03-31', type: 'expense', amount: 50, category: '餐饮' });
    await store.add('finances', { date: '2031-02-28', type: 'expense', amount: 999, category: '餐饮' });
    await store.add('finances', { date: '2031-04-01', type: 'expense', amount: 888, category: '餐饮' });

    const ms = await store.monthStats(y, m);
    assert.strictEqual(ms.income, 1000);
    assert.strictEqual(ms.expense, 250, '2 月和 4 月的不能算进来');
    assert.strictEqual(ms.balance, 750);
    assert.strictEqual(ms.byCategory['餐饮'].expense, 250);
    assert.strictEqual(ms.byCategory['餐饮'].count, 2);
    assert.strictEqual(ms.byCategory['兼职'].income, 1000);
    assert.strictEqual(ms.byDate['2031-03-15'].expense, 200);
  });

  await testAsync('monthStats 参数非法要报错', async () => {
    let threw = false;
    try { await store.monthStats(2031, 13); } catch (e) { threw = true; }
    assert.ok(threw, '月份 13 必须报错');
  });

  await testAsync('monthDayMarks 标记哪些天有数据', async () => {
    const marks = await store.monthDayMarks(2031, 3);
    assert.strictEqual(marks['2031-03-01'].income, 1000);
    assert.strictEqual(marks['2031-03-15'].expense, 200);
    assert.strictEqual(marks['2031-02-28'], undefined, '2 月的不该出现在 3 月标记里');
  });

  group('store · 持久化与批量');

  // 这一组要验证持久化与清空，先把表恢复成有数据的状态
  await store.add('records', { date: TODAY, content: '持久化基线' });
  await store.add('finances', { date: TODAY, type: 'expense', amount: 1 });

  await testAsync('数据留在库里（换一次读取仍在）', async () => {
    const before = (await store.listAll('records')).length;
    await store.add('records', { date: TODAY, content: '持久化验证' });
    const after = await store.listAll('records');
    assert.strictEqual(after.length, before + 1);
    assert.ok(after.some(r => r.content === '持久化验证'));
  });

  await testAsync('bulkAdd 批量写入；坏数据整批中止', async () => {
    const n = await store.bulkAdd('records', [
      { date: TODAY, content: '批量 1' },
      { date: TODAY, content: '批量 2' }
    ]);
    assert.strictEqual(n, 2);

    let threw = false;
    try {
      await store.bulkAdd('records', [{ date: TODAY, content: '好数据' }, { date: TODAY, content: '' }]);
    } catch (e) { threw = true; }
    assert.ok(threw, '含非法条目时必须整批拒绝');
  });

  await testAsync('overview 给出各表条数（含 learnings）', async () => {
    const o = await store.overview();
    const sum = store.TABLES.reduce((acc, t) => acc + (o[t] || 0), 0);
    assert.strictEqual(o.total, sum, 'total 必须等于各表之和');
    assert.ok(o.records > 0 && o.finances > 0);
    assert.strictEqual(typeof o.learnings, 'number', 'learnings 也要出现在总览里');
  });

  await testAsync('clear 只清自己那张表', async () => {
    const recordsBefore = (await store.listAll('records')).length;
    await store.clear('finances');
    assert.strictEqual((await store.listAll('finances')).length, 0);
    assert.strictEqual((await store.listAll('records')).length, recordsBefore, '别把别的表也清了');
  });
}

/* ==========================================================================
   3. 日历网格算法（与 calendar.js 的 gridStart 同源，独立复算一遍）
   ========================================================================== */
group('日历 · 网格算法');

function mondayGrid(year, month) {
  const first = new Date(year, month - 1, 1);
  const jsDay = first.getDay();
  const offset = jsDay === 0 ? 6 : jsDay - 1;
  const start = new Date(year, month - 1, 1 - offset);
  const cells = [];
  for (let i = 0; i < 42; i++) cells.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  return cells;
}

test('永远 42 格 = 7 列 × 6 行', () => {
  [[2026, 2], [2026, 10], [2028, 2], [2027, 1], [2026, 11]].forEach(([y, m]) => {
    assert.strictEqual(mondayGrid(y, m).length, 42, y + '-' + m + ' 必须是 42 格');
  });
});

test('首格是周一，末格是周日', () => {
  [[2026, 2], [2026, 10], [2028, 2]].forEach(([y, m]) => {
    const cells = mondayGrid(y, m);
    assert.strictEqual(cells[0].getDay(), 1, y + '-' + m + ' 首格应为周一');
    assert.strictEqual(cells[41].getDay(), 0, y + '-' + m + ' 末格应为周日');
  });
});

test('本月每一天都在网格里，且不多不少', () => {
  [[2026, 2], [2026, 10], [2028, 2], [2026, 4]].forEach(([y, m]) => {
    const cells = mondayGrid(y, m);
    const inMonth = cells.filter(d => d.getMonth() + 1 === m && d.getFullYear() === y);
    const daysInMonth = new Date(y, m, 0).getDate();
    assert.strictEqual(inMonth.length, daysInMonth, y + '-' + m + ' 应含 ' + daysInMonth + ' 天');
    assert.strictEqual(inMonth[0].getDate(), 1);
    assert.strictEqual(inMonth[inMonth.length - 1].getDate(), daysInMonth);
  });
});

test('2 月 / 大小月 / 1 号星期偏移都正确', () => {
  assert.strictEqual(mondayGrid(2026, 2).filter(d => d.getMonth() === 1).length, 28, '2026 年 2 月 28 天');
  assert.strictEqual(mondayGrid(2028, 2).filter(d => d.getMonth() === 1).length, 29, '2028 年 2 月 29 天');
  assert.strictEqual(mondayGrid(2026, 4).filter(d => d.getMonth() === 3).length, 30, '4 月 30 天');
  assert.strictEqual(mondayGrid(2026, 10).filter(d => d.getMonth() === 9).length, 31, '10 月 31 天');

  // 2026-11-01 是周日 → 首格应回退 6 天到 2026-10-26
  const nov = mondayGrid(2026, 11);
  assert.strictEqual(u.dateToStr(nov[0]), '2026-10-26');
  assert.strictEqual(u.dateToStr(nov[6]), '2026-11-01');
});

test('网格日期连续且无重复', () => {
  const cells = mondayGrid(2026, 10).map(u.dateToStr);
  assert.strictEqual(new Set(cells).size, 42, '不能有重复日期');
  for (let i = 1; i < cells.length; i++) {
    assert.strictEqual(cells[i], u.addDays(cells[i - 1], 1), '必须逐日连续');
  }
});

/* ==========================================================================
   4. 跨天判定（app.js 的纯逻辑部分）
   ========================================================================== */
group('跨天 · 00:00 刷新');

test('距下一个 00:00 的毫秒数在合理区间', () => {
  function ms(now) {
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    return next.getTime() - now.getTime();
  }
  const at2359 = new Date(2026, 9, 11, 23, 59, 0);
  assert.ok(ms(at2359) === 60000, '23:59 距次日 0 点应为 60 秒');

  const at0000 = new Date(2026, 9, 11, 0, 0, 0);
  assert.strictEqual(ms(at0000), 86400000, '0 点整距次日 0 点应为 24 小时');

  const at1200 = new Date(2026, 9, 11, 12, 0, 0);
  assert.strictEqual(ms(at1200), 43200000, '中午距次日 0 点应为 12 小时');
});

test('跨天判定只看日期串是否变化', () => {
  const before = u.dateToStr(new Date(2026, 9, 11, 23, 59, 59));
  const after = u.dateToStr(new Date(2026, 9, 12, 0, 0, 1));
  assert.notStrictEqual(before, after, '跨过 00:00 日期串必须变');

  const sameDay = u.dateToStr(new Date(2026, 9, 11, 0, 0, 1));
  assert.strictEqual(before, sameDay, '同一天内不该触发刷新');
});

test('跨天时统计归零（新的一天没有数据）', async () => {
  const clean = '2099-06-15';
  const s = await store.statsOfDate(clean);
  assert.strictEqual(s.doneCount, 0);
  assert.strictEqual(s.income, 0);
  assert.strictEqual(s.expense, 0);
});

/* ==========================================================================
   运行
   ========================================================================== */

(async function main() {
  await storeTests();

  console.log('');
  console.log('  日栈 DailyStack · 核心逻辑自测');
  console.log('  ' + '─'.repeat(52));
  groups.forEach(g => console.log('  ▸ ' + g));
  console.log('  ' + '─'.repeat(52));

  if (failures.length) {
    console.log('  ✗ 失败 ' + failures.length + ' 项，通过 ' + passed + ' 项');
    console.log('');
    failures.forEach(f => {
      console.log('  ✗ ' + f.name);
      console.log('    ' + String(f.error && f.error.message || f.error).split('\n').join('\n    '));
    });
    process.exitCode = 1;
  } else {
    console.log('  ✓ 全部通过：' + passed + ' 项');
  }
  console.log('');
})();
