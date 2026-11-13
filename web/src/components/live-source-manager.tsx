'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '@/lib/store';
import { useToast } from './toast';
import { api } from '@/lib/client-api';
import { formatRelativeTime, hostnameOf, validateSourceUrl, cn } from '@/lib/utils';
import { SearchInput, SectionTitle, TestBadge, useSourceTests } from './settings-shared';
import { EmptyState } from './states';
import { Icon } from './icon';
import { copyToClipboard } from '@/lib/clipboard';

type LiveFilter = 'all' | 'enabled' | 'disabled' | 'sub' | 'manual';

const LIVE_FILTERS: { id: LiveFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'enabled', label: '已启用' },
  { id: 'disabled', label: '已停用' },
  { id: 'sub', label: '来自订阅' },
  { id: 'manual', label: '手动添加' },
];

interface LiveRow {
  url: string;
  label: string;
  epgUrl?: string;
  preset: boolean;
  lastSync?: number;
  fromSubscriptions: string[];
}

export function LiveSourceManager() {
  const store = useAppStore();
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<LiveFilter>('all');
  const { tests, runTest } = useSourceTests();

  const rows = useMemo<LiveRow[]>(() => {
    const preset: LiveRow[] = store.liveEnvSources.map((s) => ({
      url: s.url,
      label: s.name || hostnameOf(s.url),
      epgUrl: s.epg,
      preset: true,
      fromSubscriptions: [],
    }));
    const subs: LiveRow[] = store.liveSubscriptions.map((s) => ({
      url: s.url,
      label: s.name || hostnameOf(s.url),
      epgUrl: s.epg,
      preset: false,
      lastSync: s.lastSync,
      fromSubscriptions: s.fromSubscriptions,
    }));
    const all = [...preset, ...subs];
    const q = query.trim().toLowerCase();
    return all.filter((r) => {
      if (filter === 'enabled' && !store.liveSelectedUrls.includes(r.url)) return false;
      if (filter === 'disabled' && store.liveSelectedUrls.includes(r.url)) return false;
      if (filter === 'sub' && r.fromSubscriptions.length === 0) return false;
      if (filter === 'manual' && !(r.fromSubscriptions.length === 0 && !r.preset)) return false;
      if (!q) return true;
      return r.label.toLowerCase().includes(q) || r.url.toLowerCase().includes(q);
    });
  }, [store.liveEnvSources, store.liveSubscriptions, store.liveSelectedUrls, query, filter]);

  const editingSource = editing ? store.liveSubscriptions.find((s) => s.url === editing) : undefined;

  const exportM3u = async (url: string, label: string) => {
    try {
      const res = await fetch(api.liveExportUrl(url));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const blob = new Blob([text], { type: 'audio/x-mpegurl;charset=utf-8' });
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `${label || 'live'}.m3u`;
      a.click();
      URL.revokeObjectURL(blobUrl);
      toast(`已导出「${label}」M3U 播放列表`, 'success');
    } catch {
      const ok = await copyToClipboard(url);
      toast(ok ? '已复制直播源订阅地址到剪贴板' : '导出失败，请稍后重试', ok ? 'info' : 'error');
    }
  };

  const allEnabled = rows.length > 0 && rows.every((r) => store.liveSelectedUrls.includes(r.url));
  const toggleAll = () => {
    const targets = rows
      .filter((r) => store.liveSelectedUrls.includes(r.url) === allEnabled)
      .map((r) => r.url);
    if (targets.length > 0) useAppStore.getState().toggleLiveSelectedMany(targets);
  };

  const removeWithUndo = (row: LiveRow) => {
    const snapshot = useAppStore.getState().removeLiveSubscription(row.url);
    if (!snapshot) return;
    if (editing === row.url) setEditing(null);
    toast(`已移除「${row.label}」`, 'info', {
      action: {
        label: '撤销',
        onClick: () => {
          useAppStore.getState().restoreLiveSubscription(snapshot);
          toast('已恢复', 'success');
        },
      },
    });
  };

  const empty = store.liveEnvSources.length === 0 && store.liveSubscriptions.length === 0;

  return (
    <section>
      <SectionTitle
        title="直播源"
        hint={empty ? 'M3U / TXT 频道列表管理' : `共 ${store.liveEnvSources.length + store.liveSubscriptions.length} 个 · 已启用 ${store.liveSelectedUrls.length}`}
        extra={
          <button className="btn-primary btn-sm" onClick={() => setAdding(true)}>
            <Icon name="plus" className="w-3.5 h-3.5" />
            添加直播源
          </button>
        }
      />

      <LiveSourceForm
        visible={adding || editingSource !== undefined}
        initial={editingSource}
        onCancel={() => {
          setAdding(false);
          setEditing(null);
        }}
        onSubmit={(data) => {
          if (editing) {
            store.updateLiveSubscription(editing, { name: data.name, epg: data.epg });
          } else {
            store.addLiveSubscription(data.url, data.name, data.epg);
            void runTest(data.url, () => api.liveTest(data.url));
          }
          setAdding(false);
          setEditing(null);
        }}
      />

      {empty && !adding && editingSource === undefined ? (
        <EmptyState
          icon="tv"
          title="还没有添加任何直播源"
          description="添加 M3U 或 TXT 直播源地址后即可在「直播」页按分组选台观看；也可在「数据源订阅」中一键同步整套点播源与直播源。"
          action={
            <button className="btn-primary btn-sm" onClick={() => setAdding(true)}>
              添加第一个直播源
            </button>
          }
        />
      ) : (
        <>
          <div className="space-y-2 mb-3">
            <SearchInput value={query} onChange={setQuery} placeholder="搜索直播源名称或地址" />
            <div className="flex flex-wrap items-center gap-1">
              {LIVE_FILTERS.map((f) => (
                <button
                  key={f.id}
                  className={cn(
                    'chip',
                    filter === f.id ? 'bg-accent/10 text-accent font-medium' : 'text-muted hover:text-content hover:bg-hover'
                  )}
                  onClick={() => setFilter(f.id)}
                  aria-pressed={filter === f.id}
                >
                  {f.label}
                </button>
              ))}
              <span className="ml-auto text-[11px] text-faint">显示 {rows.length} 个</span>
            </div>
            <button className="btn-ghost btn-sm" onClick={toggleAll} disabled={rows.length === 0}>
              {allEnabled ? '全部停用' : '全部启用'}
            </button>
          </div>

          {rows.length === 0 ? (
            <EmptyState variant="plain" title="没有符合条件的直播源" />
          ) : (
            <ul className="space-y-2">
              {rows.map((row) => {
                const enabled = store.liveSelectedUrls.includes(row.url);
                const fromSubscription = row.fromSubscriptions.length > 0;
                return (
                  <li
                    key={row.url}
                    className={cn(
                      'bg-card rounded-xl p-3 transition-colors hover:bg-hover/50',
                      !enabled && 'opacity-70'
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-accent shrink-0"
                        checked={enabled}
                        onChange={() => useAppStore.getState().toggleLiveSelected(row.url)}
                        aria-label={enabled ? `停用 ${row.label}` : `启用 ${row.label}`}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-content truncate">
                          {row.label}
                          {row.preset && (
                            <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-chip text-faint align-middle">
                              内置源
                            </span>
                          )}
                          {fromSubscription && (
                            <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent align-middle">
                              订阅
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-faint truncate">
                          {row.url}
                          {row.epgUrl && ' · 已配节目单'}
                          {row.lastSync && ` · 同步于 ${formatRelativeTime(row.lastSync)}`}
                        </div>
                      </div>
                      <TestBadge
                        state={tests[row.url]}
                        onTest={() => runTest(row.url, () => api.liveTest(row.url))}
                        title="拉取解析并测速（频道数量与耗时）"
                        badgeWhenOk={({ count }) => `✓ ${count ?? 0} 频道`}
                      />
                      <button
                        className="rounded-md p-2 text-muted transition-colors hover:bg-hover hover:text-accent shrink-0"
                        onClick={() => void exportM3u(row.url, row.label)}
                        aria-label="导出 M3U"
                        title="导出为标准 M3U 文件"
                      >
                        <Icon name="download" className="w-4 h-4" />
                      </button>
                      {row.preset ? null : fromSubscription ? (
                        <>
                          <button
                            className="rounded-md p-2 text-muted/30 cursor-not-allowed shrink-0"
                            disabled
                            aria-label="订阅源不可单独编辑"
                          >
                            <Icon name="edit" className="w-4 h-4" />
                          </button>
                          <button
                            className="rounded-md p-2 text-muted/30 cursor-not-allowed shrink-0"
                            disabled
                            aria-label="订阅源不可单独删除"
                          >
                            <Icon name="trash" className="w-4 h-4" />
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className="rounded-md p-2 text-muted transition-colors hover:bg-hover hover:text-accent shrink-0"
                            onClick={() => setEditing(row.url)}
                            aria-label="编辑"
                          >
                            <Icon name="edit" className="w-4 h-4" />
                          </button>
                          <button
                            className="rounded-md p-2 text-muted transition-colors hover:bg-hover hover:text-danger shrink-0"
                            onClick={() => removeWithUndo(row)}
                            aria-label="删除直播源"
                          >
                            <Icon name="trash" className="w-4 h-4" />
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function LiveSourceForm({
  visible,
  initial,
  onCancel,
  onSubmit,
}: {
  visible: boolean;
  initial?: { url: string; name?: string; epg?: string };
  onCancel: () => void;
  onSubmit: (data: { url: string; name?: string; epg?: string }) => void;
}) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [epg, setEpg] = useState('');
  const { toast } = useToast();

  useEffect(() => {
    if (visible) {
      setUrl(initial?.url ?? '');
      setName(initial?.name ?? '');
      setEpg(initial?.epg ?? '');
    }
  }, [visible, initial]);

  if (!visible) return null;

  const submit = () => {
    if (initial) {
      onSubmit({ url: initial.url, name: name.trim() || undefined, epg: epg.trim() || undefined });
      return;
    }
    const u = url.trim();
    if (!validateSourceUrl(u)) {
      toast('订阅地址需以 http:// 或 https:// 开头', 'warning');
      return;
    }
    onSubmit({ url: u, name: name.trim() || undefined, epg: epg.trim() || undefined });
  };

  return (
    <div className="space-y-2 border border-line rounded-xl p-3 bg-chip mb-2">
      <input
        className="input w-full disabled:opacity-60"
        aria-label="M3U 订阅地址"
        placeholder="M3U / TXT 订阅地址，如 https://example.com/list.m3u"
        value={url}
        maxLength={500}
        disabled={!!initial}
        onChange={(e) => setUrl(e.target.value)}
      />
      <input
        className="input w-full"
        aria-label="直播源名称（可选）"
        placeholder="名称（可选），如 卫视频道精选"
        value={name}
        maxLength={50}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className="input w-full"
        aria-label="EPG 节目单地址（可选）"
        placeholder="EPG 节目单地址（可选，XMLTV xml/xml.gz）"
        value={epg}
        maxLength={500}
        onChange={(e) => setEpg(e.target.value)}
      />
      <div className="flex gap-2 justify-end">
        <button className="btn-ghost btn-sm" onClick={onCancel}>
          取消
        </button>
        <button className="btn-primary btn-sm" onClick={submit}>
          {initial ? '保存' : '添加'}
        </button>
      </div>
    </div>
  );
}
