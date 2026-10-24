/* 浏览器冒烟：验证「云端同步层」在真实 Chrome 下的装配与降级行为。
   覆盖：
     - cloud.js 已挂载 DS.cloud 且导出方法齐全；
     - 顶部「登录同步」按钮存在（未登录态文案 / 非隐藏）；「退出」按钮存在且隐藏；
     - 登录抽屉 #drawer-login 与其中手机号 / 验证码 等元素齐全，初始隐藏；
     - 点击「登录同步」能打开登录抽屉，点 ✕ 能关闭（data-drawer-close 全局逻辑）；
     - 本地 store 在云不可达时照常写入（云钩子不介入、不抛错）；
     - 各守卫路径（非法手机号 / 离线发码）只返回错误对象或静默，不抛异常；
     - 启动及交互期间 window.__errs 无意外脚本错误（云网络不可达类提示允许过滤）。
   说明：真实云端往返需要已发布的 HTTPS 域名 + 真实手机号，无头沙箱只验证「本地优先 + 离线降级」。
   用法：NODE_PATH=<受管 node 工作区>/node_modules node test/smoke-cloud.cdp.js            */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = path.resolve(__dirname, '..');
const URL = 'file:///' + ROOT.replace(/\\/g, '/') + '/index.html';
const PORT = 9344;
const PROFILE = path.join(os.tmpdir(), 'ds-cloud-smoke-profile');

// 这些字样的报错来自云网络不可达 / CDN 加载失败，属预期内的离线降级，不计入失败
const EXPECTED_CLOUD_NOISE = /(workbuddy|cloud|network|fetch|endpoint|daily-stack|oauth|auth|timeout|ECONN|net::|Failed to|ERR_|CORS|跨域|verifyOtp|sendOtp|getSession|signInWithOAuth)/i;

function getJSON(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
      let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

let chrome, ws, msgId = 0;
const pending = new Map();

function send(method, params) {
  return new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}
function ev(expr, opts) {
  return send('Runtime.evaluate', Object.assign({ expression: expr, returnByValue: true }, opts || {}))
    .then(m => m.result && m.result.value);
}
function assert(cond, name) {
  const ok = !!cond;
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (ok ? '' : '  ← 失败'));
  return ok;
}

