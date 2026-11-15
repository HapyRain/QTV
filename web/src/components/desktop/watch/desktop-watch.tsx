'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Header } from '@/components/header';
import { SwitchSourceModal } from '@/components/switch-source';
import { SkipMarkPanel } from '@/components/skip-mark-panel';
import { EmptyState, LoadingState, Spinner } from '@/components/states';
import { Icon } from '@/components/icon';
import { enqueueDownload, requestShowDownloadManager } from '@/components/download-manager';
import { cn } from '@/lib/utils';
import type { VideoInfo } from '@/lib/types';

const PlayerShell = dynamic(() => import('@/components/player-shell').then((m) => m.PlayerShell), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center">
      <Spinner size="lg" />
    </div>
  ),
});

/** 播放器实例属性类型直接取自 PlayerShell，桌面端换源/换集时与移动端保持同一份 props */
export type DesktopPlayerProps = React.ComponentProps<typeof PlayerShell>;
export type WatchTab = 'episodes' | 'skip' | 'info';
type PlayerClockGetter = NonNullable<React.ComponentProps<typeof SkipMarkPanel>['getPlayerClock']>;

export interface DesktopWatchProps {
  player: DesktopPlayerProps;
  sourceKey: string;
  vodId: string;
  title: string;
  sourceName: string;
  qualityLabel: string | null;
  info?: VideoInfo;
  currentIndex: number;
  /** 当前集是否已有离线缓存（页面层查库后传入） */
  cachedLocal?: boolean;
  episodeCount: number;
  tab: WatchTab;
  onTabChange: (tab: WatchTab) => void;
  reversed: boolean;
  onToggleReversed: () => void;
  chunked: boolean;
  chunks: { idx: number; label: string }[];
  chunkIndex: number;
  onChunkChange: (index: number) => void;
  visibleEpisodes: number[];
  onSelectEpisode: (index: number) => void;
  onPrevEpisode: () => void;
  onNextEpisode: () => void;
  markedCount: number;
  markKey: string;
  pendingStart: number | null;
  onPendingStart: (start: number | null) => void;
  getPlayerClock: PlayerClockGetter;
  detailLoading: boolean;
  detailError: boolean;
}

/**
 * Windows 桌面宽屏点播页：左侧 16:9 影院播放器 + 右侧 340px 工作台。
 *
 * 状态与副作用（继续观看记录、进度上报、自动连播、片头片尾打点）全部留在 watch/page.tsx，
 * 这里只做渲染，保证桌面/移动两个分支共用同一套数据链路，不存在两套播放逻辑。
 */
