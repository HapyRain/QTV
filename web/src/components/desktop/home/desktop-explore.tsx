'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import { AggregatedCard, aggregateResults } from '@/components/video-card';
import { DetailModal } from '@/components/detail-modal';
import { SmartImage } from '@/components/smart-image';
import { Icon } from '@/components/icon';
import { EmptyState } from '@/components/states';
import { Header, requestShowHistory, requestShowSettings } from '@/components/header';
import { requestShowDownloadManager } from '@/components/download-manager';
import { api } from '@/lib/client-api';
import { db } from '@/lib/db';
import { useAppStore, resolveSource, isInDisabledSubscription, isSourceDisabled } from '@/lib/store';
import type { DoubanItem, SearchResultItem, SourceSearchOutcome } from '@/lib/types';
import { useToast } from '@/components/toast';
import { buildWatchUrl, cn, formatDisableTtl, formatTime, validateSourceUrl } from '@/lib/utils';

/**
 * Windows 桌面宽屏首页（探索）：
 * - 顶部大标题 + 搜索框：提交只改 URL（/?s=），搜索结果仍由本组件的搜索态呈现，
 *   与移动端共用同一套 api.search / AggregatedGroup / DetailModal，不重复实现检索逻辑；
 * - 无搜索词：「继续观看」横向行 + 豆瓣热门海报墙 + 直播/缓存快捷入口；
 * - 所有数据源都在桌面本地服务里已实现（/api/douban、/api/search），失败一律降级为空态。
 */

const DOUBAN_PAGE_SIZE = 24;
const HISTORY_LIMIT = 12;

type DoubanTab = 'tv' | 'movie';

const DOUBAN_TABS: { key: DoubanTab; label: string }[] = [
  { key: 'tv', label: '热门剧集' },
  { key: 'movie', label: '热门电影' },
];

