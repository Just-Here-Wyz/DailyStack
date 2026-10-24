/* ==========================================================================
   cloud-config.js —— 云端公开配置（仅前端安全值，可进仓库）
   --------------------------------------------------------------------------
   这些值来自 workbuddy_cloud_service 激活后返回的 publicConfig：
     endpoint           数据面基址（必需，且永远从 publicConfig 取，绝不硬编码）
     publishableKey     应用标识（仅用于识别应用，不含任何权限）
   不要在这里放任何密钥 / token。
   ========================================================================== */
window.DS = window.DS || {};
window.DS.cloudConfig = {
  endpoint: 'https://daily-stack.app.workbuddy.host',
  publishableKey: 'wbpk_cJN11fD53B8hCTmpnDBOSh_wwQc8i0RyhKUhE2H6fJuLLYr5N21yjPX'
};
