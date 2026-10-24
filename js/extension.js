/* ==========================================================================
   extension.js —— 扩展模块区挂载机制
   --------------------------------------------------------------------------
   设计意图：主布局里只有一块 #extension-zone 容器，新功能通过 registerModule
   挂进来，不改主结构、不动已定契约。

   用法（将来加「习惯打卡」只要在 app.js 里加一段）：

     DS.extension.registerModule({
       id: 'habits',
       title: '习惯打卡',
       order: 10,
       mount: function (host) {
         // host 是一个干净的 <section class="ext-module">
         // 在这里画你自己的 DOM，数据照样走 DS.store
         host.appendChild(myNode);
         return function unmount() { ... };   // 可选：返回清理函数
       }
     });

   模块渲染失败只影响它自己，不会拖垮首页。
   ========================================================================== */
(function (global) {
  'use strict';

  var DS = global.DS = global.DS || {};
  var u = DS.util;

  var modules = [];          // 已注册模块
  var instances = [];        // 已挂载实例 { id, node, unmount }
  var seq = 0;

  function zoneEl() { return u.$('#extension-zone'); }
  function bodyEl() { return u.$('#extension-mounted'); }

  function sortModules() {
    modules.sort(function (a, b) {
      var oa = typeof a.order === 'number' ? a.order : 100;
      var ob = typeof b.order === 'number' ? b.order : 100;
      if (oa !== ob) return oa - ob;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  function updateBadge() {
    var badge = u.$('#extension-count');
    var placeholder = u.$('#extension-placeholder');
    var count = modules.length;

    if (badge) u.setText(badge, count ? '已挂载 ' + count + ' 个模块' : '待挂载');
    if (placeholder) placeholder.hidden = count > 0;
  }

  /**
   * 注册一个扩展模块
   * @param {{id:string,title?:string,order?:number,mount:Function}} mod
   * @returns {Function} 注销函数
   */
  function registerModule(mod) {
    if (!mod || typeof mod.mount !== 'function') {
      throw new Error('registerModule 需要 { id, mount(host) }');
    }

    var id = String(mod.id || ('module-' + (++seq)));
    if (modules.some(function (m) { return m.id === id; })) {
      throw new Error('扩展模块 id 重复：' + id);
    }

    var entry = {
      id: id,
      title: mod.title || id,
      order: typeof mod.order === 'number' ? mod.order : 100,
      mount: mod.mount
    };

    modules.push(entry);
    sortModules();
    render();

    return function unregister() {
      var i = modules.indexOf(entry);
      if (i >= 0) modules.splice(i, 1);
      unmountOne(id);
      render();
    };
  }

  function unmountOne(id) {
    for (var i = instances.length - 1; i >= 0; i--) {
      if (instances[i].id !== id) continue;
      try {
        if (typeof instances[i].unmount === 'function') instances[i].unmount();
        if (instances[i].node && instances[i].node.parentNode) {
          instances[i].node.parentNode.removeChild(instances[i].node);
        }
      } catch (e) { /* 卸载失败不阻塞其他模块 */ }
      instances.splice(i, 1);
    }
  }

  function unmountAll() {
    instances.slice().forEach(function (inst) { unmountOne(inst.id); });
  }

  /** 重新挂载全部模块（数据变动、跨天时调用可让模块跟着刷新） */
  function render() {
    var body = bodyEl();
    updateBadge();
    if (!body) return;

    unmountAll();
    u.clear(body);

    if (!modules.length) return;

    modules.forEach(function (mod) {
      var host = u.el('section', {
        class: 'ext-module',
        dataset: { module: mod.id }
      });

      if (mod.title) host.appendChild(u.el('h3', { class: 'ext-module__title', text: mod.title }));

      try {
        var unmount = mod.mount(host);
        instances.push({ id: mod.id, node: host, unmount: typeof unmount === 'function' ? unmount : null });
      } catch (error) {
        // 模块自己炸了，只在它的槽位里报错，首页照常
        host.appendChild(u.el('p', {
          class: 'state state--error',
          text: '模块「' + mod.title + '」加载失败：' + ((error && error.message) || '未知错误')
        }));
        instances.push({ id: mod.id, node: host, unmount: null });
      }

      body.appendChild(host);
    });
  }

  function init() {
    updateBadge();
    render();
  }

  DS.extension = {
    init: init,
    render: render,
    registerModule: registerModule,
    unregisterModule: function (id) {
      var i = modules.findIndex ? modules.findIndex(function (m) { return m.id === id; })
        : (function () { for (var k = 0; k < modules.length; k++) if (modules[k].id === id) return k; return -1; })();
      if (i < 0) return false;
      modules.splice(i, 1);
      unmountOne(id);
      render();
      return true;
    },
    listModules: function () { return modules.slice(); },
    getZone: zoneEl
  };
})(window);
