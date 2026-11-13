'use client';

import { useEffect, useMemo, useState } from 'react';
import type { SearchResultItem, SourceConfig } from '@/lib/types';
import { useAppStore } from '@/lib/store';
import { qualityKey } from '@/lib/quality';
import { compactRemarks, formatRemarks, inferGroupRemarks } from '@/lib/remarks';
import { cn } from '@/lib/utils';
import { SmartImage } from './smart-image';
import { QualityBadge } from './quality-badge';
import { useQualityProbe } from './use-quality-probe';
import { useInView } from './use-in-view';
import { Icon } from './icon';

export interface AggregatedGroup {
  key: string;
  name: string;
  year?: string;
  typeName?: string;
  pic?: string;
  remarks?: string;
  items: SearchResultItem[];
}

function buildGroup(name: string, year: string | undefined, items: SearchResultItem[]): AggregatedGroup {
  return {
    key: `${name}|${year ?? ''}`,
    name,
    year,
    typeName: items.find((i) => i.typeName)?.typeName,
    pic: items.find((i) => i.pic)?.pic,
    remarks: inferGroupRemarks(items.map((i) => i.remarks)),
    items,
  };
}

export function aggregateResults(list: SearchResultItem[]): AggregatedGroup[] {
  const byName = new Map<string, SearchResultItem[]>();
  for (const item of list) {
    const k = (item.name || '').trim();
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k)!.push(item);
  }
  const groups: AggregatedGroup[] = [];
  for (const [name, items] of byName) {
    const years = [...new Set(items.map((i) => i.year).filter(Boolean))] as string[];
    if (years.length > 1) {
      for (const y of years) {
        groups.push(buildGroup(name, y, items.filter((i) => i.year === y)));
      }
      const noYear = items.filter((i) => !i.year);
      if (noYear.length) groups.push(buildGroup(name, undefined, noYear));
    } else {
      groups.push(buildGroup(name, years[0], items));
    }
  }
  return groups;
}

/**
 * 移动端映画流光聚合影片卡：
 * - 单源：点击直达详情 Bottom Sheet；
 * - 多源：显示「N 源」流光角标 + 最高画质胶囊，点击丝滑展开各源实时画质排行列表。
 */
