'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import { Header, requestShowHistory, requestShowSettings } from '@/components/header';
import { requestShowDownloadManager } from '@/components/download-manager';
import { DetailModal } from '@/components/detail-modal';
import { AggregatedCard, aggregateResults } from '@/components/video-card';
import { useAppStore, resolveSource, isInDisabledSubscription, isSourceDisabled } from '@/lib/store';
import { api } from '@/lib/client-api';
import type { SearchResultItem, SourceSearchOutcome } from '@/lib/types';
import { useSearchHistory } from '@/components/search-history';
import { buildWatchUrl, cn, formatDisableTtl, formatTime, validateSourceUrl } from '@/lib/utils';
import { useToast } from '@/components/toast';
import { EmptyState } from '@/components/states';
import { Icon } from '@/components/icon';
import { SiteFooter } from '@/components/site-footer';
import { SmartImage } from '@/components/smart-image';
import { useTheme } from '@/components/theme';
import { useAuth } from '@/components/auth';
import { Switch } from '@/components/settings-shared';
import { db } from '@/lib/db';
import { playedMinutesToday } from '@/lib/playtime-reminder';

const RESULT_PAGE_SIZE = 60;

/** 按当前时段生成温馨观影问候语 */
function getTimeGreeting(): { title: string; subtitle: string } {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 11) {
    return { title: '早安，开启美好一天', subtitle: '清晨时光 · 随时搜想看的剧' };
  }
  if (hour >= 11 && hour < 14) {
    return { title: '午安，小憩片刻', subtitle: '午休充电 · 轻松追一集下饭剧' };
  }
  if (hour >= 14 && hour < 18) {
    return { title: '下午好，愿心情明朗', subtitle: '忙里偷闲 · 聚合多源秒速直达' };
  }
  if (hour >= 18 && hour < 23) {
    return { title: '晚上好，专属观影时刻', subtitle: '卸下疲惫 · 沉浸式无广告看片' };
  }
  return { title: '夜深了，注意护眼休息', subtitle: '深夜剧场 · 看完这集早点睡哦' };
}

export default function HomePage() {
  return (
    <Suspense>
      <HomeContent />
    </Suspense>
  );
}

function HomeContent() {
  const searchParams = useSearchParams();
  const activeTab = searchParams.get('tab') || 'explore';

  if (activeTab === 'profile') {
    return <ProfileHubView />;
  }
  return <ExploreView />;
}

/**
 * [Tab 1: 探索]
 * - 顶部时段温馨问候语 + 外观切换 + 源状态指示；
 * - 灵动大搜索框 + 最近搜索胶囊标签云（单手一触即搜）；
 * - 首屏「继续观看」横向海报进度画廊（IndexedDB 实时驱动，一点即续播）；
 * - 流式聚合搜索进度条 + 映画卡片列表。
 */
