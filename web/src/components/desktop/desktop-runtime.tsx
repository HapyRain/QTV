'use client';

import { useDesktopShell } from '@/lib/desktop';

/**
 * 桌面壳运行时：唯一职责是把 `qtv-desktop` 标记挂到 <html>（卸载时清掉），本身不渲染任何东西。
 *
 * 为什么放在 layout 而不是页面里：页面组件每次路由切换都会重挂，标记却必须覆盖整个应用生命周期
 * （桌面标题栏/左栏在 /live、/watch 等每一页都存在），只有 layout 的挂载周期与之匹配。
 * 桌面判定复用 useDesktopShell，保证「首帧 false」这一条 hydration 规则只有一处实现。
 */
export function DesktopRuntime() {
  useDesktopShell();
  return null;
}