export function DesktopWatch({
  player,
  sourceKey,
  vodId,
  title,
  sourceName,
  qualityLabel,
  info,
  currentIndex,
  cachedLocal = false,
  episodeCount,
  tab,
  onTabChange,
  reversed,
  onToggleReversed,
  chunked,
  chunks,
  chunkIndex,
  onChunkChange,
  visibleEpisodes,
  onSelectEpisode,
  onPrevEpisode,
  onNextEpisode,
  markedCount,
  markKey,
  pendingStart,
  onPendingStart,
  getPlayerClock,
  detailLoading,
  detailError,
}: DesktopWatchProps) {
  const router = useRouter();
  const [switchOpen, setSwitchOpen] = useState(false);

  return (
    <div className="desktop-main bg-page">
      <div className="flex-1 min-h-0 grid grid-cols-[minmax(0,1fr)_340px]">
        {/* 左：信息栏 + 16:9 播放器 + 快捷键提示 */}
        <section className="flex flex-col min-w-0 min-h-0">
          <header className="h-12 shrink-0 flex items-center gap-3 px-4 bg-surface/70 border-b border-line/60">
            <button
              type="button"
              className="p-1.5 -ml-1 rounded-lg text-muted hover:text-content hover:bg-hover transition-colors"
              onClick={() => (window.history.length > 1 ? router.back() : router.push('/'))}
              aria-label="返回"
            >
              <Icon name="chevronLeft" className="w-5 h-5" />
            </button>

            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <h1 className="text-sm font-semibold text-content truncate">{title}</h1>
                {qualityLabel && (
                  <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-accent/15 text-accent tabular-nums">
                    {qualityLabel}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-faint truncate tabular-nums">
                {sourceName}
                {episodeCount > 0 && ` · 第 ${currentIndex + 1} / ${episodeCount} 集`}
              </p>
            </div>

            <div className="ml-auto flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                className="btn-ghost btn-sm !px-2.5 !py-1.5 text-xs"
                disabled={currentIndex <= 0}
                onClick={onPrevEpisode}
              >
                <Icon name="chevronLeft" className="w-3.5 h-3.5" />
                上一集
              </button>
              <button
                type="button"
                className="btn-ghost btn-sm !px-2.5 !py-1.5 text-xs"
                disabled={episodeCount === 0 || currentIndex >= episodeCount - 1}
                onClick={onNextEpisode}
              >
                下一集
                <Icon name="chevronRight" className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                className="btn-ghost btn-sm !px-2.5 !py-1.5 text-xs"
                onClick={() => setSwitchOpen(true)}
              >
                <Icon name="refresh" className="w-3.5 h-3.5" />
                换源
              </button>
              <button
                type="button"
                className="btn-ghost btn-sm !px-2.5 !py-1.5 text-xs"
                aria-label={cachedLocal ? '已缓存，打开缓存中心' : '缓存本集'}
                onClick={() => {
                  if (cachedLocal) {
                    requestShowDownloadManager();
                    return;
                  }
                  if (!player.url) return;
                  enqueueDownload({
                    url: player.url,
                    title: `${title}${episodeCount > 1 ? ` 第${currentIndex + 1}集` : ''}`,
                    format: 'MP4',
                    episodeKey: player.episodeKey,
                    sourceKey,
                    vodId,
                    episodeIndex: currentIndex,
                  });
                }}
              >
                <Icon name="download" className="w-3.5 h-3.5" />
                {cachedLocal ? '已缓存' : '缓存'}
              </button>
              <Link
                href="/"
                className="p-1.5 rounded-lg text-muted hover:text-content hover:bg-hover transition-colors"
                aria-label="回首页"
                title="回首页"
              >
                <Icon name="home" className="w-4 h-4" />
              </Link>
            </div>
          </header>

          <div className="flex-1 min-h-0 bg-black flex items-center justify-center overflow-hidden">
            <div className="relative w-full aspect-video max-h-full bg-black overflow-hidden">
              {player.url ? (
                <PlayerShell {...player} />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  {detailLoading ? (
                    <Spinner size="lg" />
                  ) : (
                    <p className="text-faint text-sm">
                      {detailError ? '视频加载失败，请点右上角「换源」重试' : '暂无可用播放地址'}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* 快捷键由 PlayerShell 内部的 document keydown 统一处理，这里只做提示，避免重复绑定 */}
          <footer className="h-8 shrink-0 flex items-center justify-end gap-3 px-4 bg-surface/60 border-t border-line/60 text-[11px] text-faint">
            <ShortcutHint keys="Space" label="播放/暂停" />
            <ShortcutHint keys="←/→" label="快退快进 5s" />
            <ShortcutHint keys="↑/↓" label="音量" />
            <ShortcutHint keys="F" label="全屏" />
            <ShortcutHint keys="Esc" label="退出全屏" />
          </footer>
        </section>

        {/* 右：acrylic 工作台（选集 / 片头片尾 / 简介） */}
        <aside className="acrylic-modal border-l border-line/60 flex flex-col min-h-0">
          <div className="shrink-0 p-2.5 border-b border-line/60">
            <div className="flex p-1 rounded-xl bg-chip/70 border border-line/60" role="tablist" aria-label="播放工作台">
              <TabButton active={tab === 'episodes'} onClick={() => onTabChange('episodes')}>
                选集 {episodeCount > 0 ? episodeCount : ''}
              </TabButton>
              <TabButton active={tab === 'skip'} onClick={() => onTabChange('skip')}>
                片头片尾 {markedCount > 0 ? markedCount : ''}
              </TabButton>
              <TabButton active={tab === 'info'} onClick={() => onTabChange('info')}>
                简介
              </TabButton>
            </div>
          </div>

          <div className="flex-1 min-h-0 desktop-scroll p-3.5">
            {tab === 'episodes' && (
              <div className="space-y-3 animate-fade-in">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs text-muted">
                    当前播放：<span className="text-content font-semibold">第 {currentIndex + 1} 集</span>
                  </div>
                  {episodeCount > 1 && (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-muted hover:text-content"
                      onClick={onToggleReversed}
                    >
                      <Icon
                        name="arrowDown"
                        className={cn('w-3 h-3 transition-transform', reversed && 'rotate-180')}
                      />
                      {reversed ? '正序' : '倒序'}
                    </button>
                  )}
                </div>

                {chunked && (
                  <div className="flex flex-wrap gap-1.5">
                    {chunks.map((c) => (
                      <button
                        key={c.idx}
                        type="button"
                        className={cn(
                          'chip tabular-nums',
                          chunkIndex === c.idx
                            ? 'bg-accent/15 text-accent font-semibold border border-accent/30'
                            : 'text-muted hover:text-content'
                        )}
                        onClick={() => onChunkChange(c.idx)}
                      >
                        {c.label} 集
                      </button>
                    ))}
                  </div>
                )}

                {episodeCount === 0 ? (
                  detailLoading ? (
                    <LoadingState />
                  ) : (
                    <EmptyState variant="plain" title={detailError ? '获取剧集失败' : '暂无剧集列表'} />
                  )
                ) : (
                  <div className="grid grid-cols-6 gap-2">
                    {visibleEpisodes.map((realIndex) => (
                      <button
                        key={realIndex}
                        type="button"
                        className={cn(
                          'aspect-square rounded-xl text-xs font-medium tabular-nums transition-colors',
                          realIndex === currentIndex
                            ? 'episode-active shadow-sm'
                            : 'bg-chip/60 text-muted hover:text-content hover:bg-hover'
                        )}
                        onClick={() => onSelectEpisode(realIndex)}
                      >
                        {realIndex + 1}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {tab === 'skip' && (
              <div className="animate-fade-in">
                <SkipMarkPanel
                  open
                  inline
                  onClose={() => onTabChange('episodes')}
                  markKey={markKey}
                  pendingStart={pendingStart}
                  onPendingStart={onPendingStart}
                  getPlayerClock={getPlayerClock}
                />
              </div>
            )}

            {tab === 'info' && (
              <div className="space-y-3 animate-fade-in">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="chip bg-accent/15 text-accent font-medium">{sourceName}</span>
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
              </div>
            )}
          </div>
        </aside>
      </div>

      {switchOpen && (
        <SwitchSourceModal
          currentTitle={title}
          currentSourceKey={sourceKey}
          currentVodId={vodId}
          currentIndex={currentIndex}
          onClose={() => setSwitchOpen(false)}
        />
      )}

      <Header />
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={cn(
        'flex-1 py-1.5 text-xs font-medium rounded-lg transition-all tabular-nums',
        active ? 'bg-surface-raised text-accent shadow-sm' : 'text-muted hover:text-content'
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ShortcutHint({ keys, label }: { keys: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="kbd-cap">{keys}</span>
      {label}
    </span>
  );
}
