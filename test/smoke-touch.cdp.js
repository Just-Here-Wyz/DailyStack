/* 浏览器冒烟：手机可用性（窄屏真实视口 + 触屏媒体特性）
   专抓一类真 bug：桌面靠 hover 显形的操作，在触屏上永远点不到。
   用法：node test/smoke-touch.cdp.js                                    */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = path.resolve(__dirname, '..');
const URL = 'file:///' + ROOT.replace(/\\/g, '/') + '/index.html';
const PORT = 9334;
const PROFILE = path.join(require('os').tmpdir(), 'ds-touch-profile');

const getJSON = p => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
    let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});
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

async function main() {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });

  // 注意：窄屏一律用 --window-size 真实视口，不用 Emulation.setDeviceMetricsOverride（会变形）
  chrome = spawn(CHROME, [
    '--headless=new', '--no-first-run', '--disable-gpu',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    '--allow-file-access-from-files',
    '--window-size=390,844',
    'about:blank'
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60; i++) {
    try { const l = await getJSON('/json/list'); target = l.find(t => t.type === 'page'); if (target) break; } catch (e) {}
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
  await send('Network.enable').catch(() => {});
  await send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {});   // 否则 file:// 会喂旧 CSS
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: "window.__errs=[];addEventListener('error',e=>__errs.push(String(e.message)));addEventListener('unhandledrejection',e=>__errs.push('unhandled: '+String((e.reason&&e.reason.message)||e.reason)));"
  });
  // 触屏媒体特性：只模拟 hover/pointer，不改视口，避免布局伪影
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'hover', value: 'none' }, { name: 'pointer', value: 'coarse' }]
  });
  await send('Page.navigate', { url: URL });
  await sleep(2500);

  // 造点数据，否则列表是空的看不出操作按钮
  await send('Runtime.evaluate', {
    expression: `(async () => {
      const t = DS.util.todayStr();
      await DS.store.clear('finances'); await DS.store.clear('records');
      await DS.store.add('records', { date: t, content: '手机上也能看到这条', done: true });
      await DS.store.add('finances', { date: t, type: 'expense', amount: 18.5, category: '餐饮', note: '午饭' });
      await DS.app.notifyDataChanged();
      return { ok: 1 };
    })()`, awaitPromise: true, returnByValue: true
  });
  await sleep(1200);

  const probe = `(() => {
    const op = sel => { const n = document.querySelector(sel); return n ? getComputedStyle(n).opacity : '（无此元素）'; };
    const box = sel => { const n = document.querySelector(sel); if (!n) return null; const r = n.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
    const cards = document.querySelector('#stat-grid') || document.querySelector('.stats');
    return {
      viewport: innerWidth + 'x' + innerHeight,
      hoverNone: matchMedia('(hover: none)').matches,
      hScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      statCols: cards ? getComputedStyle(cards).gridTemplateColumns.split(' ').length : null,
      recordRowActions: op('.row__actions'),
      detailRowActions: op('.detail__row-actions'),
      addFinanceBtn: box('#detail-add-finance'),
      noteDel: op('.note__del'),
      drawerBtnH: box('[data-open-form]') && box('[data-open-form]').h,
      errs: window.__errs.join(' | ') || '（无）'
    };
  })()`;
  console.log('手机视口检查:', JSON.stringify((await send('Runtime.evaluate', { expression: probe, returnByValue: true })).result.value, null, 2));

  ws.close();
  chrome.kill();
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
}
main().catch(e => { console.error('冒烟失败:', e.message); try { chrome && chrome.kill(); } catch (x) {} process.exit(1); });
