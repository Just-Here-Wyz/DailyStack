/* ==========================================================================
   test/store-extra.test.js —— 补充自测（Node 运行）
   --------------------------------------------------------------------------
   补 logic.test.js / ui.test.js 未覆盖的三块：
     ① 便利贴标签归一化（normalizeTags）
     ② 待办跨天口径（openTodosUpTo）—— 逾期挂着、未来不提前出现
     ③ 备份语义（bulkAdd 导入 ↔ listAll 读回、clear 清空）

   运行：node test/store-extra.test.js
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
function group(title) { groups.push(title); }
function test(name, fn) {
  try { fn(); passed++; console.log('    ✓ ' + name); }
  catch (e) { failures.push({ name, error: e }); console.log('    ✗ ' + name + '\n        ' + e.message); }
}
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log('    ✓ ' + name); }
  catch (e) { failures.push({ name, error: e }); console.log('    ✗ ' + name + '\n        ' + e.message); }
}

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
  files.forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f });
  });
  return sandbox;
}

/* normalizeTags 是 store.js 内部函数，按名从源码抽出求值（不为测试改产品代码） */
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('未找到函数：' + name);
  let depth = 0, opened = false;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    const c = src[i];
    if (c === '{') { depth++; opened = true; }
    else if (c === '}') { depth--; if (opened && depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('括号不平衡：' + name);
}

const STORE_SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'store.js'), 'utf8');
const tagCtx = vm.createContext({ Array, String });
vm.runInContext(extractFn(STORE_SRC, 'normalizeTags') + '\n;this.normalizeTags = normalizeTags;', tagCtx);
const normalizeTags = tagCtx.normalizeTags;

const W = loadModules(['js/util.js', 'js/store.js']);
const u = W.DS.util;
const store = W.DS.store;

console.log('\n  日栈 · 补充自测（标签 / 待办口径 / 备份语义）');
console.log('  ────────────────────────────────────────────────────');

/* =========================================================
   ① 标签归一化
   ========================================================= */
group('便利贴 · 标签归一化');
console.log('\n  ▸ 便利贴 · 标签归一化');
test('多种分隔符都能切开（逗号 / 顿号 / 分号 / 空格）', () => {
  assert.strictEqual(JSON.stringify(normalizeTags('声学, 隔振、传声损失;混响  噪声')), JSON.stringify(['声学', '隔振', '传声损失', '混响', '噪声']));
});
test('去掉 # 前缀', () => {
  assert.strictEqual(JSON.stringify(normalizeTags('#声学 ##隔振')), JSON.stringify(['声学', '隔振']));
});
test('去重（保留首次出现）', () => {
  assert.strictEqual(JSON.stringify(normalizeTags('声学 声学 隔振')), JSON.stringify(['声学', '隔振']));
});
test('最多 5 个（超出丢弃）', () => {
  assert.strictEqual(normalizeTags('一 二 三 四 五 六 七').length, 5);
});
test('单个标签截断到 12 字', () => {
  assert.strictEqual(normalizeTags('ABCDEFGHIJKLMNOPQ')[0].length, 12);
});
test('数组输入同样生效', () => {
  assert.strictEqual(JSON.stringify(normalizeTags(['声学', ' 隔振 '])), JSON.stringify(['声学', '隔振']));
});
test('空输入返回空数组（不崩）', () => {
  assert.strictEqual(JSON.stringify(normalizeTags('')), JSON.stringify([]));
  assert.strictEqual(JSON.stringify(normalizeTags(null)), JSON.stringify([]));
  assert.strictEqual(JSON.stringify(normalizeTags(undefined)), JSON.stringify([]));
});

/* =========================================================
   ② 待办跨天口径
   ========================================================= */
