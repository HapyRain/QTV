'use client';

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/utils';
import { Icon } from './icon';
import { useDesktopShell } from '@/lib/desktop';

const EXIT_MS = 180;
// 移动端底部面板退场/拖拽滑出时长，取自移动端原版
const EXIT_MS_SHEET = 220;
const DRAG_CLOSE_PX = 64;

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Drawer({
  open,
  onClose,
  title,
  children,
  width = 'max-w-md',
  subheader,
  footer,
  closeOnOverlay = true,
  resetScrollKey,
  modal = true,
  mobileSheet = false,
  mobileFull = false,
  panelStyle,
  inline = false,
  header = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: string;
  subheader?: ReactNode;
  footer?: ReactNode;
  panelStyle?: CSSProperties;
  closeOnOverlay?: boolean;
  resetScrollKey?: string;
  modal?: boolean;
  mobileSheet?: boolean;
  mobileFull?: boolean;
  /** 桌面整页模式：不进 portal、不做焦点陷阱，直接作为页面里的卡片渲染 */
  inline?: boolean;
  /** 整页模式下是否显示自带标题栏（页面已有 h1 时传 false） */
  header?: boolean;
}) {
  const [mounted, setMounted] = useState(open);
  const [entered, setEntered] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  // 首帧恒为 false，与静态导出的移动端形态一致
  const desktop = useDesktopShell();
  const exitMs = desktop ? EXIT_MS : EXIT_MS_SHEET;

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [resetScrollKey]);

  useEffect(() => {
    if (open) {
      if (modal) restoreFocusRef.current = document.activeElement as HTMLElement | null;
      setMounted(true);
      const raf = requestAnimationFrame(() => requestAnimationFrame(() => setEntered(true)));
      return () => cancelAnimationFrame(raf);
    }
    setEntered(false);
    const timer = setTimeout(() => {
      setMounted(false);
      restoreFocusRef.current?.focus?.();
      restoreFocusRef.current = null;
    }, exitMs);
    return () => clearTimeout(timer);
  }, [open, modal, exitMs]);

  // 移动端底部面板盖住整屏时锁背景滚动；桌面居中弹窗不锁（与原桌面形态一致）
  useEffect(() => {
    if (!mounted || !modal || desktop) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mounted, modal, desktop]);

  useEffect(() => {
    if (!mounted) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (document.querySelector('[role="alertdialog"]')) return;
        // 移动端非模态面板只在自身持有焦点时才吃掉 Esc
        if (!desktop && !modal && !panelRef.current?.contains(document.activeElement)) return;
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !modal) return;
      const panel = panelRef.current;
      if (!panel) return;
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getClientRects().length > 0 || el === document.activeElement
      );
      if (nodes.length === 0) {
        // 移动端原版：无可聚焦项时把焦点收到面板本身，Tab 才不会跑出面板
        if (!desktop) {
          e.preventDefault();
          panel.focus();
        }
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [mounted, onClose, modal, desktop]);

  const dragState = useRef<{ id: number; startY: number; dy: number } | null>(null);
  const beginDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragState.current = { id: e.pointerId, startY: e.clientY, dy: 0 };
    if (panelRef.current) panelRef.current.style.transition = 'none';
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* 忽略 */
    }
  };
  const moveDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragState.current;
    const panel = panelRef.current;
    if (!drag || !panel || e.pointerId !== drag.id) return;
    drag.dy = Math.max(0, e.clientY - drag.startY);
    panel.style.transform = `translateY(${drag.dy}px)`;
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragState.current;
    const panel = panelRef.current;
    dragState.current = null;
    if (!drag || !panel) return;
    panel.style.transition = '';
    if (e.type === 'pointercancel' || drag.dy <= DRAG_CLOSE_PX) {
      panel.style.transform = '';
      return;
    }
    panel.style.transform = 'translateY(100%)';
    window.setTimeout(() => {
      if (panelRef.current) panelRef.current.style.transform = '';
      onClose();
    }, EXIT_MS_SHEET);
  };

  if (inline) {
    return (
      <div className={cn('desk-card desk-inline-panel flex flex-col overflow-hidden w-full')}>
        {header && (
          <div className="shrink-0 px-6 py-4 border-b border-line/60 flex items-center justify-between">
            <h2 className="text-base font-semibold tracking-tight text-content">{title}</h2>
          </div>
        )}
        {subheader && <div className="shrink-0 px-6 py-3 border-b border-line/60">{subheader}</div>}
        <div className="px-6 py-4">{children}</div>
        {footer && <div className="shrink-0 border-t border-line/60 px-6 py-3.5">{footer}</div>}
      </div>
    );
  }

  if (!mounted) return null;

  if (!desktop) {
    // 原版移动端默认就是 90dvh 全屏面板，mobileFull 保留只为接口兼容
    void mobileFull;
    return (
      <div className={cn('fixed inset-0 z-[70]', !modal && 'pointer-events-none')}>
        {modal && (
          <div
            className={cn(
              'absolute inset-0 bg-black/72 backdrop-blur-[2px] transition-opacity duration-200',
              entered ? 'opacity-100' : 'opacity-0'
            )}
            onClick={closeOnOverlay ? onClose : undefined}
            aria-hidden
          />
        )}
        <div
          ref={panelRef}
          role="dialog"
          aria-modal={modal || undefined}
          aria-label={title}
          tabIndex={-1}
          className={cn(
            'absolute inset-x-0 bottom-0 w-full mx-auto bg-surface-raised border-t border-line/80 flex flex-col outline-none safe-x',
            'rounded-t-[24px] shadow-[0_-12px_48px_rgba(0,0,0,0.65)] pb-[env(safe-area-inset-bottom)]',
            'transition-transform duration-250 ease-[cubic-bezier(0.22,1,0.36,1)]',
            width === 'max-w-md' ? 'sm:max-w-2xl' : width,
            !modal && 'pointer-events-auto',
            mobileSheet ? 'max-h-[64dvh]' : 'h-[90dvh] max-h-[90dvh]',
            entered ? 'translate-y-0' : 'translate-y-full'
          )}
          style={panelStyle}
        >
          {/* 顶部拖拽把手：向下拖过 64px 松手即关闭，否则回弹 */}
          <div
            className="flex shrink-0 flex-col items-center pt-2.5 pb-1 touch-none select-none cursor-grab active:cursor-grabbing"
            onPointerDown={beginDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <span className="h-1.5 w-11 rounded-full bg-line/90" />
          </div>
          <div className="shrink-0 px-4 py-2.5 border-b border-line/60 flex items-center justify-between">
            <h2 className="text-base font-bold tracking-tight text-content">{title}</h2>
            <button
              className="pressable p-1.5 rounded-full bg-chip text-muted hover:text-content transition-colors"
              onClick={onClose}
              aria-label="关闭"
            >
              <Icon name="close" className="w-4 h-4" />
            </button>
          </div>
          {subheader && <div className="shrink-0 px-4 py-2.5 border-b border-line/60 bg-surface-raised">{subheader}</div>}
          <div
            ref={contentRef}
            className="flex-1 min-h-0 overflow-y-auto overscroll-contain scrollbar-thin px-4 pt-3.5 pb-6"
          >
            {children}
          </div>
          {footer && <div className="shrink-0 border-t border-line/60 bg-surface-raised px-4 py-3">{footer}</div>}
        </div>
      </div>
    );
  }

  const resolvedWidth = width === 'max-w-md' || width === 'max-w-lg' ? 'max-w-2xl' : width;

  return (
    <div className={cn('fixed inset-0 z-[70] flex items-center justify-center p-6', !modal && 'pointer-events-none')}>
      {modal && (
        <div
          className={cn(
            'absolute inset-0 bg-black/65 backdrop-blur-sm transition-opacity duration-150',
            entered ? 'opacity-100' : 'opacity-0'
          )}
          onClick={closeOnOverlay ? onClose : undefined}
          aria-hidden
        />
      )}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal={modal || undefined}
        aria-label={title}
        tabIndex={-1}
        className={cn(
          'relative w-full acrylic-modal border border-line/80 rounded-2xl flex flex-col outline-none overflow-hidden',
          'h-[76vh] max-h-[760px] transition-all duration-200 ease-out',
          resolvedWidth,
          !modal && 'pointer-events-auto',
          entered ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 translate-y-2'
        )}
        style={panelStyle}
      >
        <div className="shrink-0 px-6 py-4 border-b border-line/60 flex items-center justify-between">
          <h2 className="text-base font-semibold tracking-tight text-content">{title}</h2>
          <div className="flex items-center gap-2">
            <span className="kbd-cap">ESC</span>
            <button
              type="button"
              className="p-1.5 rounded-lg bg-chip text-muted hover:text-content hover:bg-hover transition-colors"
              onClick={onClose}
              aria-label="关闭"
            >
              <Icon name="close" className="w-4 h-4" />
            </button>
          </div>
        </div>
        {subheader && <div className="shrink-0 px-6 py-3 border-b border-line/60 bg-surface/50">{subheader}</div>}
        <div ref={contentRef} className="flex-1 min-h-0 desktop-scroll px-6 py-4">
          {children}
        </div>
        {footer && <div className="shrink-0 border-t border-line/60 bg-surface/60 px-6 py-3.5">{footer}</div>}
      </div>
    </div>
  );
}
