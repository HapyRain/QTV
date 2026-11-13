'use client';

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '@/lib/utils';
import { SmartImage } from './smart-image';
import { Dropdown } from './dropdown';
import { useAppStore } from '@/lib/store';
import {
  isSlowSource,
  matchesAlive,
  matchesKeyword,
  normalizeForSearch,
  sortChannels,
  type AliveFilter,
  type LiveSortMode,
} from '@/lib/live-channel-filter';
import { useLiveProbe, type ProbeResult } from './use-live-probe';
import type { LiveChannel } from '@/lib/types';
import { EmptyState } from './states';

const SEARCH_DEBOUNCE_MS = 200;

function formatProbeProgress(p: { done: number; total: number; startedAt: number }): string {
  const base = `${p.done}/${p.total}`;
  const remaining = p.total - p.done;
  if (remaining <= 0) return base;
  if (p.done <= 0) return `${base} · 估算中…`;
  const remainMin = Math.ceil(((Date.now() - p.startedAt) / p.done) * remaining / 60000);
  return `${base} · 约剩 ${Math.max(1, remainMin)} 分钟`;
}

export interface LiveChannelItem extends LiveChannel {
  epg?: string;
  sourceUrl?: string;
}

interface ChannelListProps {
  channels: LiveChannelItem[];
  groups: string[];
  currentUrl: string;
  onSelect: (channel: LiveChannelItem) => void;
  onFilteredChange?: (list: LiveChannelItem[]) => void;
}

type View = 'all' | 'fav' | 'recent';

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function useChipStrip(itemCount: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [edges, setEdges] = useState({ left: false, right: false });
  const drag = useRef({ startX: 0, startLeft: 0, moved: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const left = el.scrollLeft > 4;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
      setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [itemCount]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const el = ref.current;
      if (!el) return;
      const dx = e.clientX - drag.current.startX;
      if (!drag.current.moved && Math.abs(dx) > 3) drag.current.moved = true;
      if (drag.current.moved) el.scrollLeft = drag.current.startLeft - dx;
    };
    const onUp = () => setDragging(false);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
    };
  }, [dragging]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    const el = ref.current;
    if (!el) return;
    drag.current = { startX: e.clientX, startLeft: el.scrollLeft, moved: false };
    setDragging(true);
  };

  const onClickCapture = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!drag.current.moved) return;
    drag.current.moved = false;
    e.preventDefault();
    e.stopPropagation();
  };

  return { ref, dragging, edges, onPointerDown, onClickCapture };
}

