/* 同步触发集成测试（逻辑级，无需真实云端账号）
   目的：验证修复后的根因——「会话建立（登录 / 重新打开应用恢复会话）后，
   必须主动触发 syncFromCloud 去把另一端数据拉回来」，否则同手机号两端永不互通。

   做法：注入一个假的 WorkBuddyCloud 客户端，记录它收到的 select / upsert 调用，
   分别在「恢复会话」和「登录」两个入口跑一遍，断言：
     1. 四张表都被 select('*') 拉取（pull 发生）；
     2. 云端已有行被写回本地（bulkAdd 收到）；
     3. 本机独有行被 upsert 补传（push 发生）。

   用法：node test/sync.test.js                                                    */

const fs = require('fs');
const path = require('path');

let pass = true;
function assert(cond, name) {
  console.log((cond ? '  ✅ ' : '  ❌ ') + name);
  if (!cond) pass = false;
}

// ---- 注入假 WorkBuddyCloud 与本地 store / toast ----
const selectCalls = {};
const pushed = [];        // { table, row }
const deleted = [];       // { table, id }
const bulkAddCalls = [];  // { table, rows }

const fakeCloudRows = {
  records: [{ id: 'c1', date: '2026-10-11', content: '来自云端的记录', done: false,
    created_at: '2026-10-11T00:00:00Z', updated_at: '2026-10-11T00:00:00Z' }],
  todos: [],
  finances: [],
  learnings: []
};

const localOnlyRows = {
  records: [{ id: 'l1', date: '2026-10-11', content: '本机独有记录', done: false,
    createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z' }],
  todos: [], finances: [], learnings: []
};

function makeFrom(table) {
  selectCalls[table] = (selectCalls[table] || 0) + 1;
  return {
    select() { return Promise.resolve({ data: fakeCloudRows[table] || [], error: null }); },
    upsert(row) { pushed.push({ table, row }); return Promise.resolve({ data: [row], error: null }); },
    insert(row) { pushed.push({ table, row }); return Promise.resolve({ data: [row], error: null }); },
    delete() {
      return { eq(id) { deleted.push({ table, id }); return Promise.resolve({ data: [], error: null }); } };
    },
    update() { return { eq() { return Promise.resolve({ data: [], error: null }); } }; }
  };
}

function makeClient(initialSession) {
  return {
    auth: {
      getSession: () => Promise.resolve({ data: initialSession, error: null }),
      sendOtp: () => Promise.resolve({ data: { verificationId: 'v1', isExistingUser: false } }),
      verifyOtp: () => Promise.resolve({ data: { user: { id: 'u1' } } }),
      signOut: () => Promise.resolve({ data: {}, error: null })
    },
    database: { from: (t) => makeFrom(t) }
  };
}

// ---- 构造浏览器-like 全局环境并加载真实 cloud.js ----
global.window = global;
global.document = { getElementById: () => null, querySelector: () => null, addEventListener: () => {} };
global.addEventListener = () => {};

const DS = (global.DS = global.DS || {});
DS.cloudConfig = { endpoint: 'https://fake.example', publishableKey: 'pk-test' };
DS.toast = { info() {}, success() {}, error() {} };
DS.store = {
  TABLES: ['records', 'todos', 'finances', 'learnings'],
  bulkAdd(table, rows) { bulkAddCalls.push({ table, rows }); return Promise.resolve((rows || []).length); },
  listAll(table) { return Promise.resolve(localOnlyRows[table] || []); }
};

let currentClient = null;
let currentInitialSession = null;
global.WorkBuddyCloud = {
  createWorkBuddyCloud() { currentClient = makeClient(currentInitialSession); return currentClient; }
};

const code = fs.readFileSync(path.resolve(__dirname, '..', 'js', 'cloud.js'), 'utf8');
eval(code); // 执行 IIFE，挂载 DS.cloud

const tick = () => new Promise((r) => setTimeout(r, 50));

async function resetCounters() {
  Object.keys(selectCalls).forEach((k) => delete selectCalls[k]);
  pushed.length = 0; deleted.length = 0; bulkAddCalls.length = 0;
}

async function run() {
  // ===== 场景一：重新打开应用，本地存储恢复了会话（修复前这里永不触发同步）=====
  console.log('\n[场景一] 恢复会话后自动同步');
  currentInitialSession = { user: { id: 'u1' } }; // 模拟已登录的本地会话
  resetCounters();
  DS.cloud.init();
  await tick(); // 等 setSession 里的 setTimeout(triggerSyncIfAuthed, 0) 跑完

  const pulledAll = ['records', 'todos', 'finances', 'learnings'].every((t) => selectCalls[t] >= 1);
  assert(pulledAll, '四张表都被 select(\'*\') 拉取（pull 发生）');
  const bulkGotCloud = bulkAddCalls.some((c) => c.table === 'records' && c.rows.some((r) => r.id === 'c1'));
  assert(bulkGotCloud, '云端已有行 c1 被写回本地（bulkAdd 收到）');
  const pushedLocal = pushed.some((p) => p.table === 'records' && p.row && p.row.id === 'l1');
  assert(pushedLocal, '本机独有行 l1 被 upsert 补传（push 发生）');

  // ===== 场景二：首次登录（手机号验证码）后自动同步 =====
  console.log('\n[场景二] 登录后自动同步');
  currentInitialSession = null; // 全新登录，先无会话
  resetCounters();
  await DS.cloud.sendPhoneCode('13800000000');
  await DS.cloud.verifyPhoneCode('13800000000', '123456');
  await tick();

  const pulledAll2 = ['records', 'todos', 'finances', 'learnings'].every((t) => selectCalls[t] >= 1);
  assert(pulledAll2, '四张表都被 select(\'*\') 拉取（pull 发生）');
  const bulkGotCloud2 = bulkAddCalls.some((c) => c.table === 'records' && c.rows.some((r) => r.id === 'c1'));
  assert(bulkGotCloud2, '云端已有行 c1 被写回本地');
  const pushedLocal2 = pushed.some((p) => p.table === 'records' && p.row && p.row.id === 'l1');
  assert(pushedLocal2, '本机独有行 l1 被 upsert 补传');

  console.log('\n==== 同步触发测试: ' + (pass ? '全部通过 ✅' : '存在失败 ❌') + ' ====');
  process.exit(pass ? 0 : 1);
}

run().catch((e) => { console.error('测试异常:', e); process.exit(1); });
