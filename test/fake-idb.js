/* ==========================================================================
   test/fake-idb.js —— 够用的内存版 IndexedDB（仅供 Node 自测，非交付物）
   支持：open / upgradeneeded / createObjectStore / createIndex /
        transaction / objectStore / put / add / get / getAll / delete / clear /
        index.getAll / IDBKeyRange.only|bound|upperBound / oncomplete|onerror

   两条必须守住的语义（否则 await 会挂住或数据凭空消失）：
   1. 数据活在数据库层，事务只是它的「视图」——每次开事务不能重置数据；
   2. 事务的 oncomplete 必须等本事务内所有请求的 onsuccess 回调跑完才触发。
   ========================================================================== */
'use strict';

function cmpKey(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

class FakeKeyRange {
  constructor(lower, upper, lowerOpen, upperOpen) {
    this.lower = lower; this.upper = upper;
    this.lowerOpen = !!lowerOpen; this.upperOpen = !!upperOpen;
  }
  includes(key) {
    if (this.lower !== undefined && this.lower !== null) {
      const c = cmpKey(key, this.lower);
      if (c < 0 || (c === 0 && this.lowerOpen)) return false;
    }
    if (this.upper !== undefined && this.upper !== null) {
      const c = cmpKey(key, this.upper);
      if (c > 0 || (c === 0 && this.upperOpen)) return false;
    }
    return true;
  }
  static only(v) { return new FakeKeyRange(v, v, false, false); }
  static bound(l, u, lo, uo) { return new FakeKeyRange(l, u, lo, uo); }
  static upperBound(u, open) { return new FakeKeyRange(undefined, u, true, open); }
  static lowerBound(l, open) { return new FakeKeyRange(l, undefined, open, true); }
}

/* ------------------------------------------------------------ 数据库层对象 */

class FakeIndexDef {
  constructor(name, keyPath) { this.name = name; this.keyPath = keyPath; }
}

/** 数据库层的表：真正持有数据 */
class FakeStoreBase {
  constructor(name, keyPath) {
    this.name = name;
    this.keyPath = keyPath;
    this.records = new Map();
    this.indexDefs = new Map();
    this.indexNames = {
      _set: new Set(),
      contains(n) { return this._set.has(n); }
    };
  }
  createIndex(name, keyPath) {
    this.indexNames._set.add(name);
    const def = new FakeIndexDef(name, keyPath);
    this.indexDefs.set(name, def);
    return def;
  }
  rows() {
    return Array.from(this.records.values())
      .sort((a, b) => cmpKey(a[this.keyPath], b[this.keyPath]));
  }
  rowsByIndex(indexName, range) {
    const def = this.indexDefs.get(indexName);
    if (!def) throw new Error('NotFoundError: index ' + indexName);
    let rows = Array.from(this.records.values())
      .filter(r => r && r[def.keyPath] !== undefined && r[def.keyPath] !== null)
      .sort((a, b) => cmpKey(a[def.keyPath], b[def.keyPath]));
    if (range instanceof FakeKeyRange) rows = rows.filter(r => range.includes(r[def.keyPath]));
    return rows;
  }
}

/* ------------------------------------------------------------ 事务层视图 */

/** 事务层的表视图：读写同一个 base，只负责记账 */
class TxStore {
  constructor(tx, base) {
    this._tx = tx;
    this._base = base;
    this.name = base.name;
    this.keyPath = base.keyPath;
    this.indexNames = base.indexNames;
  }
  createIndex() {
    throw new Error('InvalidStateError: 事务中不能建索引，请在 upgradeneeded 里建');
  }
  index(name) {
    if (!this._base.indexDefs.has(name)) throw new Error('NotFoundError: index ' + name);
    return new TxIndex(this._tx, this._base, name);
  }
  add(value) {
    const key = value[this.keyPath];
    if (this._base.records.has(key)) {
      return this._tx._reject(new Error('ConstraintError: key exists'));
    }
    return this._tx._req(() => {
      this._base.records.set(key, structuredClone(value));
      return key;
    });
  }
  put(value) {
    const key = value[this.keyPath];
    return this._tx._req(() => {
      this._base.records.set(key, structuredClone(value));
      return key;
    });
  }
  get(key) {
    return this._tx._req(() => {
      const v = this._base.records.get(key);
      return v === undefined ? undefined : structuredClone(v);
    });
  }
  getAll(range) {
    return this._tx._req(() => {
      let rows = this._base.rows();
      if (range instanceof FakeKeyRange) rows = rows.filter(r => range.includes(r[this.keyPath]));
      return rows.map(r => structuredClone(r));
    });
  }
  delete(key) { return this._tx._req(() => { this._base.records.delete(key); return undefined; }); }
  clear() { return this._tx._req(() => { this._base.records.clear(); return undefined; }); }
  count() { return this._tx._req(() => this._base.records.size); }
}

class TxIndex {
  constructor(tx, base, name) {
    this._tx = tx;
    this._base = base;
    this.name = name;
    this.keyPath = base.indexDefs.get(name).keyPath;
  }
  getAll(range) { return this._tx._req(() => this._base.rowsByIndex(this.name, range).map(r => structuredClone(r))); }
  get(key) {
    return this._tx._req(() => {
      const found = this._base.rowsByIndex(this.name).find(r => cmpKey(r[this.keyPath], key) === 0);
      return found === undefined ? undefined : structuredClone(found);
    });
  }
  count() { return this._tx._req(() => this._base.rowsByIndex(this.name).length); }
}

class FakeTransaction {
  constructor(db, storeNames) {
    this.db = db;
    this.storeNames = storeNames;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this.error = null;
    this._pending = 0;
    this._settled = false;
    this._views = new Map();

    storeNames.forEach(n => {
      if (!db._stores.has(n)) throw new Error('NotFoundError: objectStore ' + n);
    });

    queueMicrotask(() => this._settle());
  }
  objectStore(name) {
    if (!this.storeNames.includes(name)) {
      throw new Error('NotFoundError: 事务未包含 objectStore ' + name);
    }
    if (!this._views.has(name)) this._views.set(name, new TxStore(this, this.db._stores.get(name)));
    return this._views.get(name);
  }
  _req(run) {
    const req = { result: undefined, error: null, onsuccess: null, onerror: null };
    this._pending += 1;
    queueMicrotask(() => {
      let failed = null, value;
      try { value = run(); } catch (e) { failed = e; }
      if (failed) {
        req.error = failed;
        try { if (req.onerror) req.onerror({ target: req }); } catch (e) { this._fail(e); }
      } else {
        req.result = value;
        try { if (req.onsuccess) req.onsuccess({ target: req }); } catch (e) { this._fail(e); }
      }
      this._pending -= 1;
      queueMicrotask(() => this._settle());
    });
    return req;
  }
  _reject(error) {
    const req = { result: undefined, error: error, onsuccess: null, onerror: null };
    queueMicrotask(() => { if (req.onerror) req.onerror({ target: req }); });
    return req;
  }
  _fail(err) {
    if (this._settled) return;
    this.error = err;
    if (this.onerror) this.onerror({ target: this });
  }
  _settle() {
    if (this._settled || this._pending !== 0) return;
    this._settled = true;
    if (this.oncomplete) this.oncomplete({ target: this });
  }
  abort() {
    if (this._settled) return;
    this._settled = true;
    if (this.onabort) this.onabort({ target: this });
  }
}

/* ------------------------------------------------------------ 数据库 */

class FakeDB {
  constructor(name, version) {
    this.name = name;
    this.version = version;
    this._stores = new Map();
    this.objectStoreNames = {
      _db: this,
      contains(n) { return this._db._stores.has(n); }
    };
    this.onversionchange = null;
  }
  createObjectStore(name, opts) {
    const base = new FakeStoreBase(name, (opts && opts.keyPath) || 'id');
    this._stores.set(name, base);
    return base;
  }
  transaction(storeNames) {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    return new FakeTransaction(this, names);
  }
  close() { this.closed = true; }
}

class FakeIndexedDB {
  constructor() { this._dbs = new Map(); }
  open(name, version) {
    const req = {
      result: undefined, error: null, transaction: null,
      onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null
    };
    const self = this;
    queueMicrotask(() => {
      let db = self._dbs.get(name);
      const requested = version === undefined ? 1 : version;
      let needsUpgrade = false;

      if (!db) {
        db = new FakeDB(name, requested);
        self._dbs.set(name, db);
        needsUpgrade = true;
      } else if (requested > db.version) {
        db.version = requested;
        needsUpgrade = true;
      }

      req.result = db;
      if (needsUpgrade && req.onupgradeneeded) {
        // upgrade 期间同步建表；createObjectStore 直接落在 db 上
        req.onupgradeneeded({ target: req, oldVersion: 0, newVersion: requested });
      }
      if (req.onsuccess) req.onsuccess({ target: req });
    });
    return req;
  }
  deleteDatabase(name) {
    this._dbs.delete(name);
    return { result: undefined, error: null, onsuccess: null, onerror: null };
  }
}

module.exports = { FakeIndexedDB, FakeKeyRange, FakeDB, FakeStoreBase };
