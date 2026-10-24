/* ==========================================================================
   store.js —— 本地存储抽象层（⭐ 本项目唯一数据出入口）
   --------------------------------------------------------------------------
   约定（关键接缝，勿改名、勿改签名）：
     add / put / remove / get / listByDate / listRange / listAll
     statsOfDate(dateStr) -> { doneCount, todoOpenCount, income, expense, balance }
     monthStats(year, month) -> { income, expense, balance, byCategory }

   底层：IndexedDB，数据库名 dailyStack，版本 1，三张表 records / todos / finances。
   页面代码只允许通过这里读写数据；将来换云端，只替换本文件实现。
   ========================================================================== */
(function (global) {
  'use strict';

  var DS = global.DS = global.DS || {};

  var DB_NAME = 'dailyStack';
  // v1：records / todos / finances 三表
  // v2：新增 learnings（「学习到了什么」便利贴）
  var DB_VERSION = 2;
  var TABLES = ['records', 'todos', 'finances', 'learnings'];

  var INCOME = 'income';
  var EXPENSE = 'expense';

  var dbPromise = null;

  /* ------------------------------------------------------------ 底层封装 */

  function req(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('IndexedDB 请求失败')); };
    });
  }

  function txDone(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onabort = function () { reject(tx.error || new Error('事务被中止')); };
      tx.onerror = function () { reject(tx.error || new Error('事务出错')); };
    });
  }

  /**
   * 建表建索引。注意：不要在 upgrade 事务里 await 非 IDB 的东西，
   * 否则事务会自动提交，后续 createObjectStore 会报错。
   */
  function migrate(db) {
    var s;
    if (!db.objectStoreNames.contains('records')) {
      s = db.createObjectStore('records', { keyPath: 'id' });
      s.createIndex('date', 'date', { unique: false });
      s.createIndex('done', 'done', { unique: false });
    }
    if (!db.objectStoreNames.contains('todos')) {
      s = db.createObjectStore('todos', { keyPath: 'id' });
      s.createIndex('date', 'date', { unique: false });
      s.createIndex('done', 'done', { unique: false });
    }
    if (!db.objectStoreNames.contains('finances')) {
      s = db.createObjectStore('finances', { keyPath: 'id' });
      s.createIndex('date', 'date', { unique: false });
      s.createIndex('type', 'type', { unique: false });
    }
    // v2 新增：细碎知识点便利贴。守卫式建表，老库升级不会重复创建。
    if (!db.objectStoreNames.contains('learnings')) {
      s = db.createObjectStore('learnings', { keyPath: 'id' });
      s.createIndex('date', 'date', { unique: false });
    }
  }

  function openDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise(function (resolve, reject) {
      if (!global.indexedDB) {
        reject(new Error('当前浏览器不支持 IndexedDB，无法保存数据'));
        return;
      }

      var request;
      try {
        request = global.indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        reject(e);
        return;
      }

      request.onupgradeneeded = function () { migrate(request.result); };
      request.onsuccess = function () {
        var db = request.result;
        db.onversionchange = function () { db.close(); dbPromise = null; };
        resolve(db);
      };
      request.onerror = function () {
        reject(request.error || new Error('打开本地数据库失败'));
      };
      request.onblocked = function () {
        reject(new Error('本地数据库被其他标签页占用，请关掉本工作台的其他标签页后重试'));
      };
    }).catch(function (err) {
      dbPromise = null;  // 失败不缓存，允许重试
      throw err;
    });

    return dbPromise;
  }

  /** 打开只读事务 —— 读操作统一走这里，避免 readwrite 排队 */
  function readTx(storeName, fn) {
    return openDB().then(function (db) {
      var tx = db.transaction(storeName, 'readonly');
      var store = tx.objectStore(storeName);
      return Promise.resolve(fn(store)).then(function (result) {
        return txDone(tx).then(function () { return result; });
      });
    });
  }

  /** 打开读写事务 —— 写操作统一走这里 */
  function writeTx(storeName, fn) {
    return openDB().then(function (db) {
      var tx = db.transaction(storeName, 'readwrite');
      var store = tx.objectStore(storeName);
      var out = fn(store);
      return txDone(tx).then(function () { return out; });
    });
  }

  function assertTable(table) {
    if (TABLES.indexOf(table) === -1) {
      throw new Error('未知数据表：' + table + '（只允许 ' + TABLES.join(' / ') + '）');
    }
    return table;
  }

  function idx(store, name) {
    return store.indexNames.contains(name) ? store.index(name) : null;
  }

  /* ------------------------------------------------------------ 数据规范化 */

  /**
   * 标签规范化：接受数组，或「空格 / 逗号 / 顿号 / 分号」分隔的字符串。
   * 去掉开头的 #，去重、去空、限长，一张便利贴最多 5 个标签。
   */
  function normalizeTags(input) {
    var list = [];
    if (Array.isArray(input)) list = input.slice();
    else if (typeof input === 'string') list = input.split(/[\s,，、;；]+/);

    var out = [];
    list.forEach(function (t) {
      var s = String(t === null || t === undefined ? '' : t).trim().replace(/^#+/, '');
      if (!s || out.indexOf(s) >= 0) return;
      out.push(s.slice(0, 12));
    });
    return out.slice(0, 5);
  }

  /** 按表结构补全字段、纠类型（写库前统一过一遍） */
  function normalize(table, input) {
    var u = DS.util;
    var src = input || {};
    var now = u.nowIso();

    if (table === 'records') {
      return {
        id: src.id || u.uid(),
        date: u.normalizeDateStr(src.date) || u.todayStr(),
        content: String(src.content === undefined || src.content === null ? '' : src.content).trim(),
        done: !!src.done,
        createdAt: src.createdAt || now,
        updatedAt: now
      };
    }

    if (table === 'todos') {
      var p = src.priority;
      if (p !== 'high' && p !== 'medium' && p !== 'low') p = 'medium';
      var done = !!src.done;
      return {
        id: src.id || u.uid(),
        date: u.normalizeDateStr(src.date) || u.todayStr(),
        content: String(src.content === undefined || src.content === null ? '' : src.content).trim(),
        priority: p,
        done: done,
        createdAt: src.createdAt || now,
        doneAt: done ? (src.doneAt || now) : null
      };
    }

    // learnings：细碎知识点便利贴，正文 + 标签
    if (table === 'learnings') {
      return {
        id: src.id || u.uid(),
        date: u.normalizeDateStr(src.date) || u.todayStr(),
        content: String(src.content === undefined || src.content === null ? '' : src.content).trim(),
        tags: normalizeTags(src.tags),
        createdAt: src.createdAt || now,
        updatedAt: now
      };
    }

    // finances
    var amount = u.toAmount(src.amount);
    if (!isFinite(amount)) amount = 0;
    return {
      id: src.id || u.uid(),
      date: u.normalizeDateStr(src.date) || u.todayStr(),
      type: src.type === INCOME ? INCOME : EXPENSE,
      amount: Math.abs(amount),                     // 金额一律正数，方向由 type 决定
      category: String(src.category === undefined || src.category === null ? '' : src.category).trim(),
      note: String(src.note === undefined || src.note === null ? '' : src.note).trim(),
      createdAt: src.createdAt || now
    };
  }

  /* ------------------------------------------------------------ 云端同步钩子 */

  // 本地写入成功后，若已登录云端则同步到远端。不阻塞本地流程，
  // 且通过 isSyncing() 防止「云端拉取覆盖本地」期间触发回写，避免递归。
  function cloudPushWrite(table, record) {
    if (DS.cloud && DS.cloud.isReady() && DS.cloud.isAuthed() && !DS.cloud.isSyncing()) {
      DS.cloud.pushUpsert(table, record);
    }
  }

  function cloudPushDelete(table, id) {
    if (DS.cloud && DS.cloud.isReady() && DS.cloud.isAuthed() && !DS.cloud.isSyncing()) {
      DS.cloud.pushDelete(table, id);
    }
  }

  /* ------------------------------------------------------------ 通用 CRUD */

  /** 新增，返回含 id 的完整对象 */
  function add(table, obj) {
    assertTable(table);
    var record = normalize(table, obj);
    var err = validate(table, record);
    if (err) return Promise.reject(new Error(err));
    return writeTx(table, function (store) { store.add(record); }).then(function () { cloudPushWrite(table, record); return record; });
  }

  /** 按 id 更新，返回更新后的完整对象 */
  function put(table, obj) {
    assertTable(table);
    if (!obj || !obj.id) return Promise.reject(new Error('更新失败：缺少 id'));
    return get(table, obj.id).then(function (existing) {
      if (!existing) throw new Error('更新失败：这条数据已不存在');
      var merged = Object.assign({}, existing, obj);
      if (table === 'records' || table === 'todos') merged.createdAt = existing.createdAt;
      var record = normalize(table, merged);
      var err = validate(table, record);
      if (err) throw new Error(err);
      return writeTx(table, function (store) { store.put(record); }).then(function () { cloudPushWrite(table, record); return record; });
    });
  }

  /** 删除 */
  function remove(table, id) {
    assertTable(table);
    if (!id) return Promise.reject(new Error('删除失败：缺少 id'));
    return writeTx(table, function (store) { store.delete(id); }).then(function () { cloudPushDelete(table, id); });
  }

  /** 读取单条 */
  function get(table, id) {
    assertTable(table);
    if (!id) return Promise.resolve(null);
    return readTx(table, function (store) { return req(store.get(id)); }).then(function (v) {
      return v === undefined ? null : v;
    });
  }

  /** 按 YYYY-MM-DD 查询；date 非法时返回空数组（不抛错，页面无需兜底） */
  function listByDate(table, dateStr) {
    assertTable(table);
    var d = DS.util.normalizeDateStr(dateStr);
    if (!d) return Promise.resolve([]);
    return readTx(table, function (store) {
      var index = idx(store, 'date');
      // 有 date 索引走索引；没有则整表读回再用内存过滤（索引缺失也不静默丢数据）
      return index ? req(index.getAll(IDBKeyRange.only(d))) : req(store.getAll());
    }).then(function (rows) {
      var list = rows || [];
      return list.filter(function (r) { return r && r.date === d; });
    });
  }

  /** 日期区间查询 [from, to]，闭区间；月度报表用 */
  function listRange(table, from, to) {
    assertTable(table);
    var a = DS.util.normalizeDateStr(from);
    var b = DS.util.normalizeDateStr(to);
    if (!a || !b) return Promise.resolve([]);
    if (a > b) { var t = a; a = b; b = t; }
    return readTx(table, function (store) {
      var index = idx(store, 'date');
      if (!index) return req(store.getAll());
      return req(index.getAll(IDBKeyRange.bound(a, b)));
    }).then(function (rows) { return rows || []; });
  }

  /** 整表读取 */
  function listAll(table) {
    assertTable(table);
    return readTx(table, function (store) { return req(store.getAll()); })
      .then(function (rows) { return rows || []; });
  }

  /** 整表清空（备份功能用） */
  function clear(table) {
    assertTable(table);
    return writeTx(table, function (store) { store.clear(); });
  }

  /** 批量写入（导入备份用），返回写入条数 */
  function bulkAdd(table, arr) {
    assertTable(table);
    var list = (arr || []).map(function (o) { return normalize(table, o); });
    var bad = list.filter(function (r) { return !!validate(table, r); });
    if (bad.length) return Promise.reject(new Error('有 ' + bad.length + ' 条数据格式不合法，已全部中止导入'));
    return writeTx(table, function (store) {
      list.forEach(function (r) { store.put(r); });
    }).then(function () {
      // 导入 / 云拉取都会走这里：云拉取时 isSyncing() 为真，下面的回写被跳过，避免递归
      if (DS.cloud && DS.cloud.isReady() && DS.cloud.isAuthed() && !DS.cloud.isSyncing()) {
        list.forEach(function (r) { DS.cloud.pushUpsert(table, r); });
      }
      return list.length;
    });
  }

  /** 字段级校验：返回错误文案或 null */
  function validate(table, r) {
    if (!r) return '数据为空';
    if (!r.date) return '日期不能为空';
    if (table === 'records' || table === 'todos') {
      if (!r.content) return '内容不能为空';
      if (r.content.length > 200) return '内容不能超过 200 字';
    }
    if (table === 'finances') {
      if (typeof r.amount !== 'number' || !isFinite(r.amount)) return '金额必须是数字';
      if (r.amount <= 0) return '金额必须大于 0';
      if (r.type !== INCOME && r.type !== EXPENSE) return '收支类型只能是 income 或 expense';
    }
    if (table === 'learnings') {
      if (!r.content) return '知识点不能为空';
      if (r.content.length > 200) return '知识点不能超过 200 字';
    }
    return null;
  }

  /* ------------------------------------------------------------ 派生统计 */

  function sumAmount(rows, type) {
    return (rows || []).reduce(function (acc, r) {
      if (!r || r.type !== type) return acc;
      var v = Number(r.amount);
      return acc + (isFinite(v) ? v : 0);
    }, 0);
  }

  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

  /**
   * 某一天的聚合统计：首页四张卡直接用它，页面里不写聚合逻辑。
   * todoOpenCount = 计划日期在当天或更早、且未完成的待办（含逾期）
   */
  function statsOfDate(dateStr) {
    var d = DS.util.normalizeDateStr(dateStr) || DS.util.todayStr();
    return Promise.all([
      listByDate('records', d),
      listByDate('todos', d),
      listByDate('finances', d),
      openTodosUpTo(d)
    ]).then(function (res) {
      var records = res[0], todos = res[1], finances = res[2], openUpTo = res[3];
      var income = round2(sumAmount(finances, INCOME));
      var expense = round2(sumAmount(finances, EXPENSE));
      var overdue = openUpTo.filter(function (t) { return t.date < d; }).length;

      return {
        date: d,
        doneCount: records.filter(function (r) { return !!r.done; }).length,
        recordCount: records.length,
        todoCount: todos.length,
        todoOpenCount: openUpTo.length,
        todoDoneCount: todos.filter(function (t) { return !!t.done; }).length,
        overdueCount: overdue,
        income: income,
        expense: expense,
        balance: round2(income - expense)
      };
    });
  }

  /** 计划日期 <= dateStr 且未完成的待办（逾期也算「待办未完成」） */
  function openTodosUpTo(dateStr) {
    var d = DS.util.normalizeDateStr(dateStr) || DS.util.todayStr();
    return readTx('todos', function (store) {
      var index = idx(store, 'date');
      if (!index) return req(store.getAll());
      return req(index.getAll(IDBKeyRange.upperBound(d, false)));
    }).then(function (rows) {
      return (rows || []).filter(function (t) { return t && !t.done; });
    });
  }

  /** 计划日期落在某个月内的未完成待办数量（日历角标用） */
  function monthOpenTodos(year, month) {
    return listRange('todos', DS.util.monthStart(year, month), DS.util.monthEnd(year, month))
      .then(function (rows) { return (rows || []).filter(function (t) { return !t.done; }).length; });
  }

  /**
   * 某个月的聚合：月度报表用
   * byCategory: { 餐饮: { income, expense, count }, ... }
   */
  function monthStats(year, month) {
    var y = Number(year);
    var m = Number(month);
    if (!isFinite(y) || !isFinite(m) || m < 1 || m > 12) {
      return Promise.reject(new Error('monthStats 参数不合法：需要 (year, month 1-12)'));
    }
    var from = DS.util.monthStart(y, m);
    var to = DS.util.monthEnd(y, m);

    return Promise.all([
      listRange('finances', from, to),
      listRange('records', from, to),
      listRange('todos', from, to)
    ]).then(function (res) {
      var finances = res[0] || [], records = res[1] || [], todos = res[2] || [];
      var income = round2(sumAmount(finances, INCOME));
      var expense = round2(sumAmount(finances, EXPENSE));
      var byCategory = {};
      var byDate = {};

      finances.forEach(function (f) {
        var key = f.category || '未分类';
        if (!byCategory[key]) byCategory[key] = { income: 0, expense: 0, count: 0 };
        byCategory[key][f.type === INCOME ? 'income' : 'expense'] += Number(f.amount) || 0;
        byCategory[key].count += 1;

        if (!byDate[f.date]) byDate[f.date] = { income: 0, expense: 0 };
        byDate[f.date][f.type === INCOME ? 'income' : 'expense'] += Number(f.amount) || 0;
      });

      Object.keys(byCategory).forEach(function (k) {
        byCategory[k].income = round2(byCategory[k].income);
        byCategory[k].expense = round2(byCategory[k].expense);
      });
      Object.keys(byDate).forEach(function (k) {
        byDate[k].income = round2(byDate[k].income);
        byDate[k].expense = round2(byDate[k].expense);
      });

      return {
        year: y,
        month: m,
        from: from,
        to: to,
        income: income,
        expense: expense,
        balance: round2(income - expense),
        byCategory: byCategory,
        byDate: byDate,
        recordCount: records.length,
        recordDoneCount: records.filter(function (r) { return !!r.done; }).length,
        todoCount: todos.length,
        todoDoneCount: todos.filter(function (t) { return !!t.done; }).length
      };
    });
  }

  /** 批量取某个月的每日聚合（日历角标：哪些天有数据） */
  function monthDayMarks(year, month) {
    var y = Number(year), m = Number(month);
    var from = DS.util.monthStart(y, m);
    var to = DS.util.monthEnd(y, m);
    return Promise.all([
      listRange('records', from, to),
      listRange('todos', from, to),
      listRange('finances', from, to)
    ]).then(function (res) {
      var marks = {};
      function touch(date) {
        if (!marks[date]) marks[date] = { records: 0, todos: 0, income: 0, expense: 0 };
        return marks[date];
      }
      (res[0] || []).forEach(function (r) { touch(r.date).records += 1; });
      (res[1] || []).forEach(function (t) { touch(t.date).todos += 1; });
      (res[2] || []).forEach(function (f) {
        var mk = touch(f.date);
        if (f.type === INCOME) mk.income += Number(f.amount) || 0;
        else mk.expense += Number(f.amount) || 0;
      });
      return marks;
    });
  }

  /** 数据总览（备份抽屉用） */
  function overview() {
    return Promise.all(TABLES.map(function (t) { return listAll(t); })).then(function (res) {
      // 按 TABLES 顺序映射，将来再加表不用改这里
      var out = { total: 0 };
      TABLES.forEach(function (t, i) {
        out[t] = (res[i] || []).length;
        out.total += out[t];
      });
      return out;
    });
  }

  /* ------------------------------------------------------------ 导出 */

  DS.store = {
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION,
    TABLES: TABLES,

    open: openDB,

    // 约定接口（勿改名 / 勿改签名）
    add: add,
    put: put,
    remove: remove,
    get: get,
    listByDate: listByDate,
    listRange: listRange,
    listAll: listAll,
    statsOfDate: statsOfDate,
    monthStats: monthStats,

    // 补充接口（页面内部用，同样属于 store 层）
    clear: clear,
    bulkAdd: bulkAdd,
    validate: validate,
    openTodosUpTo: openTodosUpTo,
    monthOpenTodos: monthOpenTodos,
    monthDayMarks: monthDayMarks,
    overview: overview
  };
})(window);