export function DesktopExplore() {
  const searchParams = useSearchParams();
  const router = useRouter();
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
  const [doubanTab, setDoubanTab] = useState<DoubanTab>('tv');
  const [detailItem, setDetailItem] = useState<SearchResultItem | null>(null);
  // 逐源流式结果：与移动端一致，先到的源先出卡片，不用等最慢的源
  const [streamedOutcomes, setStreamedOutcomes] = useState<SourceSearchOutcome[]>([]);
  const { toast } = useToast();

  const sourceNameOf = (key: string) =>
    resolveSource({ customAPIs, envSources }, key)?.name || key;

  // 地址栏变化（含点海报标题跳搜索 / 返回探索）时回填输入框
  useEffect(() => setInput(urlQuery), [urlQuery]);

  // 与移动端同一套「可用源」口径：URL 合法 + 未被健康度自动停用 + 所属订阅未停用
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

  const recommendQuery = useQuery({
    queryKey: ['desktop-douban', doubanTab],
    queryFn: ({ signal }) => api.douban(doubanTab, '热门', 0, DOUBAN_PAGE_SIZE, signal),
    // 搜索态下不占用请求；返回探索时命中缓存直接出图
    enabled: !urlQuery,
    staleTime: 30 * 60_000,
  });
  const posters = recommendQuery.data?.items ?? [];
  // 与移动端一致：热门电影（movie）的海报直连豆瓣图床易 403，强制走本地代理
  const posterMode = doubanTab === 'movie' ? 'proxy' : imageProxyMode;
  const posterProxy = doubanTab === 'movie' ? undefined : customImageProxy;

  const searchQuery = useQuery({
    queryKey: ['desktop-search', urlQuery, selectedKeys, yellowFilter],
    queryFn: ({ signal }) => {
      setStreamedOutcomes([]);
      return api.search(urlQuery.slice(0, 100), selectedSources, yellowFilter, {
        signal,
        // 与移动端一致：逐源结算即渲染，并记录源健康度（连续无响应自动熔断）
        onSource: (outcome) => {
          setStreamedOutcomes((prev) => [...prev.filter((o) => o.sourceKey !== outcome.sourceKey), outcome]);
          for (const ev of useAppStore.getState().recordSourceHealth([outcome])) {
            toast(
              ev.permanent
                ? `「${sourceNameOf(ev.key)}」多次无响应，已自动停用`
                : `「${sourceNameOf(ev.key)}」超时，暂停 ${formatDisableTtl(ev.ttlMs ?? 0)}`,
              'warning'
            );
          }
        },
      });
    },
    enabled: Boolean(urlQuery) && selectedSources.length > 0,
    staleTime: 300_000,
  });
  const streamedList = useMemo(() => streamedOutcomes.flatMap((o) => o.list), [streamedOutcomes]);
  const groups = useMemo(() => {
    const list = searchQuery.data
      ? streamedOutcomes.length > 0
        ? streamedList
        : searchQuery.data.list
      : streamedList;
    return aggregateResults(list);
  }, [searchQuery.data, streamedList, streamedOutcomes.length]);

  // IndexedDB 实时驱动「继续观看」：dexie 的 liveQuery 自带走查与卸载
  const recentHistory = useLiveQuery(
    () => db.history.orderBy('timestamp').reverse().limit(HISTORY_LIMIT).toArray(),
    []
  );

  const submitSearch = (e: FormEvent) => {
    e.preventDefault();
    const q = input.trim().slice(0, 100);
    if (!q) return;
    router.push(`/?s=${encodeURIComponent(q)}`, { scroll: false });
  };

  // 豆瓣条目只有标题、没有点播源的 vodId，无法直接映射到播放页，
  // 所以点海报 = 用片名发起聚合搜索（少一层数据依赖，点击结果与手输一致）
  const searchByTitle = (title: string) => {
    router.push(`/?s=${encodeURIComponent(title.slice(0, 100))}`, { scroll: false });
  };

  return (
    <div className="desktop-main">
      <div className="desktop-scroll flex-1 min-h-0 px-8 py-6">
        <header className="flex flex-wrap items-center justify-between gap-4 mb-6">
          <div className="min-w-0">
            <h1 className="text-2xl font-extrabold tracking-tight text-content">探索发现</h1>
            <p className="text-xs text-faint mt-1">想看的，这里都有 · 高清流畅 · 无广告</p>
          </div>

          <form onSubmit={submitSearch} className="w-full max-w-md">
            <div className="flex items-center h-10 pl-3.5 pr-1.5 rounded-xl border border-line/80 bg-surface-raised/90 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25 transition-all">
              <Icon name="search" className="w-4 h-4 text-faint shrink-0 mr-2.5" />
              <input
                className="flex-1 min-w-0 bg-transparent text-sm text-content placeholder:text-faint focus:outline-none"
                placeholder="搜索电影、剧集、综艺、动漫..."
                value={input}
                maxLength={100}
                onChange={(e) => setInput(e.target.value)}
                aria-label="搜索影片"
              />
              <button
                type="submit"
                className="btn-primary !py-1.5 !px-3.5 !rounded-lg text-xs font-semibold shrink-0"
              >
                搜索
              </button>
            </div>
          </form>
        </header>

        {!urlQuery && posters.length > 0 && (
          <section className="desk-hero" aria-label="今日精选">
            <SmartImage
              url={posters[0].cover}
              mode={posterMode}
              customProxy={posterProxy}
              alt=""
              className="desk-hero-img"
              loading="eager"
            />
            <div className="desk-hero-scrim" />
            <div className="desk-hero-in">
              <div className="desk-kicker">FEATURED · 今日精选</div>
              <h2>{posters[0].title}</h2>
              <div className="desk-hero-meta">
                {posters[0].rating && <b>{posters[0].rating}</b>}
                <span>{doubanTab === 'tv' ? '剧集' : '电影'}</span>
                <span>豆瓣热播</span>
              </div>
              <div className="desk-hero-actions">
                <button className="desk-btn desk-btn-primary" onClick={() => searchByTitle(posters[0].title)}>
                  <Icon name="play" className="w-3.5 h-3.5" />查找片源
                </button>
                <button className="desk-btn" onClick={() => setDoubanTab(doubanTab === 'tv' ? 'movie' : 'tv')}>
                  换一部
                </button>
              </div>
            </div>
          </section>
        )}

        {urlQuery ? (
          <section aria-label="搜索结果" className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm text-muted min-w-0 truncate">
                「<span className="font-semibold text-content">{urlQuery}</span>」
                <span className="text-faint ml-2 num">
                  {searchQuery.isError
                    ? '检索异常'
                    : searchQuery.isPending && selectedSources.length > 0
                      ? '正在聚合检索…'
                      : `共 ${groups.length} 部影片`}
                </span>
              </div>
              <button
                type="button"
                onClick={() => router.push('/', { scroll: false })}
                className="shrink-0 text-xs font-medium text-accent hover:underline"
              >
                返回探索
              </button>
            </div>

            {selectedSources.length === 0 ? (
              <EmptyState
                icon="link"
                title="尚未启用点播源"
                description="启用至少一个点播源后即可聚合搜索全网影视"
                action={
                  <button
                    type="button"
                    className="btn-primary btn-sm"
                    onClick={() => requestShowSettings('sources')}
                  >
                    去配置数据源
                  </button>
                }
                className="!py-16"
              />
            ) : searchQuery.isPending ? (
              <SkeletonGrid />
            ) : searchQuery.isError ? (
              // 失败只降级成空态，保留重新搜索入口，不白屏
              <EmptyState
                icon="alert"
                title="检索未能完成"
                description={searchQuery.error instanceof Error ? searchQuery.error.message : '请检查网络连接后重试'}
                action={
                  <button type="button" className="btn-ghost btn-sm" onClick={() => void searchQuery.refetch()}>
                    重新搜索
                  </button>
                }
                className="!py-16"
              />
            ) : groups.length === 0 ? (
              <EmptyState
                icon="search"
                title="没有找到匹配的影视资源"
                description="可尝试简化关键词，或在「设置 → 片源」中导入更多点播源"
                className="!py-16"
              />
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-5 items-start">
                {groups.map((group) => (
                  <AggregatedCard
                    key={group.key}
                    group={group}
                    sources={selectedSources}
                    onOpen={(item) => setDetailItem(item)}
                  />
                ))}
              </div>
            )}
          </section>
        ) : (
          <>
            {recentHistory && recentHistory.length > 0 && (
              <section aria-label="继续观看" className="mb-8">
                <SectionTitle
                  title="继续观看"
                  action={
                    <button
                      type="button"
                      onClick={() => requestShowHistory()}
                      className="inline-flex items-center gap-0.5 text-xs font-medium text-accent"
                    >
                      全部记录
                      <Icon name="chevronRight" className="w-3.5 h-3.5" />
                    </button>
                  }
                />
                <div className="flex gap-4 overflow-x-auto hide-scrollbar pb-2">
                  {recentHistory.map((item) => {
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
                        key={item.id}
                        href={href}
                        className="pressable group relative w-[152px] shrink-0 rounded-xl overflow-hidden border border-line/60 bg-card shadow-card"
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

            <section aria-label="热门推荐" className="mb-8">
              <div className="flex items-center justify-between gap-3 mb-3">
                <div className="inline-flex items-center gap-1 rounded-xl bg-chip/60 p-1 border border-line/50">
                  {DOUBAN_TABS.map((tab) => (
                    <button
                      key={tab.key}
                      type="button"
                      onClick={() => setDoubanTab(tab.key)}
                      className={cn(
                        'px-3 h-8 rounded-lg text-xs font-medium transition-colors',
                        doubanTab === tab.key
                          ? 'bg-accent text-on-accent font-semibold'
                          : 'text-muted hover:text-content'
                      )}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                <span className="text-xs text-faint">每天更新 · 点击海报立即搜索</span>
              </div>

              <SectionTitle title={doubanTab === 'tv' ? '热播剧集' : '热门电影'} />

              {recommendQuery.isPending ? (
                <SkeletonGrid />
              ) : posters.length === 0 ? (
                // 豆瓣接口被墙 / 超时都走这里：降级为空态，不影响下方快捷入口
                <EmptyState
                  icon="alert"
                  title="暂时取不到热门推荐"
                  description="网络不好时，可以直接用上方搜索框按片名找片"
                  className="!py-12"
                />
              ) : (
                <div className="poster-grid-desktop">
                  {posters.map((item) => (
                    <PosterCard
                      key={item.id}
                      item={item}
                      onOpen={() => searchByTitle(item.title)}
                      mode={posterMode}
                      customProxy={posterProxy}
                    />
                  ))}
                </div>
              )}
            </section>

            <section aria-label="快捷入口" className="grid grid-cols-2 gap-4 max-w-2xl">
              <Link
                href="/live"
                className="pressable card p-4 flex items-center gap-3 bg-gradient-to-br from-sky-500/12 via-card to-card border-accent/25"
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
                className="pressable card p-4 flex items-center gap-3 text-left"
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
      </div>

      <DetailModal item={detailItem} onClose={() => setDetailItem(null)} />
      <Header />
    </div>
  );
}

/** 桌面分区标题：小色条 + 粗体，右侧可挂一个「全部/更多」入口 */
function SectionTitle({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2">
        <span className="h-3.5 w-1 rounded-full bg-accent" />
        <h2 className="text-sm font-bold text-content">{title}</h2>
      </div>
      {action}
    </div>
  );
}

/** 豆瓣海报卡：海报 + 评分 + 标题，整卡点击 → 用片名聚合搜索 */
function PosterCard({
  item,
  onOpen,
  mode,
  customProxy,
}: {
  item: DoubanItem;
  onOpen: () => void;
  mode: 'direct' | 'proxy' | 'custom';
  customProxy?: string;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = Boolean(item.cover) && !imgFailed;

  return (
    <button
      type="button"
      onClick={onOpen}
      title={`搜索《${item.title}》`}
      className="pressable group text-left rounded-xl overflow-hidden border border-line/60 bg-card hover:border-accent/50 transition-colors"
    >
      <div className="relative aspect-[2/3] bg-chip overflow-hidden">
        {showImg ? (
          <SmartImage
            url={item.cover}
            mode={mode}
            customProxy={customProxy}
            alt={item.title}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
            onExhausted={() => setImgFailed(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Icon name="tv" className="w-8 h-8 text-faint" />
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-transparent" />
        {item.rating && (
          <span className="absolute top-2 right-2 inline-flex items-center gap-0.5 rounded-full bg-black/65 backdrop-blur-md px-2 py-0.5 text-[11px] font-semibold text-amber-400 num">
            <Icon name="star" className="w-3 h-3" />
            {item.rating}
          </span>
        )}
      </div>
      <div className="px-2.5 py-2">
        <div className="text-xs font-semibold text-content truncate">{item.title}</div>
        <div className="text-[11px] text-faint mt-0.5 truncate">{item.isTv ? '剧集' : '电影'} · 点击检索</div>
      </div>
    </button>
  );
}

/** 加载骨架：与海报墙同构，避免整页白屏跳动 */
function SkeletonGrid({ count = 12 }: { count?: number }) {
  return (
    <div className="poster-grid-desktop" aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-xl overflow-hidden border border-line/50 bg-card">
          <div className="aspect-[2/3] skeleton" />
          <div className="p-2.5 space-y-2">
            <div className="h-3 w-4/5 skeleton rounded" />
            <div className="h-2.5 w-1/3 skeleton rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}
