'use client';

import { useEffect, useState } from 'react';

/**
 * 运行环境判定：当前页面是否跑在 Windows 桌面壳（Electron）里。
 *
 * 桌面前端与移动端共用同一套 `web/` 源码，靠这里区分：
 * - Electron 的 preload 会注入 `window.QTVDesktop`（见 windows/preload.cjs）；
 * - 静态导出的 HTML / 移动端 WebView 里没有该对象，一律按移动端处理。
 */
export function isDesktopShell(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as { QTVDesktop?: { isDesktop?: boolean } };
  if (w.QTVDesktop?.isDesktop) return true;
  return /Electron/i.test(navigator.userAgent || '');
}

/**
 * 给 <html> 打上 `qtv-desktop` 标记：桌面专属样式都挂在它下面，移动端不受影响。
 *
 * 刻意「只加不删」：多个组件都会调用它，运行期间只会从移动形态切到桌面形态，
 * 一旦某个页面的组件卸载就 remove，会导致桌面样式在其他页面整体失效。
 */
export function markDesktopShell(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.add('qtv-desktop');
}

/**
 * 让桌面壳把窗口切到系统全屏（Electron `BrowserWindow.setFullScreen`）。
 * 桌面端不用 HTML 全屏 API：Electron 无边框窗口下 `requestFullscreen()` 不生效，
 * 播放器改用 ArtPlayer 的「网页全屏」铺满视口，再由这里把窗口本身也切成全屏。
 */
export function setDesktopWindowFullscreen(fullscreen: boolean): void {
  const w = window as unknown as {
    QTVDesktop?: { setFullscreen?: (flag: boolean) => Promise<boolean> | void };
  };
  try {
    void w.QTVDesktop?.setFullscreen?.(fullscreen);
  } catch {
    /* 桥不可用（浏览器）时忽略：网页全屏本身已经生效 */
  }
}

/**
 * 组件里用这个 hook 判断桌面形态：首帧恒为 false（与静态导出 HTML 一致，避免 hydration 不匹配），
 * 挂载后再切换。桌面形态同时会给 <html> 加 `qtv-desktop`。
 */
export function useDesktopShell(): boolean {
  return useDesktopMode() === 'desktop';
}

export type DesktopMode = 'pending' | 'mobile' | 'desktop';

/**
 * 三态版本：`pending` 表示「还没在客户端判定过环境」。
 *
 * 页面级组件（尤其是会挂播放器的 /watch、/live）用它在 pending 时先渲染占位，
 * 否则桌面壳会先按移动端布局挂载一次播放器、判定完成后再重挂一次，
 * 导致重复拉流。首帧仍是移动端与桌面端一致的空壳，所以不会 hydration 不匹配。
 */
export function useDesktopMode(): DesktopMode {
  const [mode, setMode] = useState<DesktopMode>('pending');

  useEffect(() => {
    if (isDesktopShell()) {
      markDesktopShell();
      setMode('desktop');
    } else {
      setMode('mobile');
    }
  }, []);

  return mode;
}
