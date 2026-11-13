'use client';

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client-api';
import type { SearchResultItem, VideoDetail } from '@/lib/types';
import { buildWatchUrl, cn } from '@/lib/utils';
import { formatRemarks } from '@/lib/remarks';
import { SmartImage } from './smart-image';
import { useAppStore, resolveSource } from '@/lib/store';
import { useToast } from './toast';
import { addSearchHistory } from '@/lib/db';
import { copyToClipboard } from '@/lib/clipboard';
import { EmptyState, ErrorState, LoadingState } from './states';
import { useFocusTrap } from './use-focus-trap';
import { Icon } from './icon';

/**
 * 移动端原生感影视详情 Bottom Sheet（Apple TV+ / Infuse 风格）：
 * - 顶部高斯模糊海报氛围背景 + 物理拖拽把手（支持按住下滑跟手关闭）；
 * - 立即播放主按钮（直达第 1 集）+ 复制链接胶囊；
 * - 内置「剧集分段器」（每 50 集自动生成 `1-50`、`51-100` 横向胶囊，百集长剧秒切无需狂滑）。
 */

const EPISODE_CHUNK_SIZE = 50;
const DRAG_CLOSE_PX = 64;

export function DetailModal({ item, onClose }: { item: SearchResultItem | null; onClose: () => void }) {
  const store = useAppStore();
  const router = useRouter();
  const { toast } = useToast();
  const [detail, setDetail] = useState<VideoDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reversed, setReversed] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);
  const [chunkIndex, setChunkIndex] = useState(0);
  const [descExpanded, setDescExpanded] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useFocusTrap(Boolean(item), panelRef);

  useEffect(() => {
    setPosterFailed(false);
    setChunkIndex(0);
    setDescExpanded(false);
  }, [item?.pic, item?.vodId, store.imageProxyMode, store.customImageProxy]);

  useEffect(() => {
    if (!item) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [item]);

  useEffect(() => {
    if (!item) {
      setDetail(null);
      setError('');
      return;
    }
    const source = resolveSource(store, item.sourceKey, {
      url: item.sourceUrl,
      name: item.sourceName,
    });
    if (!source) {
      setError('点播源配置不存在，请在「我的 → 数据源管理」中检查');
      return;
    }
    setLoading(true);
    setError('');
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    api
      .detail(item.vodId, source, controller.signal)
      .then((d) => setDetail(d))
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : '获取详情失败');
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item]);

  useEffect(() => {
    if (!item) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [item, onClose]);

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
    }, 200);
  };

  const totalEpisodes = detail?.episodes.length ?? 0;

  // 剧集分段计算（超过 50 集时启用分段胶囊）
  const chunks = useMemo(() => {
    if (totalEpisodes <= EPISODE_CHUNK_SIZE) return [];
    const list: { label: string; start: number; end: number }[] = [];
    for (let s = 0; s < totalEpisodes; s += EPISODE_CHUNK_SIZE) {
      const e = Math.min(s + EPISODE_CHUNK_SIZE, totalEpisodes);
      list.push({ label: `${s + 1}-${e}`, start: s, end: e });
    }
    return list;
  }, [totalEpisodes]);

  const visibleIndices = useMemo(() => {
    if (!detail) return [];
    const allIndices = detail.episodes.map((_, idx) => idx);
    if (reversed) {
      return [...allIndices].reverse();
    }
    if (chunks.length > 0) {
      const c = chunks[Math.min(chunkIndex, chunks.length - 1)];
      return allIndices.slice(c.start, c.end);
    }
    return allIndices;
  }, [detail, reversed, chunks, chunkIndex]);

  if (!item) return null;

  const info = detail?.videoInfo;

  const play = (index: number) => {
    if (!detail || !detail.episodes[index]) return;
    addSearchHistory(item.name).catch(() => {});
    onClose();
    router.push(
      buildWatchUrl({
        sourceKey: item.sourceKey,
        vodId: item.vodId,
        index,
        title: item.name,
        sourceUrl: item.sourceUrl,
      })
    );
  };

  const copyLinks = async () => {
    if (!detail) return;
    const ok = await copyToClipboard(detail.episodes.join('\n'));
    if (ok) toast('全部剧集链接已复制', 'success');
    else toast('复制失败', 'error');
  };

  const remarks = formatRemarks(info?.remarks || item.remarks);
  const badges = [info?.typeName || item.typeName, info?.year || item.year, info?.area, remarks].filter(
    Boolean
  ) as string[];

  return (
    <div
      className="fixed inset-0 z-[75] flex items-end justify-center bg-black/75 backdrop-blur-[2px] animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative bg-surface-raised rounded-t-[26px] w-full max-w-2xl shadow-[0_-14px_54px_rgba(0,0,0,0.75)] border-t border-white/10 sheet-up outline-none max-h-[88dvh] flex flex-col overflow-hidden safe-x pb-[env(safe-area-inset-bottom)]"
        role="dialog"
        aria-modal="true"
        aria-label={`${item.name} 详情`}
      >
        {/* 高斯模糊海报背景氛围层 */}
        {item.pic && !posterFailed && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-44 opacity-25 blur-2xl scale-125 overflow-hidden"
          >
            <SmartImage
              url={item.pic}
              mode={store.imageProxyMode}
              customProxy={store.customImageProxy}
              alt=""
              className="w-full h-full object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-b from-transparent to-surface-raised" />
          </div>
        )}

        {/* 顶部拖拽把手 */}
        <div
          className="relative z-10 flex shrink-0 flex-col items-center pt-2.5 pb-1 touch-none select-none cursor-grab active:cursor-grabbing"
          onPointerDown={beginDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <span className="h-1.5 w-11 rounded-full bg-white/20" />
        </div>

        {/* 头部海报与元信息区 */}
        <div className="relative z-10 px-4 pt-2 pb-3.5 border-b border-line/60 shrink-0">
          <div className="flex items-start gap-3.5">
            {item.pic && !posterFailed ? (
              <SmartImage
                url={item.pic}
                mode={store.imageProxyMode}
                customProxy={store.customImageProxy}
                alt={item.name}
                className="w-20 aspect-[2/3] object-cover rounded-xl bg-chip shrink-0 shadow-lg ring-1 ring-white/10"
                loading="eager"
                onExhausted={() => setPosterFailed(true)}
              />
            ) : (
              <div className="w-20 aspect-[2/3] rounded-xl bg-chip shrink-0 flex items-center justify-center ring-1 ring-white/10">
                <Icon name="tv" className="w-7 h-7 text-faint" />
              </div>
            )}

            <div className="flex-1 min-w-0 pt-0.5">
              <div className="flex items-start justify-between gap-2">
                <h2 className="text-base font-bold text-content leading-snug line-clamp-2">{item.name}</h2>
                <button
                  className="pressable p-1.5 -mr-1 -mt-0.5 rounded-full bg-chip/90 text-muted hover:text-content shrink-0"
                  onClick={onClose}
                  aria-label="关闭"
                >
                  <Icon name="close" className="w-4 h-4" />
                </button>
              </div>

              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span className="tag bg-accent/15 text-accent font-semibold">{item.sourceName}</span>
                {badges.map((b, idx) => (
                  <span key={idx} className="tag bg-chip/90 text-muted">
                    {b}
                  </span>
                ))}
              </div>

              {(info?.actor || info?.director) && (
                <p className="mt-2 text-xs text-faint line-clamp-1">
                  {info.director ? `导演：${info.director}  ` : ''}
                  {info.actor ? `主演：${info.actor}` : ''}
                </p>
              )}

              {totalEpisodes > 0 && (
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    className="btn-primary btn-sm flex-1 justify-center py-2 shadow-glow"
                    onClick={() => play(0)}
                  >
                    <Icon name="play" className="w-4 h-4" />
                    立即播放
                  </button>
                  <button
                    type="button"
                    className="btn-ghost btn-sm px-3 py-2"
                    onClick={copyLinks}
                    title="复制全部剧集播放地址"
                  >
                    <Icon name="copy" className="w-4 h-4" />
                    复制链接
                  </button>
                </div>
              )}
            </div>
          </div>

          {info?.desc && (
            <div className="mt-3">
              <p
                onClick={() => setDescExpanded((v) => !v)}
                className={cn(
                  'text-xs text-muted leading-relaxed cursor-pointer transition-all',
                  !descExpanded && 'line-clamp-2'
                )}
              >
                {info.desc}
              </p>
            </div>
          )}
        </div>

        {/* 剧集选集区 */}
        <div className="relative z-10 px-4 pt-3 pb-5 flex-1 min-h-0 overflow-y-auto overscroll-contain scrollbar-thin">
          {loading && <LoadingState label="正在加载剧集列表..." />}

          {!loading && error && <ErrorState message={error || '获取详情失败'} />}

          {!loading && !error && detail && (
            <>
              {totalEpisodes > 0 ? (
                <>
                  <div className="flex items-center justify-between gap-2 mb-2.5">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-content">选集</span>
                      <span className="text-xs text-faint num">共 {totalEpisodes} 集</span>
                    </div>
                    {totalEpisodes > 1 && (
                      <button
                        type="button"
                        className="btn-ghost btn-sm !py-1 !px-2.5 !min-h-[28px]"
                        onClick={() => setReversed((v) => !v)}
                      >
                        <Icon
                          name="arrowDown"
                          className={cn('w-3.5 h-3.5 transition-transform', reversed && 'rotate-180')}
                        />
                        {reversed ? '正序' : '倒序'}
                      </button>
                    )}
                  </div>

                  {/* 百集长剧分段胶囊（仅在正序且 >50 集时展示） */}
                  {!reversed && chunks.length > 0 && (
                    <div className="flex items-center gap-1.5 overflow-x-auto hide-scrollbar pb-2.5 mb-1">
                      {chunks.map((c, idx) => (
                        <button
                          key={c.label}
                          type="button"
                          onClick={() => setChunkIndex(idx)}
                          className={cn(
                            'shrink-0 px-3 py-1 rounded-full text-xs font-medium num transition-colors',
                            chunkIndex === idx
                              ? 'bg-accent text-on-accent shadow-sm'
                              : 'bg-chip text-muted hover:text-content'
                          )}
                        >
                          {c.label}
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
                    {visibleIndices.map((realIndex) => (
                      <button
                        key={realIndex}
                        type="button"
                        className="pressable rounded-xl border border-line/60 bg-chip/75 py-2.5 px-1 text-center text-xs font-semibold text-content num hover:border-accent/50 hover:bg-accent/10 active:bg-accent active:text-on-accent transition-colors"
                        onClick={() => play(realIndex)}
                      >
                        {totalEpisodes === 1 ? '正片' : `第 ${realIndex + 1} 集`}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <EmptyState
                  icon="alert"
                  title="未找到可播放剧集"
                  description="该来源可能暂无资源，请尝试切换其他来源"
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