export function LiveChannelList({ channels, groups, currentUrl, onSelect, onFilteredChange }: ChannelListProps) {
  const liveFavorites = useAppStore((s) => s.liveFavorites);
  const liveRecent = useAppStore((s) => s.liveRecent);
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);

  const [view, setView] = useState<View>('all');
  const [group, setGroup] = useState<string>('');
  const [keyword, setKeyword] = useState('');
  const debouncedKeyword = useDebouncedValue(keyword, SEARCH_DEBOUNCE_MS);
  const [sortMode, setSortMode] = useState<LiveSortMode>('default');
  const [aliveFilter, setAliveFilter] = useState<AliveFilter>('off');
  const [cursor, setCursor] = useState(-1);
  const chipStrip = useChipStrip(groups.length);
  const listRef = useRef<HTMLDivElement>(null);
  const {
    results: probeResults,
    progress: probeProgress,
    probe,
    cancel: cancelProbe,
    clear: clearProbe,
    isProbing,
    hint: probeHint,
  } = useLiveProbe();

  const [, setProbeTick] = useState(0);
  useEffect(() => {
    if (!isProbing) return;
    const timer = setInterval(() => setProbeTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [isProbing]);

  const favSet = useMemo(() => new Set(liveFavorites), [liveFavorites]);
  const recentOrder = useMemo(() => new Map(liveRecent.map((r, i) => [r.url, i] as const)), [liveRecent]);
  const normalizedKeyword = useMemo(() => normalizeForSearch(debouncedKeyword.trim()), [debouncedKeyword]);

  const matched = useMemo(() => {
    let list: LiveChannelItem[];
    if (view === 'fav') {
      list = channels.filter((c) => favSet.has(c.url));
    } else if (view === 'recent') {
      list = liveRecent
        .map((r) => channels.find((c) => c.url === r.url))
        .filter((c): c is LiveChannelItem => Boolean(c));
    } else {
      list = channels;
    }
    if (view !== 'recent' && group) {
      list = list.filter((c) => c.group === group);
    }
    if (normalizedKeyword) {
      list = list.filter((c) => matchesKeyword(c, normalizedKeyword));
    }
    return sortChannels(list, sortMode, { recentOrder, probeOf: (url) => probeResults.get(url) });
  }, [channels, favSet, liveRecent, view, group, normalizedKeyword, sortMode, recentOrder, probeResults]);

  const filtered = useMemo(
    () =>
      aliveFilter === 'off'
        ? matched
        : matched.filter((c) => matchesAlive(probeResults.get(c.url), aliveFilter)),
    [matched, aliveFilter, probeResults]
  );

  useEffect(() => {
    onFilteredChange?.(filtered);
  }, [filtered, onFilteredChange]);

  const aliveCounts = useMemo(() => {
    let ok = 0;
    let green = 0;
    for (const c of matched) {
      const p = probeResults.get(c.url);
      if (!p?.ok) continue;
      ok++;
      if (matchesAlive(p, 'green')) green++;
    }
    return { ok, green };
  }, [matched, probeResults]);

  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => listRef.current,
    estimateSize: (i) => (filtered[i].group ? 54 : 48),
    overscan: 10,
    getItemKey: (i) => filtered[i].url,
  });

  useEffect(() => {
    setCursor(-1);
    if (!currentUrl) {
      virtualizer.scrollToOffset(0);
      return;
    }
    const idx = filteredRef.current.findIndex((c) => c.url === currentUrl);
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: 'auto' });
    else virtualizer.scrollToOffset(0);
  }, [view, group, sortMode, debouncedKeyword, aliveFilter, currentUrl, virtualizer]);

  const removeRecent = useCallback((url: string) => {
    useAppStore.getState().removeLiveRecent(url);
  }, []);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 顶部一体式工具栏：视图切换 + 搜索框 + 排序 + 测活 */}
      <div className="px-3 pt-2.5 pb-2 border-b border-line/60 space-y-2 shrink-0">
        <div className="flex items-center gap-1.5">
          <div className="flex bg-chip rounded-xl p-0.5 shrink-0">
            {(
              [
                ['all', `全部${channels.length ? ` ${channels.length}` : ''}`],
                ['fav', `收藏${liveFavorites.length ? ` ${liveFavorites.length}` : ''}`],
                ['recent', '最近'],
              ] as [View, string][]
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                className={cn(
                  'px-2.5 py-1 rounded-lg text-xs font-medium transition-colors num',
                  view === v ? 'bg-surface-raised text-accent shadow-sm' : 'text-muted hover:text-content'
                )}
                onClick={() => setView(v)}
              >
                {label}
              </button>
            ))}
          </div>

          <input
            className="input flex-1 min-w-0 !py-1.5 !px-3 text-xs"
            placeholder="搜台名 / 分组..."
            value={keyword}
            maxLength={60}
            onChange={(e) => setKeyword(e.target.value)}
          />

          <Dropdown
            className="shrink-0 [&>button]:!py-1.5 [&>button]:!px-2.5 [&>button]:text-xs"
            value={sortMode}
            ariaLabel="排序方式"
            onChange={(v) => setSortMode(v as LiveSortMode)}
            options={[
              { value: 'default', label: '默认' },
              { value: 'name', label: '名称' },
              { value: 'group', label: '分组' },
              { value: 'probe', label: '可用优先' },
              { value: 'recent', label: '最近看' },
            ]}
          />
        </div>

        {/* 分组横向滑动胶囊 + 测活控制 */}
        <div className="flex items-center gap-1.5">
          {view === 'all' && groups.length > 0 && (
            <div className="relative flex-1 min-w-0">
              <div
                ref={chipStrip.ref}
                onPointerDown={chipStrip.onPointerDown}
                onClickCapture={chipStrip.onClickCapture}
                className="flex gap-1.5 overflow-x-auto hide-scrollbar select-none"
              >
                <GroupChip active={!group} label="全部分组" onClick={() => setGroup('')} />
                {groups.map((g) => (
                  <GroupChip key={g} active={group === g} label={g} onClick={() => setGroup(g === group ? '' : g)} />
                ))}
              </div>
              {chipStrip.edges.right && (
                <div className="pointer-events-none absolute inset-y-0 right-0 w-5 bg-gradient-to-l from-page to-transparent" />
              )}
            </div>
          )}

          <div className="flex items-center gap-1 ml-auto shrink-0">
            <button
              type="button"
              className="btn-ghost btn-sm !py-1 !px-2.5 !min-h-[28px] text-[11px]"
              disabled={isProbing || filtered.length === 0}
              onClick={() => void probe(filtered)}
            >
              {isProbing && probeProgress ? formatProbeProgress(probeProgress) : '测活'}
            </button>
            {isProbing ? (
              <button
                type="button"
                className="btn-ghost btn-sm !py-1 !px-2 !min-h-[28px] text-[11px]"
                onClick={cancelProbe}
              >
                停止
              </button>
            ) : (
              probeResults.size > 0 && (
                <>
                  <button
                    type="button"
                    className={cn(
                      'px-2 py-1 rounded-full text-[11px] font-medium border num',
                      aliveFilter === 'green'
                        ? 'bg-accent text-on-accent border-accent'
                        : 'bg-chip text-muted border-line/60'
                    )}
                    onClick={() => setAliveFilter((v) => (v === 'green' ? 'off' : 'green'))}
                  >
                    秒播 {aliveCounts.green}
                  </button>
                  <button
                    type="button"
                    className="px-2 py-1 rounded-full text-[11px] bg-chip text-faint"
                    onClick={() => {
                      clearProbe();
                      setAliveFilter('off');
                    }}
                  >
                    清除
                  </button>
                </>
              )
            )}
          </div>
        </div>

        {probeHint && <p className="text-[11px] text-faint">{probeHint}</p>}
      </div>

      {/* 虚拟滚动频道列表 */}
      <div
        ref={listRef}
        data-channel-list
        tabIndex={0}
        className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-2.5 py-2 focus-visible:outline-none"
      >
        {filtered.length === 0 ? (
          <EmptyState
            variant="plain"
            className="!py-10"
            title={
              view === 'fav'
                ? '暂无收藏频道，点按频道右侧星标即可加入收藏'
                : view === 'recent'
                  ? '暂无最近观看的频道'
                  : channels.length === 0
                    ? '暂无频道，请先在「我的 → 数据源与订阅」中添加直播源'
                    : aliveFilter !== 'off' && probeResults.size > 0
                      ? '没有符合筛选的秒播频道，可点击取消筛选'
                      : '没有匹配的频道'
            }
          />
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((vi) => (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${vi.start}px)`,
                  paddingBottom: 6,
                }}
              >
                <ChannelRow
                  channel={filtered[vi.index]}
                  active={filtered[vi.index].url === currentUrl}
                  cursor={cursor === vi.index}
                  isFav={favSet.has(filtered[vi.index].url)}
                  probe={probeResults.get(filtered[vi.index].url)}
                  logo={filtered[vi.index].logo}
                  imageProxyMode={imageProxyMode}
                  customProxy={customImageProxy}
                  onSelect={onSelect}
                  onRemoveRecent={view === 'recent' ? removeRecent : undefined}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function GroupChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={cn(
        'shrink-0 px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors border',
        active
          ? 'bg-accent text-on-accent border-accent shadow-sm'
          : 'bg-chip/85 text-muted border-line/60 hover:text-content'
      )}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

const ChannelRow = memo(function ChannelRow({
  channel,
  active,
  cursor,
  isFav,
  probe,
  logo,
  imageProxyMode,
  customProxy,
  onSelect,
  onRemoveRecent,
}: {
  channel: LiveChannelItem;
  active: boolean;
  cursor: boolean;
  isFav: boolean;
  probe?: ProbeResult;
  logo?: string;
  imageProxyMode: 'direct' | 'proxy' | 'custom';
  customProxy: string;
  onSelect: (channel: LiveChannelItem) => void;
  onRemoveRecent?: (url: string) => void;
}) {
  const [logoFailed, setLogoFailed] = useState(false);
  useEffect(() => setLogoFailed(false), [logo]);

  const isHevc = Boolean(probe?.codec && /hvc1|hev1|hevc/i.test(probe.codec));
  const slow = isSlowSource(probe);
  const weakLevel = probe?.ok && probe.level !== 'segment';
  const amber = Boolean(probe && (weakLevel || (!probe.ok && probe.timedOut) || slow));
  const dotClass = amber ? 'bg-warning' : probe?.ok ? 'bg-success' : 'bg-danger';

  return (
    <div data-url={channel.url}>
      <div
        className={cn(
          'pressable group flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-colors relative cursor-pointer',
          active
            ? 'bg-accent/12 border-accent/40'
            : 'bg-card/85 border-line/50 hover:bg-hover',
          cursor && 'ring-1 ring-accent/70'
        )}
        onClick={() => onSelect(channel)}
      >
        <div className="w-8 h-8 shrink-0 rounded-lg bg-chip flex items-center justify-center overflow-hidden">
          {logo && !logoFailed ? (
            <SmartImage
              url={logo}
              mode={imageProxyMode}
              customProxy={customProxy}
              alt=""
              className="w-full h-full object-contain"
              onExhausted={() => setLogoFailed(true)}
            />
          ) : (
            <span className="text-xs font-bold text-faint">{channel.name.slice(0, 1)}</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            {probe && <span className={cn('w-2 h-2 rounded-full shrink-0', dotClass)} />}
            <span className={cn('text-xs font-semibold truncate', active ? 'text-accent' : 'text-content')}>
              {channel.name}
            </span>
            {isHevc && (
              <span
                className="shrink-0 rounded-full bg-warning/15 px-1.5 text-[10px] font-medium text-warning"
                title="H.265 编码频道，依赖设备硬件解码支持"
              >
                HEVC
              </span>
            )}
            {probe?.ok && probe.ms != null && probe.level === 'segment' && (
              <span className="text-[10px] text-faint num shrink-0">{probe.ms}ms</span>
            )}
          </div>
          {channel.group && <div className="text-[10px] text-faint truncate mt-0.5">{channel.group}</div>}
        </div>

        {onRemoveRecent && (
          <button
            type="button"
            className="shrink-0 p-1.5 rounded-full text-faint hover:text-danger"
            aria-label="移除该记录"
            onClick={(e) => {
              e.stopPropagation();
              onRemoveRecent(channel.url);
            }}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}

        <button
          type="button"
          className={cn(
            'shrink-0 p-1.5 rounded-full transition-transform active:scale-125',
            isFav ? 'text-warning' : 'text-faint/60 hover:text-warning'
          )}
          aria-label={isFav ? '取消收藏' : '收藏'}
          onClick={(e) => {
            e.stopPropagation();
            useAppStore.getState().toggleLiveFavorite(channel.url);
          }}
        >
          <svg className="w-4 h-4" fill={isFav ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.196-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.783-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
            />
          </svg>
        </button>
      </div>
    </div>
  );
});
