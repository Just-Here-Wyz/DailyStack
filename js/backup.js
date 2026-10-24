/* ==========================================================================
   backup.js —— 数据备份（导出 / 导入 / 清空）
   --------------------------------------------------------------------------
   本地优先的代价是数据只在浏览器里，清缓存就没了。所以给一个后路：
   JSON 导出、JSON 导入（可合并 / 可整体替换 / 可统一改日期）、清空。
   ========================================================================== */
(function (global) {
  'use strict';

  var DS = global.DS = global.DS || {};
  var u = DS.util;

  var EXPORT_APP = 'dailyStack';
  // v1：三表；v2：含 learnings。导入侧对缺失的表做容错，旧备份照样能导。
  var EXPORT_VERSION = 2;

  /** 表名 -> 中文名（确认弹窗与提示用） */
  var TABLE_LABEL = {
    records: '记录',
    todos: '待办',
    finances: '收支',
    learnings: '学习'
  };

  /* ------------------------------------------------------------ 导出 */

  function buildPayload() {
    // 走 DS.store.TABLES，将来再加表自动纳入备份，不用回来改
    var names = DS.store.TABLES;
    return Promise.all(names.map(function (t) { return DS.store.listAll(t); }))
      .then(function (res) {
        var tables = {}, counts = {}, total = 0;
        names.forEach(function (t, i) {
          tables[t] = res[i] || [];
          counts[t] = tables[t].length;
          total += counts[t];
        });
        return {
          app: EXPORT_APP,
          version: EXPORT_VERSION,
          exportedAt: u.nowIso(),
          tables: tables,
          counts: counts,
          total: total
        };
      });
  }

  function exportJson() {
    return buildPayload().then(function (payload) {
      if (!payload.total) {
        DS.toast.error('当前没有任何数据可导出');
        return null;
      }

      var text = JSON.stringify(payload, null, 2);
      var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var stamp = u.todayStr().replace(/-/g, '');
      var name = '日栈备份-' + stamp + '.json';

      var a = u.el('a', { href: url, download: name, style: { display: 'none' } });
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        if (a.parentNode) a.parentNode.removeChild(a);
        URL.revokeObjectURL(url);
      }, 1000);

      DS.toast.success('已导出 ' + payload.total + ' 条数据');
      return payload;
    });
  }

  /* ------------------------------------------------------------ 导入 */

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(new Error('文件读取失败')); };
      reader.readAsText(file, 'utf-8');
    });
  }

  function parsePayload(text) {
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('这不是一个合法的 JSON 备份文件');
    }
    if (!data || typeof data !== 'object') throw new Error('备份文件内容为空');
    if (data.app && data.app !== EXPORT_APP) throw new Error('这个备份不属于日栈（app: ' + data.app + '）');

    var tables = data.tables || data;   // 兼容直接给出表的裸结构
    var out = {}, total = 0;
    // 按当前表清单取值；旧备份缺的表补空数组，不报错
    DS.store.TABLES.forEach(function (t) {
      var rows = tables[t];
      out[t] = Array.isArray(rows) ? rows : [];
      total += out[t].length;
    });

    if (!total) throw new Error('备份文件里没有任何数据');
    return out;
  }

  /** 导入：overwriteDate 传了就把日期统一改掉；merge 为 false 时先清空 */
  function importPayload(tables, options) {
    var opts = options || {};
    var overwriteDate = u.normalizeDateStr(opts.date);
    var merge = !!opts.merge;

    function prep(table) {
      return (tables[table] || []).map(function (row) {
        var copy = Object.assign({}, row);
        if (overwriteDate) copy.date = overwriteDate;
        // 重新发 id，避免和现有数据撞车
        copy.id = u.uid();
        return copy;
      });
    }

    var order = DS.store.TABLES;
    var prepared = {};
    order.forEach(function (t) { prepared[t] = prep(t); });

    var chain = Promise.resolve();
    if (!merge) {
      order.forEach(function (t) { chain = chain.then(function () { return DS.store.clear(t); }); });
    }

    var written = 0;
    order.forEach(function (t) {
      chain = chain.then(function () {
        if (!prepared[t].length) return null;
        return DS.store.bulkAdd(t, prepared[t]).then(function (n) { written += n; });
      });
    });

    var counts = {};
    order.forEach(function (t) { counts[t] = prepared[t].length; });

    return chain.then(function () {
      return { written: written, counts: counts };
    });
  }

  function handleFile(file, options) {
    if (!file) return Promise.resolve(null);
    var errNode = u.$('#import-error');
    if (errNode) u.setText(errNode, '');

    return readFile(file)
      .then(function (text) {
        var tables = parsePayload(text);
        var total = 0;
        var lines = DS.store.TABLES.map(function (t) {
          var n = (tables[t] || []).length;
          total += n;
          return '· ' + (TABLE_LABEL[t] || t) + ' ' + n + ' 条';
        });
        var overwriteDate = u.normalizeDateStr(options && options.date);
        var mergeLabel = options && options.merge ? '合并导入' : '覆盖导入（会先清空现有数据）';

        var ok = global.confirm(
          '将导入 ' + total + ' 条数据：\n' +
          lines.join('\n') + '\n\n' +
          '方式：' + mergeLabel +
          (overwriteDate ? '\n日期：统一改为 ' + overwriteDate : '\n日期：沿用备份中的原日期') +
          '\n\n确定继续吗？'
        );
        if (!ok) return null;

        return importPayload(tables, options).then(function (res) {
          DS.toast.success('已导入 ' + res.written + ' 条数据', 2200);
          if (DS.app && DS.app.notifyDataChanged) DS.app.notifyDataChanged();
          return res;
        });
      })
      .catch(function (error) {
        var message = (error && error.message) || '导入失败';
        if (errNode) u.setText(errNode, message);
        DS.toast.error(message, 2600);
        return null;
      });
  }

  /* ------------------------------------------------------------ 清空 */

  function clearAll() {
    var ok = global.confirm('确定清空全部数据吗？\n记录、待办、收支都会被删除，且无法恢复。\n建议先导出一份备份。');
    if (!ok) return Promise.resolve(false);

    var again = global.confirm('最后确认：真的要清空吗？此操作不可撤销。');
    if (!again) return Promise.resolve(false);

    return Promise.all(DS.store.TABLES.map(function (t) { return DS.store.clear(t); }))
      .then(function () {
        DS.toast.success('已清空全部数据');
        if (DS.app && DS.app.notifyDataChanged) DS.app.notifyDataChanged();
        return true;
      })
      .catch(function (error) {
        DS.toast.error((error && error.message) || '清空失败');
        return false;
      });
  }

  /* ------------------------------------------------------------ 面板刷新 */

  function refreshCount() {
    var node = u.$('#backup-count');
    if (!node) return;
    DS.store.overview().then(function (o) {
      // 按表清单生成，新增表自动出现在统计里
      var parts = DS.store.TABLES.map(function (t) {
        return (TABLE_LABEL[t] || t) + ' ' + (o[t] || 0);
      });
      u.setText(node, '当前共有 ' + o.total + ' 条：' + parts.join(' · '));
    }, function () {
      u.setText(node, '数据统计失败');
    });
  }

  /* ------------------------------------------------------------ 初始化 */

  function init() {
    var openBtn = u.$('#btn-backup');
    var drawer = u.$('#drawer-backup');
    var exportBtn = u.$('#btn-export');
    var pickBtn = u.$('#btn-import-pick');
    var fileInput = u.$('#import-file');
    var clearBtn = u.$('#btn-clear-all');
    var importDate = u.$('#import-date');
    var mergeInput = u.$('#import-merge');

    if (openBtn && drawer) {
      openBtn.addEventListener('click', function () {
        drawer.hidden = false;
        document.body.style.overflow = 'hidden';
        refreshCount();
        if (importDate && !importDate.value) importDate.value = u.todayStr();
      });
    }

    if (exportBtn) exportBtn.addEventListener('click', function () {
      exportBtn.disabled = true;
      DS.util.safe(exportJson()).then(function (res) {
        exportBtn.disabled = false;
        if (!res.ok) DS.toast.error((res.error && res.error.message) || '导出失败');
      });
    });

    if (pickBtn && fileInput) {
      pickBtn.addEventListener('click', function () { fileInput.value = ''; fileInput.click(); });
      fileInput.addEventListener('change', function () {
        var file = fileInput.files && fileInput.files[0];
        if (!file) return;
        handleFile(file, {
          date: importDate && importDate.value ? importDate.value : null,
          merge: !!(mergeInput && mergeInput.checked)
        }).then(function () {
          fileInput.value = '';
          refreshCount();
        });
      });
    }

    if (clearBtn) clearBtn.addEventListener('click', function () {
      clearAll().then(function (done) { if (done) refreshCount(); });
    });
  }

  DS.backup = {
    init: init,
    exportJson: exportJson,
    importPayload: importPayload,
    refreshCount: refreshCount,
    buildPayload: buildPayload
  };
})(window);
