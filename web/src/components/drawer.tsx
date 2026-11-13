'use client';

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from './icon';

/**
 * 移动端原生感物理阻尼底部面板（BottomSheet / Drawer）：
 * - 在移动设备上统一表现为自底向上弹出的圆角面板（带顶部拖拽胶囊把手 + 物理跟手拖拽关闭）；
 * - 支持全屏高（mobileFull，92dvh）与半屏高（mobileSheet，62dvh），默认在手机上也采用 90dvh 底部圆角卡片形态，
 *   彻底告别桌面端从右侧直愣愣滑出的生硬侧边栏；
 * - 打开期间锁定背景滚动，支持按住顶部区域向下拖拽跟手关闭（位移 > 64px 松手滑出，否则弹簧回弹）。
 */

const EXIT_MS = 220;
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
}) {
  const [mounted, setMounted] = useState(open);
  const [entered, setEntered] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

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
    }, EXIT_MS);
    return () => clearTimeout(timer);
  }, [open, modal]);

  useEffect(() => {
    if (!mounted || !modal) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mounted, modal]);

  useEffect(() => {
    if (!mounted) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (document.querySelector('[role="alertdialog"]')) return;
        if (!modal && !panelRef.current?.contains(document.activeElement)) return;
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
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !panel.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !panel.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [mounted, onClose, modal]);

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
    }, EXIT_MS);
  };

  if (!mounted) return null;

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
        {/* 顶部物理拖拽把手区域 */}
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
