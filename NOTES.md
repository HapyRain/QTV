# 迭代记录与后续计划

## 2026-11-13 · QTV 品牌升级（当前）

- **更名与形象**：项目由 LJJTV 更名为 **QTV**。全平台 Logo 资产重制——Android 48–192px 圆角/圆形桌面图标 + Android 8.0+ 自适应图标（`mipmap-anydpi-v26` + `drawable-nodpi/ic_launcher_foreground.png`，`#06080C` 底色）、iOS 1024px 无透明通道 AppIcon、Web 全套 `icon-*` / `favicon` / `apple-touch-icon` 与 16:9 播放器待机海报。
- **工程更名**：Gradle 工程 `qtv-android`，iOS 工程 `ios/QTV.xcodeproj`（共享 Scheme `QTV`，target/product `QTV`），桌面显示名统一为 `QTV`。
- **文案与 SEO**：`layout.tsx` / `manifest.ts` / 离线页 / 探索页 / 我的页 / 关于弹窗 / 页脚全部换成 QTV；离线页重写为移动端深色重连页；`themeColor` 统一 `#06080c`。
- **导入导出**：导出前缀 `QTV-SourceList_` / `QTV-Backup_`，备份格式名 `QTV-Settings`；导入向下兼容旧版 `LibreTV-Settings` / `LibreTV-SourceList`。
- **兼容别名**：原生桥双通道 `window.QTV`（主）+ `window.LJJTV`（旧）；深链 `qtv://` + `ljjtv://`；返回键钩子 `__qtvCloseOverlay` + `__ljjtvCloseOverlay`。包名 / Bundle ID 为 `org.qtv.app`。
- **仓库**：迁至 <https://github.com/HapyRain/QTV>，CI（GitHub Actions）一次产出 Android APK 与 iOS 未签名 IPA。

## 2026-11-13 · 双端与移动端重构（前序）

- 完整前端纳入仓库（`web/` Next.js + `app/` Kotlin），新增跨平台构建脚本，一条命令同步双端资产。
- 移动端 UI 重构：底部三栏导航（探索 / 直播 / 我的）、播放器吸顶 + 工作台、详情与设置改底部 Sheet、50 集分段、继续观看画廊、流式检索进度。
- 直播页重做：播放器吸顶 + 下方频道/EPG 工作台，移除 FAB 抽屉选台。
- 删除桌面/服务端残留：PWA 安装横幅、二维码、密码登录、键盘快捷键、Docker 相关文档与文案。
- 播放器：手势轴互斥（阈值 12px / 比值 1.3）、亮度/音量 HUD、全屏原生桥、iOS 原生 HLS 分支（MSE 不可用走 AVPlayer）。
- 下载：App 壳走原生保存桥分块流式落盘，不再走文件选择器；修复「点击下载立即提示已取消」。
- 版本号统一 `1.0`，原生接口版本读 `BuildConfig.VERSION_NAME`（Android）/ `CFBundleShortVersionString`（iOS）；页面滚动条在 CSS 与 WebView 两侧同时关闭。

## 下一阶段

### 桌面端（重点，尚未提交）

- 目标：Windows / macOS / Linux 桌面应用，复用同一套 `web/` 前端。
- 方向：Tauri（体积小、复用现有 Web 技术栈）或 Electron；本地 API 层按平台各写一份，接口契约与移动端一致。
- 桌面专属能力：系统文件选择器保存、窗口全屏/迷你播放、快捷键、托盘与开机自启。

### 移动端继续打磨

- [ ] **架构分层**：`features/<domain>`（搜索/详情/播放/直播/设置）+ `shared/`（UI 原子组件、hooks、api client、store），`lib/` 纯逻辑迁入 `shared/` 并保留单测。
- [ ] **设计系统**：令牌 → 基础组件（按钮/输入/卡片/Sheet/Dialog/Toast/骨架）→ 页面，沉淀可复用原子组件。
- [ ] **播放器解耦**：抽成独立 feature（引擎无关：hls.js / 原生 `<video>`），控制条自绘，手势与 HUD 作为可复用模块。
- [ ] **数据层**：统一 query/mutation（超时、重试、取消、错误归一化），替换页面内零散 fetch。
- [ ] **状态管理**：按 feature 拆分 store，降低全局 store 跨页耦合。
- [ ] **测试**：组件测试（交互/可访问性）+ 关键流程 E2E（搜索 → 详情 → 播放）。
- [ ] **构建**：`scripts/build-web.mjs` 的构建期手术改为显式构建模式（`NEXT_OUTPUT=export` + 环境开关），减少源码字符串替换。
- [ ] release 签名与 CI 发布（APK 正式签名 / IPA 自签说明）。
