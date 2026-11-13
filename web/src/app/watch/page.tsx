'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
const PlayerShell = dynamic(() => import('@/components/player-shell').then((m) => m.PlayerShell), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center">
      <Spinner size="lg" />
    </div>
  ),
});
import { EmptyState, LoadingState, Spinner } from '@/components/states';
import { SwitchSourceModal } from '@/components/switch-source';
import { SkipMarkPanel } from '@/components/skip-mark-panel';
import { skipMarkKey, validateSegment, type SkipSegment } from '@/lib/skip-marks';
import type { PlayerSkipApi } from '@/components/player-shell';
import { useToast } from '@/components/toast';
import { enqueueDownload, requestShowDownloadManager } from '@/components/download-manager';
import { Icon } from '@/components/icon';
import { useAuth } from '@/components/auth';
import { resolveSource, useAppStore } from '@/lib/store';
import { qualityKey, qualityLabel } from '@/lib/quality';
import {
  clearProgress,
  progressKeyOf,
  saveProgress,
  updateHistoryProgress,
  upsertHistory,
  db,
} from '@/lib/db';
import { cn } from '@/lib/utils';

const EPISODE_CHUNK_SIZE = 50;

type WatchTab = 'episodes' | 'skip' | 'info';

export default function WatchPage() {
  return (
    <Suspense>
      <WatchContent />
    </Suspense>
  );
}

function WatchContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const store = useAppStore();
  const { verified } = useAuth();
  const { toast } = useToast();

  const sourceKey = searchParams.get('source') || '';
  const vodId = searchParams.get('id') || '';
  const directUrl = searchParams.get('url') || '';
  const titleParam = searchParams.get('title') || '';
  const indexParam = parseInt(searchParams.get('index') || '0', 10) || 0;

  const [activeTab, setActiveTab] = useState<WatchTab>('episodes');
  const [reversed, setReversed] = useState(false);
  const [chunkIndex, setChunkIndex] = useState(0);
  const [switchOpen, setSwitchOpen] = useState(false);
  const playerApiRef = useRef<PlayerSkipApi | null>(null);

  const source = resolveSource(store, sourceKey, {
    url: searchParams.get('sourceUrl') || undefined,
    detail: searchParams.get('detail') || undefined,
  });

  const detailQuery = useQuery({
    queryKey: ['detail', sourceKey, vodId, source?.url],
    queryFn: ({ signal }) => api.detail(vodId, source!, signal),
    enabled: Boolean(source && vodId && verified),
    staleTime: 5 * 60_000,
  });

  const episodes = useMemo(() => detailQuery.data?.episodes ?? [], [detailQuery.data]);
  const info = detailQuery.data?.videoInfo;
  const videoTitle = titleParam || info?.title || '未知视频';

  const currentUrl = useMemo(() => {
    if (episodes.length > 0) {
      const idx = Math.min(Math.max(indexParam, 0), episodes.length - 1);
      return episodes[idx] || directUrl;
    }
    return directUrl;
  }, [episodes, indexParam, directUrl]);

  const currentIndex = useMemo(() => {
    if (episodes.length > 0) return Math.min(Math.max(indexParam, 0), episodes.length - 1);
    return indexParam;
  }, [episodes, indexParam]);

  // 当前集变化时，自动切换到对应的 50 集分段
  useEffect(() => {
    setChunkIndex(Math.floor(currentIndex / EPISODE_CHUNK_SIZE));
  }, [currentIndex]);

  const skipMarkFallback = `${sourceKey}:${vodId || currentUrl}`;
  const markKey = useMemo(
    () => skipMarkKey(videoTitle, skipMarkFallback),
    [videoTitle, skipMarkFallback]
  );
  const skipMark = store.skipMarks[markKey];
  const markedCount = skipMark?.segments.length ?? 0;

  const currentQualityLabel = useMemo(() => {
    if (!sourceKey || !vodId) return null;
    const q = store.qualityMap[qualityKey(sourceKey, vodId)];
    return qualityLabel(q?.height);
  }, [store.qualityMap, sourceKey, vodId]);

  const [pendingStart, setPendingStart] = useState<number | null>(null);
  useEffect(() => setPendingStart(null), [sourceKey, vodId, currentIndex]);

  const goEpisode = useCallback(
    (index: number) => {
      const sp = new URLSearchParams(searchParams.toString());
      sp.set('index', String(index));
      sp.set('url', episodes[index] || directUrl);
      sp.delete('position');
      router.replace(`/watch?${sp.toString()}`, { scroll: false });
    },
    [router, searchParams, episodes, directUrl]
  );

  const getRestorePosition = useCallback(async () => {
    const urlPos = parseInt(searchParams.get('position') || '0', 10) || 0;
    if (urlPos > 0) return urlPos;
    if (!vodId) return 0;
    const entry = await db.progress.get(progressKeyOf(sourceKey, vodId, currentIndex));
    return entry?.position ?? 0;
  }, [searchParams, sourceKey, vodId, currentIndex]);

  useEffect(() => {
    if (!verified || !sourceKey || !currentUrl) return;
    const timer = setTimeout(() => {
      upsertHistory({
        sourceKey,
        sourceUrl: source?.url,
        vodId: vodId || currentUrl,
        title: videoTitle,
        pic: info?.cover,
        episodeIndex: currentIndex,
        totalEpisodes: episodes.length,
        playbackPosition: 0,
        duration: 0,
        timestamp: Date.now(),
      }).catch(() => {});
    }, 1500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verified, sourceKey, vodId, currentIndex, videoTitle, currentUrl, info?.cover]);

  const handleProgress = useCallback(
    (position: number, duration: number) => {
      if (vodId) {
        saveProgress(sourceKey, vodId, currentIndex, position, duration).catch(() => {});
        updateHistoryProgress(sourceKey, vodId || currentUrl, position, duration).catch(() => {});
      }
    },
    [sourceKey, vodId, currentIndex, currentUrl]
  );

  const autoNextTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (autoNextTimer.current) clearTimeout(autoNextTimer.current);
  }, []);

  const handleEnded = useCallback(() => {
    if (vodId) clearProgress(sourceKey, vodId, currentIndex).catch(() => {});
    if (store.autoplayNext && currentIndex < episodes.length - 1) {
      autoNextTimer.current = setTimeout(() => goEpisode(currentIndex + 1), 800);
    }
  }, [store.autoplayNext, currentIndex, episodes.length, goEpisode, sourceKey, vodId]);

  const handleRecordSegment = useCallback(
    (segment: SkipSegment) => {
      const duration = playerApiRef.current?.getDuration() ?? 0;
      const existing = useAppStore.getState().skipMarks[markKey]?.segments ?? [];
      const error = validateSegment(segment, duration, existing);
      if (error) {
        toast(error, 'error');
        return;
      }
      useAppStore.getState().setSkipMark(markKey, [...existing, segment]);
      const label =
        segment.type === 'opening' ? '片头结束' : segment.type === 'ending' ? '片尾开始' : '中段片段';
      const hint =
        segment.type === 'middle'
          ? useAppStore.getState().autoSkipSegments
            ? '，命中时将自动跳过'
            : '，命中时显示跳过按钮'
          : '';
      toast(`已记录${label}${hint}`, 'success');
    },
    [markKey, toast]
  );

  // 分段计算（超过 40 集时启用 50 集分段胶囊）
  const useChunking = episodes.length > 40;
  const totalChunks = Math.ceil(episodes.length / EPISODE_CHUNK_SIZE);
  const chunks = useMemo(() => {
    if (!useChunking) return [];
    return Array.from({ length: totalChunks }, (_, idx) => {
      const start = idx * EPISODE_CHUNK_SIZE;
      const end = Math.min(episodes.length - 1, start + EPISODE_CHUNK_SIZE - 1);
      return { idx, label: `${start + 1}-${end + 1}`, start, end };
    });
  }, [useChunking, totalChunks, episodes.length]);

  const visibleEpisodes = useMemo(() => {
    const indices = episodes.map((_, i) => i);
    const sliced = useChunking
      ? indices.slice(chunkIndex * EPISODE_CHUNK_SIZE, (chunkIndex + 1) * EPISODE_CHUNK_SIZE)
      : indices;
    return reversed ? [...sliced].reverse() : sliced;
  }, [episodes, useChunking, chunkIndex, reversed]);

  if (!source) {
    return (
      <div className="min-h-screen-safe flex items-center justify-center px-4">
        <div className="text-center max-w-md card p-6">
          <h1 className="text-content font-semibold mb-2">未找到对应的点播源</h1>
          <p className="text-sm text-muted mb-4">
            该影片来自点播源「{sourceKey}」，可能已被移除或尚未导入。
          </p>
          <Link href="/" className="btn-primary">
            返回探索首页
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen-safe flex flex-col bg-page">
      {/* 顶部沉浸固定区：导航栏 + 16:9 播放器吸顶，下滑选集或打点时视频始终可见 */}
      <div className="sticky top-0 z-40 bg-[#06080c]/95 backdrop-blur-xl border-b border-line/60 pt-[env(safe-area-inset-top)]">
        <header className="max-w-5xl mx-auto px-3 h-12 flex items-center gap-2">
          <BackButton />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <h1 className="text-sm font-semibold text-content truncate">{videoTitle}</h1>
              {currentQualityLabel && (
                <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-accent/15 text-accent tabular-nums">
                  {currentQualityLabel}
                </span>
              )}
            </div>
            <p className="text-[11px] text-faint truncate tabular-nums">
              {source.name}
              {episodes.length > 0 && ` · 第 ${currentIndex + 1} / ${episodes.length} 集`}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              className="btn-ghost btn-sm !px-2.5 !py-1.5 text-xs"
              onClick={() => setSwitchOpen(true)}
            >
              <Icon name="refresh" className="w-3.5 h-3.5" />
              <span>换源</span>
            </button>
            <button
              type="button"
              className="btn-ghost btn-sm !px-2.5 !py-1.5 text-xs"
              onClick={() => {
                if (!currentUrl) return;
                enqueueDownload({
                  url: currentUrl,
                  title: `${videoTitle}${episodes.length > 1 ? ` 第${currentIndex + 1}集` : ''}`,
                  format: 'MP4',
                });
              }}
              aria-label="缓存本集"
            >
              <Icon name="download" className="w-3.5 h-3.5" />
              <span className="hidden xs:inline">缓存</span>
            </button>
            <HomeButton />
          </div>
        </header>

        {/* 16:9 播放器容器 */}
        <div className="max-w-5xl mx-auto w-full bg-black">
          <div className="aspect-video w-full bg-black overflow-hidden relative">
            {currentUrl ? (
              <PlayerShell
                url={currentUrl}
                title={videoTitle}
                adFilter={store.adFilter}
                autoplayNext={store.autoplayNext}
                skipMark={skipMark}
                autoSkipSegments={store.autoSkipSegments}
                volumeBoost={store.volumeBoost}
                miniProgressBar={store.miniProgressBar}
                pendingStart={pendingStart}
                onPendingStart={setPendingStart}
                onPlayerApi={(api) => {
                  playerApiRef.current = api;
                }}
                onRecordSegment={handleRecordSegment}
                episodeKey={`${sourceKey}:${vodId}:${currentIndex}`}
                nextUrl={currentIndex + 1 < episodes.length ? episodes[currentIndex + 1] : undefined}
                nextEpisodeKey={
                  currentIndex + 1 < episodes.length ? `${sourceKey}:${vodId}:${currentIndex + 1}` : undefined
                }
                getRestorePosition={getRestorePosition}
                onTimeUpdate={handleProgress}
                onPause={handleProgress}
                onEnded={handleEnded}
                hasPrevEpisode={currentIndex > 0}
                hasNextEpisode={episodes.length > 0 && currentIndex < episodes.length - 1}
                onPrevEpisode={() => goEpisode(currentIndex - 1)}
                onNextEpisode={() => goEpisode(currentIndex + 1)}
                onQuality={(height) => {
                  if (!sourceKey || !vodId) return;
                  useAppStore.getState().setQuality({
                    [qualityKey(sourceKey, vodId)]: { height, from: 'play', timestamp: Date.now() },
                  });
                }}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                {detailQuery.isLoading ? (
                  <Spinner size="lg" />
                ) : (
                  <p className="text-faint text-sm">
                    {detailQuery.isError ? '视频加载失败，请点右上角「换源」重试' : '暂无可用播放地址'}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 下半屏移动端一体化工作台 */}
      <main className="flex-1 max-w-5xl w-full mx-auto px-3.5 pt-3 pb-10 space-y-3">
        {/* 快捷控制胶囊条：上一集 / 下一集 / 自动连播 / 离线队列 */}
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar py-0.5">
          <button
            type="button"
            className="btn-ghost btn-sm shrink-0"
            disabled={currentIndex <= 0}
            onClick={() => goEpisode(currentIndex - 1)}
          >
            <Icon name="chevronLeft" className="w-3.5 h-3.5" />
            上一集
          </button>
          <button
            type="button"
            className="btn-ghost btn-sm shrink-0"
            disabled={episodes.length === 0 || currentIndex >= episodes.length - 1}
            onClick={() => goEpisode(currentIndex + 1)}
          >
            下一集
            <Icon name="chevronRight" className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            className={cn(
              'chip shrink-0 flex items-center gap-1.5 py-1.5 px-3',
              store.autoplayNext ? 'bg-accent/15 text-accent border border-accent/30' : 'text-muted'
            )}
            onClick={() => store.updateSettings({ autoplayNext: !store.autoplayNext })}
          >
            <span className={cn('w-1.5 h-1.5 rounded-full', store.autoplayNext ? 'bg-accent' : 'bg-faint')} />
            自动连播
          </button>
          <button
            type="button"
            className="chip shrink-0 flex items-center gap-1 py-1.5 px-3 text-muted hover:text-content ml-auto"
            onClick={() => requestShowDownloadManager()}
          >
            <Icon name="download" className="w-3.5 h-3.5" />
            下载队列
          </button>
        </div>

        {/* 三栏 Segmented Control：选集 / 片头片尾打点 / 影片简介 */}
        <div className="flex p-1 rounded-xl bg-chip border border-line/60" role="tablist" aria-label="播放工作台">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'episodes'}
            className={cn(
              'flex-1 py-1.5 text-xs font-medium rounded-lg transition-all tabular-nums',
              activeTab === 'episodes' ? 'bg-surface-raised text-accent shadow-sm' : 'text-muted hover:text-content'
            )}
            onClick={() => setActiveTab('episodes')}
          >
            选集 {episodes.length > 0 ? `(${episodes.length})` : ''}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'skip'}
            className={cn(
              'flex-1 py-1.5 text-xs font-medium rounded-lg transition-all tabular-nums',
              activeTab === 'skip' ? 'bg-surface-raised text-accent shadow-sm' : 'text-muted hover:text-content'
            )}
            onClick={() => setActiveTab('skip')}
          >
            跳过片头片尾 {markedCount > 0 ? `(${markedCount})` : ''}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'info'}
            className={cn(
              'flex-1 py-1.5 text-xs font-medium rounded-lg transition-all',
              activeTab === 'info' ? 'bg-surface-raised text-accent shadow-sm' : 'text-muted hover:text-content'
            )}
            onClick={() => setActiveTab('info')}
          >
            影片简介
          </button>
        </div>

        {/* Tab 1: 选集面板（含 50 集分段胶囊与正倒序） */}
        {activeTab === 'episodes' && (
          <section className="card p-3.5 space-y-3 animate-fade-in">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs text-muted">
                当前播放：<span className="text-content font-semibold">第 {currentIndex + 1} 集</span>
              </div>
              {episodes.length > 1 && (
                <button
                  type="button"
                  className="btn-ghost btn-sm !py-1 !px-2.5 text-xs"
                  onClick={() => setReversed((v) => !v)}
                >
                  <Icon
                    name="arrowDown"
                    className={cn('w-3.5 h-3.5 transition-transform', reversed && 'rotate-180')}
                  />
                  {reversed ? '正序排列' : '倒序排列'}
                </button>
              )}
            </div>

            {useChunking && (
              <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1">
                {chunks.map((c) => (
                  <button
                    key={c.idx}
                    type="button"
                    className={cn(
                      'chip shrink-0 tabular-nums',
                      chunkIndex === c.idx
                        ? 'bg-accent/15 text-accent font-semibold border border-accent/30'
                        : 'text-muted hover:text-content'
                    )}
                    onClick={() => setChunkIndex(c.idx)}
                  >
                    {c.label} 集
                  </button>
                ))}
              </div>
            )}

            {episodes.length === 0 ? (
              detailQuery.isLoading ? (
                <LoadingState />
              ) : (
                <EmptyState variant="plain" title={detailQuery.isError ? '获取剧集失败' : '暂无剧集列表'} />
              )
            ) : (
              <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-2">
                {visibleEpisodes.map((realIndex) => (
                  <EpisodeButton
                    key={realIndex}
                    index={realIndex}
                    active={realIndex === currentIndex}
                    onClick={() => goEpisode(realIndex)}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        {/* Tab 2: 内嵌式片头/片尾一键打点面板 */}
        {activeTab === 'skip' && (
          <section className="card p-3.5 animate-fade-in">
            <SkipMarkPanel
              open={true}
              inline={true}
              onClose={() => setActiveTab('episodes')}
              markKey={markKey}
              pendingStart={pendingStart}
              onPendingStart={setPendingStart}
              getPlayerClock={() => {
                const api = playerApiRef.current;
                if (!api) return null;
                return {
                  currentTime: api.getCurrentTime(),
                  duration: api.getDuration(),
                  seek: (s) => api.seek(s),
                  pause: () => api.pause(),
                  isPaused: () => api.isPaused(),
                };
              }}
            />
          </section>
        )}

        {/* Tab 3: 影片简介与演职员元数据 */}
        {activeTab === 'info' && (
          <section className="card p-4 space-y-3 animate-fade-in">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="chip bg-accent/15 text-accent font-medium">{source.name}</span>
              {info?.typeName && <span className="chip">{info.typeName}</span>}
              {info?.year && <span className="chip tabular-nums">{info.year}</span>}
              {info?.area && <span className="chip">{info.area}</span>}
              {info?.remarks && <span className="chip">{info.remarks}</span>}
            </div>
            {(info?.director || info?.actor) && (
              <div className="space-y-1 text-xs text-muted">
                {info?.director && (
                  <p>
                    <span className="text-faint">导演：</span>
                    {info.director}
                  </p>
                )}
                {info?.actor && (
                  <p>
                    <span className="text-faint">主演：</span>
                    {info.actor}
                  </p>
                )}
              </div>
            )}
            <p className="text-xs text-muted leading-relaxed whitespace-pre-line">
              {info?.desc ? info.desc.replace(/<[^>]+>/g, '').trim() : '暂无详细剧情简介。'}
            </p>
            <div className="pt-2 border-t border-line/60 flex items-center justify-between text-[11px] text-faint">
              <span>全屏手势：双击左右快进退 10s · 长按 3x 倍速 · 左右侧竖滑调光与音量</span>
            </div>
          </section>
        )}
      </main>

      {switchOpen && (
        <SwitchSourceModal
          currentTitle={videoTitle}
          currentSourceKey={sourceKey}
          currentVodId={vodId}
          currentIndex={currentIndex}
          onClose={() => setSwitchOpen(false)}
        />
      )}
    </div>
  );
}

function EpisodeButton({ index, active, onClick }: { index: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={cn(
        'btn btn-sm !px-1.5 !py-2 tabular-nums text-xs font-medium rounded-xl',
        active ? 'episode-active shadow-sm' : 'btn-ghost bg-chip/60'
      )}
      onClick={onClick}
    >
      {index + 1}
    </button>
  );
}

function BackButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="p-2 -ml-1.5 rounded-xl text-muted hover:text-content hover:bg-hover transition-colors"
      onClick={() => {
        if (window.history.length > 1) router.back();
        else router.push('/');
      }}
      aria-label="返回"
    >
      <Icon name="chevronLeft" className="w-5 h-5" />
    </button>
  );
}

function HomeButton() {
  return (
    <Link
      href="/"
      className="p-2 rounded-xl text-muted hover:text-content hover:bg-hover transition-colors"
      aria-label="回首页"
      title="回首页"
    >
      <Icon name="home" className="w-4 h-4" />
    </Link>
  );
}
