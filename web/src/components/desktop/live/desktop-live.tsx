'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import { requestShowSettings } from '@/components/header';
import { LiveChannelList, type LiveChannelItem } from '@/components/live-channel-list';
import { LiveEpgPanel } from '@/components/live-epg-panel';
import { SmartImage } from '@/components/smart-image';
import { Spinner } from '@/components/states';
import { Icon } from '@/components/icon';
import { useToast } from '@/components/toast';
import { copyToClipboard } from '@/lib/clipboard';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';

const LivePlayer = dynamic(() => import('@/components/live-player').then((m) => m.LivePlayer), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center bg-black">
      <Spinner size="lg" />
    </div>
  ),
});

export interface DesktopLiveProps {
  channels: LiveChannelItem[];
  groups: string[];
  currentUrl: string;
  currentChannel?: LiveChannelItem;
  loading: boolean;
  /** 已完成的源数，用于显示增量加载进度 */
  loadedSources?: number;
  sourceCount: number;
  failedCount: number;
  volumeBoost: boolean;
  onSelect: (channel: LiveChannelItem) => void;
  onFilteredChange: (list: LiveChannelItem[]) => void;
  onPrevChannel: () => void;
  onNextChannel: () => void;
}

/**
 * Windows 桌面宽屏直播页：左侧 16:9 播放器 + 频道信息条，右侧 340px 频道/EPG 工作台。
 *
 * 频道数据源、URL 解析、选中跳转（selectChannel 会 router.replace 并写「最近观看」）
 * 全部沿用 live/page.tsx 的 useQuery，这里只负责桌面排版与播放器外壳。
 */
