/* 浏览器冒烟：验证「学习便利贴」在真实 Chrome + 真实 IndexedDB + 真实 CSS 下的表现。
   夹具测不到的部分：真实 DB 升级建表、CSS 变量计算、限高滚动、折叠后高度。
   用法：node test/smoke-learnings.cdp.js                                        */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = path.resolve(__dirname, '..');
const URL = 'file:///' + ROOT.replace(/\\/g, '/') + '/index.html';
const PORT = 9333;
const PROFILE = path.join(require('os').tmpdir(), 'ds-smoke-profile');

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

  // 等调试端口
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
    // 无头模式下 confirm 默认被驳回，测试删除流程要代用户点「确定」
    if (m.method === 'Page.javascriptDialogOpening') { send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); return; }
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable').catch(() => {});
  // 在文档创建时就挂上错误收集器，才能抓到启动阶段的异常
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: "window.__errs=[];addEventListener('error',e=>__errs.push(String(e.message)));addEventListener('unhandledrejection',e=>__errs.push('unhandled: '+String((e.reason&&e.reason.message)||e.reason)));"
  });
  await send('Page.navigate', { url: URL });
  await sleep(2500);

  // ---- 注入真实数据：走 store 层，跟用户操作同一条路径 ----
  const seed = `
    (async () => {
      const s = window.DS && window.DS.store;
      if (!s) return { err: 'DS.store 未就绪' };
      await s.clear('learnings');
      const rows = [
        'IndexedDB 事务一旦空闲就自动提交，别在里面 await 非 IDB 的东西',
        'CSS 自定义属性必须 setProperty，直接 style["--x"]= 不生效',
        'GridTemplate auto-fill + minmax 可以做出自适应的便利贴墙',
        'file:// 下的 IndexedDB 按文件路径隔离，换个目录就是另一个库',
        '尾巴上的小知识点也要有家',
        '再贴一条试试限高滚动'
      ];
      await s.bulkAdd('learnings', rows.map((c, i) => ({ content: c, date: window.DS.util.todayStr() })));
      window.DS.learnings.refresh();
      return { ok: true, n: rows.length };
    })()
  `;
  const seeded = await send('Runtime.evaluate', { expression: seed, awaitPromise: true, returnByValue: true });
  console.log('注入:', JSON.stringify(seeded.result.value));
  await sleep(1200);

  // ---- 读取真实渲染结果 ----
  const probe = `
    (() => {
      const slot = document.querySelector('[data-module="learnings"]');
      if (!slot) return { err: '模块未挂载' };
      const root = slot.querySelector('.learn');
      const notes = [...slot.querySelectorAll('.note')];
      const wall = slot.querySelector('.learn__wall');
      const cs = wall ? getComputedStyle(wall) : null;
      const n0 = notes[0] ? getComputedStyle(notes[0]) : null;
      return {
        mounted: true,
        noteCount: notes.length,
        count: slot.querySelector('.learn__count').textContent,
        wallMaxHeight: cs ? cs.maxHeight : null,
        wallScrollHeight: wall ? wall.scrollHeight : null,
        wallClientHeight: wall ? wall.clientHeight : null,
        scrollable: wall ? wall.scrollHeight > wall.clientHeight + 1 : null,
        cols: cs ? cs.gridTemplateColumns.split(' ').length : null,
        noteBg: n0 ? n0.backgroundColor : null,
        noteTilt: n0 ? n0.transform : null,
        tints: notes.map(n => n.className.match(/note--t(\\d)/)[1]).join(''),
        texts: notes.slice(0, 2).map(n => n.querySelector('.note__text').textContent.slice(0, 14)),
        expandedHeight: root.getBoundingClientRect().height,
        zoneHeight: document.querySelector('#extension-zone').getBoundingClientRect().height,
        hasDelBtn: !!notes[0].querySelector('.note__del'),
        inputPh: slot.querySelector('.learn__compose .input').placeholder
      };
    })()
  `;
  const before = await send('Runtime.evaluate', { expression: probe, returnByValue: true });
  console.log('展开态:', JSON.stringify(before.result.value, null, 2));

  // ---- 折叠 ----
  const collapse = `
    (() => {
      const slot = document.querySelector('[data-module="learnings"]');
      slot.querySelector('.learn__bar').click();
      const root = slot.querySelector('.learn');
      return {
        collapsed: root.classList.contains('learn--collapsed'),
        aria: slot.querySelector('.learn__bar').getAttribute('aria-expanded'),
        height: root.getBoundingClientRect().height,
        panelHidden: getComputedStyle(slot.querySelector('.learn__panel')).display
      };
    })()
  `;
  const after = await send('Runtime.evaluate', { expression: collapse, returnByValue: true });
  console.log('折叠态:', JSON.stringify(after.result.value, null, 2));

  // ---- 刷新后数据是否还在（真实 IndexedDB 持久化）----
  await send('Page.navigate', { url: URL });
  await sleep(2200);
  const persisted = `
    (() => {
      const slot = document.querySelector('[data-module="learnings"]');
      const notes = [...slot.querySelectorAll('.note')];
      return { noteCount: notes.length, count: slot.querySelector('.learn__count').textContent };
    })()
  `;
  const p = await send('Runtime.evaluate', { expression: persisted, returnByValue: true });
  console.log('重开页面:', JSON.stringify(p.result.value));

  /* ================= 本轮专项：标签与检索（真实防抖 / 真实 blur） ================= */
  await send('Page.bringToFront').catch(() => {});   // 无头下也要让页面拿到焦点，focus() 才生效
  await send('Runtime.evaluate', {
    expression: `(async () => {
      const s = DS.store;
      await s.clear('learnings');
      await s.bulkAdd('learnings', [
        { content: 'CSS 层叠上下文决定谁盖住谁', tags: ['前端', 'CSS'] },
        { content: 'IndexedDB 索引按 keyPath 建', tags: ['数据库'] }
      ]);
      await DS.learnings.refresh();
      return { ok: 1 };
    })()`, awaitPromise: true, returnByValue: true
  });
  await sleep(900);

  const tagProbe = `(() => {
    const slot = document.querySelector('[data-module="learnings"]');
    const chips = [...slot.querySelectorAll('.learn__chip')];
    return {
      chips: chips.map(c => c.textContent),
      activeFirst: chips[0].className.includes('is-active'),
      noteTags: [...slot.querySelectorAll('.note')].map(n => [...n.querySelectorAll('.note__tag')].map(t => t.textContent).join(',')),
      noteCount: slot.querySelectorAll('.note').length
    };
  })()`;
  console.log('标签云:', JSON.stringify((await send('Runtime.evaluate', { expression: tagProbe, returnByValue: true })).result.value, null, 2));

  // 点标签筛选 → 再点取消
  const clickTag = `(() => {
    const slot = document.querySelector('[data-module="learnings"]');
    const chip = [...slot.querySelectorAll('.learn__chip')].find(c => c.textContent.includes('#前端'));
    chip.click();
    return new Promise(r => setTimeout(() => {
      const after = slot.querySelectorAll('.note').length;
      const chip2 = [...slot.querySelectorAll('.learn__chip')].find(c => c.textContent.includes('#前端'));
      chip2.click();
      setTimeout(() => r({ filtered: after, restored: slot.querySelectorAll('.note').length }), 400);
    }, 400));
  })()`;
  console.log('标签筛选:', JSON.stringify((await send('Runtime.evaluate', { expression: clickTag, awaitPromise: true, returnByValue: true })).result.value));

  // 搜索（真实 180ms 防抖）
  const doSearch = `(() => {
    const el = document.querySelector('.learn__search');
    el.value = 'keyPath';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return new Promise(r => setTimeout(() => {
      const slot = document.querySelector('[data-module="learnings"]');
      const hit = [...slot.querySelectorAll('.note')].map(n => n.querySelector('.note__text').textContent.slice(0, 10));
      el.value = 'zzz-没有这个词';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      setTimeout(() => r({
        hit, empty: slot.textContent.includes('没有匹配的知识点'),
        hasReset: !![...slot.querySelectorAll('.btn')].find(b => b.textContent === '清空筛选')
      }), 500);
    }, 500));
  })()`;
  console.log('检索:', JSON.stringify((await send('Runtime.evaluate', { expression: doSearch, awaitPromise: true, returnByValue: true })).result.value));

  // 单击放大预览 + 单独导出入口（本轮新增）
  const preview = `(() => {
    const slot = document.querySelector('[data-module="learnings"]');
    const clear = [...slot.querySelectorAll('.btn')].find(b => b.textContent === '清空筛选');
    if (clear) clear.click();
    return new Promise(r => setTimeout(() => {
      const src = slot.querySelector('.note__text');
      const noteFont = parseFloat(getComputedStyle(src).fontSize);
      src.click();                                  // 单击 → 打开放大预览
      setTimeout(() => {
        const pv = document.querySelector('.note-preview');
        const pvFont = pv ? parseFloat(getComputedStyle(pv.querySelector('.note-preview__body')).fontSize) : 0;
        const hasExport = [...slot.querySelectorAll('.learn__export')].map(b => b.textContent).join('/');
        const inBody = pv ? pv.parentNode === document.body : false;
        const json = DS.learnings.toJson();
        const md = DS.learnings.toMarkdown();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));   // ESC 关闭
        setTimeout(() => r({
          opened: !!pv, inBody, noteFont, pvFont, bigger: pvFont > noteFont,
          hasExport, closedByEsc: !document.querySelector('.note-preview'),
          jsonOk: json.schema === 'daily-stack.learnings/v1' && json.count === json.items.length &&
                  Array.isArray(json.items[0].tags) && typeof json.items[0].content === 'string',
          mdOk: md.indexOf('## 1.') >= 0 && md.indexOf('标签：') >= 0
        }), 200);
      }, 300);
    }, 400));
  })()`;
  console.log('放大预览 / 导出入口:', JSON.stringify((await send('Runtime.evaluate', { expression: preview, awaitPromise: true, returnByValue: true })).result.value));

  // 清空筛选 → 预览层点「编辑」→ 改标签（真实 focus / blur）
  const editTags = `(() => {
    const slot = document.querySelector('[data-module="learnings"]');
    const clear = [...slot.querySelectorAll('.btn')].find(b => b.textContent === '清空筛选');
    if (clear) clear.click();                        // 可能已无筛选，按钮不存在就跳过
    return new Promise(r => setTimeout(() => {
      slot.querySelector('.note__text').click();     // 单击 → 预览
      setTimeout(() => {
        const pv = document.querySelector('.note-preview');
        const editBtn = pv && [...pv.querySelectorAll('.btn')].find(b => b.textContent === '编辑');
        const previewOpened = !!pv;
        if (editBtn) editBtn.click();                // 预览层「编辑」→ 原地编辑
        setTimeout(() => {
          const ta = slot.querySelector('.note__edit');
          const ti = slot.querySelector('.note__tag-input');
          const before = ti ? ti.value : '';
          ti.value = '前端 CSS 布局';
          // 无头模式下 focus() 改不动 activeElement（focused 恒为 false），
          // 所以用合成 blur 事件驱动同一条「失焦即保存」路径；有头浏览器里点别处即触发。
          ta.dispatchEvent(new FocusEvent('blur'));
          setTimeout(async () => {
            const rows = await DS.store.listAll('learnings');
            r({ previewOpened, before, leftEditing: !slot.querySelector('.note__edit'), saved: rows.map(x => (x.tags || []).join('/')).sort().join(' | ') });
          }, 700);
        }, 300);
      }, 300);
    }, 400));
  })()`;
  console.log('编辑改标签:', JSON.stringify((await send('Runtime.evaluate', { expression: editTags, awaitPromise: true, returnByValue: true })).result.value));

  /* ================= 本轮专项：收支录入 / 编辑 / 删除 / 两位小数 ================= */
  const money = `(() => {
    document.querySelector('#detail-add-finance').click();
    const el = document.querySelector('#finance-amount');
    const opened = !document.querySelector('#drawer').hidden;
    el.value = '12.345'; el.dispatchEvent(new Event('input', { bubbles: true }));
    const a1 = el.value;
    el.value = '1.2.3';  el.dispatchEvent(new Event('input', { bubbles: true }));
    const a2 = el.value;
    el.value = '12.3';   el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('blur'));
    const a3 = el.value;
    return { opened, a1, a2, a3, hint: document.querySelector('#detail-add-hint').textContent };
  })()`;
  console.log('金额收敛:', JSON.stringify((await send('Runtime.evaluate', { expression: money, returnByValue: true })).result.value));

  const saveFlow = `(() => {
    const set = (sel, v) => { const e = document.querySelector(sel); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); };
    set('#finance-amount', '12.34'); set('#finance-category', '测试'); set('#finance-note', '冒烟一笔');
    document.querySelector('#drawer-submit').click();
    return new Promise(r => setTimeout(async () => {
      const rows = await DS.store.listAll('finances');
      const mine = rows.filter(x => x.note === '冒烟一笔')[0];
      const box = document.querySelector('#detail-list');
      const line = [...box.querySelectorAll('.detail__row')].find(x => x.textContent.includes('冒烟一笔'));
      r({
        closed: document.querySelector('#drawer').hidden,
        amount: mine && mine.amount,
        rowText: line && line.querySelector('.detail__row-amount').textContent,
        actions: line ? line.querySelectorAll('.icon-btn').length : 0
      });
    }, 900));
  })()`;
  console.log('记一笔:', JSON.stringify((await send('Runtime.evaluate', { expression: saveFlow, awaitPromise: true, returnByValue: true })).result.value));

  const editFlow = `(() => {
    const line = [...document.querySelectorAll('#detail-list .detail__row')].find(x => x.textContent.includes('冒烟一笔'));
    line.querySelectorAll('.icon-btn')[0].click();                 // 编辑
    return new Promise(r => setTimeout(() => {
      const el = document.querySelector('#finance-amount');
      const back = el.value;
      el.value = '20.5'; el.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#finance-note').value = '改过了';
      document.querySelector('#drawer-submit').click();
      setTimeout(async () => {
        const rows = await DS.store.listAll('finances');
        const mine = rows.filter(x => x.note === '改过了')[0];
        r({ back, amount: mine && mine.amount });
      }, 900);
    }, 400));
  })()`;
  console.log('编辑收支:', JSON.stringify((await send('Runtime.evaluate', { expression: editFlow, awaitPromise: true, returnByValue: true })).result.value));

  const delFlow = `(() => {
    const line = [...document.querySelectorAll('#detail-list .detail__row')].find(x => x.textContent.includes('改过了'));
    line.querySelectorAll('.icon-btn')[1].click();                 // 删除（confirm 已由页面弹窗接管？无头下走默认 true）
    return new Promise(r => setTimeout(async () => {
      const rows = await DS.store.listAll('finances');
      r({ left: rows.filter(x => x.note === '改过了').length });
    }, 900));
  })()`;
  console.log('删除收支:', JSON.stringify((await send('Runtime.evaluate', { expression: delFlow, awaitPromise: true, returnByValue: true })).result.value));

  /* ================= 扩展区外观（不再自称「预留」） ================= */
  const zone = `(() => {
    const z = document.querySelector('#extension-zone');
    const box = document.querySelector('.extension') || z;
    const cs = getComputedStyle(box);
    return {
      hasReservedWord: z.textContent.includes('预留'),
      borderStyle: cs.borderStyle, borderWidth: cs.borderWidth,
      padding: cs.padding, aria: z.getAttribute('aria-label'),
      placeholder: !!document.querySelector('#extension-placeholder')
    };
  })()`;
  console.log('扩展区:', JSON.stringify((await send('Runtime.evaluate', { expression: zone, returnByValue: true })).result.value));

  // ---- 控制台错误 ----
  const errs = await send('Runtime.evaluate', {
    expression: 'window.__errs ? window.__errs.join(" | ") : "（未注入错误收集器）"',
    returnByValue: true
  });
  console.log('页面错误:', errs.result.value);

  ws.close();
  chrome.kill();
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* 忽略清理失败 */ }
}

main().catch(e => { console.error('冒烟失败:', e.message); try { chrome && chrome.kill(); } catch (x) {} process.exit(1); });
