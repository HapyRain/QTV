# 迭代记录与后续计划

## 2026-11-14 · Windows 桌面端（当前）

- **新增 Windows 桌面端（Electron）**：无边框 Mica 标题栏 + 左侧导航栏、`Ctrl+K` 全局搜索、窗口置顶、16:9 迷你播放窗、托盘常驻（关闭到托盘、托盘退出）、窗口位置/尺寸记忆、分片流式下载到 `Videos\QTV`。
- **本地 API 引擎（Node）**：`windows/local-api-server.mjs` 在 `127.0.0.1` 随机端口同时提供静态站点与全套 `/api/*`（状态、豆瓣/Bangumi、并发搜索、详情、直播 M3U/EPG、画质探测、M3U8 代理与去广告、源测活、订阅解析），与 Kotlin / Swift 实现保持同一契约。
- **三端共用一套前端**：`scripts/build-web.mjs` 一次导出并同步 `app/.../www`、`ios/QTV/Resources/www`、`windows/www`；桌面形态由运行时 `window.QTVDesktop` 判定（`web/src/lib/desktop.ts`），移动端界面不受影响。
- **桌面 UI 源码化**：早期桌面界面靠 Babel 注入压缩 chunk 实现（`compile_desktop_ui.mjs` / `compile-desktop-bundle.mjs`，人工补丁不可复现），本轮改为真正的 TSX 源码（`web/src/components/desktop/**`），删除注入脚本，`build-web.mjs` 重新构建即可产出桌面端。
- **修复**：本地服务与前端契约对齐（搜索 `wd`、详情 `source` JSON、画质/直播探测 NDJSON、`player-state` GET、`adFilter`、EPG `tvgId`）；下载桥方法名对齐前端 `NativeSaveBridge`；删除拍照用的 `QTV_SHOWCASE` 假数据接管器；本地服务去掉 `Access-Control-Allow-Origin: *` 并给代理加 SSRF 校验与体积上限；Electron 补单实例锁、导航守卫、权限请求默认拒绝。
- **工程**：CI 合并为一条三端流水线（ubuntu / macos-15 / windows-latest 并行出 APK、未签名 IPA、Windows 安装包）；screenshots 按 `mobile/` `desktop/` 分目录；`.gitignore` 补 Electron 产物。

### 2026-11-15 · 桌面端整页化改版（第一阶段）

- **导航改成真实路由**：`/history`、`/cache`、`/sources`、`/settings` 四个桌面整页，历史/缓存/片源/设置不再用浮层抽屉；移动端仍保留原底部导航与抽屉（事件监听按 `desktop` 分流）。
- **设计定稿落地**：`app/desktop.css` 新增桌面专用 token（纯黑 / 暖白两套，随 `.dark` 切换），统一标题栏、侧栏、页面标题、卡片、列表、分段控件与进入动效；移动端样式不受影响。
- **首页**：新增 featured hero（取豆瓣热播首条，标题/评分/「查找片源」），保留下方聚合搜索与海报墙。
- **设置页**：外观（深/浅色）+ 播放面板 + 海报面板 + 备份面板 + 关于，全部复用现有 store 与组件。
- **缓存页**：复用全局下载队列（`qtv:download-*` 事件桥），支持播放 / 打开位置 / 暂停继续 / 删除；`requestShowDownloadManager()` 在桌面端改为跳 `/cache`。
- **待办（下一阶段）**：探索 / 直播 / 点播的内容区仍是旧版式，只换了壳与配色，需要按定稿 mockup 重排；历史/缓存页需要用真实数据回归；缓存暂停/删除需要真机验证。

### 2026-11-15 · 离线缓存「有文件没入口、回看不走缓存」

- **根因**：下载链路（`runDownloadJob`）把 MP4 写进系统目录后就结束了 —— 原生桥 `saveEnd()` 只回布尔，**从未把落盘位置告诉前端**；`downloads` 表没有路径字段，「离线缓存中心」只能显示进度和删除；播放页也不知道这一集缓存过，所以重新打开永远走在线线路。三端共用同一份 `web/`，Android / iOS / Windows 全中。
- **桥层**：三端保存桥统一新增 `getLastSavedPath()` / `openSavedFile(path)` / `openDownloadFolder()`；`saveEnd` 成功后上报位置（Android MediaStore `content://`、iOS 沙盒绝对路径、Windows 绝对路径）。iOS 的 messageHandler 是异步的，前端在 `close()` 里做 10×30ms 短轮询。
- **本地服务**：三端新增 `/api/local-file?path=`，只允许各端下载目录内的文件，支持 HTTP Range；Windows 用 `fs.createReadStream` 流式、Android 用 `openAssetFileDescriptor` + 有界流、iOS 用 `FileHandle` 256KB 分块。
- **前端**：`downloads` 表新增 `filePath / episodeKey / sourceKey / vodId / episodeIndex`；下载完成写入位置；播放页按「源+影片+集」命中已完成记录后，把播放地址换成 `/api/local-file?path=…` 并显示「已缓存」徽章（播放器新增直读 MP4 分支，不再交给 hls.js）；缓存中心已完成条目显示文件名 +「播放」「打开位置」。
- 顺带把「内置代理加速模式」等描述改成「下载加速」。