export function DesktopLive({
  channels,
  groups,
  currentUrl,
  currentChannel,
  loading,
  loadedSources = 0,
  sourceCount,
  failedCount,
  volumeBoost,
  onSelect,
  onFilteredChange,
  onPrevChannel,
  onNextChannel,
}: DesktopLiveProps) {
  const { toast } = useToast();
  const liveFavorites = useAppStore((s) => s.liveFavorites);
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);

  const [panelMode, setPanelMode] = useState<'channels' | 'epg'>('channels');
  const [logoFailed, setLogoFailed] = useState(false);

  const isFavorite = currentChannel ? liveFavorites.includes(currentChannel.url) : false;

  return (
    <div className="desktop-main bg-page">
      <div className="flex-1 min-h-0 grid grid-cols-[minmax(0,1fr)_340px]">
        {/* 左：频道信息条 + 16:9 直播播放器 */}
        <section className="flex flex-col min-w-0 min-h-0">
          <header className="h-12 shrink-0 flex items-center gap-3 px-4 bg-surface/70 border-b border-line/60">
            <div className="w-8 h-8 shrink-0 rounded-lg bg-chip flex items-center justify-center overflow-hidden ring-1 ring-white/5">
              {currentChannel?.logo && !logoFailed ? (
                <SmartImage
                  url={currentChannel.logo}
                  mode={imageProxyMode}
                  customProxy={customImageProxy}
                  alt=""
                  className="w-full h-full object-contain"
                  onExhausted={() => setLogoFailed(true)}
                />
              ) : (
                <Icon name="tv" className="w-4 h-4 text-accent" />
              )}
            </div>

            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                {currentChannel && <span className="live-dot shrink-0" />}
                <h1 className="text-sm font-semibold text-content truncate">
                  {currentChannel ? currentChannel.name : '从右侧频道列表选择频道开播'}
                </h1>
              </div>
              <p className="text-[11px] text-faint truncate">
                {currentChannel?.group ||
                  (channels.length > 0 ? `共 ${channels.length} 个频道在线` : '待加载频道')}
              </p>
            </div>

            <div className="ml-auto flex items-center gap-1 shrink-0">
              {currentChannel && (
                <>
                  <button
                    type="button"
                    className={cn(
                      'p-1.5 rounded-lg bg-chip/70 transition-colors',
                      isFavorite ? 'text-warning' : 'text-muted hover:text-accent'
                    )}
                    onClick={() => useAppStore.getState().toggleLiveFavorite(currentChannel.url)}
                    aria-label={isFavorite ? '取消收藏' : '收藏频道'}
                    title={isFavorite ? '取消收藏' : '收藏频道'}
                  >
                    <Icon name="star" className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    className="p-1.5 rounded-lg bg-chip/70 text-muted hover:text-accent"
                    onClick={async () => {
                      const ok = await copyToClipboard(currentChannel.url);
                      if (ok) toast('直播流地址已复制', 'success');
                    }}
                    aria-label="复制流地址"
                    title="复制流地址"
                  >
                    <Icon name="copy" className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    className="p-1.5 rounded-lg bg-chip/70 text-muted hover:text-accent"
                    onClick={onPrevChannel}
                    aria-label="上一台"
                    title="上一台"
                  >
                    <Icon name="chevronLeft" className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    className="p-1.5 rounded-lg bg-chip/70 text-muted hover:text-accent"
                    onClick={onNextChannel}
                    aria-label="下一台"
                    title="下一台"
                  >
                    <Icon name="chevronRight" className="w-4 h-4" />
                  </button>
                </>
              )}
              <button
                type="button"
                className={cn(
                  'ml-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors',
                  panelMode === 'epg' ? 'bg-accent text-on-accent' : 'bg-chip text-muted hover:text-content'
                )}
                onClick={() => setPanelMode((m) => (m === 'channels' ? 'epg' : 'channels'))}
              >
                {panelMode === 'epg' ? '选台' : '节目单'}
              </button>
            </div>
          </header>

          <div className="flex-1 min-h-0 bg-black flex items-center justify-center overflow-hidden">
            <div className="relative w-full aspect-video max-h-full bg-black overflow-hidden">
              {currentUrl ? (
                <LivePlayer
                  url={currentUrl}
                  title={currentChannel?.name || '电视直播'}
                  onPrevChannel={onPrevChannel}
                  onNextChannel={onNextChannel}
                  volumeBoost={volumeBoost}
                />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center gap-3 px-6 text-center bg-gradient-to-b from-[#0b1220] to-black">
                  <div className="flex items-center gap-2 rounded-full bg-white/10 px-3 py-1">
                    <span className="live-dot" />
                    <span className="text-xs font-semibold text-white/90 tracking-wider">LIVE 导播工作台</span>
                  </div>
                  <p className="text-white/65 text-xs leading-relaxed max-w-sm">
                    {sourceCount === 0
                      ? '尚未启用 M3U 直播源，添加后即可观看卫视频道'
                      : loading
                        ? `正在同步频道列表... ${loadedSources}/${sourceCount} 个源`
                        : `已就绪 ${channels.length} 个直播频道，点击右侧列表即可播放`}
                  </p>
                  {sourceCount === 0 && (
                    <button
                      type="button"
                      onClick={() => requestShowSettings('sources')}
                      className="btn-primary btn-sm"
                    >
                      <Icon name="plus" className="w-3.5 h-3.5" />
                      配置直播源
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* 右：频道列表 / EPG 节目单 */}
        <aside className="acrylic-modal border-l border-line/60 flex flex-col min-h-0">
          <div className="shrink-0 px-3 h-10 flex items-center gap-2 border-b border-line/60">
            <span className="text-xs font-semibold text-content">
              {panelMode === 'epg' ? '电子节目单' : '频道列表'}
            </span>
            {panelMode === 'epg' && currentChannel && (
              <span className="text-[11px] text-faint truncate">{currentChannel.name}</span>
            )}
            <button
              type="button"
              onClick={() => setPanelMode('channels')}
              className="ml-auto text-[11px] font-medium text-accent"
            >
              选台
            </button>
          </div>

          {panelMode === 'epg' ? (
            <div className="flex-1 min-h-0 desktop-scroll p-3 space-y-3 animate-fade-in">
              {currentChannel ? (
                <LiveEpgPanel epgUrl={currentChannel.epg} tvgId={currentChannel.tvgId} />
              ) : (
                <p className="text-xs text-faint py-10 text-center">选择频道后加载节目单</p>
              )}
            </div>
          ) : loading && channels.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-2">
              <Spinner size="lg" />
              <span className="text-xs text-faint">正在加载频道列表... {loadedSources}/{sourceCount} 个源</span>
            </div>
          ) : (
            <div className="flex-1 min-h-0">
              <LiveChannelList
                channels={channels}
                groups={groups}
                currentUrl={currentUrl}
                onSelect={onSelect}
                onFilteredChange={onFilteredChange}
              />
            </div>
          )}

          <div className="shrink-0 px-3 py-1.5 border-t border-line/60 text-[11px] text-faint flex items-center justify-between gap-2">
            <span className="truncate">
              {sourceCount === 0
                ? '暂未启用直播源'
                : `${failedCount > 0 ? `${failedCount} 个源拉取失败 · ` : ''}已启用 ${sourceCount} 个直播源`}
            </span>
            <button
              type="button"
              onClick={() => requestShowSettings('sources')}
              className="text-accent font-medium shrink-0"
            >
              管理直播源
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
