/* ==========================================================================
   test/minidom.js —— 极简 DOM（仅供 Node 集成自测，非交付物）
   只实现本项目页面代码真正用到的那部分 API：
     querySelector / querySelectorAll（支持 #id .class [attr] [a="v"] tag 的后代组合）
     createElement / createTextNode / appendChild / removeChild / insertBefore
     classList / dataset / setAttribute / getAttribute / textContent / closest
     addEventListener / dispatchEvent（冒泡）/ click()
   ＋ 一个够用的 HTML 解析器（只认标签、属性、文本，不处理 script/style 内容）
   ========================================================================== */
'use strict';

class ClassList {
  constructor(el) { this._el = el; this._set = new Set(); }
  add(...names) { names.forEach(n => n && this._set.add(n)); this._sync(); }
  remove(...names) { names.forEach(n => this._set.delete(n)); this._sync(); }
  contains(n) { return this._set.has(n); }
  toggle(n, force) {
    const on = force === undefined ? !this._set.has(n) : !!force;
    if (on) this._set.add(n); else this._set.delete(n);
    this._sync();
    return on;
  }
  _sync() { this._el._attrs.class = Array.from(this._set).join(' '); }
  toString() { return Array.from(this._set).join(' '); }
}

class El {
  constructor(tag, doc) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.ownerDocument = doc || null;
    this.childNodes = [];
    this.parentNode = null;
    this._attrs = {};
    this._listeners = {};
    this._dataset = {};
    // 让 dataset.foo = 'bar' 同步成 data-foo 属性，这样选择器才找得到
    const self = this;
    this.dataset = new Proxy(this._dataset, {
      set(t, k, v) {
        t[k] = v;
        const attr = 'data-' + String(k).replace(/[A-Z]/g, c => '-' + c.toLowerCase());
        self._attrs[attr] = String(v);
        return true;
      },
      deleteProperty(t, k) {
        delete t[k];
        const attr = 'data-' + String(k).replace(/[A-Z]/g, c => '-' + c.toLowerCase());
        delete self._attrs[attr];
        return true;
      }
    });
    this.style = new Proxy({}, { set: (t, k, v) => { t[k] = v; return true; } });
    this._text = '';
    this._classList = new ClassList(this);
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.checked = false;
    this.files = null;
  }

  /* ---- 属性 ---- */
  get className() { return this._attrs.class || ''; }
  set className(v) {
    this._attrs.class = String(v || '');
    this._classList._set = new Set(this._attrs.class.split(/\s+/).filter(Boolean));
  }
  get classList() { return this._classList; }
  get id() { return this._attrs.id || ''; }
  set id(v) { this._attrs.id = String(v); }

  setAttribute(name, value) {
    if (name === 'class') { this.className = value; return; }
    if (name === 'hidden') { this.hidden = true; return; }
    if (name === 'disabled') { this.disabled = true; return; }
    if (name === 'checked') { this.checked = true; return; }
    if (name === 'value') { this.value = String(value); return; }
    this._attrs[name] = value === null || value === undefined ? '' : String(value);
  }
  getAttribute(name) {
    if (name === 'class') return this.className;
    if (name === 'hidden') return this.hidden ? '' : null;
    if (name === 'value') return this.value;
    return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
  }
  removeAttribute(name) {
    if (name === 'class') this.className = '';
    else if (name === 'hidden') this.hidden = false;
    else delete this._attrs[name];
  }
  hasAttribute(name) { return this.getAttribute(name) !== null; }

  /* ---- 文本 ---- */
  get textContent() {
    if (this.childNodes.length === 0) return this._text;
    return this.childNodes.map(c => (c.nodeType === 3 ? c.data : c.textContent)).join('');
  }
  set textContent(v) {
    this.childNodes.forEach(c => { c.parentNode = null; });
    this.childNodes = [];
    this._text = v === null || v === undefined ? '' : String(v);
  }
  get innerHTML() { return ''; }
  set innerHTML(v) {
    // 只用于放图标 SVG 字符串，测试里当作文本占位
    this.textContent = String(v || '').replace(/<[^>]*>/g, '');
  }

  /* ---- 树 ---- */
  appendChild(child) {
    if (!child) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    // hidden 属性参与 :empty 语义不需要，但 hidden=true 的占位要能被查询到
    return child;
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) { this.childNodes.splice(i, 1); child.parentNode = null; }
    return child;
  }
  get firstChild() { return this.childNodes[0] || null; }
  get children() { return this.childNodes.filter(c => c.nodeType !== 3); }
  get childElementCount() { return this.children.length; }

  closest(sel) {
    let node = this;
    while (node) {
      if (node.nodeType !== 3 && matches(node, sel)) return node;
      node = node.parentNode;
    }
    return null;
  }

  /* ---- 事件 ---- */
  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    const arr = this._listeners[type] || [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
  dispatchEvent(event) {
    event.target = event.target || this;
    let node = this;
    while (node) {
      const arr = node._listeners[event.type] || [];
      arr.slice().forEach(fn => {
        try { fn.call(node, event); } catch (e) { throw e; }
      });
      if (!event.bubbles) break;
      node = node.parentNode;
    }
    return !event.defaultPrevented;
  }
  click() {
    const ev = { type: 'click', bubbles: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    return this.dispatchEvent(ev);
  }

  /* ---- 布局（测试里只给零值，避免取到 undefined） ---- */
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  get offsetHeight() { return 0; }
  get offsetWidth() { return 0; }
  focus() { this.ownerDocument.activeElement = this; }
  select() {}
  /** 真实 textarea 有，夹具给个空实现即可（便利贴编辑态会调） */
  setSelectionRange() {}
  /** 表单重置：把 value / checked 打回初始状态（够用即可） */
  reset() {
    const walk = node => {
      node.childNodes.forEach(c => {
        if (c.nodeType === 3) return;
        if (c.tagName === 'INPUT') {
          const type = c.getAttribute('type');
          if (type === 'radio' || type === 'checkbox') c.checked = c.hasAttribute('data-default-checked');
          else c.value = '';
        }
        walk(c);
      });
    };
    walk(this);
  }
  contains(node) {
    while (node) { if (node === this) return true; node = node.parentNode; }
    return false;
  }
  querySelector(sel) { return query(this, sel)[0] || null; }
  querySelectorAll(sel) { return query(this, sel); }
}

/* ------------------------------------------------------------ 选择器 */

function tokens(sel) {
  return String(sel).trim().split(/\s+/).filter(Boolean).map(part => {
    const m = { tag: null, id: null, classes: [], attrs: [], pseudo: [] };
    const re = /([#.]?[\w-]+|\[[^\]]+\]|:[\w-]+)/g;
    let t;
    while ((t = re.exec(part))) {
      const piece = t[1];
      if (piece[0] === '#') m.id = piece.slice(1);
      else if (piece[0] === '.') m.classes.push(piece.slice(1));
      else if (piece[0] === ':') m.pseudo.push(piece.slice(1));
      else if (piece[0] === '[') {
        const body = piece.slice(1, -1);
        const eq = body.indexOf('=');
        if (eq < 0) m.attrs.push({ name: body, value: undefined });
        else m.attrs.push({
          name: body.slice(0, eq),
          value: body.slice(eq + 1).replace(/^["']|["']$/g, '')
        });
      } else m.tag = piece.toLowerCase();
    }
    return m;
  });
}

function matches(node, sel) {
  if (!node || node.nodeType === 3) return false;
  return tokens(sel).every(m => matchesOne(node, m));
}

function matchesOne(node, m) {
  if (m.tag && node.tagName.toLowerCase() !== m.tag) return false;
  if (m.id && node.id !== m.id) return false;
  for (const c of m.classes) if (!node.classList.contains(c)) return false;
  for (const a of m.attrs) {
    const v = node.getAttribute(a.name);
    if (v === null) return false;
    if (a.value !== undefined && v !== a.value) return false;
  }
  for (const p of m.pseudo) {
    if (p === 'checked') { if (!node.checked) return false; }
    else if (p === 'disabled') { if (!node.disabled) return false; }
    else if (p === 'not') { return false; }
    // 其他伪类一律忽略，不因为不认识就漏掉元素
  }
  return true;
}

function descendants(root) {
  const out = [];
  (function walk(node) {
    node.childNodes.forEach(c => {
      if (c.nodeType === 3) return;
      out.push(c);
      walk(c);
    });
  })(root);
  return out;
}

function query(root, sel) {
  const groups = String(sel).split(',').map(s => s.trim()).filter(Boolean);
  const all = descendants(root);
  const found = [];
  groups.forEach(g => {
    const parts = tokens(g);
    let candidates = all.filter(n => matchesOne(n, parts[parts.length - 1]));
    // 逐个祖先条件回退校验
    for (let i = parts.length - 2; i >= 0; i--) {
      const need = parts[i];
      candidates = candidates.filter(n => {
        let p = n.parentNode;
        while (p && p !== root) {
          if (matchesOne(p, need)) return true;
          p = p.parentNode;
        }
        return false;
      });
    }
    candidates.forEach(c => { if (!found.includes(c)) found.push(c); });
  });
  return found;
}

/* ------------------------------------------------------------ 解析器 */

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function parseAttrs(raw, node) {
  const re = /([\w:-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(raw))) {
    const name = m[1];
    const value = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5] !== undefined ? m[5] : '';
    if (name === 'class') node.className = value;
    else if (name === 'id') node.id = value;
    else if (name === 'hidden') node.hidden = true;
    else if (name === 'checked') node.checked = true;
    else if (name === 'disabled') node.disabled = true;
    else if (name === 'value') node.value = value;
    else if (name === 'selected') { /* noop */ }
    else if (name.indexOf('data-') === 0) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      node.dataset[key] = value;
    } else node._attrs[name] = value;
  }
}

/** 解析 HTML 字符串，返回 { body, getById } */
function parseHtml(html, doc) {
  const root = new El('body', doc);
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<(\/?)([\w:-]+)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let last = 0, m;

  while ((m = re.exec(html))) {
    const text = html.slice(last, m.index);
    if (text.trim()) stack[stack.length - 1].appendChild(textNode(text, doc));
    last = re.lastIndex;
    if (m[0].startsWith('<!--')) continue;

    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();

    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName.toLowerCase() === tag) { stack.length = i; break; }
      }
      continue;
    }

    const node = new El(tag, doc);
    parseAttrs(m[3] || '', node);
    stack[stack.length - 1].appendChild(node);

    if (tag === 'script' || tag === 'style') {
      const closer = new RegExp('</' + tag + '\\s*>', 'i');
      const rest = html.slice(re.lastIndex);
      const cm = closer.exec(rest);
      re.lastIndex = cm ? re.lastIndex + cm.index + cm[0].length : html.length;
      last = re.lastIndex;
      continue;
    }

    if (!VOID_TAGS.has(tag) && !/\/\s*$/.test(m[3] || '')) stack.push(node);
    // 只保留文本节点的父级
    void text;
  }

  const tail = html.slice(last);
  if (tail.trim()) stack[stack.length - 1].appendChild(textNode(tail, doc));

  return root;
}

function textNode(data, doc) {
  return { nodeType: 3, data: String(data), parentNode: null, textContent: String(data) };
}

/* ------------------------------------------------------------ 文档 */

function createDocument(html) {
  const body = parseHtml(html || '', null);
  const doc = {
    nodeType: 9,
    body,
    documentElement: body,
    hidden: false,
    readyState: 'complete',
    activeElement: null,
    _listeners: {},
    createElement: tag => new El(tag, doc),
    createTextNode: data => textNode(data, doc),
    querySelector: sel => query(body, sel)[0] || null,
    querySelectorAll: sel => query(body, sel),
    getElementById: id => query(body, '#' + id)[0] || null,
    addEventListener(type, fn) { (doc._listeners[type] = doc._listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const arr = doc._listeners[type] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    dispatch(type) {
      (doc._listeners[type] || []).slice().forEach(fn => fn({ type }));
    }
  };
  body.ownerDocument = doc;
  (function fix(node) {
    node.ownerDocument = doc;
    node.childNodes.forEach(c => { if (c.nodeType !== 3) fix(c); });
  })(body);
  return doc;
}

module.exports = { createDocument, El, parseHtml, matches, query, tokens };
