/* ==========================================================================
   learnings.js —— 扩展模块「学习到了什么」
   --------------------------------------------------------------------------
   细碎知识点，一条一张便利贴。

   三条纪律（与全项目一致）：
   1. 数据一律走 DS.store，本文件不直接碰 IndexedDB；
   2. 不写硬编码颜色，纸色/纸边全用 css 变量；
   3. 通过 DS.extension.registerModule 挂进扩展模块区，不改主布局，
      且便利贴墙限高内部滚动 —— 条目再多也不把扩展区占满。
   ========================================================================== */
(function (global) {
  'use strict';

  var DS = global.DS = global.DS || {};
  var u = DS.util;

  var COLLAPSE_KEY = 'ds.learnings.collapsed';
  var TABLE = 'learnings';
  var MAX_LEN = 200;

  var ICON = {
    caret: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>',
    del:   '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12"></path><path d="M18 6 6 18"></path></svg>'
  };

  /* ------------------------------------------------------------ 状态 */

  var state = {
    rows: [],
    loading: true,
    error: null,
    collapsed: readCollapsed(),
    editingId: null,
    filterTag: null,      // 当前点选的标签，null = 全部
    keyword: '',          // 搜索关键词，匹配正文与标签
    exportFiltered: false // 导出时是否只导当前筛选结果（默认 false = 全部）
  };

  var refs = null;   // 当前挂载实例持有的 DOM 引用

  function readCollapsed() {
    try { return global.localStorage.getItem(COLLAPSE_KEY) === '1'; }
    catch (e) { return false; }
  }

  function writeCollapsed(v) {
    try { global.localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0'); } catch (e) { /* 隐私模式下忽略 */ }
  }

  /* ------------------------------------------------------------ 装饰（由 id 稳定推导） */

  /** id -> 0..3 纸色序号：同一条永远同色，不会刷新跳色 */
  function tintOf(id) {
    var h = 0;
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return h % 4;
  }

  /** id -> '-1.40' ~ '1.40' 度倾斜：手贴上去的随机感，但可复现 */
  function tiltOf(id) {
    var h = 0;
    for (var i = 0; i < id.length; i++) h = (h * 7 + id.charCodeAt(i) * 13) >>> 0;
    return ((h % 29) / 10 - 1.4).toFixed(2) + 'deg';
  }

  /** 挂倾斜角：自测夹具的 style 是简化对象，没有 setProperty，缺了只是不歪，不影响功能 */
  function applyTilt(node, id) {
    if (node.style && typeof node.style.setProperty === 'function') {
      node.style.setProperty('--note-tilt', tiltOf(id));
    }
  }

  /** 用新节点替换旧节点，并尽量保持原位 */
  function swapNode(oldNode, newNode) {
    var parent = oldNode && oldNode.parentNode;
    if (!parent) return false;
    // 注意：childNodes 在真实浏览器是 NodeList，没有 indexOf，必须借用数组方法
    var kids = parent.childNodes;
    var at = Array.prototype.indexOf.call(kids || [], oldNode);
    var next = at >= 0 && kids[at + 1] ? kids[at + 1] : null;
    parent.removeChild(oldNode);
    if (typeof parent.insertBefore === 'function') parent.insertBefore(newNode, next);
    else parent.appendChild(newNode);   // 自测夹具只实现了 appendChild，退化为追加
    return true;
  }

  /* ------------------------------------------------------------ 数据 */

  /**
   * 取全部知识点。
   * 【重要 · 不要改】这里是刻意用 listAll 而不是 listByDate：
   * 「学习到了什么」是累积的知识库，不随日期变化——
   * 切到日历上的任何一天、跨过 00:00，便利贴都还是那些，不增不减。
   * 别为了「按日回顾」把它改成按 date 过滤，那是另一回事，需要单独做开关。
   */
  function load() {
    state.loading = true;
    state.error = null;
    return DS.store.listAll(TABLE).then(function (rows) {
      state.rows = (rows || []).slice().sort(u.compareByCreatedDesc);
      state.loading = false;
    }, function (err) {
      state.error = err;
      state.rows = [];
      state.loading = false;
    });
  }

  function addNote(text, tagsRaw) {
    var content = String(text || '').trim();
    if (!content) return Promise.resolve();
    if (content.length > MAX_LEN) {
      DS.toast.error('一条最多 ' + MAX_LEN + ' 字，请拆成两条贴');
      return Promise.resolve();
    }
    return DS.store.add(TABLE, { content: content, tags: normalizeTagsLocal(tagsRaw) }).then(function () {
      DS.toast.success('已贴上');
      return refreshWall();
    }, function (err) {
      DS.toast.error((err && err.message) || '保存失败');
    });
  }

  function saveNote(row, text, tagsRaw) {
    var content = String(text || '').trim();
    if (!content) { DS.toast.error('内容不能为空'); return Promise.resolve(); }
    if (content.length > MAX_LEN) {
      DS.toast.error('一条最多 ' + MAX_LEN + ' 字');
      return Promise.resolve();
    }
    var tags = normalizeTagsLocal(tagsRaw);
    var unchanged = content === row.content && tags.join('|') === (row.tags || []).join('|');
    if (unchanged) return Promise.resolve();

    return DS.store.put(TABLE, {
      id: row.id, content: content, tags: tags, date: row.date, createdAt: row.createdAt
    }).then(function () {
      DS.toast.success('已更新');
      return refreshWall();
    }, function (err) {
      DS.toast.error((err && err.message) || '保存失败');
      return refreshWall();
    });
  }

  /** 标签串 -> 数组（展示层也要能算，最终仍以 store.normalize 为准） */
  function normalizeTagsLocal(raw) {
    if (Array.isArray(raw)) return raw;
    return String(raw || '').split(/[\s,，、;；]+/)
      .map(function (t) { return t.replace(/^#+/, '').trim(); })
      .filter(Boolean)
      .slice(0, 5);
  }

  /* ------------------------------------------------------------ 标签 */

  /** 从全部知识点里聚合出标签云：{ 标签: 条数 }，按条数降序、同条数按名字 */
  function tagCloud() {
    var map = {};
    state.rows.forEach(function (r) {
      (r.tags || []).forEach(function (t) {
        map[t] = (map[t] || 0) + 1;
      });
    });
    return Object.keys(map).map(function (t) {
      return { tag: t, count: map[t] };
    }).sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      return a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0;
    });
  }

  /** 当前筛选条件下应该显示哪些条 */
  function visibleRows() {
    var kw = String(state.keyword || '').trim().toLowerCase();
    return state.rows.filter(function (r) {
      if (state.filterTag && (r.tags || []).indexOf(state.filterTag) < 0) return false;
      if (!kw) return true;
      var hay = (r.content + ' ' + (r.tags || []).join(' ')).toLowerCase();
      return hay.indexOf(kw) >= 0;
    });
  }

  /** 当前是否处于筛选状态（有标签筛选或搜索关键词） */
  function hasFilter() {
    return !!(state.filterTag || String(state.keyword || '').trim());
  }

  /** 同步「仅导出筛选结果」勾选框：没筛选时禁用并取消勾选，避免导出成不存在的空集 */
  function syncScopeToggle() {
    if (!refs) return;
    var cb = refs.scopeToggle;
    var wrapEl = refs.scopeWrap;
    if (!cb) return;
    var on = hasFilter();
    cb.disabled = !on;
    if (!on) { cb.checked = false; state.exportFiltered = false; }
    if (wrapEl && wrapEl.classList && wrapEl.classList.toggle) {
      wrapEl.classList.toggle('is-off', !on);
    }
  }

  function removeNote(row) {
    var ok = global.confirm('删除这条知识点？\n\n' + row.content);
    if (!ok) return Promise.resolve();
    return DS.store.remove(TABLE, row.id).then(function () {
      DS.toast.info('已删除');
      return refreshWall();
    }, function (err) {
      DS.toast.error((err && err.message) || '删除失败');
    });
  }

  /* ------------------------------------------------------------ 渲染 */

  function noteNode(row) {
    var text = u.el('p', { class: 'note__text', text: row.content });

    var del = u.el('button', {
      type: 'button',
      class: 'note__del',
      html: ICON.del,
      title: '删除',
      'aria-label': '删除这条知识点',
      // 不需要 stopPropagation：删除键与正文是兄弟节点，冒泡不会触发编辑
      onclick: function () { removeNote(row); }
    });

    // 标签 chip：点一下就按这个标签筛选
    var tagRow = null;
    if ((row.tags || []).length) {
      tagRow = u.el('div', { class: 'note__tags' }, row.tags.map(function (t) {
        return u.el('button', {
          type: 'button',
          class: 'note__tag' + (state.filterTag === t ? ' is-active' : ''),
          text: '#' + t,
          title: state.filterTag === t ? '取消筛选' : '只看「' + t + '」',
          onclick: function () { setFilterTag(state.filterTag === t ? null : t); }
        });
      }));
    }

    var node = u.el('article', {
      class: 'note note--t' + tintOf(row.id),
      dataset: { id: row.id },
      tabindex: '0'
    }, [
      text,
      tagRow,
      u.el('p', { class: 'note__meta', text: u.shortDate(row.date) }),
      del
    ].filter(Boolean));
    applyTilt(node, row.id);   // 自定义属性必须走 setProperty，直接赋到 style 上不生效

    // 点击正文（或键盘 Enter）进入原地编辑
    function beginEdit() {
      if (state.editingId === row.id) return;
      state.editingId = row.id;

      var ta = u.el('textarea', { class: 'note__edit', rows: '3' });
      ta.value = row.content;

      var tagInput = u.el('input', {
        class: 'input note__tag-input',
        type: 'text',
        placeholder: '标签，空格分隔',
        'aria-label': '标签'
      });
      tagInput.value = (row.tags || []).join(' ');

      var finished = false;
      function finish(commit) {
        if (finished) return;
        finished = true;
        var val = ta.value;
        var tags = tagInput.value;
        // 期间可能因为跨天/其他操作导致整墙重绘，节点已脱离文档就别硬换了
        try {
          if (ta.parentNode === node) swapNode(ta, text);
          if (tagRow) { if (tagInput.parentNode === node) swapNode(tagInput, tagRow); }
          else if (tagInput.parentNode === node) node.removeChild(tagInput);
          if (del.parentNode !== node) node.appendChild(del);
        } catch (e) { /* 已重绘，忽略 */ }
        state.editingId = null;
        if (commit) saveNote(row, val, tags);
      }

      // 在两个输入框之间跳焦点不该算「编辑结束」，所以延后一拍再看焦点落在哪
      function blurGuard(other) {
        return function () {
          setTimeout(function () {
            if (document.activeElement === other) return;
            finish(true);
          }, 0);
        };
      }
      ta.addEventListener('blur', blurGuard(tagInput));
      tagInput.addEventListener('blur', blurGuard(ta));

      function onEditKey(e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      }
      ta.addEventListener('keydown', onEditKey);
      tagInput.addEventListener('keydown', onEditKey);

      swapNode(text, ta);
      if (tagRow && tagRow.parentNode === node) swapNode(tagRow, tagInput);
      else node.insertBefore(tagInput, node.querySelector('.note__meta'));
      if (del.parentNode) del.parentNode.removeChild(del);   // 编辑时先收起删除键，避免误触
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }

    // 单击正文 → 放大预览（编辑入口收进预览层）；键盘 Enter 同效
    text.addEventListener('click', function () { openPreview(row); });
    node.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target === node) { e.preventDefault(); openPreview(row); }
    });

    // 预览层的「编辑」按钮复用这里的原地编辑逻辑
    node.__beginEdit = beginEdit;

    return node;
  }

  function wallNode() {
    if (state.loading) {
      return u.el('div', { class: 'skeleton', 'aria-busy': 'true', 'aria-label': '加载中' }, [
        u.el('div', { class: 'skeleton__row' }),
        u.el('div', { class: 'skeleton__row' })
      ]);
    }
    if (state.error) {
      return u.el('div', { class: 'state state--error' }, [
        u.el('p', { text: (state.error && state.error.message) || '读取失败' }),
        u.el('div', { class: 'state__actions' }, [
          u.el('button', {
            type: 'button', class: 'btn btn--ghost btn--sm', text: '重试',
            onclick: function () { refreshWall(); }
          })
        ])
      ]);
    }
    if (!state.rows.length) {
      return u.el('div', { class: 'state' }, [
        u.el('p', { text: '还没有贴过知识点' }),
        u.el('p', { class: 'note__meta', text: '想到什么就贴一张，不用组织语言' })
      ]);
    }

    var rows = visibleRows();
    if (!rows.length) {
      // 有数据但被筛掉了，要说清楚是筛选的缘故，并提供退路
      return u.el('div', { class: 'state' }, [
        u.el('p', { text: '没有匹配的知识点' }),
        u.el('div', { class: 'state__actions' }, [
          u.el('button', {
            type: 'button', class: 'btn btn--ghost btn--sm', text: '清空筛选',
            onclick: function () {
              state.filterTag = null;
              state.keyword = '';
              if (refs && refs.search) refs.search.value = '';
              refreshWall();
            }
          })
        ])
      ]);
    }

    var wall = u.el('div', { class: 'learn__wall' });
    rows.forEach(function (r) { wall.appendChild(noteNode(r)); });
    return wall;
  }

  /** 标签云：全部 + 各标签（带条数），点一下即筛选 */
  function tagBarNode() {
    var bar = u.el('div', { class: 'learn__tags' });
    if (!state.rows.length) return bar;

    bar.appendChild(u.el('button', {
      type: 'button',
      class: 'learn__chip' + (state.filterTag ? '' : ' is-active'),
      text: '全部 ' + state.rows.length,
      onclick: function () { setFilterTag(null); }
    }));

    tagCloud().forEach(function (c) {
      bar.appendChild(u.el('button', {
        type: 'button',
        class: 'learn__chip' + (state.filterTag === c.tag ? ' is-active' : ''),
        text: '#' + c.tag + ' ' + c.count,
        title: state.filterTag === c.tag ? '取消筛选' : '只看「' + c.tag + '」',
        onclick: function () { setFilterTag(state.filterTag === c.tag ? null : c.tag); }
      }));
    });

    return bar;
  }

  function setFilterTag(tag) {
    state.filterTag = tag || null;
    // 同步更新：筛选一变就立刻让「仅导出筛选结果」可用，不用等数据加载完
    syncScopeToggle();
    return refreshWall();
  }

  /** 重绘便利贴墙 + 标签云 + 计数；输入框与搜索框是固定节点，不参与重绘以免打断打字 */
  function refreshWall() {
    if (!refs) return Promise.resolve();
    var input = refs.input;
    var keepFocus = document.activeElement === input;
    return load().then(function () {
      if (!refs) return;
      u.setText(refs.count, String(state.rows.length));
      var fresh = wallNode();
      swapNode(refs.wrap, fresh);
      refs.wrap = fresh;
      var freshBar = tagBarNode();
      swapNode(refs.tagBar, freshBar);
      refs.tagBar = freshBar;
      // 用户正在输入时，重绘后把焦点还回去
      if (keepFocus && input) input.focus();
      // 筛选条件可能变了 → 同步「仅导出筛选结果」勾选框的可用状态
      syncScopeToggle();
    });
  }

  function setCollapsed(v) {
    state.collapsed = !!v;
    writeCollapsed(state.collapsed);
    if (!refs) return;
    refs.root.classList.toggle('learn--collapsed', state.collapsed);
    refs.bar.setAttribute('aria-expanded', state.collapsed ? 'false' : 'true');
    u.setText(refs.tip, state.collapsed ? '点标题展开' : '点标题收起');
  }

  /* ------------------------------------------------------------ 挂载 */

  function mount(host) {
    var count = u.el('span', { class: 'learn__count', text: '0' });
    var tip = u.el('span', { class: 'learn__tip', text: state.collapsed ? '点标题展开' : '点标题收起' });

    var bar = u.el('button', {
      type: 'button',
      class: 'learn__bar',
      'aria-expanded': state.collapsed ? 'false' : 'true',
      onclick: function () { setCollapsed(!state.collapsed); }
    }, [
      u.el('span', { class: 'learn__caret', html: ICON.caret }),
      u.el('span', { class: 'learn__title', text: '学习到了什么' }),
      count,
      tip
    ]);

    var input = u.el('input', {
      class: 'input',
      type: 'text',
      maxlength: String(MAX_LEN),
      placeholder: '刚学到了什么？一句话就行',
      'aria-label': '新增知识点'
    });

    // 新增时的标签输入（可选）
    var tagInput = u.el('input', {
      class: 'input learn__tag-input',
      type: 'text',
      maxlength: '60',
      placeholder: '#标签（可选，空格分隔）',
      'aria-label': '标签'
    });

    function submit() {
      var v = input.value;
      if (!String(v).trim()) return;
      var t = tagInput.value;
      input.value = '';
      tagInput.value = '';
      addNote(v, t);
    }

    function onComposeKey(e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    }
    input.addEventListener('keydown', onComposeKey);
    tagInput.addEventListener('keydown', onComposeKey);

    var compose = u.el('div', { class: 'learn__compose' }, [
      input,
      tagInput,
      u.el('button', {
        type: 'button', class: 'btn btn--primary btn--sm learn__add', text: '贴上',
        onclick: submit
      })
    ]);

    // 筛选行：左边标签云（会随数据重绘），右边搜索框（固定，不参与重绘）
    var tagBar = tagBarNode();

    var search = u.el('input', {
      class: 'input learn__search',
      type: 'search',
      placeholder: '搜索内容或标签',
      'aria-label': '搜索知识点'
    });
    search.addEventListener('input', u.debounce(function () {
      state.keyword = search.value;
      syncScopeToggle();   // 同上：搜索一输入立刻同步勾选框可用性
      refreshWall();
    }, 180));

    // 导出范围：勾选后只导当前筛选结果（与页面显示一致），没筛选时自动禁用
    var scopeBox = u.el('input', {
      class: 'learn__scope-input',
      type: 'checkbox',
      'aria-label': '仅导出当前筛选结果'
    });
    scopeBox.addEventListener('change', function () {
      state.exportFiltered = !!scopeBox.checked;
    });
    var scopeWrap = u.el('label', {
      class: 'learn__scope',
      title: '勾选后，「导出 JSON / MD」只导出当前标签筛选或搜索出来的知识点；未筛选时不可用'
    }, [scopeBox, u.el('span', { text: '仅导出筛选结果' })]);

    // 单独导出：JSON（Python 直接 json.load）/ Markdown（按条分节，便于切片进知识库）
    var exportJson = u.el('button', {
      type: 'button', class: 'btn btn--ghost btn--sm learn__export', text: '导出 JSON',
      title: '导出知识点为 JSON，可直接放进 Python 知识库；勾选「仅导出筛选结果」后只导筛选部分',
      onclick: function () { exportNotes('json'); }
    });
    var exportMd = u.el('button', {
      type: 'button', class: 'btn btn--ghost btn--sm learn__export', text: '导出 MD',
      title: '导出为 Markdown，每条一节，便于切片；勾选「仅导出筛选结果」后只导筛选部分',
      onclick: function () { exportNotes('md'); }
    });

    var filterRow = u.el('div', { class: 'learn__filter' }, [tagBar, search, scopeWrap, exportJson, exportMd]);

    var wrap = wallNode();

    var panel = u.el('div', { class: 'learn__panel' }, [compose, filterRow, wrap]);

    var root = u.el('div', {
      class: 'learn' + (state.collapsed ? ' learn--collapsed' : ''),
      dataset: { module: 'learnings' }
    }, [bar, panel]);

    host.appendChild(root);
    refs = {
      root: root, bar: bar, count: count, tip: tip,
      input: input, tagInput: tagInput, tagBar: tagBar, search: search, wrap: wrap,
      scopeToggle: scopeBox, scopeWrap: scopeWrap
    };
    syncScopeToggle();

    // 首帧数据
    load().then(function () {
      if (!refs || refs.root !== root) return;   // 已被卸载就没必要再画
      u.setText(count, String(state.rows.length));
      var fresh = wallNode();
      swapNode(wrap, fresh);
      refs.wrap = fresh;
      var freshBar = tagBarNode();
      swapNode(tagBar, freshBar);
      refs.tagBar = freshBar;
    });

    return function unmount() {
      refs = null;
      state.editingId = null;
    };
  }

  /* ------------------------------------------------------------ 放大预览 */

  var previewEl = null;

  function closePreview() {
    if (!previewEl) return;
    var node = previewEl;
    previewEl = null;
    if (node.parentNode) node.parentNode.removeChild(node);
    document.removeEventListener('keydown', previewKeydown, true);
  }

  function previewKeydown(e) {
    if (e.key === 'Escape') { e.preventDefault(); closePreview(); }
  }

  function copyNote(row) {
    var text = String(row.content || '');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        DS.toast.success('已复制内容');
      }, function () {
        DS.toast.error('复制失败，请手动选中');
      });
    } else {
      DS.toast.info('当前环境不支持一键复制');
    }
  }

  /**
   * 放大预览：便利贴墙有 268px 限高，所以浮层挂到 body，不受裁切。
   * 预览层内提供 编辑 / 复制 / 删除 / 关闭 四个入口。
   */
  function openPreview(row) {
    closePreview();

    var overlay = u.el('div', {
      class: 'note-preview', role: 'dialog', 'aria-modal': 'true', 'aria-label': '知识点预览'
    });
    var card = u.el('div', { class: 'note-preview__card note--t' + tintOf(row.id) });

    var head = u.el('div', { class: 'note-preview__head' }, [
      u.el('span', { class: 'note-preview__date', text: u.shortDate(row.date) })
    ]);
    if ((row.tags || []).length) {
      head.appendChild(u.el('span', { class: 'note-preview__tags' }, row.tags.map(function (t) {
        return u.el('span', { class: 'note__tag', text: '#' + t });
      })));
    }

    var closeBtn = u.el('button', {
      type: 'button', class: 'btn btn--primary btn--sm', text: '关闭',
      onclick: closePreview
    });

    var actions = u.el('div', { class: 'note-preview__actions' }, [
      u.el('button', {
        type: 'button', class: 'btn btn--ghost btn--sm', text: '编辑',
        onclick: function () {
          closePreview();
          // 找到墙上对应的便利贴，复用它的原地编辑入口（期间墙若重绘，节点失效则优雅放弃）
          var host = refs && refs.wrap;
          var node = host && host.querySelector ? host.querySelector('[data-id="' + row.id + '"]') : null;
          if (node && typeof node.__beginEdit === 'function') node.__beginEdit();
        }
      }),
      u.el('button', {
        type: 'button', class: 'btn btn--ghost btn--sm', text: '复制',
        onclick: function () { copyNote(row); }
      }),
      u.el('button', {
        type: 'button', class: 'btn btn--ghost btn--sm note-preview__del', text: '删除',
        onclick: function () { closePreview(); removeNote(row); }
      }),
      closeBtn
    ]);

    card.appendChild(head);
    card.appendChild(u.el('p', { class: 'note-preview__body', text: row.content }));
    card.appendChild(actions);
    overlay.appendChild(card);

    overlay.addEventListener('click', function (e) { if (e && e.target === overlay) closePreview(); });
    card.addEventListener('click', function (e) { if (e && e.stopPropagation) e.stopPropagation(); });

    document.body.appendChild(overlay);
    previewEl = overlay;
    document.addEventListener('keydown', previewKeydown, true);
    if (closeBtn.focus) closeBtn.focus();
  }

  /* ------------------------------------------------------------ 单独导出 */

  function downloadFile(name, text, mime) {
    var blob = new Blob([text], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = u.el('a', { href: url, download: name, style: { display: 'none' } });
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }

  /** 结构化 JSON：Python 里 json.load 即可直接遍历 items */
  function buildJsonPayload(rows) {
    return {
      schema: 'daily-stack.learnings/v1',
      source: '日栈 DailyStack · 学习到了什么',
      exportedAt: new Date().toISOString(),
      count: rows.length,
      items: rows.map(function (r) {
        return {
          id: r.id,
          content: r.content,
          tags: (r.tags || []).slice(),
          date: r.date || null,
          createdAt: r.createdAt || null
        };
      })
    };
  }

  /** Markdown：每条一个二级标题，便于按条切片进向量库 */
  function buildMarkdown(rows) {
    var lines = [
      '# 学习到了什么 · 日栈 DailyStack',
      '',
      '> 导出时间：' + u.longDate(u.todayStr()) + ' ｜ 共 ' + rows.length + ' 条',
      ''
    ];
    rows.forEach(function (r, i) {
      lines.push('## ' + (i + 1) + '. ' + String(r.content || '').replace(/\s*\n+\s*/g, ' '));
      var meta = [];
      if ((r.tags || []).length) {
        meta.push('标签：' + r.tags.map(function (t) { return '#' + t; }).join(' '));
      }
      if (r.date) meta.push('记录于：' + r.date);
      if (meta.length) lines.push('', meta.join(' ｜ '));
      lines.push('');
    });
    return lines.join('\n');
  }

  /**
   * 单独导出全部知识点（区别于「数据备份」的整库导出）。
   * @param {'json'|'md'} format
   */
  /**
   * 导出。范围由 state.exportFiltered 决定：
   *   勾选「仅导出筛选结果」且当前确有筛选 → 只导 visibleRows()（与页面显示完全一致）
   *   否则 → 导全部 state.rows
   * 文件名带 -筛选 后缀区分，避免和全量导出混淆。
   */
  function exportNotes(format) {
    var scoped = !!state.exportFiltered && hasFilter();
    var rows = scoped ? visibleRows() : state.rows.slice();
    if (!rows.length) {
      DS.toast.error(scoped ? '当前筛选结果为空，没有可导出的知识点' : '还没有可导出的知识点');
      return;
    }
    var stamp = u.todayStr().replace(/-/g, '');
    var suffix = scoped ? '-筛选' : '';
    if (format === 'md') {
      downloadFile('日栈知识点-' + stamp + suffix + '.md', buildMarkdown(rows), 'text/markdown;charset=utf-8');
    } else {
      downloadFile('日栈知识点-' + stamp + suffix + '.json', JSON.stringify(buildJsonPayload(rows), null, 2), 'application/json;charset=utf-8');
    }
    DS.toast.success('已导出 ' + rows.length + ' 条知识点' + (scoped ? '（当前筛选）' : '（全部）'));
  }

  /* ------------------------------------------------------------ 导出 */

  DS.learnings = {
    /** 供 app.js 在 boot() 末尾调用 */
    register: function () {
      return DS.extension.registerModule({
        id: 'learnings',
        title: null,          // 用模块自带的折叠条，不再叠一层标题
        order: 5,
        mount: mount
      });
    },
    refresh: refreshWall,
    mount: mount,
    /** 单独导出（测试 / 手动调用）：DS.learnings.export('json' | 'md') */
    export: exportNotes,
    toJson: function (rows) { return buildJsonPayload(rows || state.rows); },
    toMarkdown: function (rows) { return buildMarkdown(rows || state.rows); },
    /** 当前是否处于筛选状态（有标签筛选或搜索关键词） */
    hasFilter: hasFilter,
    /** 当前筛选结果（与页面显示完全一致）；导出勾选「仅导出筛选结果」时用的就是它 */
    visibleRows: function () { return visibleRows(); }
  };
})(window);