async function main() {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });

  chrome = spawn(CHROME, [
    '--headless=new', '--no-first-run', '--disable-gpu',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    '--allow-file-access-from-files',
    '--window-size=1440,1000',
    'about:blank'
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60; i++) {
    try { const list = await getJSON('/json/list'); target = list.find(t => t.type === 'page'); if (target) break; } catch (e) {}
    await sleep(300);
  }
  if (!target) throw new Error('拿不到调试目标');

  const WebSocket = require('ws');
  ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.method === 'Page.javascriptDialogOpening') { send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); return; }
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable').catch(() => {});
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: "window.__errs=[];addEventListener('error',e=>__errs.push(String(e.message||e.error)));addEventListener('unhandledrejection',e=>__errs.push('unhandled: '+String((e.reason&&e.reason.message)||e.reason)));"
  });
  await send('Page.navigate', { url: URL });
  await sleep(2800);

  /* ---------- 1. 结构 + 云状态 ---------- */
  console.log('\n[1] 云端层装配');
  const a = await ev(`(() => {
    const c = window.DS && window.DS.cloud;
    const methods = ['init','isReady','isAuthed','isSyncing','getSession','onAuthStateChange','ensureSynced','refreshSession','sendPhoneCode','verifyPhoneCode','signOut','syncFromCloud','pushUpsert','pushDelete','mountUI'];
    const missing = methods.filter(m => typeof (c && c[m]) !== 'function');
    const btn = document.querySelector('#btn-sync');
    const logout = document.querySelector('#btn-logout');
    const drawer = document.querySelector('#drawer-login');
    const ids = ['login-phone','login-code','login-send-code','login-phone-submit','login-phone-error','login-code-error'];
    const missingIds = ids.filter(id => !document.getElementById(id));
    return {
      hasCloud: !!c, missingMethods: missing,
      isReady: c ? c.isReady() : null, isAuthed: c ? c.isAuthed() : null,
      sdkLoaded: typeof window.WorkBuddyCloud !== 'undefined',
      btnExists: !!btn, btnText: btn ? btn.textContent : null, btnHidden: btn ? btn.hidden : null,
      logoutExists: !!logout, logoutHidden: logout ? logout.hidden : null,
      drawerExists: !!drawer, drawerHiddenInitially: drawer ? drawer.hidden : null,
      missingIds: missingIds
    };
  })()`);
  console.log('   ', JSON.stringify(a));
  let pass = true;
  pass &= assert(a.hasCloud, 'DS.cloud 已挂载');
  pass &= assert(a.missingMethods.length === 0, 'DS.cloud 方法齐全 (' + a.missingMethods.join(',') + ')');
  pass &= assert(a.isAuthed === false, '未登录态（isAuthed=false）');
  pass &= assert(a.btnExists && a.btnText === '登录同步' && a.btnHidden === false, '顶部按钮：登录同步 / 可见');
  pass &= assert(a.logoutExists && a.logoutHidden === true, '退出按钮存在且初始隐藏');
  pass &= assert(a.drawerExists && a.drawerHiddenInitially === true, '登录抽屉存在且初始隐藏');
  pass &= assert(a.missingIds.length === 0, '登录抽屉子元素齐全 (' + a.missingIds.join(',') + ')');

  /* ---------- 2. 打开 / 关闭登录抽屉 ---------- */
  console.log('\n[2] 登录抽屉开合');
  const b = await ev(`(() => {
    document.querySelector('#btn-sync').click();
    const d = document.querySelector('#drawer-login');
    const open = d ? !d.hidden : false;
    const closeBtn = d ? d.querySelector('[data-drawer-close]') : null;
    if (closeBtn) closeBtn.click();
    const closed = d ? d.hidden : null;
    return { open, hasCloseBtn: !!closeBtn, closed };
  })()`);
  console.log('   ', JSON.stringify(b));
  pass &= assert(b.open === true, '点「登录同步」打开登录抽屉');
  pass &= assert(b.closed === true, '点 ✕ 关闭登录抽屉');

  /* ---------- 3. 本地写入不受影响（云钩子不介入） ---------- */
  console.log('\n[3] 本地写入（云不可达时）');
  const d = await ev(`(async () => {
    const s = window.DS.store;
    await s.clear('records');
    await s.add('records', { date: window.DS.util.todayStr(), content: '云端冒烟-本地写入', done: false });
    const all = await s.listAll('records');
    return { count: all.length, hasContent: all.some(r => r.content === '云端冒烟-本地写入') };
  })()`, { awaitPromise: true });
  console.log('   ', JSON.stringify(d.result ? d.result.value : d));
  const dval = d.result ? d.result.value : d;
  pass &= assert(dval.count === 1 && dval.hasContent, '本地 add 成功且可被 listAll 读回');

  /* ---------- 4. 守卫路径：只返回错误对象，不抛异常 ---------- */
  console.log('\n[4] 守卫路径（离线 / 非法输入）');
  const e = await ev(`(async () => {
    let threw = false, badPhone = null, offline = null;
    try {
      const r1 = await window.DS.cloud.sendPhoneCode('123');
      const r2 = await window.DS.cloud.sendPhoneCode('13800000000');
      badPhone = !!(r1 && r1.error);
      offline = !!(r2 && r2.error);
    } catch (err) { threw = true; }
    return { threw, badPhone, offline };
  })()`, { awaitPromise: true });
  console.log('   ', JSON.stringify(e.result ? e.result.value : e));
  const eval_ = e.result ? e.result.value : e;
  pass &= assert(eval_.threw === false, '发码守卫不抛异常');
  pass &= assert(eval_.badPhone === true, '非法手机号返回错误');
  pass &= assert(eval_.offline === true, '离线发码返回错误（而非崩溃）');

  /* ---------- 5. 页面错误 ---------- */
  console.log('\n[5] 脚本错误');
  const errs = await ev('window.__errs ? window.__errs.slice() : []') || [];
  const unexpected = errs.filter(x => !EXPECTED_CLOUD_NOISE.test(x));
  console.log('   全部错误(' + errs.length + '):', JSON.stringify(errs));
  console.log('   意外错误(' + unexpected.length + '):', JSON.stringify(unexpected));
  pass &= assert(unexpected.length === 0, '无意外脚本错误（云网络噪音已过滤）');

  ws.close();
  chrome.kill();
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (x) {}
  console.log('\n==== 云端冒烟结果: ' + (pass ? '全部通过 ✅' : '存在失败 ❌') + ' ====');
  process.exit(pass ? 0 : 1);
}

main().catch(e => { console.error('冒烟失败:', e.message); try { chrome && chrome.kill(); } catch (x) {} process.exit(1); });
