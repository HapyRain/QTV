'use client';

import { useEffect } from 'react';

/**
 * 返回键闭环的前端一半（plan：返回要"先关浮层 → 再退页 → 最后双击退出"）。
 *
 * Android 实体返回键由原生层接管：先问本组件「有没有浮层可关」，有则消费这次返回，
 * 没有才走「WebView 历史后退 / 根页双击退出」。
 *
 * 判定口径：DOM 里存在 role="dialog"（详情弹窗/抽屉/确认框/登录框/换源面板……）
 * 就认为有浮层开着，并派发 Escape 让它关闭——这些浮层全都已监听 Escape（逐一核对过）。
 * 个别浮层即使没关掉，本次返回也只是被消费（再按一次即可），不会误退出 App。
 */
export function BackGuard() {
  useEffect(() => {
    const closeOverlay = () => {
      try {
        const hasOverlay = !!document.querySelector('[role="dialog"], [aria-modal="true"]');
        if (!hasOverlay) return false;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return true;
      } catch {
        return false;
      }
    };
    // 原生宿主读这两个钩子（QTV 为主，LJJTV 兼容旧宿主）
    const w = window as unknown as { __qtvCloseOverlay?: () => boolean; __ljjtvCloseOverlay?: () => boolean };
    w.__qtvCloseOverlay = closeOverlay;
    w.__ljjtvCloseOverlay = closeOverlay;
    return () => {
      delete w.__qtvCloseOverlay;
      delete w.__ljjtvCloseOverlay;
    };
  }, []);

  return null;
}