function ExploreView() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { toast } = useToast();
  const { resolved: themeMode, setTheme } = useTheme();
  const urlQuery = searchParams.get('s') || '';

  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const sourceHealth = useAppStore((s) => s.sourceHealth);
  const subscriptions = useAppStore((s) => s.subscriptions);
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);

  const [input, setInput] = useState(urlQuery);
  const [detailItem, setDetailItem] = useState<SearchResultItem | null>(null);
  const [streamedOutcomes, setStreamedOutcomes] = useState<SourceSearchOutcome[]>([]);
  const [greeting, setGreeting] = useState({ title: '专属观影时刻', subtitle: '聚合搜索 · 多源直连 · 纯净无广' });
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setGreeting(getTimeGreeting());
  }, []);

  useEffect(() => {
    setInput(urlQuery);
  }, [urlQuery]);

  // IndexedDB 实时读取最近观看记录（首屏「继续观看」画廊）
  const recentHistory = useLiveQuery(
    () => db.history.orderBy('timestamp').reverse().limit(12).toArray(),
    []
  );

  const sourceName = (key: string) =>
    customAPIs.find((a) => a.key === key)?.name ??
    envSources.find((a) => a.key === key)?.name ??
    key;

  const selectedSources = useMemo(() => {
    const seen = new Set<string>();
    return selectedKeys
      .map((key) => resolveSource({ customAPIs, envSources }, key))
      .filter((s): s is NonNullable<typeof s> => {
        if (!s || !validateSourceUrl(s.url) || seen.has(s.key)) return false;
        seen.add(s.key);
        return true;
      })
      .filter((s) => !isSourceDisabled({ sourceHealth }, s.key))
      .filter((s) => !isInDisabledSubscription({ subscriptions }, s.key));
  }, [customAPIs, envSources, selectedKeys, sourceHealth, subscriptions]);

  const disabledSources = useMemo(
    () => selectedKeys.filter((key) => isSourceDisabled({ sourceHealth }, key)),
    [selectedKeys, sourceHealth]
  );

  const offSubscriptionSources = useMemo(
    () =>
      selectedKeys.filter(
        (key) => !isSourceDisabled({ sourceHealth }, key) && isInDisabledSubscription({ subscriptions }, key)
      ),
    [selectedKeys, sourceHealth, subscriptions]
  );

  const searchQuery = useQuery({
    queryKey: ['search', urlQuery, selectedKeys, yellowFilter],
    queryFn: ({ signal }) => {
      setStreamedOutcomes([]);
      return api.search(urlQuery.slice(0, 100), selectedSources, yellowFilter, {
        signal,
        onSource: (outcome) => {
          setStreamedOutcomes((prev) => [...prev, outcome]);
          for (const ev of useAppStore.getState().recordSourceHealth([outcome])) {
            toast(
              ev.permanent
                ? `「${sourceName(ev.key)}」多次无响应，已自动停用`
                : `「${sourceName(ev.key)}」超时，暂停 ${formatDisableTtl(ev.ttlMs ?? 0)}`,
              'warning'
            );
          }
        },
      });
    },
    enabled: Boolean(urlQuery) && selectedSources.length > 0,
    staleTime: 300_000,
  });

  const searchHistory = useSearchHistory('');

  const runSearch = (q: string) => {
    const query = q.trim().slice(0, 100);
    if (!query) {
      toast('请输入想看的影视名称', 'info');
      inputRef.current?.focus();
      return;
    }
    if (selectedSources.length === 0) {
      toast('请先添加并启用至少一个点播源', 'warning');
      requestShowSettings('sources');
      return;
    }
    inputRef.current?.blur();
    router.push(`/?s=${encodeURIComponent(query)}`, { scroll: false });
    searchHistory.record(query);
  };

  const clearSearch = () => {
    setInput('');
    if (urlQuery) {
      router.push('/', { scroll: false });
    } else {
      inputRef.current?.focus();
    }
  };

  const isSearching = Boolean(urlQuery) && searchQuery.isFetching && !searchQuery.data;
  const streamedList = useMemo(() => streamedOutcomes.flatMap((o) => o.list), [streamedOutcomes]);
  const list = useMemo(() => {
    if (searchQuery.data) {
      if (streamedOutcomes.length > 0) return streamedList;
      return searchQuery.data.list;
    }
    return isSearching ? streamedList : [];
  }, [searchQuery.data, isSearching, streamedList, streamedOutcomes.length]);

  const failures =
    searchQuery.data?.failures ??
    streamedOutcomes
      .filter((o) => !o.ok)
      .map((o) => ({ sourceKey: o.sourceKey, error: o.error || '请求失败', timedOut: o.timedOut }));

  const groups = useMemo(() => aggregateResults(list), [list]);

  const [visibleCount, setVisibleCount] = useState(RESULT_PAGE_SIZE);
  const visibleGroups = useMemo(() => groups.slice(0, visibleCount), [groups, visibleCount]);
  useEffect(() => setVisibleCount(RESULT_PAGE_SIZE), [urlQuery]);

  const searchTotal = selectedSources.length;
  const searchFinished = Boolean(searchQuery.data) && !searchQuery.isFetching;
  const searchFailed = Boolean(searchQuery.isError) && !searchQuery.isFetching;
  const searchDone = searchFinished ? searchTotal : streamedOutcomes.length;
  const searchPct = searchTotal > 0 ? Math.min(100, Math.round((searchDone / searchTotal) * 100)) : 0;

  return (
    <div className="min-h-screen-safe flex flex-col pb-tabbar">
      {/* 顶部沉浸式问候与状态栏 */}
      <header className="safe-top px-4 pt-3 pb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/icons/icon-512.png"
            alt="QTV"
            className="w-9 h-9 rounded-2xl shadow-card ring-1 ring-white/10 shrink-0"
            onClick={() => {
              if (urlQuery) clearSearch();
            }}
          />
          <div className="min-w-0">
            <h1 className="text-base font-extrabold tracking-tight text-content truncate">
              {urlQuery ? '影视检索' : greeting.title}
            </h1>
            <p className="text-[11px] text-faint truncate">{greeting.subtitle}</p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => requestShowSettings('sources')}
            className="pressable inline-flex items-center gap-1.5 rounded-full border border-line/70 bg-card/85 px-2.5 py-1.5 text-[11px] font-medium text-muted"
          >
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                selectedSources.length > 0 ? 'bg-success' : 'bg-warning animate-pulse'
              )}
            />
            <span className="num">{selectedSources.length} 源</span>
          </button>
          <button
            type="button"
            onClick={() => setTheme(themeMode === 'dark' ? 'light' : 'dark')}
            aria-label="切换明暗主题"
            className="pressable p-2 rounded-full border border-line/70 bg-card/85 text-muted hover:text-content"
          >
            <Icon name={themeMode === 'dark' ? 'moon' : 'sun'} className="w-4 h-4" />
          </button>
        </div>
      </header>

      <main className="page-in flex-1 max-w-4xl w-full mx-auto px-4 pt-2 pb-6 space-y-6">
        {/* 搜索胶囊栏 */}
        <section>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              runSearch(input);
            }}
          >
            <div className="flex items-center min-h-[48px] pl-3.5 pr-1.5 rounded-2xl border border-line/80 bg-surface-raised/90 shadow-card focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/30 transition-all">
              <Icon name="search" className="w-4 h-4 text-faint shrink-0 mr-2.5" />
              <input
                ref={inputRef}
                className="flex-1 min-w-0 bg-transparent text-sm text-content placeholder:text-faint focus:outline-none"
                placeholder="搜索电影、剧集、综艺、动漫..."
                value={input}
                maxLength={100}
                onChange={(e) => setInput(e.target.value)}
                aria-label="搜索影片"
              />
              {(input || urlQuery) && (
                <button
                  type="button"
                  className="pressable shrink-0 p-1.5 mr-1 rounded-full text-faint hover:text-content"
                  onClick={clearSearch}
                  aria-label="清空搜索"
                >
                  <Icon name="close" className="w-4 h-4" />
                </button>
              )}
              <button
                type="submit"
                className="btn-primary !py-2 !px-4 !rounded-xl text-xs font-semibold shrink-0"
              >
                搜索
              </button>
            </div>
          </form>

          {/* 最近搜索胶囊标签云（仅在未进入搜索结果态或历史非空时显示，点按直达） */}
          {!urlQuery && searchHistory.matches.length > 0 && (
            <div className="mt-3">
              <div className="flex items-center justify-between mb-1.5 px-0.5">
                <span className="text-[11px] font-medium text-faint flex items-center gap-1">
                  <Icon name="clock" className="w-3 h-3" />
                  最近搜索
                </span>
                <button
                  type="button"
                  onClick={searchHistory.clearAll}
                  className="text-[11px] text-faint hover:text-danger transition-colors"
                >
                  清空
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {searchHistory.matches.map((h) => (
                  <div
                    key={h.text}
                    className="inline-flex items-center rounded-full border border-line/60 bg-card/80 pl-3 pr-1.5 py-1 text-xs text-content shadow-sm"
                  >
                    <button
                      type="button"
                      className="pressable truncate max-w-[10rem] mr-1"
                      onClick={() => {
                        setInput(h.text);
                        runSearch(h.text);
                      }}
                    >
                      {h.text}
                    </button>
                    <button
                      type="button"
                      onClick={() => searchHistory.remove(h.text)}
                      aria-label={`删除 ${h.text}`}
                      className="p-0.5 rounded-full text-faint hover:text-danger"
                    >
                      <Icon name="close" className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* 首屏态（无搜索词）：继续观看画廊 + 快速状态引导 */}
        {!urlQuery && (
          <>
            {selectedSources.length === 0 && (
              <NoSourceGuide hasSources={customAPIs.length > 0 || envSources.length > 0} />
            )}

            {/* 继续观看（Continue Watching）横向海报画廊 */}
            {recentHistory && recentHistory.length > 0 && (
              <section aria-label="继续观看">
                <div className="flex items-center justify-between mb-2.5 px-0.5">
                  <div className="flex items-center gap-1.5">
                    <span className="h-3.5 w-1 rounded-full bg-accent" />
                    <h2 className="text-sm font-bold text-content">继续观看</h2>
                  </div>
                  <button
                    type="button"
                    onClick={requestShowHistory}
                    className="pressable inline-flex items-center gap-0.5 text-xs font-medium text-accent"
                  >
                    全部记录
                    <Icon name="chevronRight" className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="flex gap-3 overflow-x-auto hide-scrollbar pb-1 -mx-4 px-4">
                  {recentHistory.slice(0, 8).map((item) => {
                    const src = resolveSource({ customAPIs, envSources }, item.sourceKey);
                    const hasPct =
                      item.playbackPosition > 10 &&
                      item.duration > 0 &&
                      item.playbackPosition < item.duration * 0.95;
                    const pct = hasPct ? Math.round((item.playbackPosition / item.duration) * 100) : 0;
                    const href = buildWatchUrl({
                      sourceKey: item.sourceKey,
                      vodId: item.vodId,
                      index: item.episodeIndex,
                      title: item.title,
                      sourceUrl: src?.url || item.sourceUrl,
                      detail: src?.detail,
                    });

                    return (
                      <Link
                        key={`${item.sourceKey}_${item.vodId}`}
                        href={href}
                        className="pressable group relative w-[128px] shrink-0 rounded-2xl overflow-hidden border border-line/60 bg-card shadow-card"
                      >
                        <div className="relative aspect-[2/3] bg-chip">
                          {item.pic ? (
                            <SmartImage
                              url={item.pic}
                              mode={imageProxyMode}
                              customProxy={customImageProxy}
                              alt={item.title}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <Icon name="play" className="w-7 h-7 text-faint" />
                            </div>
                          )}
                          <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/15 to-transparent" />
                          <span className="absolute top-2 right-2 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 backdrop-blur-md text-white">
                            <Icon name="play" className="w-3 h-3" />
                          </span>
                          <div className="absolute bottom-2 inset-x-2">
                            <span className="block text-[10px] font-medium text-white/90 num truncate">
                              {item.totalEpisodes > 1 ? `第 ${item.episodeIndex + 1} 集` : '正片'}
                              {hasPct ? ` · ${formatTime(item.playbackPosition)}` : ''}
                            </span>
                            {hasPct && (
                              <div className="mt-1 h-1 w-full rounded-full bg-white/25 overflow-hidden">
                                <div className="h-full bg-accent rounded-full" style={{ width: `${pct}%` }} />
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="p-2">
                          <div className="text-xs font-semibold text-content truncate">{item.title}</div>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </section>
            )}

            {/* 首页快捷剧场双卡（电视直播 & 离线下载/数据源） */}
            <section aria-label="快捷剧场" className="grid grid-cols-2 gap-3">
              <Link
                href="/live"
                className="pressable card p-3.5 flex items-center gap-3 bg-gradient-to-br from-sky-500/12 via-card to-card border-accent/25"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-accent/15 text-accent">
                  <Icon name="tv" className="w-5 h-5" />
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-bold text-content">电视直播</div>
                  <div className="text-[11px] text-faint truncate">卫视频道 · 秒切换台</div>
                </div>
              </Link>

              <button
                type="button"
                onClick={requestShowDownloadManager}
                className="pressable card p-3.5 flex items-center gap-3 text-left"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-indigo-500/15 text-indigo-400">
                  <Icon name="download" className="w-5 h-5" />
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-bold text-content">离线缓存</div>
                  <div className="text-[11px] text-faint truncate">边下边存 · 随时随心看</div>
                </div>
              </button>
            </section>
          </>
        )}

        {/* 搜索结果态 */}
        {urlQuery && (
          <section aria-label="搜索结果" className="space-y-3">
            {/* 流式检索进度胶囊 */}
            <div className="card p-3 bg-surface-raised/80">
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="text-xs text-muted min-w-0 truncate">
                  「<span className="font-semibold text-content">{urlQuery}</span>」
                  <span className="text-faint ml-1 num">
                    {searchFailed
                      ? '检索异常'
                      : searchFinished
                        ? `共 ${groups.length} 部影片（${list.length} 条源结果）`
                        : `正在聚合检索 ${searchDone}/${searchTotal} 个源…`}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={clearSearch}
                  className="shrink-0 text-[11px] font-medium text-accent hover:underline"
                >
                  返回探索
                </button>
              </div>
              <div
                className="h-1.5 rounded-full bg-chip overflow-hidden"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={searchPct}
              >
                <div
                  className={cn(
                    'h-full rounded-full transition-[width] duration-300',
                    searchFinished ? 'bg-success' : 'bg-accent search-progress-active'
                  )}
                  style={{ width: `${searchPct}%` }}
                />
              </div>
            </div>

            {selectedSources.length === 0 ? (
              <NoSourceGuide hasSources={customAPIs.length > 0 || envSources.length > 0} />
            ) : list.length > 0 ? (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-start">
                  {visibleGroups.map((group) => (
                    <AggregatedCard
                      key={group.key}
                      group={group}
                      sources={selectedSources}
                      onOpen={(item) => setDetailItem(item)}
                    />
                  ))}
                </div>
                {groups.length > visibleCount && (
                  <div className="flex justify-center pt-2">
                    <button
                      className="btn-ghost btn-sm"
                      onClick={() => setVisibleCount((v) => v + RESULT_PAGE_SIZE)}
                    >
                      加载更多（剩余 {groups.length - visibleCount} 部）
                    </button>
                  </div>
                )}
              </>
            ) : isSearching ? (
              <ResultsSkeleton />
            ) : searchFailed ? (
              <div className="card p-8 text-center">
                <h3 className="text-content font-semibold mb-1.5">检索未能完成</h3>
                <p className="text-xs text-muted mb-4">
                  {searchQuery.error instanceof Error ? searchQuery.error.message : '请检查网络连接后重试'}
                </p>
                <button className="btn-primary btn-sm" onClick={() => void searchQuery.refetch()}>
                  重新搜索
                </button>
              </div>
            ) : (
              <EmptyState
                icon="search"
                title="没有找到匹配的影视资源"
                description="可尝试简化关键词，或在「我的 → 数据源管理」中导入更多点播源"
                className="!py-12"
              />
            )}

            {failures.length > 0 && (
              <div className="text-[11px] bg-chip/70 rounded-xl px-3 py-2 flex flex-wrap gap-x-2.5 gap-y-1">
                <span className="text-faint">{isSearching ? '暂未响应：' : '部分源未返回：'}</span>
                {failures.map((f) => (
                  <span key={f.sourceKey} className={f.timedOut ? 'text-warning' : 'text-faint'}>
                    {f.timedOut ? '⏱' : '✗'} {sourceName(f.sourceKey)}
                  </span>
                ))}
              </div>
            )}

            {disabledSources.length > 0 && (
              <div className="text-[11px] text-faint bg-chip/70 rounded-xl px-3 py-2">
                {disabledSources.length} 个超时源已自动避让：{disabledSources.map((k) => sourceName(k)).join('、')}
              </div>
            )}

            {offSubscriptionSources.length > 0 && (
              <div className="text-[11px] text-faint bg-chip/70 rounded-xl px-3 py-2">
                {offSubscriptionSources.length} 个源所属订阅已停用
              </div>
            )}
          </section>
        )}
      </main>

      <DetailModal item={detailItem} onClose={() => setDetailItem(null)} />
      <Header />
    </div>
  );
}

/**
 * [Tab 3: 我的（个人片库与设置中心）]
 * - 顶部专属陪伴状态卡（展示今日观影分钟数 + 45 分钟护眼提醒状态）；
 * - 片库与工具矩阵（观看历史、离线下载队列、点播/直播源工作台、订阅同步）；
 * - 常用观影偏好直切开关（广告切片过滤、自动连播、自动跳过片头片尾、音量增强、深浅外观）；
 * - 底部版本铭牌；
 */
function ProfileHubView() {
  const store = useAppStore();
  const { resolved: themeMode, setTheme } = useTheme();
  const { version } = useAuth();
  const [playedMin, setPlayedMin] = useState(0);
  const [aboutOpen, setAboutOpen] = useState(false);

  const historyCount = useLiveQuery(() => db.history.count(), []) ?? 0;
  const downloadCount = useLiveQuery(() => db.downloads.count(), []) ?? 0;

  useEffect(() => {
    setPlayedMin(playedMinutesToday());
  }, []);

  const enabledVodCount = store.selectedKeys.length;
  const totalVodCount = store.customAPIs.length + store.envSources.length;
  const enabledLiveCount = store.liveSelectedUrls.length;
  const skipMarkMovies = Object.keys(store.skipMarks).length;

  return (
    <div className="min-h-screen-safe flex flex-col pb-tabbar">
      <header className="safe-top px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-extrabold tracking-tight text-content">我的片库与偏好</h1>
          <p className="text-xs text-faint">专属私人影院 · 本机隐私存储</p>
        </div>
        <button
          type="button"
          onClick={() => setTheme(themeMode === 'dark' ? 'light' : 'dark')}
          className="pressable inline-flex items-center gap-1.5 rounded-full border border-line/70 bg-card px-3 py-1.5 text-xs font-medium text-content"
        >
          <Icon name={themeMode === 'dark' ? 'moon' : 'sun'} className="w-3.5 h-3.5 text-accent" />
          {themeMode === 'dark' ? '映画暗黑' : '纯净浅色'}
        </button>
      </header>

      <main className="page-in flex-1 max-w-2xl w-full mx-auto px-4 pt-2 pb-4 space-y-4">
        {/* 顶部专属陪伴状态卡 */}
        <section className="card p-4 bg-gradient-to-br from-sky-500/15 via-indigo-500/8 to-card border-accent/30">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent/20 text-accent ring-1 ring-accent/30">
                <Icon name="sparkles" className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-bold text-content">今日已陪伴观影 {playedMin} 分钟</div>
                <p className="text-xs text-muted mt-0.5">
                  每连续观看 45 分钟，灵动胶囊会自动提醒喝水休息
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* 核心片库与数据源四宫格 */}
        <section className="grid grid-cols-2 gap-2.5">
          <button
            type="button"
            onClick={requestShowHistory}
            className="pressable card p-3.5 text-left flex flex-col justify-between gap-2"
          >
            <div className="flex items-center justify-between">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/15 text-accent">
                <Icon name="clock" className="w-4 h-4" />
              </span>
              <span className="text-xs font-bold text-content num">{historyCount} 条</span>
            </div>
            <div>
              <div className="text-sm font-semibold text-content">观看历史</div>
              <div className="text-[11px] text-faint">断点续播与记录管理</div>
            </div>
          </button>

          <button
            type="button"
            onClick={requestShowDownloadManager}
            className="pressable card p-3.5 text-left flex flex-col justify-between gap-2"
          >
            <div className="flex items-center justify-between">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-400">
                <Icon name="download" className="w-4 h-4" />
              </span>
              <span className="text-xs font-bold text-content num">{downloadCount} 任务</span>
            </div>
            <div>
              <div className="text-sm font-semibold text-content">离线下载</div>
              <div className="text-[11px] text-faint">本机边下边存为 MP4</div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => requestShowSettings('sources')}
            className="pressable card p-3.5 text-left flex flex-col justify-between gap-2"
          >
            <div className="flex items-center justify-between">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400">
                <Icon name="link" className="w-4 h-4" />
              </span>
              <span className="text-xs font-bold text-accent num">
                {enabledVodCount}/{totalVodCount} 源
              </span>
            </div>
            <div>
              <div className="text-sm font-semibold text-content">数据源与订阅</div>
              <div className="text-[11px] text-faint">点播源 · 直播 {enabledLiveCount} 源 · 测活</div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => requestShowSettings('data')}
            className="pressable card p-3.5 text-left flex flex-col justify-between gap-2"
          >
            <div className="flex items-center justify-between">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-500/15 text-amber-400">
                <Icon name="sliders" className="w-4 h-4" />
              </span>
              <Icon name="chevronRight" className="w-4 h-4 text-faint" />
            </div>
            <div>
              <div className="text-sm font-semibold text-content">备份与高级设置</div>
              <div className="text-[11px] text-faint">配置导入导出与缓存清理</div>
            </div>
          </button>
        </section>

        {/* 原生分组列表：观影与播放偏好直切 */}
        <section className="card divide-y divide-line/60 overflow-hidden">
          <div className="px-4 py-2.5 bg-surface/60">
            <h2 className="text-xs font-bold tracking-wide text-muted">观影体验与智能过滤</h2>
          </div>

          <div className="px-4 py-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-content">智能去广告切片</div>
              <div className="text-xs text-faint">自动识别并剔除正片中插播的广告分片</div>
            </div>
            <Switch
              checked={store.adFilter}
              onChange={(v) => store.updateSettings({ adFilter: v })}
              label="智能去广告切片"
            />
          </div>

          <div className="px-4 py-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-content">剧集自动连播</div>
              <div className="text-xs text-faint">本集播完后自动无缝切入下一集</div>
            </div>
            <Switch
              checked={store.autoplayNext}
              onChange={(v) => store.updateSettings({ autoplayNext: v })}
              label="剧集自动连播"
            />
          </div>

          <div className="px-4 py-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-content">
                自动跳过片头片尾{skipMarkMovies > 0 ? `（已标 ${skipMarkMovies} 部）` : ''}
              </div>
              <div className="text-xs text-faint">命中标记的片头/片尾区间时自动跳过</div>
            </div>
            <Switch
              checked={store.autoSkipSegments}
              onChange={(v) => store.updateSettings({ autoSkipSegments: v })}
              label="自动跳过片头片尾"
            />
          </div>

          <div className="px-4 py-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-content">人声音量增强 (1.8x)</div>
              <div className="text-xs text-faint">音源偏小时开启，软限幅防破音放大响度</div>
            </div>
            <Switch
              checked={store.volumeBoost}
              onChange={(v) => store.updateSettings({ volumeBoost: v })}
              label="人声音量增强"
            />
          </div>

          <div className="px-4 py-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-content">息屏底边细进度条</div>
              <div className="text-xs text-faint">控制栏收起后，画面底部保留 3px 极细进度线</div>
            </div>
            <Switch
              checked={store.miniProgressBar}
              onChange={(v) => store.updateSettings({ miniProgressBar: v })}
              label="息屏底边细进度条"
            />
          </div>
        </section>

        {/* 触控手势速览卡（完全替代旧版 PC 快捷键说明） */}
        <section className="card p-4 space-y-2.5">
          <div className="flex items-center gap-2">
            <Icon name="shield" className="w-4 h-4 text-accent" />
            <h2 className="text-xs font-bold text-content">全屏观影触控手势指南</h2>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-xl bg-chip/65 px-3 py-2">
              <span className="font-semibold text-accent block">双击画面左 / 右侧</span>
              <span className="text-faint text-[11px]">快退 10 秒 / 快进 10 秒</span>
            </div>
            <div className="rounded-xl bg-chip/65 px-3 py-2">
              <span className="font-semibold text-accent block">长按画面任意处</span>
              <span className="text-faint text-[11px]">3.0 倍速极速快进预览</span>
            </div>
            <div className="rounded-xl bg-chip/65 px-3 py-2">
              <span className="font-semibold text-accent block">全屏左 / 右上下滑</span>
              <span className="text-faint text-[11px]">无级调节屏幕亮度与音量</span>
            </div>
            <div className="rounded-xl bg-chip/65 px-3 py-2">
              <span className="font-semibold text-accent block">全屏横向滑动</span>
              <span className="text-faint text-[11px]">高精度预览时间轴跳转</span>
            </div>
          </div>
        </section>

        {/* 关于：仓库地址 / 开源协议 / 致谢（小弹窗，右上角可关） */}
        <button
          type="button"
          onClick={() => setAboutOpen(true)}
          className="pressable card w-full p-3.5 flex items-center justify-between gap-3 text-left"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-chip text-muted">
              <Icon name="shield" className="w-4 h-4" />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-medium text-content">关于 QTV</div>
              <div className="text-[11px] text-faint truncate">
                版本 v{version ?? '1.0'} · 开源协议 · 致谢
              </div>
            </div>
          </div>
          <Icon name="chevronRight" className="w-4 h-4 text-faint shrink-0" />
        </button>

        <SiteFooter />
      </main>

      <Header />
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} version={version} />
    </div>
  );
}

function ResultsSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="card flex p-2.5 gap-3 h-[154px] overflow-hidden">
          <div className="w-[92px] rounded-xl shrink-0 skeleton" />
          <div className="flex-1 py-1 space-y-2.5">
            <div className="h-4 w-3/4 skeleton" />
            <div className="h-3 w-1/2 skeleton" />
            <div className="h-3 w-full skeleton" />
          </div>
        </div>
      ))}
    </div>
  );
}