### 2026-11-14 · 面向用户的文案整改

- 新手引导改成用户视角（欢迎使用 / 添加片源 / 快捷操作），删掉「本地直连架构」「零服务端本地聚合引擎」「HLS 切片广告净流」这类架构自述。
- 品牌位去掉「QTV Desktop / Windows 原生桌面版」；侧栏「本地代理引擎 / 就绪 / 快速配置向导」改为「我的片源 / 正常 / 新手引导」；快捷键只保留真实生效的 6 个。
- 全站去技术术语：采集站/接口 → 片源、测活 → 检测、分片续传 → 断点续传、代理增强 → 下载加速、智能直连 → 智能加速；报错提示改成「网络受限，换条线路重试」。

### 2026-11-14 · 桌面端体验修复（补充）

- **全屏**：Electron 无边框窗口里 HTML 全屏 API 不生效（`requestFullscreen()` 永远 pending），桌面端改用 ArtPlayer「网页全屏」铺满视口 + 主进程 `setFullScreen` 把窗口切成系统全屏；`F` / `Esc` 同步切换，退出后窗口恢复原尺寸。
- **详情弹窗**：桌面端不再从底部滑出抽屉，改为居中弹窗（圆角、无拖拽把手）；移动端保持原底部 Sheet。
- **首页推荐**：旧的 `movie.douban.com/j/search_subjects` 已下线，改走 `m.douban.com/rexxar/api/v2/subject_collection/*`（剧集 `tv_hot`、电影 `movie_hot`，高分走 `tv_chinese_best_weekly` / `movie_top250`），并修正 UA/Referer（桌面 UA 会被判爬虫返回空体）。
- **桌面壳**：`/watch` 无源错误页补上标题栏外壳（无边框窗口原本没有关闭/拖动区域）；标题栏与使用向导的版本号改读原生 `/api/status`。

## 2026-11-13 · QTV 品牌升级（前序）

- 项目由 LJJTV 更名为 **QTV**：全套 Logo（Android 自适应图标、iOS 1024 AppIcon、Web 图标与 16:9 待机海报）、应用名、SEO、离线页、关于页。
- 工程更名：Gradle `qtv-android`、iOS `ios/QTV.xcodeproj`（共享 Scheme `QTV`），包名 / Bundle ID `org.qtv.app`。
- 导出前缀 `QTV-SourceList_` / `QTV-Backup_`，导入向下兼容旧版 `LibreTV-Settings`；原生桥 `window.QTV` + `window.LJJTV` 双通道。
- 仓库迁至 <https://github.com/HapyRain/QTV>，GitHub Actions 产出 Android APK 与 iOS 未签名 IPA。

## 2026-11-13 · 双端与移动端重构（前序）

- 完整前端纳入仓库（`web/` Next.js + `app/` Kotlin），跨平台构建脚本一条命令同步双端资产。
- 移动端 UI 重构：底部三栏导航、播放器吸顶 + 工作台、底部 Sheet、50 集分段、继续观看、流式检索进度；直播页播放器吸顶 + 频道/EPG 工作台。
- 播放器：手势轴互斥（阈值 12px / 比值 1.3）、亮度/音量 HUD、全屏原生桥、iOS 原生 HLS 分支；下载走原生保存桥分片落盘。
- 版本号统一 `1.0`，页面滚动条在 CSS 与 WebView 两侧同时关闭。

## 下一阶段

### 桌面端

- [ ] macOS / Linux 构建与打包（同一套 Electron 代码，补 `electron-builder` mac/linux target 与平台签名说明）。
- [ ] 桌面端快捷键完整对齐（播放/暂停、快进快退、音量、全屏已支持；跨页快捷键表在设置里展示）。
- [ ] 自动更新（`electron-updater` + GitHub Releases）。
- [ ] 托盘「开机自启」与「迷你窗吸附」。
- [ ] 桌面端组件测试（本地 API 契约用 Node 单测固化，避免再次出现前后端字段漂移）。

### 移动端继续打磨

- [ ] **架构分层**：`features/<domain>`（搜索/详情/播放/直播/设置）+ `shared/`（UI 原子组件、hooks、api client、store），`lib/` 纯逻辑迁入 `shared/` 并保留单测。
- [ ] **设计系统**：令牌 → 基础组件（按钮/输入/卡片/Sheet/Dialog/Toast/骨架）→ 页面，沉淀可复用原子组件。
- [ ] **播放器解耦**：抽成独立 feature（引擎无关：hls.js / 原生 `<video>`），控制条自绘，手势与 HUD 作为可复用模块。
- [ ] **数据层**：统一 query/mutation（超时、重试、取消、错误归一化），替换页面内零散 fetch。
- [ ] **测试**：组件测试（交互/可访问性）+ 关键流程 E2E（搜索 → 详情 → 播放）。
- [ ] **构建**：`scripts/build-web.mjs` 的构建期手术改为显式构建模式（`NEXT_OUTPUT=export` + 环境开关），减少源码字符串替换。
- [ ] release 签名与 CI 发布（APK 正式签名 / IPA 自签说明）。
