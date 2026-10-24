/* ==========================================================================
   service-worker.js —— 日栈 DailyStack 离线缓存
   --------------------------------------------------------------------------
   策略：
   ① 安装时预缓存核心静态资源（HTML / CSS / 全部 js / 图标 / manifest），
      离线也能打开应用；
   ② 运行时同源 GET 请求走「stale-while-revalidate」：命中缓存先返回，
      同时后台拉新版本写回缓存（下次打开即最新），离线时自动回退缓存；
   ③ 跨域请求（WorkBuddy 云端 SDK / CDN）一律放行——不拦截、不缓存，
      避免影响登录与数据同步。

   更新方式：改动前端资源时把 CACHE 版本号 +1 即可让所有客户端换新缓存。
   ========================================================================== */
'use strict';

var CACHE = 'daily-stack-v2';

var PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/util.js',
  './js/store.js',
  './js/toast.js',
  './js/stats.js',
  './js/lists.js',
  './js/calendar.js',
  './js/detail.js',
  './js/extension.js',
  './js/learnings.js',
  './js/backup.js',
  './js/cloud-config.js',
  './js/cloud.js',
  './js/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // 逐个 add：单个资源拿不到不至于让整个安装失败
      return Promise.all(PRECACHE.map(function (url) {
        return cache.add(url).catch(function () { /* 忽略单个失败 */ });
      }));
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  // 跨域放行：CDN 上的 SDK、云端接口都交给浏览器默认处理
  if (new URL(req.url).origin !== self.location.origin) return;

  e.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(req).then(function (cached) {
        var fromNetwork = fetch(req).then(function (res) {
          // 只缓存正常的同源基本响应；重定向 / 错误响应不落盘
          if (res && res.status === 200 && res.type === 'basic') {
            cache.put(req, res.clone());
          }
          return res;
        }).catch(function () {
          return cached;   // 离线：有缓存就用缓存
        });
        return cached || fromNetwork;
      });
    })
  );
});
