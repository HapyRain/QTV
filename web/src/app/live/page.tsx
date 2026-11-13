'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import { api } from '@/lib/client-api';
import { copyToClipboard } from '@/lib/clipboard';
import { Header, requestShowSettings } from '@/components/header';
import { LiveChannelList, type LiveChannelItem } from '@/components/live-channel-list';
import { LiveEpgPanel } from '@/components/live-epg-panel';
import { Spinner } from '@/components/states';
import { allLiveSources, useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { SmartImage } from '@/components/smart-image';
import { Icon } from '@/components/icon';
import { useToast } from '@/components/toast';

const LivePlayer = dynamic(() => import('@/components/live-player').then((m) => m.LivePlayer), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center bg-black">
      <Spinner size="lg" />
    </div>
  ),
});

/**
 * 移动端电视直播中心（/live）：
 * - 彻底摒弃旧版「右下角 FAB 呼出抽屉选台，关闭后下方大片空白」的桌面妥协设计；
 * - 上半屏 Sticky 固定置顶：16:9 播放器 + 紧凑频道控制栏（台标、当前台名、回看上一台、上/下一台、收藏、复制、节目单切换）；
 * - 下半屏独占剩余视口高度：直接内嵌完整的虚拟滚动频道列表工作台（或一键切换查看当前频道 EPG 节目单），真正做到边看边选台。
 */
export default function LivePage() {
  return (
    <Suspense>
      <LiveContent />
    </Suspense>
  );
}

function LiveContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { toast } = useToast();
  const liveSelectedUrls = useAppStore((s) => s.liveSelectedUrls);
  const liveEnvSources = useAppStore((s) => s.liveEnvSources);
  const liveSubscriptions = useAppStore((s) => s.liveSubscriptions);
  const liveFavorites = useAppStore((s) => s.liveFavorites);
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const volumeBoost = useAppStore((s) => s.volumeBoost);
  const customImageProxy = useAppStore((s) => s.customImageProxy);

  const [panelMode, setPanelMode] = useState<'channels' | 'epg'>('channels');
  const [logoFailed, setLogoFailed] = useState(false);

  const filteredRef = useRef<LiveChannelItem[]>([]);
  const currentChannelRef = useRef<LiveChannelItem | undefined>(undefined);
  const lastChannelRef = useRef<LiveChannelItem | null>(null);

  const sources = useMemo(() => {
    const selected = new Set(liveSelectedUrls);
    return allLiveSources({ liveEnvSources, liveSubscriptions }).filter((s) => selected.has(s.url));
  }, [liveSelectedUrls, liveEnvSources, liveSubscriptions]);

  const playlistsQuery = useQuery({
    queryKey: ['livePlaylists', sources.map((s) => s.url).join('|')],
    queryFn: async () => {
      const results = await Promise.allSettled(sources.map((s) => api.livePlaylist(s.url)));
      return sources.map((source, i) => ({ source, result: results[i] }));
    },
    enabled: sources.length > 0,
    staleTime: 10 * 60_000,
  });

  const { channels, groups, failedCount } = useMemo(() => {
    const list: LiveChannelItem[] = [];
    const seen = new Set<string>();
    let failed = 0;
    for (const { source, result } of playlistsQuery.data ?? []) {
      if (result.status !== 'fulfilled') {
        failed++;
        continue;
      }
      for (const c of result.value.channels) {
        if (seen.has(c.url)) continue;
        seen.add(c.url);
        list.push({ ...c, epg: source.epg, sourceUrl: source.url });
      }
    }
    const groups = [...new Set(list.map((c) => c.group).filter((g): g is string => Boolean(g)))].sort(
      (a, b) => a.localeCompare(b, 'zh')
    );
    return { channels: list, groups, failedCount: failed };
  }, [playlistsQuery.data]);

  const currentUrl = searchParams.get('url') || '';
  const currentChannel = useMemo(() => {
    const found = channels.find((c) => c.url === currentUrl);
    if (found) return found;
    if (!currentUrl) return undefined;
    return {
      id: searchParams.get('tvgId') || currentUrl,
      url: currentUrl,
      name: searchParams.get('name') || '未知频道',
      group: searchParams.get('group') || undefined,
      tvgId: searchParams.get('tvgId') || undefined,
      epg: searchParams.get('epg') || undefined,
    } as LiveChannelItem;
  }, [channels, currentUrl, searchParams]);

  useEffect(() => {
    setLogoFailed(false);
  }, [currentChannel?.url]);
  useEffect(() => {
    currentChannelRef.current = currentChannel;
  }, [currentChannel]);

  const selectChannel = useCallback(
    (c: LiveChannelItem) => {
      const cur = currentChannelRef.current;
      if (cur && cur.url !== c.url) lastChannelRef.current = cur;
      const sp = new URLSearchParams({ url: c.url, name: c.name });
      if (c.group) sp.set('group', c.group);
      if (c.tvgId) sp.set('tvgId', c.tvgId);
      if (c.epg) sp.set('epg', c.epg);
      router.replace(`/live?${sp.toString()}`, { scroll: false });
      useAppStore.getState().addLiveRecent({
        url: c.url,
        name: c.name,
        logo: c.logo,
        group: c.group,
        tvgId: c.tvgId,
        epg: c.epg,
        sourceUrl: c.sourceUrl,
      });
    },
    [router]
  );

  const handleFilteredChange = useCallback((list: LiveChannelItem[]) => {
    filteredRef.current = list;
  }, []);

  const switchChannelByOffset = useCallback(
    (delta: 1 | -1) => {
      const list = filteredRef.current;
      if (list.length === 0) return;
      const nowUrl = new URLSearchParams(window.location.search).get('url') || '';
      const idx = list.findIndex((c) => c.url === nowUrl);
      const next =
        idx === -1 ? (delta === 1 ? 0 : list.length - 1) : (idx + delta + list.length) % list.length;
      selectChannel(list[next]);
    },
    [selectChannel]
  );

  const goPrevChannel = useCallback(() => switchChannelByOffset(-1), [switchChannelByOffset]);
  const goNextChannel = useCallback(() => switchChannelByOffset(1), [switchChannelByOffset]);

  const backToPrevChannel = useCallback(() => {
    const prev = lastChannelRef.current;
    if (!prev) return;
    lastChannelRef.current = null;
    selectChannel(prev);
  }, [selectChannel]);

  const logo = currentChannel?.logo;
  const isFavorite = currentChannel ? liveFavorites.includes(currentChannel.url) : false;

  return (
    <div className="h-[100dvh] flex flex-col overflow-hidden bg-page pb-tabbar">
      {/* 上半屏固定置顶：沉浸黑底安全区 + 16:9 播放器 + 紧凑控制栏 */}
      <div className="shrink-0 bg-black safe-top border-b border-line/60">
        <div className="relative aspect-video w-full max-w-3xl mx-auto bg-black overflow-hidden">
          {currentUrl ? (
            <LivePlayer
              url={currentUrl}
              title={currentChannel?.name || '电视直播'}
              onPrevChannel={goPrevChannel}
              onNextChannel={goNextChannel}
              volumeBoost={volumeBoost}
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center gap-3 px-6 text-center bg-gradient-to-b from-[#0b1220] to-black">
              <div className="flex items-center gap-2 rounded-full bg-white/10 px-3 py-1">
                <span className="live-dot" />
                <span className="text-xs font-semibold text-white/90 tracking-wider">LIVE 电视中心</span>
              </div>
              <p className="text-white/65 text-xs leading-relaxed max-w-xs">
                {sources.length === 0
                  ? liveEnvSources.length + liveSubscriptions.length > 0
                    ? '当前直播源未勾选启用，请点击下方按钮开启'
                    : '尚未配置 M3U 直播源，添加后即可观看卫视频道'
                  : playlistsQuery.isLoading
                    ? '正在同步频道列表...'
                    : `已就绪 ${channels.length} 个频道，点按下方列表即刻开播`}
              </p>
              {sources.length === 0 && (
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

        {/* 紧凑型当前频道状态与快捷控制栏 */}
        <div className="bg-surface-raised px-3 py-2 flex items-center justify-between gap-2 max-w-3xl mx-auto">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <div className="w-8 h-8 shrink-0 rounded-lg bg-chip flex items-center justify-center overflow-hidden ring-1 ring-white/5">
              {logo && !logoFailed ? (
                <SmartImage
                  url={logo}
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
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                {currentChannel && <span className="live-dot shrink-0" />}
                <h1 className="text-xs font-bold text-content truncate">
                  {currentChannel ? currentChannel.name : '请选择下方频道播放'}
                </h1>
              </div>
              <p className="text-[11px] text-faint truncate">
                {currentChannel?.group || (channels.length > 0 ? `共 ${channels.length} 个频道在线` : '待加载频道')}
              </p>
            </div>
          </div>

          {/* 换台、收藏与节目单切换按钮组 */}
          <div className="flex items-center gap-1 shrink-0">
            {currentChannel && (
              <>
                <button
                  type="button"
                  className={cn(
                    'pressable rounded-lg p-1.5 transition-colors',
                    lastChannelRef.current ? 'text-muted hover:text-accent bg-chip/70' : 'text-faint/35'
                  )}
                  onClick={backToPrevChannel}
                  aria-label="回看上一频道"
                  title="回看上一频道"
                >
                  <Icon name="undo" className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  className="pressable rounded-lg p-1.5 bg-chip/70 text-muted hover:text-accent"
                  onClick={goPrevChannel}
                  aria-label="上一台"
                >
                  <Icon name="chevronLeft" className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  className="pressable rounded-lg p-1.5 bg-chip/70 text-muted hover:text-accent"
                  onClick={goNextChannel}
                  aria-label="下一台"
                >
                  <Icon name="chevronRight" className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  className={cn(
                    'pressable rounded-lg p-1.5 bg-chip/70 transition-colors',
                    isFavorite ? 'text-warning' : 'text-muted'
                  )}
                  onClick={() => useAppStore.getState().toggleLiveFavorite(currentChannel.url)}
                  aria-label={isFavorite ? '取消收藏' : '收藏频道'}
                >
                  <svg
                    className="w-4 h-4"
                    fill={isFavorite ? 'currentColor' : 'none'}
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.196-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.783-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
                    />
                  </svg>
                </button>
                <button
                  type="button"
                  className="pressable rounded-lg p-1.5 bg-chip/70 text-muted hover:text-accent"
                  onClick={async () => {
                    const ok = await copyToClipboard(currentChannel.url);
                    if (ok) toast('直播流地址已复制', 'success');
                  }}
                  aria-label="复制流地址"
                >
                  <Icon name="copy" className="w-4 h-4" />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => setPanelMode((m) => (m === 'channels' ? 'epg' : 'channels'))}
              className={cn(
                'pressable rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors',
                panelMode === 'epg' ? 'bg-accent text-on-accent' : 'bg-chip text-muted'
              )}
            >
              {panelMode === 'epg' ? '选台' : '节目单'}
            </button>
          </div>
        </div>
      </div>

      {/* 下半屏：直接内嵌完整的虚拟滚动频道列表工作台或节目单 */}
      <main className="flex-1 min-h-0 max-w-3xl w-full mx-auto flex flex-col overflow-hidden">
        {panelMode === 'epg' && currentChannel ? (
          <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-3 animate-fade-in">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-content">{currentChannel.name} · 节目单</h2>
              <button
                type="button"
                onClick={() => setPanelMode('channels')}
                className="text-xs font-medium text-accent"
              >
                返回频道列表
              </button>
            </div>
            <LiveEpgPanel epgUrl={currentChannel.epg} tvgId={currentChannel.tvgId} />
          </div>
        ) : playlistsQuery.isLoading && channels.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2">
            <Spinner size="lg" />
            <span className="text-xs text-faint">正在加载频道列表...</span>
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col">
            <LiveChannelList
              channels={channels}
              groups={groups}
              currentUrl={currentUrl}
              onSelect={selectChannel}
              onFilteredChange={handleFilteredChange}
            />
            {(failedCount > 0 || sources.length === 0) && (
              <div className="text-[11px] text-faint px-3 py-1.5 border-t border-line/60 flex items-center justify-between shrink-0">
                <span>
                  {sources.length === 0
                    ? '暂未启用直播源'
                    : `${failedCount > 0 ? `${failedCount} 个源拉取失败 · ` : ''}已启用 ${sources.length} 个直播源`}
                </span>
                <button
                  type="button"
                  onClick={() => requestShowSettings('sources')}
                  className="text-accent font-medium"
                >
                  管理直播源
                </button>
              </div>
            )}
          </div>
        )}
      </main>

      <Header />
    </div>
  );
}