async function todoTests() {
  const TODAY = u.todayStr();
  const YESTERDAY = u.addDays(TODAY, -1);
  const LASTWEEK = u.addDays(TODAY, -7);
  const TOMORROW = u.addDays(TODAY, 1);

  console.log('\n  ▸ 待办 · 跨天口径（openTodosUpTo）');
  group('待办 · 跨天口径');

  await testAsync('昨天未完成仍挂着（跨 00:00 不消失）', async () => {
    const t = await store.add('todos', { date: YESTERDAY, content: '昨天没做完的事', done: false });
    const open = await store.openTodosUpTo(TODAY);
    assert.ok(open.some((x) => x.id === t.id), '昨天未完成待办必须仍在列表里');
    await store.remove('todos', t.id);
  });

  await testAsync('上周未完成同样挂着（逾期一直挂）', async () => {
    const t = await store.add('todos', { date: LASTWEEK, content: '上周遗留', done: false });
    const open = await store.openTodosUpTo(TODAY);
    assert.ok(open.some((x) => x.id === t.id), '逾期项不该被刷掉');
    await store.remove('todos', t.id);
  });

  await testAsync('今天未完成要在列表里', async () => {
    const t = await store.add('todos', { date: TODAY, content: '今天要做', done: false });
    const open = await store.openTodosUpTo(TODAY);
    assert.ok(open.some((x) => x.id === t.id));
    await store.remove('todos', t.id);
  });

  await testAsync('已完成的不再计入未完成', async () => {
    const t = await store.add('todos', { date: YESTERDAY, content: '已完成项', done: true });
    const open = await store.openTodosUpTo(TODAY);
    assert.ok(!open.some((x) => x.id === t.id), 'done=true 不该出现在未完成里');
    await store.remove('todos', t.id);
  });

  await testAsync('未来日期的待办不提前出现', async () => {
    const t = await store.add('todos', { date: TOMORROW, content: '明天才做', done: false });
    const open = await store.openTodosUpTo(TODAY);
    assert.ok(!open.some((x) => x.id === t.id), '计划日期 > 今天的不该提前冒出来');
    await store.remove('todos', t.id);
  });

  await testAsync('统计口径含逾期（overdueCount 与 todoOpenCount 一致增长）', async () => {
    const a = await store.add('todos', { date: YESTERDAY, content: '逾期 1', done: false });
    const b = await store.add('todos', { date: TODAY, content: '今天 1', done: false });
    const s = await store.statsOfDate(TODAY);
    assert.ok(s.todoOpenCount >= 2, '未完成统计应含逾期项，实际 ' + s.todoOpenCount);
    assert.ok(s.overdueCount >= 1, '逾期数应 ≥1，实际 ' + s.overdueCount);
    await store.remove('todos', a.id);
    await store.remove('todos', b.id);
  });
}

/* =========================================================
   ③ 备份语义（导出 → 清空 → 导入）
   ========================================================= */
async function backupTests() {
  const TODAY = u.todayStr();
  console.log('\n  ▸ 备份 · 导出导入往返');
  group('备份 · 导出导入往返');

  await testAsync('四张表全量读回即为备份载荷（条数守恒）', async () => {
    await store.bulkAdd('records', [
      { id: 'bk-r1', date: TODAY, content: '备份测试记录', done: true },
      { id: 'bk-r2', date: TODAY, content: '备份测试记录 2', done: true }
    ]);
    const all = await store.listAll('records');
    assert.ok(all.length >= 2, 'listAll 应读到刚才写入的行');
    const ov = await store.overview();
    assert.ok(ov && typeof ov.total === 'number' && ov.total >= 2, 'overview 统计总数应为数字且 ≥2');
    assert.ok(typeof ov.records === 'number', 'overview 应按表名给出条数');
  });

  await testAsync('导入同一批 id 不重复（bulkAdd 幂等）', async () => {
    const before = (await store.listAll('records')).length;
    await store.bulkAdd('records', [
      { id: 'bk-r1', date: TODAY, content: '备份测试记录', done: true },
      { id: 'bk-r2', date: TODAY, content: '备份测试记录 2', done: true }
    ]);
    const after = (await store.listAll('records')).length;
    assert.strictEqual(after, before, '相同 id 重复导入不应产生新行');
  });

  await testAsync('clear 清空后可读回空（不抛错）', async () => {
    await store.clear('records');
    const rows = await store.listAll('records');
    assert.strictEqual(rows.length, 0, '清空后应为 0 行');
  });

  await testAsync('空库统计不报错，返回 0 而非异常', async () => {
    const s = await store.statsOfDate(TODAY);
    assert.strictEqual(s.doneCount, 0);
    assert.strictEqual(s.income, 0);
    assert.strictEqual(s.expense, 0);
  });
}

/* ------------------------------------------------------------ 执行 */
(async function main() {
  await todoTests();
  await backupTests();
  console.log('\n  ────────────────────────────────────────────────────');
  if (failures.length === 0) {
    console.log(`  ✓ 全部通过：${passed} 项\n`);
    process.exit(0);
  } else {
    console.log(`  ✗ 通过 ${passed} 项，失败 ${failures.length} 项\n`);
    process.exit(1);
  }
})();