export function AggregatedCard({
  group,
  onOpen,
  sources,
}: {
  group: AggregatedGroup;
  onOpen: (item: SearchResultItem) => void;
  sources?: SourceConfig[];
}) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const [imgFailed, setImgFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const showImg = !!group.pic && !imgFailed;

  const multi = group.items.length > 1;
  const adult = useMemo(() => group.items.some((i) => i.isAdult), [group.items]);

  const { qualities, probing, progress, prime, probe, probeQueued, retry } = useQualityProbe(sources);

  const itemsSignature = useMemo(
    () => group.items.map((i) => `${i.sourceKey}_${i.vodId}`).join(','),
    [group.items]
  );
  useEffect(() => {
    prime(group.items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsSignature]);

  const { ref: inViewRef, inView } = useInView<HTMLDivElement>(!multi);
  useEffect(() => {
    if (!multi && inView) probeQueued(group.items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multi, inView, itemsSignature]);

  const activate = () => {
    if (multi) {
      const next = !expanded;
      setExpanded(next);
      if (next) probe(group.items);
    } else {
      onOpen(group.items[0]);
    }
  };

  const singleItem = multi ? undefined : group.items[0];
  const singleKey = singleItem ? qualityKey(singleItem.sourceKey, singleItem.vodId) : undefined;

  const heightOf = (item: SearchResultItem) => qualities[qualityKey(item.sourceKey, item.vodId)]?.height ?? 0;
  const sortedItems = useMemo(() => {
    const height = (item: SearchResultItem) => qualities[qualityKey(item.sourceKey, item.vodId)]?.height ?? 0;
    return group.items
      .map((item, index) => ({ item, index }))
      .sort((a, b) => height(b.item) - height(a.item) || a.index - b.index)
      .map((entry) => entry.item);
  }, [group.items, qualities]);
  const bestHeight = sortedItems.reduce((max, item) => Math.max(max, heightOf(item)), 0);
  const firstBest = sortedItems.find((item) => bestHeight > 0 && heightOf(item) === bestHeight);
  const bestKey = firstBest ? qualityKey(firstBest.sourceKey, firstBest.vodId) : undefined;
  const remarksList = sortedItems.map((item) => compactRemarks(item.remarks));
  const sharedRemarks =
    remarksList.length > 0 && remarksList.every((label) => label && label === remarksList[0])
      ? remarksList[0]
      : undefined;

  return (
    <div
      ref={inViewRef}
      className={cn(
        'card transition-all duration-200',
        multi && expanded && 'ring-1 ring-accent/50 bg-surface-raised/90'
      )}
    >
      <div
        className="pressable flex h-full cursor-pointer p-2.5 gap-3 focus-visible:outline-none"
        role="button"
        tabIndex={0}
        aria-expanded={multi ? expanded : undefined}
        onClick={activate}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            activate();
          }
        }}
      >
        {showImg ? (
          <div className="relative flex-shrink-0 w-[92px] aspect-[2/3] rounded-xl overflow-hidden bg-chip shadow-md ring-1 ring-white/5">
            <SmartImage
              url={group.pic}
              mode={imageProxyMode}
              customProxy={customImageProxy}
              alt={group.name}
              className="absolute inset-0 h-full w-full object-cover"
              onExhausted={() => setImgFailed(true)}
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-transparent to-transparent" />
            {multi && (
              <span className="absolute top-1.5 left-1.5 rounded-full bg-black/75 backdrop-blur-md px-2 py-0.5 text-[10px] text-accent font-semibold num">
                {group.items.length} 源
              </span>
            )}
            {group.remarks && (
              <span className="absolute bottom-1.5 inset-x-1.5 text-center truncate text-[10px] font-medium text-white/95 drop-shadow">
                {group.remarks}
              </span>
            )}
          </div>
        ) : (
          <div className="relative flex-shrink-0 w-[92px] aspect-[2/3] rounded-xl bg-chip flex items-center justify-center ring-1 ring-white/5">
            <Icon name="tv" className="w-7 h-7 text-faint" />
            {multi && (
              <span className="absolute top-1.5 left-1.5 rounded-full bg-black/75 px-2 py-0.5 text-[10px] text-accent font-semibold num">
                {group.items.length} 源
              </span>
            )}
          </div>
        )}

        <div className="flex flex-col flex-grow min-w-0 py-0.5">
          <div className="flex-grow">
            <h3 className="font-bold text-[15px] text-content leading-snug mb-1.5 line-clamp-2" title={group.name}>
              {group.name}
            </h3>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {group.typeName && <span className="tag bg-accent/14 text-accent">{group.typeName}</span>}
              {group.year && <span className="tag bg-chip text-muted num">{group.year}</span>}
              {adult && <span className="tag bg-pink-500/15 text-pink-400">18+</span>}
              {singleKey && (
                <QualityBadge
                  entry={qualities[singleKey]}
                  loading={probing[singleKey]}
                  onRetry={singleItem ? () => retry([singleItem]) : undefined}
                />
              )}
            </div>
            <p className="text-xs text-muted line-clamp-1">{group.remarks || '点击查看剧集与播放源'}</p>
          </div>

          <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-line/50">
            <span className="text-xs font-medium text-faint truncate">
              {multi ? `聚合 ${group.items.length} 个播放源` : group.items[0].sourceName}
            </span>
            {multi ? (
              <span className="flex items-center gap-1.5 shrink-0">
                {progress.best && (
                  <span className="tag bg-accent/15 text-accent font-semibold num">{progress.best}</span>
                )}
                <span className="inline-flex items-center gap-0.5 text-xs font-medium text-accent">
                  {expanded ? '收起' : '选源'}
                  <Icon
                    name="chevronDown"
                    className={cn('w-3.5 h-3.5 transition-transform duration-200', expanded && 'rotate-180')}
                  />
                </span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-0.5 text-xs font-medium text-accent shrink-0">
                选集
                <Icon name="chevronRight" className="w-3.5 h-3.5" />
              </span>
            )}
          </div>
        </div>
      </div>

      {multi && expanded && (
        <div className="border-t border-line/60 px-3 py-2.5 bg-surface/60 animate-fade-in">
          <div className="flex items-center justify-between gap-2 mb-2">
            <p className="text-[11px] font-medium text-muted">
              优选播放源（按实测画质排序）{sharedRemarks ? ` · ${sharedRemarks}` : ''}
            </p>
            {progress.total > 0 &&
              (progress.done < progress.total ? (
                <p className="text-[11px] text-accent num flex items-center gap-1.5">
                  <span className="search-progress-dot" aria-hidden />
                  探测 {progress.done}/{progress.total}
                </p>
              ) : (
                <p className="text-[11px] text-accent num">
                  {progress.best ? `最高 ${progress.best}` : '点击直达选集'}
                </p>
              ))}
          </div>
          {progress.total > 0 && progress.done < progress.total && (
            <div className="h-1 rounded-full bg-chip overflow-hidden mb-2.5">
              <div
                className="h-full rounded-full bg-accent probe-shimmer transition-[width] duration-300"
                style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
              />
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            {sortedItems.map((item) => {
              const itemKey = qualityKey(item.sourceKey, item.vodId);
              const label = compactRemarks(item.remarks);
              const isBest = itemKey === bestKey;
              return (
                <div
                  key={`${item.sourceKey}_${item.vodId}`}
                  role="button"
                  tabIndex={0}
                  className={cn(
                    'pressable flex w-full min-w-0 items-center gap-2.5 rounded-xl border px-3 py-2.5',
                    'text-xs cursor-pointer transition-colors',
                    isBest
                      ? 'border-accent/45 bg-accent/10 text-content'
                      : 'border-line/60 bg-chip/70 text-content hover:bg-hover'
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpen(item);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    e.stopPropagation();
                    onOpen(item);
                  }}
                >
                  <span className="font-semibold truncate flex-1 min-w-0">{item.sourceName}</span>
                  {isBest && (
                    <span className="rounded-full bg-accent/20 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
                      最佳
                    </span>
                  )}
                  <QualityBadge
                    entry={qualities[itemKey]}
                    loading={probing[itemKey]}
                    onRetry={() => retry([item])}
                    className="min-w-[3.25rem] justify-center num"
                  />
                  {!sharedRemarks && label && <span className="text-faint shrink-0 num">{label}</span>}
                  <Icon name="play" className="w-3.5 h-3.5 text-accent shrink-0" />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function VideoCard({ item, onClick }: { item: SearchResultItem; onClick: () => void }) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = !!item.pic && !imgFailed;

  return (
    <div
      className="card pressable cursor-pointer h-full p-2.5 flex gap-3"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {showImg ? (
        <div className="relative flex-shrink-0 w-[92px] aspect-[2/3] rounded-xl overflow-hidden bg-chip">
          <SmartImage
            url={item.pic}
            mode={imageProxyMode}
            customProxy={customImageProxy}
            alt={item.name}
            className="h-full w-full object-cover"
            onExhausted={() => setImgFailed(true)}
          />
        </div>
      ) : (
        <div className="flex-shrink-0 w-[92px] aspect-[2/3] rounded-xl bg-chip flex items-center justify-center">
          <Icon name="tv" className="w-7 h-7 text-faint" />
        </div>
      )}
      <div className="flex flex-col flex-grow min-w-0 py-0.5">
        <h3 className="font-bold text-sm text-content mb-1.5 line-clamp-2">{item.name}</h3>
        <p className="text-xs text-muted line-clamp-2 mb-2">{formatRemarks(item.remarks) || '暂无介绍'}</p>
        <div className="mt-auto pt-1.5 border-t border-line/50">
          <span className="tag bg-chip text-muted truncate">{item.sourceName}</span>
        </div>
      </div>
    </div>
  );
}
