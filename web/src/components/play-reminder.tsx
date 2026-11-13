'use client';

import { useEffect, useRef, useState } from 'react';
import { addPlaytime } from '@/lib/playtime-reminder';

/**
 * 播放休息提醒（升级为顶部灵动岛流体胶囊 Dynamic Island Pill）：
 * - 每连续播放满 45 分钟，自屏幕顶部安全区下方弹性展开流体毛玻璃胶囊：
 *   「已经连续看了 45 分钟啦，起来活动一下、喝口水吧」
 * - 支持手指按住向上轻推收起，或 6 秒后自动丝滑消散；
 * - 即使在看剧或浏览期间也极具原生 iOS/Android 灵动胶囊质感。
 */

type Phase = 'in' | 'shown' | 'out';

export function PlayReminder() {
  const [message, setMessage] = useState<string | null>(null);
  const [minuteMark, setMinuteMark] = useState<number>(45);
  const [phase, setPhase] = useState<Phase>('in');
  const [dragY, setDragY] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragStartRef = useRef<number | null>(null);

  const dismiss = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setPhase('out');
    window.setTimeout(() => {
      setMessage(null);
      setPhase('in');
      setDragY(0);
    }, 380);
  };

  useEffect(() => {
    let last = Date.now();
    const id = window.setInterval(() => {
      const now = Date.now();
      const delta = (now - last) / 1000;
      last = now;
      const video = document.querySelector('video');
      const playing = !!video && !video.paused && !video.ended;
      if (!playing) return;
      const minute = addPlaytime(Math.min(delta, 6));
      if (minute != null && !message) {
        setMinuteMark(minute);
        setMessage(`已经连续看了 ${minute} 分钟啦，起来活动一下、喝口水吧`);
        setPhase('in');
      }
    }, 2000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!message || phase !== 'in') return;
    const enter = window.setTimeout(() => setPhase('shown'), 380);
    const auto = window.setTimeout(() => dismiss(), 6_000 + 380);
    return () => {
      window.clearTimeout(enter);
      window.clearTimeout(auto);
    };
  }, [message, phase]);

  if (!message) return null;

  const onPointerDown = (e: React.PointerEvent) => {
    dragStartRef.current = e.clientY;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch {
      /* 忽略 */
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragStartRef.current == null) return;
    const dy = e.clientY - dragStartRef.current;
    if (dy < 0) setDragY(dy);
  };
  const onPointerUp = () => {
    const dy = dragY;
    dragStartRef.current = null;
    if (dy < -36) {
      setDragY(dy - 80);
      dismiss();
    } else {
      setDragY(0);
    }
  };

  return (
    <div className="fixed top-[calc(0.65rem_+_env(safe-area-inset-top))] inset-x-3 z-[120] flex justify-center pointer-events-none">
      <div
        role="status"
        aria-live="polite"
        className={[
          'pointer-events-auto select-none touch-none cursor-grab active:cursor-grabbing',
          'flex items-center gap-3 rounded-full border border-accent/35 bg-[#0b1018]/92 backdrop-blur-2xl',
          'pl-3 pr-4 py-2.5 shadow-[0_14px_44px_rgba(0,0,0,0.65),0_0_24px_rgba(56,189,248,0.18)]',
          'max-w-md w-auto',
          phase === 'in' ? 'island-in' : '',
          phase === 'out' ? 'island-out' : '',
        ].join(' ')}
        style={{
          transform: dragY !== 0 ? `translateY(${dragY}px)` : phase === 'out' ? undefined : 'translateY(0)',
          transition: dragStartRef.current == null ? 'transform .24s cubic-bezier(.22,1,.36,1)' : 'none',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={dismiss}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-sky-400/25 to-indigo-500/25 text-accent ring-1 ring-accent/30">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z"
            />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-semibold tracking-wide text-accent">贴心提醒 · {minuteMark} 分钟</span>
          </div>
          <p className="text-xs font-medium text-white/95 leading-snug">{message}</p>
        </div>
      </div>
    </div>
  );
}
