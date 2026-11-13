'use client';

import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/lib/store';
import {
  SEGMENT_COLORS,
  SEGMENT_LABELS,
  validateSegment,
  type SkipSegment,
  type SkipSegmentType,
} from '@/lib/skip-marks';
import { cn, formatTime } from '@/lib/utils';
import { useToast } from './toast';
import { Drawer } from './drawer';
import { Icon } from './icon';

interface PlayerClock {
  currentTime: number;
  duration: number;
  seek(seconds: number): void;
  pause(): void;
  isPaused(): boolean;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

export function SkipMarkPanel({
  open,
  onClose,
  markKey,
  pendingStart,
  onPendingStart,
  getPlayerClock,
  mobileMaxHeight,
  inline = false,
}: {
  open: boolean;
  onClose: () => void;
  markKey: string;
  pendingStart: number | null;
  onPendingStart: (start: number | null) => void;
  getPlayerClock: () => PlayerClock | null;
  mobileMaxHeight?: number;
  /** 内嵌在播放页下方工作台时直接渲染面板内容，不弹抽屉遮挡视频 */
  inline?: boolean;
}) {
  const mark = useAppStore((s) => s.skipMarks[markKey]);
  const setSkipMark = useAppStore((s) => s.setSkipMark);
  const setSkipMarkEnabled = useAppStore((s) => s.setSkipMarkEnabled);
  const autoSkipSegments = useAppStore((s) => s.autoSkipSegments);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const { toast } = useToast();

  const segments = (mark?.segments ?? []).slice().sort((a, b) => a.start - b.start);
  const enabled = mark ? mark.enabled !== false : false;

  const clockFnRef = useRef(getPlayerClock);
  clockFnRef.current = getPlayerClock;
  const [clock, setClock] = useState({ current: 0, duration: 0, paused: true });

  const isActive = inline || open;

  useEffect(() => {
    if (!isActive) return;
    const tick = () => {
      const c = clockFnRef.current();
      setClock({
        current: c?.currentTime ?? 0,
        duration: c?.duration ?? 0,
        paused: c ? c.isPaused() : true,
      });
    };
    tick();
    const timer = setInterval(tick, 800);
    return () => clearInterval(timer);
  }, [isActive]);

  const write = (next: SkipSegment[]) => setSkipMark(markKey, next);

  const pauseAndSnap = (): { t: number; duration: number } | null => {
    const c = getPlayerClock();
    if (!c) {
      toast('播放器尚未就绪，请稍后再试', 'warning');
      return null;
    }
    if (!c.isPaused()) c.pause();
    setClock({ current: c.currentTime, duration: c.duration, paused: true });
    return { t: round1(c.currentTime), duration: c.duration };
  };

  const tryRecord = (segment: SkipSegment, label: string, duration: number): boolean => {
    const error = validateSegment(segment, duration, segments);
    if (error) {
      toast(error, 'error');
      return false;
    }
    write([...segments, segment]);
    const effect = autoSkipSegments
      ? segment.type === 'ending'
        ? '，越过起点后自动结束本集'
        : '，命中时将自动跳过'
      : segment.type === 'ending'
        ? '，命中时显示「跳过片尾」按钮'
        : '，命中时显示跳过按钮';
    const at =
      segment.type === 'ending'
        ? formatTime(segment.start)
        : segment.type === 'middle'
          ? `${formatTime(segment.start)} → ${formatTime(segment.end)}`
          : formatTime(segment.end);
    toast(`已记录${label} ${at}${effect}`, 'success');
    return true;
  };

  const recordAt = (type: 'opening' | 'ending') => {
    const snap = pauseAndSnap();
    if (!snap) return;
    if (snap.t <= 0) {
      toast(type === 'opening' ? '请先播放到片头结束的位置' : '请先播放到片尾开始的位置', 'warning');
      return;
    }
    if (type === 'opening') tryRecord({ type, start: 0, end: snap.t }, '片头结束', snap.duration);
    else tryRecord({ type, start: snap.t, end: -1 }, '片尾开始', snap.duration);
  };

  const markMiddleStart = () => {
    const snap = pauseAndSnap();
    if (!snap) return;
    if (snap.t <= 0) {
      toast('请先播放到片段起点', 'warning');
      return;
    }
    onPendingStart(snap.t);
    toast(`已暂停并记录起点 ${formatTime(snap.t)}，继续播放到终点后点「标记中段终点」`, 'info');
  };

  const markMiddleEnd = () => {
    if (pendingStart === null) return;
    const snap = pauseAndSnap();
    if (!snap) return;
    if (snap.t <= pendingStart) {
      toast('终点需晚于起点', 'warning');
      return;
    }
    if (tryRecord({ type: 'middle', start: pendingStart, end: snap.t }, '中段片段', snap.duration)) {
      onPendingStart(null);
    }
  };

  const remove = (index: number) => {
    const seg = segments[index];
    if (!seg) return;
    const wasDisabled = mark?.enabled === false;
    write(segments.filter((_, i) => i !== index));
    toast(`已删除${SEGMENT_LABELS[seg.type]}片段`, 'info', {
      action: {
        label: '撤销',
        onClick: () => {
          setSkipMark(markKey, segments);
          if (wasDisabled) setSkipMarkEnabled(markKey, false);
        },
      },
    });
  };

  const nudge = (index: number, delta: number) => {
    const seg = segments[index];
    if (!seg) return;
    const changed: SkipSegment =
      seg.type === 'ending'
        ? { ...seg, start: round1(seg.start + delta) }
        : seg.type === 'opening'
          ? { ...seg, end: round1(seg.end + delta) }
          : { ...seg, start: round1(seg.start + delta), end: round1(seg.end + delta) };
    const clockNow = getPlayerClock();
    const others = segments.filter((_, i) => i !== index);
    const error = validateSegment(changed, clockNow?.duration ?? 0, others);
    if (error) {
      toast(error, 'error');
      return;
    }
    write(segments.map((s, i) => (i === index ? changed : s)));
  };

  const jump = (seg: SkipSegment, to: 'start' | 'end') => {
    const c = getPlayerClock();
    if (!c) {
      toast('播放器尚未就绪，请稍后再试', 'warning');
      return;
    }
    c.pause();
    c.seek(to === 'start' ? seg.start : Math.max(0, seg.end - 1));
    setClock({ current: to === 'start' ? seg.start : Math.max(0, seg.end - 1), duration: c.duration, paused: true });
  };

  const currentKey = segments.find((s) => {
    if (clock.current < s.start) return false;
    if (s.type === 'ending') return true;
    return clock.current < s.end;
  });

  const actionControls = (
    <div className="rounded-xl bg-chip/60 border border-line/60 p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-[11px] font-medium text-muted">
          一键打点（点击会自动暂停在当前画面）
        </span>
        <span className="text-xs font-mono tabular-nums text-accent font-semibold">
          {formatTime(clock.current)} <span className="text-faint font-normal">/ {formatTime(clock.duration)}</span>
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <button
          type="button"
          className="btn-ghost btn-sm justify-center py-2 text-xs font-medium border border-line/80 bg-card/80"
          onClick={() => recordAt('opening')}
        >
          记为片头结束
        </button>
        <button
          type="button"
          className="btn-ghost btn-sm justify-center py-2 text-xs font-medium border border-line/80 bg-card/80"
          onClick={() => recordAt('ending')}
        >
          记为片尾开始
        </button>
        {pendingStart === null ? (
          <button
            type="button"
            className="col-span-2 sm:col-span-1 btn-ghost btn-sm justify-center py-2 text-xs font-medium border border-line/80 bg-card/80"
            onClick={markMiddleStart}
          >
            标记中段广告起点
          </button>
        ) : (
          <div className="col-span-2 sm:col-span-1 flex items-center gap-1.5">
            <button
              type="button"
              className="flex-1 btn-primary btn-sm justify-center py-2 text-xs"
              onClick={markMiddleEnd}
            >
              记中段终点 ({formatTime(pendingStart)}起)
            </button>
            <button
              type="button"
              className="btn-ghost btn-sm py-2 px-2.5 text-xs"
              onClick={() => onPendingStart(null)}
            >
              取消
            </button>
          </div>
        )}
      </div>
    </div>
  );

  const bodyContent = (
    <div className="space-y-3">
      {inline && actionControls}

      <div className="flex items-center justify-between gap-2 px-1">
        <p className="text-xs text-muted">
          本剧已标记 <span className="text-content font-semibold tabular-nums">{segments.length}</span> 段 · 同剧各集自动套用
        </p>
        <div className="flex items-center gap-3">
          <label
            className={cn(
              'flex shrink-0 items-center gap-1.5 text-xs',
              mark ? 'cursor-pointer text-muted hover:text-content' : 'cursor-not-allowed text-faint'
            )}
          >
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-accent"
              checked={enabled}
              disabled={!mark}
              onChange={(e) => setSkipMarkEnabled(markKey, e.target.checked)}
            />
            本剧生效
          </label>
          <label className="flex shrink-0 items-center gap-1.5 text-xs cursor-pointer text-muted hover:text-content">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-accent"
              checked={autoSkipSegments}
              onChange={(e) => updateSettings({ autoSkipSegments: e.target.checked })}
            />
            自动跳过
          </label>
        </div>
      </div>

      {segments.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line/70 bg-card/30 px-4 py-5 text-center">
          <p className="text-xs text-muted leading-relaxed">
            尚未标记跳过片段。当视频播放到片头曲结束或片尾曲开始时，轻点上方按钮即可一键记录，本剧所有集数都会自动跳过。
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {segments.map((seg, i) => {
            const isCurrent = currentKey === seg;
            const sameTypeCount = segments.filter((s) => s.type === seg.type).length;
            const label =
              seg.type === 'middle' && sameTypeCount > 1
                ? `${SEGMENT_LABELS.middle}${segments.slice(0, i).filter((s) => s.type === 'middle').length + 1}`
                : SEGMENT_LABELS[seg.type];
            return (
              <li
                key={`${seg.type}:${seg.start}`}
                className={cn(
                  'relative rounded-xl border bg-card/60 px-3 py-2.5 pr-9 transition-colors',
                  isCurrent ? 'border-accent/60 bg-accent/5' : 'border-line/70'
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2 text-xs">
                    <span
                      aria-hidden
                      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: SEGMENT_COLORS[seg.type] }}
                    />
                    <span className="font-medium text-content">{label}</span>
                    <span className="font-mono tabular-nums text-muted">
                      {formatTime(seg.start)} → {seg.type === 'ending' ? '片尾结束' : formatTime(seg.end)}
                    </span>
                  </span>
                  {isCurrent && (
                    <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent font-medium">
                      当前命中
                    </span>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    className="btn-ghost btn-sm text-[11px] px-2.5 py-1"
                    onClick={() => jump(seg, 'start')}
                  >
                    预览起点
                  </button>
                  {seg.type !== 'ending' && (
                    <button
                      type="button"
                      className="btn-ghost btn-sm text-[11px] px-2.5 py-1"
                      onClick={() => jump(seg, 'end')}
                    >
                      预览终点
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-ghost btn-sm text-[11px] px-2.5 py-1 tabular-nums"
                    onClick={() => nudge(i, -1)}
                  >
                    提前 1s
                  </button>
                  <button
                    type="button"
                    className="btn-ghost btn-sm text-[11px] px-2.5 py-1 tabular-nums"
                    onClick={() => nudge(i, 1)}
                  >
                    推后 1s
                  </button>
                </div>
                <button
                  type="button"
                  className="absolute right-1.5 top-1.5 rounded-lg p-1.5 text-muted transition-colors hover:bg-hover hover:text-danger"
                  aria-label={`删除${label}片段`}
                  onClick={() => remove(i)}
                >
                  <Icon name="close" className="h-4 w-4" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );

  if (inline) {
    return bodyContent;
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="片头片尾跳过标记"
      width="max-w-sm lg:max-w-[20rem]"
      modal={false}
      mobileSheet
      panelStyle={mobileMaxHeight ? { maxHeight: mobileMaxHeight } : undefined}
      footer={actionControls}
    >
      {bodyContent}
    </Drawer>
  );
}