function NoSourceGuide({ hasSources = false }: { hasSources?: boolean }) {
  return (
    <div className="card p-6 text-center">
      <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-accent/15 text-accent">
        <Icon name="link" className="w-5 h-5" />
      </div>
      <h3 className="text-content font-bold text-sm mb-1.5">
        {hasSources ? '尚未勾选启用点播源' : '先配置数据源开启私人影院'}
      </h3>
      <p className="text-xs text-muted leading-relaxed mb-4">
        {hasSources
          ? '你已导入点播源，勾选启用后即可聚合搜索全网影视。'
          : '支持一键导入数据源订阅链接（或单独添加 Apple CMS 接口），配置后即可免登录畅看。'}
      </p>
      <button
        type="button"
        className="btn-primary btn-sm"
        onClick={() => requestShowSettings('sources')}
      >
        <Icon name="plus" className="w-3.5 h-3.5" />
        {hasSources ? '去启用点播源' : '去配置数据源'}
      </button>
    </div>
  );
}

const REPO_URL = 'https://github.com/HapyRain/QTV';

/**
 * 「关于」小弹窗：仓库地址 / 开源协议 / 致谢 / 版本号。
 * 用 role="dialog" 让 Android 返回键先关它（BackGuard 靠这个选择器找浮层）。
 */
