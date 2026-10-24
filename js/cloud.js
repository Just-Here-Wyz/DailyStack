/* ==========================================================================
   cloud.js —— 云端同步层（WorkBuddy Cloud Service）
   --------------------------------------------------------------------------
   职责：
     1. 初始化 SDK（Form B：CDN 全局 WorkBuddyCloud）。
     2. 登录 / 注册（手机号验证码），会话恢复与退出。
     3. 登录后把本地 IndexedDB 与云端 Database 双向同步：
        - 每次本地写（add/put/remove）同时 push 到云端（store.js 调用）。
        - 登录 / 点「同步」/ 窗口聚焦时，pull 云端全量覆盖本地（先上传本地独有行）。
     4. 顶部「同步」按钮 + 登录弹窗的 UI 绑定。

   设计要点：
     - 未登录时应用完全照旧（纯本地），云端代码静默不介入。
     - 所有客户端调用都从 publicConfig 取 endpoint / publishableKey，绝不硬编码。
     - 绝不手动传 owner_id / token：表用 owner_id DEFAULT auth.uid() + RLS，会话由 SDK 自动附带。
     - 写错（网络 / 未登录 / 配额）只给轻提示，不阻塞本地使用。
   ========================================================================== */
(function (global) {
  'use strict';

  var DS = global.DS = global.DS || {};
  var u = DS.util;

  var client = null;      // WorkBuddyCloud 客户端实例
  var ready = false;      // SDK 已加载且客户端已创建
  var session = null;     // 当前会话（含 user）
  var syncing = false;    // 云 ↔ 本地同步锁（pull 期间禁止 store 回写云端，避免递归）
  var otpPending = null;  // 手机号验证码的中间态
  var stateListeners = []; // auth 状态变化监听
  var syncTimer = null;   // 周期性后台同步的定时器

  /* ------------------------------------------------------------ 初始化 */

  function publicConfig() {
    return (DS.cloudConfig && DS.cloudConfig.endpoint && DS.cloudConfig.publishableKey)
      ? DS.cloudConfig : null;
  }

  function init() {
    var cfg = publicConfig();
    if (!cfg) return false;

    // SDK 以 async 方式异步加载：可能尚未就绪（离线，或被网络延迟）。
    // 此时不阻塞启动——先让本地应用照常跑，再由 scheduleSdkRetry 等脚本到位后接入。
    if (!global.WorkBuddyCloud || !global.WorkBuddyCloud.createWorkBuddyCloud) {
      scheduleSdkRetry();
      return false;
    }

    try {
      client = global.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: cfg.endpoint,
        publishableKey: cfg.publishableKey
      });
      ready = true;
    } catch (e) {
      ready = false;
      client = null;
      return false;
    }

    // 后台恢复已有会话（异步；不阻塞启动）
    refreshSession();

    return true;
  }

  // SDK 通过 async 加载，可能晚于应用启动到达。这里短轮询等待，到位即接入；
  // 离线 / 被墙时轮询耗尽后放弃，应用始终本地可用，不产生任何报错。
  var sdkRetryTimer = null;
  var sdkRetryCount = 0;
  var SDK_RETRY_MAX = 30; // 500ms × 30 ≈ 15s 窗口

  function scheduleSdkRetry() {
    if (sdkRetryTimer || sdkRetryCount >= SDK_RETRY_MAX) return;
    sdkRetryTimer = setInterval(function () {
      sdkRetryCount += 1;
      if (global.WorkBuddyCloud && global.WorkBuddyCloud.createWorkBuddyCloud) {
        clearInterval(sdkRetryTimer); sdkRetryTimer = null;
        init();
      } else if (sdkRetryCount >= SDK_RETRY_MAX) {
        clearInterval(sdkRetryTimer); sdkRetryTimer = null;
      }
    }, 500);
  }

  function isReady() { return ready && !!client; }
  function isAuthed() { return !!(session && session.user); }
  function isSyncing() { return syncing; }
  function getSession() { return session; }

  function onAuthStateChange(cb) {
    if (typeof cb === 'function') stateListeners.push(cb);
  }

  function setSession(s) {
    var prevId = (session && session.user && session.user.id) || null;
    var nextId = (s && s.user && s.user.id) || null;
    session = s;
    if (prevId !== nextId) {
      stateListeners.forEach(function (cb) { try { cb(s); } catch (e) {} });
      // 登录成功，或「重新打开应用」由本地存储恢复了会话 → 立即到云端拉取一次，
      // 这样同一账号在其他设备上的改动才会出现在本机。用 setTimeout(0) 让上面的监听先跑完、避免重入。
      if (nextId) setTimeout(triggerSyncIfAuthed, 0);
    }
  }

  /** 已登录且当前未在同步时，主动与云端拉取 / 补传一次 */
  function triggerSyncIfAuthed() {
    if (!isReady() || !isAuthed() || syncing) return;
    syncFromCloud().then(function (ok) {
      if (ok && DS.toast) DS.toast.success('云端同步完成');
    });
  }

  function reportSyncError(error) {
    var msg = (error && error.message) || '云端同步出错';
    if (DS.toast) DS.toast.info('云端同步：' + msg);
  }

  /* ------------------------------------------------------------ 会话 */

  function refreshSession() {
    if (!isReady()) return Promise.resolve(null);
    return client.auth.getSession().then(function (res) {
      if (res.error) { setSession(null); return null; }
      setSession(res.data || null);
      return session;
    }).catch(function () { setSession(null); return null; });
  }

  /** 启动后调用：恢复会话，已登录则立即与云端同步一次 */
  function ensureSynced() {
    if (!isReady()) return Promise.resolve(false);
    return refreshSession().then(function () {
      if (isAuthed()) return syncFromCloud().then(function () { return true; });
      return false;
    });
  }

  /* ------------------------------------------------------------ 手机号验证码 */

  function sendPhoneCode(phone) {
    if (!/^1\d{10}$/.test(phone)) {
      return Promise.resolve({ error: { message: '请输入正确的 11 位手机号' } });
    }
    if (!isReady()) return Promise.resolve({ error: { message: '云服务未就绪（可能离线）' } });
    return client.auth.sendOtp({ phone }).then(function (res) {
      if (res.error) return res;
      otpPending = {
        phone: phone,
        verificationId: res.data && res.data.verificationId,
        isExistingUser: !!(res.data && res.data.isExistingUser)
      };
      return res;
    });
  }

  function verifyPhoneCode(phone, code) {
    var pending = otpPending;
    if (!pending || pending.phone !== phone) {
      return Promise.resolve({ error: { message: '请先获取验证码' } });
    }
    if (!isReady()) return Promise.resolve({ error: { message: '云服务未就绪' } });
    return client.auth.verifyOtp({
      phone: pending.phone,
      verificationId: pending.verificationId,
      isExistingUser: pending.isExistingUser,
      token: code
    }).then(function (res) {
      if (res.error) return res;
      otpPending = null;
      setSession(res.data || null);
      if (isAuthed()) afterSignedIn();
      return res;
    });
  }

  /* ------------------------------------------------------------ 退出 */

  function signOut() {
    if (!isReady()) return Promise.resolve();
    return client.auth.signOut().then(function () {
      setSession(null);
      if (DS.toast) DS.toast.info('已退出登录，数据仍保留在本机');
    });
  }

  function afterSignedIn() {
    if (DS.toast) DS.toast.success('登录成功，正在同步云端数据…');
    syncFromCloud().then(function (ok) {
      if (ok && DS.toast) DS.toast.success('云端同步完成');
    });
  }

  /* ------------------------------------------------------------ 数据映射 */

  function mapToCloud(table, rec) {
    if (!rec || !rec.id) return null;
    if (table === 'records') {
      return {
        id: rec.id, date: rec.date, content: rec.content, done: !!rec.done,
        created_at: rec.createdAt || null, updated_at: rec.updatedAt || null
      };
    }
    if (table === 'todos') {
      return {
        id: rec.id, date: rec.date, content: rec.content,
        priority: rec.priority || 'medium', done: !!rec.done,
        created_at: rec.createdAt || null, done_at: rec.doneAt || null
      };
    }
    if (table === 'learnings') {
      return {
        id: rec.id, date: rec.date, content: rec.content,
        tags: Array.isArray(rec.tags) ? rec.tags : [],
        created_at: rec.createdAt || null, updated_at: rec.updatedAt || null
      };
    }
    if (table === 'finances') {
      return {
        id: rec.id, date: rec.date,
        type: rec.type === 'income' ? 'income' : 'expense',
        amount: Number(rec.amount) || 0,
        category: rec.category || '', note: rec.note || '',
        created_at: rec.createdAt || null
      };
    }
    return null;
  }

  function mapFromCloud(table, row) {
    if (!row || !row.id) return null;
    if (table === 'records') {
      return {
        id: row.id, date: row.date, content: row.content, done: !!row.done,
        createdAt: row.created_at || null, updatedAt: row.updated_at || null
      };
    }
    if (table === 'todos') {
      return {
        id: row.id, date: row.date, content: row.content,
        priority: row.priority || 'medium', done: !!row.done,
        createdAt: row.created_at || null, doneAt: row.done_at || null
      };
    }
    if (table === 'learnings') {
      return {
        id: row.id, date: row.date, content: row.content,
        tags: Array.isArray(row.tags) ? row.tags : [],
        createdAt: row.created_at || null, updatedAt: row.updated_at || null
      };
    }
    if (table === 'finances') {
      return {
        id: row.id, date: row.date,
        type: row.type === 'income' ? 'income' : 'expense',
        amount: Number(row.amount) || 0,
        category: row.category || '', note: row.note || '',
        createdAt: row.created_at || null
      };
    }
    return null;
  }

  /* ------------------------------------------------------------ 云端写（供 store 调用） */

  function pushUpsert(table, rec) {
    if (!isReady() || !isAuthed()) return Promise.resolve();
    var row = mapToCloud(table, rec);
    if (!row) return Promise.resolve();
    return client.database.from(table).upsert(row).then(function (res) {
      if (res.error) reportSyncError(res.error);
    });
  }

  function pushDelete(table, id) {
    if (!isReady() || !isAuthed()) return Promise.resolve();
    return client.database.from(table).delete().eq('id', id).then(function (res) {
      if (res.error) reportSyncError(res.error);
    });
  }

  function pullTable(table) {
    return client.database.from(table).select('*').then(function (res) {
      if (res.error) { reportSyncError(res.error); return []; }
      return (res.data || []).map(function (row) { return mapFromCloud(table, row); });
    });
  }

  /* ------------------------------------------------------------ 同步主流程 */

  /**
   * 登录 / 点「同步」/ 窗口聚焦时调用：
   *   1. 拉取云端全量 → 覆盖本地（期间 syncing 锁住，store 不会回写云端，避免递归）
   *   2. 上传本地独有行（登录前在本机创建、尚未上云的数据）
   *   3. 通知页面刷新
   * 返回 Promise<boolean>：是否成功同步。
   */
  function syncFromCloud() {
    if (!isReady() || !isAuthed()) return Promise.resolve(false);
    if (syncing) return Promise.resolve(false);
    syncing = true;

    var cloudIds = {};
    var tables = DS.store.TABLES;

    var pullJobs = tables.map(function (table) {
      return pullTable(table).then(function (rows) {
        cloudIds[table] = {};
        rows.forEach(function (r) { if (r && r.id) cloudIds[table][r.id] = true; });
        return DS.store.bulkAdd(table, rows); // 锁住期间，store 内部不会回写云端
      });
    });

    return Promise.all(pullJobs)
      .then(function () {
        var pushJobs = tables.map(function (table) {
          return DS.store.listAll(table).then(function (localRows) {
            var onlyLocal = localRows.filter(function (r) { return r && r.id && !cloudIds[table][r.id]; });
            return Promise.all(onlyLocal.map(function (r) { return pushUpsert(table, r); }));
          });
        });
        return Promise.all(pushJobs);
      })
      .then(function () {
        syncing = false;
        if (DS.app && DS.app.notifyDataChanged) DS.app.notifyDataChanged();
        return true;
      })
      .catch(function (e) {
        syncing = false;
        reportSyncError(e);
        return false;
      });
  }

  /* ------------------------------------------------------------ UI 绑定 */

  function mountUI() {
    var syncBtn = u.$('#btn-sync');
    var logoutBtn = u.$('#btn-logout');
    var drawer = u.$('#drawer-login');
    var phoneInput = u.$('#login-phone');
    var codeInput = u.$('#login-code');
    var sendBtn = u.$('#login-send-code');
    var submitBtn = u.$('#login-phone-submit');
    var phoneErr = u.$('#login-phone-error');
    var codeErr = u.$('#login-code-error');

    function openLogin() {
      if (!drawer) return;
      drawer.hidden = false;
      document.body.style.overflow = 'hidden';
      if (phoneInput) setTimeout(function () { phoneInput.focus(); }, 60);
    }
    function closeLogin() {
      if (!drawer) return;
      drawer.hidden = true;
      document.body.style.overflow = '';
    }

    function updateAuthUI() {
      if (isAuthed()) {
        if (syncBtn) { syncBtn.textContent = '同步'; syncBtn.title = '点一下立即与云端同步'; syncBtn.hidden = false; }
        if (logoutBtn) logoutBtn.hidden = false;
      } else {
        if (syncBtn) { syncBtn.textContent = '登录同步'; syncBtn.title = '登录后手机和电脑自动同步'; syncBtn.hidden = false; }
        if (logoutBtn) logoutBtn.hidden = true;
      }
    }

    if (syncBtn) {
      syncBtn.addEventListener('click', function () {
        if (isAuthed()) {
          if (!isReady()) { if (DS.toast) DS.toast.error('云服务未就绪（可能离线）'); return; }
          if (DS.toast) DS.toast.info('正在同步…');
          syncFromCloud();
        } else {
          openLogin();
        }
      });
    }

    if (logoutBtn) {
      logoutBtn.addEventListener('click', function () { signOut(); });
    }

    if (sendBtn && phoneInput && codeInput) {
      sendBtn.addEventListener('click', function () {
        var phone = phoneInput.value.trim();
        if (!/^1\d{10}$/.test(phone)) { if (phoneErr) u.setText(phoneErr, '请输入正确的 11 位手机号'); return; }
        if (phoneErr) u.setText(phoneErr, '');
        sendBtn.disabled = true;
        DS.util.safe(sendPhoneCode(phone)).then(function (res) {
          sendBtn.disabled = false;
          if (!res || res.error) {
            if (DS.toast) DS.toast.error((res && res.error && res.error.message) || '验证码发送失败');
            return;
          }
          codeInput.disabled = false;
          if (submitBtn) submitBtn.disabled = false;
          if (DS.toast) DS.toast.info('验证码已发送，请查收短信');
          startResendCountdown(sendBtn);
        });
      });
    }

    if (submitBtn && phoneInput && codeInput) {
      submitBtn.addEventListener('click', function () {
        var phone = phoneInput.value.trim();
        var code = codeInput.value.trim();
        if (!code) { if (codeErr) u.setText(codeErr, '请输入验证码'); return; }
        if (codeErr) u.setText(codeErr, '');
        submitBtn.disabled = true;
        DS.util.safe(verifyPhoneCode(phone, code)).then(function (res) {
          submitBtn.disabled = false;
          if (!res || res.error) {
            if (DS.toast) DS.toast.error((res && res.error && res.error.message) || '登录失败');
            return;
          }
          closeLogin();
        });
      });
      // 验证码框回车即提交
      codeInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submitBtn.click(); }
      });
    }

    // 退出登录后，状态刷新 + 收起弹窗
    onAuthStateChange(function (s) {
      updateAuthUI();
      if (!s) closeLogin();
    });

    // 已登录时，窗口重新聚焦主动拉取一次其他设备的改动
    global.addEventListener('focus', function () {
      if (isAuthed() && !syncing) syncFromCloud();
    }, false);

    // 周期性后台同步：覆盖「两台设备同时开着」的场景——一端改动后，
    // 另一端不依赖手动点同步 / 切窗口，约 1 分钟内也能拉到。仅在已登录且空闲时跑。
    if (!syncTimer) {
      syncTimer = setInterval(function () {
        if (isAuthed() && !syncing) syncFromCloud();
      }, 60000);
    }

    updateAuthUI();
  }

  function startResendCountdown(btn) {
    var secs = 60;
    btn.disabled = true;
    var timer = setInterval(function () {
      secs -= 1;
      if (secs <= 0) {
        clearInterval(timer);
        btn.disabled = false;
        u.setText(btn, '重新获取验证码');
      } else {
        u.setText(btn, secs + ' 秒后可重发');
      }
    }, 1000);
  }

  /* ------------------------------------------------------------ 导出 */

  DS.cloud = {
    init: init,
    isReady: isReady,
    isAuthed: isAuthed,
    isSyncing: isSyncing,
    getSession: getSession,
    onAuthStateChange: onAuthStateChange,
    ensureSynced: ensureSynced,
    refreshSession: refreshSession,
    sendPhoneCode: sendPhoneCode,
    verifyPhoneCode: verifyPhoneCode,
    signOut: signOut,
    syncFromCloud: syncFromCloud,
    pushUpsert: pushUpsert,
    pushDelete: pushDelete,
    mountUI: mountUI
  };
})(window);
