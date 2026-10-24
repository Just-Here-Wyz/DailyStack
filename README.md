# 日栈 DailyStack

> 把「今天做了什么 / 要做什么 / 收支 / 知识点」收进一页的日常记录台。
> 纯前端、零依赖、零构建，双击 `index.html` 即用；**不登录就绝不联网、绝不上传**。

**在线体验**：<https://daily-stack.app.workbuddy.host/>

---

## 为什么做这个

每天的信息散在四五个 App 里：备忘录管待办、表格记收支、日历看进度、便签存知识点——
切换成本比记录本身还高。日栈把这四件事压进一屏，并以「今天」为唯一主线。

## 功能

| 模块 | 说明 |
|---|---|
| 今日记录 | 一段自由文本 + 当天状态，随时补记 |
| 待办清单 | 勾选完成、自动按日归档、**逾期项高亮**（跨天自动判定） |
| 收支记账 | 分类收入 / 支出，实时算当日合计与本月统计 |
| 日历回看 | 按日期翻看历史记录，一眼看出哪天空着 |
| 知识点便签 | 便利贴式记录，支持预览、JSON / Markdown 导出 |
| 云同步 | 手机号 + 验证码登录，多端双向同步；未登录零上传 |
| PWA | 可安装到桌面 / 手机，Service Worker 离线缓存 |

## 技术选型

| 层 | 选择 | 原因 |
|---|---|---|
| 框架 | 无（原生 JS，模块化 IIFE） | 单页工具没必要背上构建链，双击就能改 |
| 存储 | IndexedDB | 数据量会随使用增长，localStorage 5MB 上限不够 |
| 同步 | WorkBuddy Cloud（PG + RLS） | 免自建后端；行级安全让「用户只能读自己的行」由数据库保证 |
| 分发 | 静态托管 | 一个 `index.html` 就是全部入口 |

**规模**：JS 4306 行 · HTML + CSS 1751 行 · 无第三方运行时依赖（仅云端 SDK 异步加载）。

## 目录结构

```
index.html            入口
js/
  app.js              启动、路由、页面装配
  store.js            数据层契约（本地 + 云钩子）
  cloud.js            云端 SDK 接入、登录/会话、双向同步
  cloud-config.js     公开配置（endpoint / publishableKey，不含任何权限）
  lists.js            待办与列表
  calendar.js         日历回看
  stats.js            收支统计
  learnings.js        知识点便签
  detail.js           记录详情
  backup.js           导入导出
  util.js / toast.js  工具与提示
css/                  样式（含移动端断点）
test/                 307 项逻辑 / UI 断言 + 3 个真实浏览器冒烟脚本
tools/                图标生成
```

## 本地运行

```bash
# 方式一：直接双击 index.html
# 方式二（推荐，Service Worker 需要 http 协议）：
python -m http.server 8080
# 打开 http://localhost:8080
```

云同步需要 WorkBuddy Cloud 的 `endpoint` 与 `publishableKey`，已写在 `js/cloud-config.js`——
这两个值是**应用标识**，不含任何写入权限，安全边界由数据库行级安全（RLS）保证。

## 测试

```bash
node test/logic.test.js        # 40 项：日期 / 金额 / store 契约 / 统计口径
node test/store-extra.test.js  # 17 项：持久化与批量操作
node test/ui.test.js           # 250 项：DOM 渲染与交互
node test/sync.test.js         # 云同步触发与冲突处理
```

以上全部通过。另有三支 CDP 脚本（`smoke-cloud` / `smoke-learnings` / `smoke-touch`）在真实 Chrome 里验证
云层装配、便签预览与移动端触控，用于改版前后的回归。

## 设计取舍

- **不登录 = 零网络**：所有 `fetch` 都挂在登录态之后，未登录时连 SDK 都不加载。
- **失败必须可见**：同步失败在顶栏标红，不静默丢弃本地改动。
- **离线静默降级**：断网时先写本地、恢复后补传，不弹窗打断记录。
- **数据可带走**：全量 JSON / Markdown 导出，不锁定在应用里。
- **不做的事**：不做多用户协作、不做社交、不接入广告与统计 SDK。

## 已知限制

- 云同步为「最后写入覆盖」，冲突时以服务端时间戳为准，不做字段级合并。
- 只有手机号一种登录方式（微信登录因需已发布域名，已移除）。
- 无服务端渲染，首屏依赖本地缓存，极慢网络下首次加载约 1~2 秒。

## 许可

代码以 [MIT](LICENSE) 协议发布。

---

开发过程采用「**编写 → 自测 → 独立复测验收**」双角色流程：改版后必须重跑上述断言，
并由另一个角色从用户视角复测，而不是采信开发者的自述。