function AboutDialog({
  open,
  onClose,
  version,
}: {
  open: boolean;
  onClose: () => void;
  version: string | null;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[85] flex items-center justify-center px-5 bg-black/70 backdrop-blur-[2px] animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label="关于 QTV"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative w-full max-w-sm rounded-[24px] border border-line/70 bg-surface-raised shadow-[0_20px_60px_rgba(0,0,0,0.6)] p-5 sheet-up">
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="pressable absolute right-3 top-3 p-1.5 rounded-full bg-chip text-muted hover:text-content"
        >
          <Icon name="close" className="w-4 h-4" />
        </button>

        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/icons/icon-192.png"
          alt="QTV"
          className="w-12 h-12 rounded-2xl ring-1 ring-white/10"
        />
        <h2 className="mt-3 text-base font-extrabold tracking-tight text-content">
          QTV <span className="text-xs font-medium text-faint num">v{version ?? '1.0'}</span>
        </h2>
        <p className="mt-1 text-[11px] text-faint">本机影视聚合播放器</p>

        <p className="mt-3 text-xs leading-relaxed text-muted">
          本应用只负责聚合你自行配置的第三方数据源，并播放你选中的流。不存储、不分发任何影视资源，
          内容与版权均归第三方站点及权利人所有。
        </p>

        <div className="mt-4 space-y-2 text-xs">
          <a
            href={REPO_URL}
            className="pressable flex items-center justify-between gap-3 rounded-xl bg-chip/70 px-3 py-2.5 text-content"
          >
            <span className="flex items-center gap-2 shrink-0">
              <Icon name="link" className="w-4 h-4 text-accent" />
              开源仓库
            </span>
            <span className="text-faint truncate">github.com/HapyRain/QTV</span>
          </a>
          <div className="flex items-center justify-between gap-3 rounded-xl bg-chip/70 px-3 py-2.5">
            <span className="flex items-center gap-2 text-content">
              <Icon name="shield" className="w-4 h-4 text-accent" />
              开源协议
            </span>
            <span className="text-faint">GNU AGPL-3.0</span>
          </div>
          <div className="rounded-xl bg-chip/70 px-3 py-2.5 text-faint leading-relaxed">
            致谢：ArtPlayer · hls.js · Next.js，以及所有公开数据源的作者
          </div>
        </div>

        <p className="mt-4 text-center text-[11px] text-faint">感谢使用，觉得顺手的话欢迎在仓库点个 Star ⭐</p>
      </div>
    </div>
  );
}
