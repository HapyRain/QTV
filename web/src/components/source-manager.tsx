'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Drawer } from './drawer';
import { ConfirmDialog } from './confirm-dialog';
import { Dropdown, type DropdownOption } from './dropdown';
import { Icon, type IconName } from './icon';
import { LiveSourceManager } from './live-source-manager';
import {
  HealthBadge,
  SearchInput,
  SectionTitle,
  SelectRow,
  TestBadge,
  ToggleRow,
  Switch,
  useSourceTests,
  type TestState,
} from './settings-shared';
import { loadCacheSettings, saveCacheSettings, getCacheSummary, clearVideoCache, type CacheSummary } from '@/lib/video-cache';
import { EmptyState, Spinner } from './states';
import { useSourceProbe } from './use-source-probe';
import { isSourceDisabled, keyBelongsToSubscription, subKeyPrefix, useAppStore } from '@/lib/store';
import type { SourceConfig } from '@/lib/types';
import { useToast } from './toast';
import { formatRelativeTime, hostnameOf, validateSourceUrl, cn } from '@/lib/utils';
import { exportConfig, importConfig } from '@/lib/db';
import { PERSIST_KEY } from '@/lib/persist-storage';
import { api } from '@/lib/client-api';
import { AUTO_REFRESH_MAX_FAIL_STREAK, syncSourceSubscription } from '@/lib/subscription-sync';
import { describeParseStats } from '@/lib/tvbox-parser';

type PrimaryTab = 'sources' | 'prefs' | 'data';
type SecondaryTab = 'vod' | 'live' | 'subs' | 'playback' | 'image' | 'io';

const PRIMARY_TABS: { id: PrimaryTab; label: string; icon: IconName }[] = [
  { id: 'sources', label: '片源管理', icon: 'link' },
  { id: 'prefs', label: '观影偏好', icon: 'sliders' },
  { id: 'data', label: '备份恢复', icon: 'download' },
];

const SECONDARY_TABS: Record<PrimaryTab, { id: SecondaryTab; label: string }[]> = {
  sources: [
    { id: 'vod', label: '点播源' },
    { id: 'live', label: '直播源' },
    { id: 'subs', label: '聚合订阅' },
  ],
  prefs: [
    { id: 'playback', label: '播放与过滤' },
    { id: 'image', label: '海报加载' },
  ],
  data: [{ id: 'io', label: '整机备份与恢复' }],
};

const TAB_STORAGE_KEY = 'libretv-settings-tab';

export function SourceManagerDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [primary, setPrimary] = useState<PrimaryTab>('sources');
  const [secondary, setSecondary] = useState<Record<PrimaryTab, SecondaryTab>>({
    sources: 'vod',
    prefs: 'playback',
    data: 'io',
  });

  useEffect(() => {
    try {
      const raw = localStorage.getItem(TAB_STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as {
        primary?: PrimaryTab;
        secondary?: Partial<Record<PrimaryTab, SecondaryTab>>;
      };
      const migratedSubs = saved.secondary?.data === 'subs';
      const targetPrimary = migratedSubs && saved.primary === 'data' ? 'sources' : saved.primary;
      if (targetPrimary && SECONDARY_TABS[targetPrimary]) setPrimary(targetPrimary);
      setSecondary((prev) => {
        const next = { ...prev };
        if (migratedSubs) next.sources = 'subs';
        for (const key of Object.keys(SECONDARY_TABS) as PrimaryTab[]) {
          const v = saved.secondary?.[key];
          if (v && SECONDARY_TABS[key].some((t) => t.id === v)) next[key] = v;
        }
        return next;
      });
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(TAB_STORAGE_KEY, JSON.stringify({ primary, secondary }));
    } catch {
      /* ignore */
    }
  }, [primary, secondary]);

  const current = secondary[primary];

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="片源与偏好设置"
      resetScrollKey={current}
      mobileFull
      subheader={
        <div className="space-y-2">
          <TabRow tabs={PRIMARY_TABS} value={primary} onChange={setPrimary} variant="primary" ariaLabel="设置分类" />
          {SECONDARY_TABS[primary].length > 1 && (
            <TabRow
              tabs={SECONDARY_TABS[primary]}
              value={current}
              onChange={(id) => setSecondary((prev) => ({ ...prev, [primary]: id }))}
              variant="secondary"
              ariaLabel="设置子项"
            />
          )}
        </div>
      }
    >
      {current === 'vod' && <VodSourcesPanel />}
      {current === 'live' && <LiveSourceManager />}
      {current === 'playback' && <PlaybackPanel />}
      {current === 'image' && <ImagePanel />}
      {current === 'subs' && <SourceSubscriptions />}
      {current === 'io' && <ConfigIoPanel />}
    </Drawer>
  );
}

function TabRow<T extends string>({
  tabs,
  value,
  onChange,
  variant,
  ariaLabel,
}: {
  tabs: { id: T; label: string; icon?: IconName }[];
  value: T;
  onChange: (id: T) => void;
  variant: 'primary' | 'secondary';
  ariaLabel: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn('flex w-full gap-1', variant === 'primary' && 'p-1 bg-chip rounded-xl')}
    >
      {tabs.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            className={cn(
              'flex-1 min-w-0 inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-lg transition-colors',
              variant === 'primary'
                ? cn(
                    'px-2 py-1.5 text-xs',
                    active ? 'bg-surface-raised text-accent font-semibold shadow-sm' : 'text-muted hover:text-content'
                  )
                : cn(
                    'px-2.5 py-1.5 text-xs',
                    active ? 'bg-accent/15 text-accent font-medium' : 'text-muted hover:text-content hover:bg-hover'
                  )
            )}
            onClick={() => onChange(t.id)}
          >
            {t.icon && <Icon name={t.icon} className="w-3.5 h-3.5" />}
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

type VodFilter = 'all' | 'enabled' | 'disabled' | 'sub' | 'manual';

const VOD_FILTERS: { id: VodFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'enabled', label: '已启用' },
  { id: 'disabled', label: '已停用' },
  { id: 'sub', label: '来自订阅' },
  { id: 'manual', label: '手动添加' },
];

function VodSourcesPanel() {
  const store = useAppStore();
  const { toast } = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<VodFilter>('all');
  const { tests, runTest } = useSourceTests();
  const { progress, probe, cancel, isProbing } = useSourceProbe();

  const envKeys = useMemo(() => new Set(store.envSources.map((s) => s.key)), [store.envSources]);
  const all = useMemo(() => [...store.envSources, ...store.customAPIs], [store.envSources, store.customAPIs]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((s) => {
      const fromSub = s.key.startsWith('sub_');
      if (filter === 'enabled' && !(store.selectedKeys.includes(s.key) && !isSourceDisabled(store, s.key))) return false;
      if (filter === 'disabled' && !isSourceDisabled(store, s.key)) return false;
      if (filter === 'sub' && !fromSub) return false;
      if (filter === 'manual' && (fromSub || envKeys.has(s.key))) return false;
      if (!q) return true;
      return s.name.toLowerCase().includes(q) || s.url.toLowerCase().includes(q);
    });
  }, [all, query, filter, store, envKeys]);

  const visibleKeys = filtered.map((s) => s.key);
  const allSelected = visibleKeys.length > 0 && visibleKeys.every((k) => store.selectedKeys.includes(k));

  const toggleAll = () => {
    if (allSelected) {
      store.setSelectedKeys(store.selectedKeys.filter((k) => !visibleKeys.includes(k)));
      return;
    }
    const eligible = filtered.filter((s) => !(s.isAdult && store.yellowFilter)).map((s) => s.key);
    const skipped = filtered.length - eligible.length;
    store.setSelectedKeys([...new Set([...store.selectedKeys, ...eligible])]);
    if (skipped > 0) toast(`已启用 ${eligible.length} 个；${skipped} 个成人源因过滤开启被跳过`, 'info');
  };

  const runAll = async () => {
    if (isProbing) {
      cancel();
      return;
    }
    const result = await probe(filtered.map((s) => ({ key: s.key, url: s.url })));
    if (!result) return;
    toast(`测活完成：${result.ok}/${result.total} 个可用`, result.ok === result.total ? 'success' : 'info');
  };

  const restoreAll = () => {
    const keys = filtered.filter((s) => isSourceDisabled(store, s.key)).map((s) => s.key);
    if (keys.length === 0) return;
    keys.forEach((k) => useAppStore.getState().clearSourceHealth(k));
    toast(`已恢复 ${keys.length} 个源`, 'success');
  };

  const empty = store.envSources.length === 0 && store.customAPIs.length === 0;

  return (
    <section>
      <SectionTitle
        title="点播源"
        hint={empty ? undefined : `共 ${all.length} 个 · 已启用 ${all.filter((s) => store.selectedKeys.includes(s.key)).length}`}
        extra={
          <button className="btn-primary btn-sm" onClick={() => setEditing('__new__')}>
            <Icon name="plus" className="w-3.5 h-3.5" />
            添加点播源
          </button>
        }
      />

      <SourceForm
        visible={editing === '__new__'}
        onCancel={() => setEditing(null)}
        onSubmit={(data) => {
          store.addCustomApi(data);
          setEditing(null);
        }}
      />

      {empty && editing !== '__new__' ? (
        <EmptyState
          icon="link"
          title="还没有添加任何点播源"
          description="添加采集站 API 即可搜索影片；也可到「聚合订阅」一键导入整套点播源与直播源。"
          action={
            <button className="btn-primary btn-sm" onClick={() => setEditing('__new__')}>
              添加第一个点播源
            </button>
          }
        />
      ) : (
        <>
          <div className="space-y-2 mb-3">
            <SearchInput value={query} onChange={setQuery} placeholder="搜索点播源名称或地址" />
            <div className="flex flex-wrap items-center gap-1">
              {VOD_FILTERS.map((f) => (
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
              <span className="ml-auto text-[11px] text-faint">显示 {filtered.length} 个</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button className="btn-ghost btn-sm" onClick={toggleAll} disabled={filtered.length === 0}>
                {allSelected ? '全部停用' : '全部启用'}
              </button>
              <button className="btn-ghost btn-sm" onClick={runAll} disabled={filtered.length === 0}>
                {isProbing ? '取消测活' : '批量测活'}
              </button>
              {filter === 'disabled' && (
                <button className="btn-ghost btn-sm" onClick={restoreAll} disabled={filtered.length === 0}>
                  全部恢复
                </button>
              )}
            </div>
            {progress && (
              <div className="flex items-center gap-2 text-[11px] text-muted">
                <div className="flex-1 h-1.5 bg-chip rounded-full overflow-hidden">
                  <div
                    className="h-full bg-accent transition-[width] duration-200"
                    style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
                  />
                </div>
                <span className="tabular-nums shrink-0">
                  {progress.done}/{progress.total} · 可用 {progress.ok}
                  {formatEta(progress.done, progress.total, progress.startedAt)}
                </span>
                <button className="btn-ghost btn-sm shrink-0" onClick={cancel}>
                  取消
                </button>
              </div>
            )}
          </div>

          {filtered.length === 0 ? (
            <EmptyState variant="plain" title="没有符合条件的点播源" />
          ) : (
            <ul className="space-y-2">
              {filtered.map((source) => (
                <VodSourceRow
                  key={source.key}
                  api={source}
                  isEnv={envKeys.has(source.key)}
                  editing={editing === source.key}
                  onEdit={setEditing}
                  onCancelEdit={() => setEditing(null)}
                  onUpdate={(data) => {
                    store.updateCustomApi(source.key, data);
                    setEditing(null);
                  }}
                  testState={tests[source.key]}
                  onTest={() =>
                    runTest(source.key, async () => {
                      const r = await api.testSource(source.url);
                      useAppStore.getState().recordSourceHealth([
                        { sourceKey: source.key, ok: r.ok, ms: r.ms, error: r.error, list: [] },
                      ]);
                      return r;
                    })
                  }
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function formatEta(done: number, total: number, startedAt: number): string {
  if (done <= 0 || done >= total) return '';
  const elapsed = Date.now() - startedAt;
  const remainSec = Math.max(0, Math.round(((elapsed / done) * (total - done)) / 1000));
  return remainSec > 0 ? ` · 约 ${remainSec}s` : '';
}

function VodSourceRow({
  api,
  isEnv,
  editing,
  onEdit,
  onCancelEdit,
  onUpdate,
  testState,
  onTest,
}: {
  api: SourceConfig;
  isEnv: boolean;
  editing: boolean;
  onEdit: (key: string) => void;
  onCancelEdit: () => void;
  onUpdate: (data: { name: string; url: string; detail?: string; isAdult?: boolean }) => void;
  testState?: TestState;
  onTest: () => void;
}) {
  const selected = useAppStore((s) => s.selectedKeys.includes(api.key));
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const toast = useToast().toast;
  const fromSubscription = api.key.startsWith('sub_');
  const adultBlocked = !!api.isAdult && yellowFilter;

  const remove = () => {
    const snapshot = useAppStore.getState().removeCustomApi(api.key);
    if (!snapshot) return;
    toast(`已移除「${api.name}」`, 'info', {
      action: {
        label: '撤销',
        onClick: () => {
          const ok = useAppStore.getState().restoreCustomApi(snapshot);
          toast(ok ? '已恢复' : '恢复失败：该源位置已被占用', ok ? 'success' : 'warning');
        },
      },
    });
  };

  if (editing) {
    return (
      <li className="bg-card rounded-xl p-3">
        <SourceForm visible initial={api} onCancel={onCancelEdit} onSubmit={onUpdate} />
      </li>
    );
  }

  return (
    <li
      className={cn(
        'bg-card rounded-xl p-3 transition-colors hover:bg-hover/50',
        !selected && 'opacity-70'
      )}
    >
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          className="h-4 w-4 accent-accent shrink-0"
          checked={selected}
          onChange={() => useAppStore.getState().toggleSourceSelected(api.key)}
          disabled={adultBlocked}
          aria-label={`选择 ${api.name}`}
        />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-content truncate">
            {api.name}
            {api.isAdult && <span className="text-pink-400 text-xs ml-1">(18+)</span>}
            {isEnv && (
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
          <div className="text-xs text-faint truncate">{api.url}</div>
        </div>
        <HealthBadge sourceKey={api.key} />
        <TestBadge
          state={testState}
          onTest={onTest}
          title="测试可用性与响应耗时"
          badgeWhenOk={({ ms }) => `✓ ${ms}ms`}
        />
        {!isEnv &&
          (fromSubscription ? (
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
                onClick={() => onEdit(api.key)}
                aria-label="编辑"
              >
                <Icon name="edit" className="w-4 h-4" />
              </button>
              <button
                className="rounded-md p-2 text-muted transition-colors hover:bg-hover hover:text-danger shrink-0"
                onClick={remove}
                aria-label="删除"
              >
                <Icon name="trash" className="w-4 h-4" />
              </button>
            </>
          ))}
      </div>
    </li>
  );
}

function PlaybackPanel() {
  const store = useAppStore();
  const { toast } = useToast();
  const [clearMarksOpen, setClearMarksOpen] = useState(false);
  const markCount = Object.keys(store.skipMarks).length;
  return (
    <section>
      <SectionTitle title="播放与内容过滤" />
      <div className="space-y-3">
        <ToggleRow
          label="广告切片过滤"
          description="智能剔除播放列表中的插播广告分片，保持正片时间轴连续。"
          checked={store.adFilter}
          onChange={(v) => store.updateSettings({ adFilter: v })}
        />
        <ToggleRow
          label="自动连播下一集"
          description="单集播放结束后自动无缝切换至下一集。"
          checked={store.autoplayNext}
          onChange={(v) => store.updateSettings({ autoplayNext: v })}
        />
        <ToggleRow
          label="自动跳过片头片尾"
          description="命中已标记的片头/中段时自动跳至正片，命中片尾时自动结束本集；关闭后仅在画面右下角显示手动「跳过」胶囊。"
          checked={store.autoSkipSegments}
          onChange={(v) => store.updateSettings({ autoSkipSegments: v })}
        />
        <ToggleRow
          label="人声与音量增强"
          description="部分片源声音偏小时开启：通过音频增益链放大约 1.8 倍并启用防破音限幅。"
          checked={store.volumeBoost}
          onChange={(v) => store.updateSettings({ volumeBoost: v })}
        />
        <ToggleRow
          label="底部常驻微进度线"
          description="控制栏收起后，在画面底边保留一条 3px 流光细线以便随时扫视进度；关闭后全屏观影完全无遮挡，轻触画面即可唤出控制栏。"
          checked={store.miniProgressBar}
          onChange={(v) => store.updateSettings({ miniProgressBar: v })}
        />
        <ToggleRow
          label="成人内容过滤"
          description="在搜索与片源列表中自动屏蔽成人分类内容。"
          checked={store.yellowFilter}
          onChange={(v) => store.updateSettings({ yellowFilter: v })}
        />
      </div>

      {markCount > 0 && (
        <div className="flex items-center justify-between gap-3 pt-3 mt-3 border-t border-line">
          <div className="min-w-0">
            <div className="text-sm text-content">片头片尾打点记录</div>
            <div className="text-xs text-faint">已记录 {markCount} 部影视；可在播放页「跳过片头片尾」面板中逐剧管理</div>
          </div>
          <button className="btn-ghost btn-sm shrink-0" onClick={() => setClearMarksOpen(true)}>
            清除全部
          </button>
        </div>
      )}

      <ConfirmDialog
        open={clearMarksOpen}
        danger
        title="清除全部跳过标记？"
        message={`将清空已记录的 ${markCount} 部剧集的片头片尾标记，可随时在播放页重新打点。`}
        confirmLabel="确认清除"
        onCancel={() => setClearMarksOpen(false)}
        onConfirm={() => {
          store.clearAllSkipMarks();
          setClearMarksOpen(false);
          toast('已清除全部片头片尾标记', 'success');
        }}
      />

      <VideoCachePanel />
    </section>
  );
}

function VideoCachePanel() {
  const [enabled, setEnabled] = useState(() => loadCacheSettings().enabled);
  const [summary, setSummary] = useState<CacheSummary>({ segments: 0, bytes: 0, episodes: 0 });
  const [clearing, setClearing] = useState(false);

  const refresh = useCallback(() => {
    void getCacheSummary().then(setSummary);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const formatBytes = (bytes: number): string => {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
  };

  return (
    <div className="space-y-3 pt-3 mt-3 border-t border-line">
      <ToggleRow
        label="播放分片本机预缓存"
        description="观影或暂停时自动将后续视频分片缓存至本机闪存，回看或网络波动时秒级命中。"
        checked={enabled}
        onChange={(v) => {
          const next = saveCacheSettings({ enabled: v });
          setEnabled(next.enabled);
        }}
      />
      <div className="flex items-center justify-between text-xs text-faint">
        <span className="tabular-nums">
          本机已缓存 {summary.segments} 个分片 · {formatBytes(summary.bytes)} · 涉及 {summary.episodes} 集
        </span>
        <button
          type="button"
          className="px-2.5 py-1 rounded-lg bg-chip text-content hover:bg-hover transition-colors disabled:opacity-50"
          disabled={clearing || summary.segments === 0}
          onClick={async () => {
            setClearing(true);
            await clearVideoCache();
            refresh();
            setClearing(false);
          }}
        >
          清理缓存
        </button>
      </div>
    </div>
  );
}

function ImagePanel() {
  const store = useAppStore();
  const mode = store.imageProxyMode;
  const description: Record<'direct' | 'proxy' | 'custom', string> = {
    direct: '优先从源站直接加载高清海报；遇到防盗链时自动切换公共镜像与本地代理兜底。',
    proxy: '所有剧集海报优先通过本机代理通道伪装来源加载，兼容性最稳。',
    custom: '使用自定义图片代理模板加载剧集封面。',
  };
  return (
    <section>
      <SectionTitle title="海报封面加载" />
      <div className="space-y-2">
        <SelectRow
          label="封面加载策略"
          value={mode}
          description={description[mode]}
          onChange={(v) => store.updateSettings({ imageProxyMode: v as 'direct' | 'proxy' | 'custom' })}
          options={[
            { value: 'direct', label: '智能直连', hint: '速度最快' },
            { value: 'proxy', label: '代理增强', hint: '防破图最稳' },
            { value: 'custom', label: '自定义', hint: '自建镜像模板' },
          ]}
        />
        {mode === 'custom' && <CustomProxyInput />}
      </div>
    </section>
  );
}

function CustomProxyInput() {
  const value = useAppStore((s) => s.customImageProxy);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => updateSettings({ customImageProxy: draft }), 300);
    return () => clearTimeout(timer);
  }, [draft, value, updateSettings]);

  return (
    <input
      className="input w-full"
      aria-label="自定义代理模板"
      placeholder="代理模板，如 https://p.example.com/?url={url}"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
    />
  );
}

const REFRESH_OPTIONS: DropdownOption[] = [
  { value: 'off', label: '手动同步', hint: '仅在点刷新时更新' },
  { value: '1', label: '每天', hint: '启动应用时自动检查' },
  { value: '3', label: '每 3 天' },
  { value: '7', label: '每 7 天' },
  { value: '14', label: '每 14 天' },
  { value: '30', label: '每 30 天' },
];

function SourceSubscriptions() {
  const store = useAppStore();
  const { toast } = useToast();
  const [subUrl, setSubUrl] = useState('');
  const [syncing, setSyncing] = useState<Set<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const sync = async (url: string) => {
    setSyncing((prev) => new Set(prev).add(url));
    try {
      const { vodCount, liveCount, stats } = await syncSourceSubscription(url);
      const detail = describeParseStats(stats, { includeSamples: false });
      const formatLabel =
        stats?.format === 'tvbox'
          ? '（TVBOX 配置）'
          : stats?.format === 'source-catalog'
            ? '（接口源列表）'
            : '';
      toast(`已同步 ${vodCount} 个点播源、${liveCount} 个直播源${formatLabel}${detail ? `；${detail}` : ''}`, 'success');
      setSubUrl('');
    } catch (err) {
      toast(err instanceof Error ? err.message : '订阅同步失败', 'error');
    } finally {
      setSyncing((prev) => {
        const next = new Set(prev);
        next.delete(url);
        return next;
      });
    }
  };

  const addAndSync = () => {
    const url = subUrl.trim();
    if (!validateSourceUrl(url)) {
      toast('订阅地址需以 http:// 或 https:// 开头', 'warning');
      return;
    }
    void sync(url);
  };

  const exportSources = () => {
    const all = [...store.envSources, ...store.customAPIs];
    const seen = new Set<string>();
    const sources = all
      .filter((s) => {
        const u = s.url.replace(/\/+$/, '');
        if (seen.has(u)) return false;
        seen.add(u);
        return true;
      })
      .map(({ name, url, detail, isAdult }) => ({ name, url, detail, isAdult }));

    const liveSeen = new Set<string>();
    const liveSources = [...store.liveEnvSources, ...store.liveSubscriptions]
      .filter((s) => {
        if (liveSeen.has(s.url)) return false;
        liveSeen.add(s.url);
        return true;
      })
      .map(({ name, url, epg }) => ({ name: name || hostnameOf(url), url, epg }));

    const payload = { name: 'LibreTV-SourceList', version: 2, exportedAt: Date.now(), sources, liveSources };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `QTV-SourceList_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`已导出 ${sources.length} 个点播源、${liveSources.length} 个直播源`, 'success');
  };

  const deleteImpact = (url: string) => {
    const prefix = subKeyPrefix(url);
    return {
      vod: store.customAPIs.filter((a) => keyBelongsToSubscription(a.key, prefix)).length,
      live: store.liveSubscriptions.filter((s) => s.fromSubscriptions.includes(url)).length,
    };
  };

  return (
    <section>
      <SectionTitle
        title="聚合数据源订阅"
        extra={
          <button
            className="btn-ghost btn-sm"
            onClick={exportSources}
            disabled={
              store.customAPIs.length + store.envSources.length + store.liveSubscriptions.length + store.liveEnvSources.length ===
              0
            }
          >
            导出源列表 JSON
          </button>
        }
      />

      <div className="flex gap-2 mb-2.5">
        <input
          className="input flex-1 min-w-0"
          placeholder="输入订阅地址（QTV 源列表或 TVBOX JSON 链接）"
          value={subUrl}
          onChange={(e) => setSubUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addAndSync();
          }}
        />
        <button
          className="btn-primary btn-sm shrink-0"
          disabled={!subUrl.trim() || syncing.size > 0}
          onClick={addAndSync}
        >
          {syncing.size > 0 ? '同步中…' : '添加订阅'}
        </button>
      </div>
      {store.subscriptions.length === 0 ? (
        <p className="text-xs text-faint leading-relaxed">
          填入远端 JSON 订阅链接即可一次性导入整套点播源与直播源，支持 QTV 源列表与 TVBOX 接口配置自动识别。
        </p>
      ) : (
        <ul className="space-y-2">
          {store.subscriptions.map((sub) => {
            const vodCount = store.customAPIs.filter((a) => keyBelongsToSubscription(a.key, subKeyPrefix(sub.url))).length;
            const liveCount = store.liveSubscriptions.filter((s) => s.fromSubscriptions.includes(sub.url)).length;
            const isSyncing = syncing.has(sub.url);
            const paused = Boolean(
              sub.refreshDays && (sub.failStreak ?? 0) >= AUTO_REFRESH_MAX_FAIL_STREAK
            );
            const nextAt =
              sub.refreshDays && sub.lastSync ? sub.lastSync + sub.refreshDays * 86_400_000 : undefined;
            const remainingMs = nextAt ? nextAt - Date.now() : 0;
            return (
              <li
                key={sub.url}
                className={cn(
                  'bg-card rounded-xl p-3 transition-colors hover:bg-hover/50',
                  sub.enabled === false && 'opacity-70'
                )}
              >
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-content truncate">{sub.name || hostnameOf(sub.url)}</div>
                    <div className="text-xs text-faint truncate">
                      {sub.url}
                      {sub.lastSync && ` · 同步于 ${formatRelativeTime(sub.lastSync)}`}
                    </div>
                    <div className="mt-1 flex items-center gap-1 flex-wrap">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">点播 {vodCount}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">直播 {liveCount}</span>
                      {sub.enabled === false && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning/15 text-warning">已停用</span>
                      )}
                      {sub.lastStatus === 'error' ? (
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded bg-danger/15 text-danger"
                          title={sub.lastError}
                        >
                          上次同步失败
                        </span>
                      ) : sub.lastStatus === 'ok' && sub.lastCounts ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-success/15 text-success">
                          上次导入 {sub.lastCounts.vod} 点播 / {sub.lastCounts.live} 直播
                        </span>
                      ) : null}
                    </div>
                    {sub.lastStatus === 'error' && sub.lastError && (
                      <p className="text-[11px] text-danger mt-1 break-all">{sub.lastError}</p>
                    )}
                    <div className="mt-1.5 flex items-center gap-1.5 flex-wrap text-[11px] text-faint">
                      <Icon name="clock" className="w-3 h-3 shrink-0" />
                      <span>自动更新</span>
                      <Dropdown
                        value={sub.refreshDays ? String(sub.refreshDays) : 'off'}
                        onChange={(v) =>
                          store.setSubscriptionRefreshDays(sub.url, v === 'off' ? undefined : Number(v))
                        }
                        options={REFRESH_OPTIONS}
                        ariaLabel="自动更新周期"
                        className="[&>button]:!py-0.5 [&>button]:!pl-2 [&>button]:!pr-1.5 [&>button]:text-[11px]"
                      />
                      {paused ? (
                        <span className="text-warning">
                          已暂停：连续失败 {sub.failStreak} 次，手动同步成功即恢复
                        </span>
                      ) : remainingMs > 0 ? (
                        <span>约 {Math.max(1, Math.ceil(remainingMs / 86_400_000))} 天后更新</span>
                      ) : sub.refreshDays ? (
                        <span>下次启动应用时更新</span>
                      ) : null}
                    </div>
                  </div>
                  <Switch
                    checked={sub.enabled !== false}
                    onChange={(v) => store.setSubscriptionEnabled(sub.url, v)}
                    label={sub.enabled === false ? '启用该订阅' : '停用该订阅'}
                  />
                  <button
                    className="rounded-md p-2 shrink-0 text-muted transition-colors hover:bg-hover hover:text-accent disabled:opacity-40"
                    disabled={isSyncing}
                    onClick={() => sync(sub.url)}
                    aria-label="重新同步"
                  >
                    {isSyncing ? (
                      <Spinner size="sm" />
                    ) : (
                      <Icon name="refresh" className="w-4 h-4" />
                    )}
                  </button>
                  <button
                    className="rounded-md p-2 shrink-0 text-muted transition-colors hover:bg-hover hover:text-danger"
                    onClick={() => setPendingDelete(sub.url)}
                    aria-label="删除订阅"
                  >
                    <Icon name="trash" className="w-4 h-4" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        danger
        title="删除该订阅？"
        message={
          pendingDelete
            ? (() => {
                const impact = deleteImpact(pendingDelete);
                const parts: string[] = [];
                if (impact.vod > 0) parts.push(`${impact.vod} 个点播源`);
                if (impact.live > 0) parts.push(`${impact.live} 个直播源`);
                return parts.length > 0
                  ? `将同时移除该订阅导入的 ${parts.join(' 与 ')}；已收藏的直播频道会保留。`
                  : '该订阅当前未导入任何源，删除后不影响其他数据。';
              })()
            : undefined
        }
        confirmLabel="确认删除"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const url = pendingDelete;
          if (url) useAppStore.getState().removeSubscription(url);
          setPendingDelete(null);
          toast('订阅已删除', 'success');
        }}
      />
    </section>
  );
}

function ConfigIoPanel() {
  const { toast } = useToast();
  const [pending, setPending] = useState<{ file: File; summary: string } | null>(null);

  const doExport = async () => {
    try {
      const json = await exportConfig();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `QTV-Backup_${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast('整机配置备份已导出', 'success');
    } catch {
      toast('导出失败', 'error');
    }
  };

  const pickImport = async (file: File) => {
    try {
      const summary = summarizeConfig(await file.text());
      setPending({ file, summary });
    } catch (err) {
      toast(err instanceof Error ? err.message : '导入失败', 'error');
    }
  };

  const confirmImport = async () => {
    if (!pending) return;
    try {
      await importConfig(await pending.file.text());
      setPending(null);
      toast('配置恢复成功，即将重新加载', 'success');
      setTimeout(() => window.location.reload(), 1200);
    } catch (err) {
      toast(err instanceof Error ? err.message : '导入失败', 'error');
    }
  };

  return (
    <section className="space-y-3">
      <SectionTitle title="整机配置备份与恢复" hint="一键备份点播源、直播源、聚合订阅、片头片尾标记与观看历史" />
      <div className="grid grid-cols-2 gap-2.5">
        <button className="btn-ghost py-2.5 text-xs font-medium rounded-xl border border-line/70" onClick={doExport}>
          <Icon name="download" className="w-4 h-4" />
          导出备份文件
        </button>
        <label className="btn-ghost py-2.5 text-xs font-medium rounded-xl border border-line/70 cursor-pointer">
          <Icon name="refresh" className="w-4 h-4" />
          从备份文件恢复
          <input
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void pickImport(f);
              e.target.value = '';
            }}
          />
        </label>
      </div>

      <ConfirmDialog
        open={pending !== null}
        danger
        title="确认恢复备份并覆盖当前数据？"
        message={pending ? `${pending.summary}。恢复后将自动刷新应用，当前设备上的设置与历史将被备份替换。` : undefined}
        confirmLabel="确认恢复"
        onCancel={() => setPending(null)}
        onConfirm={confirmImport}
      />
    </section>
  );
}

function summarizeConfig(text: string): string {
  let cfg: { name?: string; data?: Record<string, unknown> };
  try {
    cfg = JSON.parse(text) as { name?: string; data?: Record<string, unknown> };
  } catch {
    throw new Error('文件不是合法的 JSON');
  }
  // 兼容旧版导出的 LibreTV-Settings 备份
  if (cfg.name !== 'QTV-Settings' && cfg.name !== 'LibreTV-Settings') throw new Error('不是有效的 QTV 备份文件');

  const parts: string[] = [];
  const settingsRaw = cfg.data?.[PERSIST_KEY];
  if (typeof settingsRaw === 'string') {
    try {
      const state = (JSON.parse(settingsRaw) as { state?: Record<string, unknown> }).state ?? {};
      const vod = Array.isArray(state.customAPIs) ? state.customAPIs.length : 0;
      const live = Array.isArray(state.liveSubscriptions) ? state.liveSubscriptions.length : 0;
      const subs = Array.isArray(state.subscriptions) ? state.subscriptions.length : 0;
      parts.push(`${vod} 个点播源`, `${live} 个直播源`, `${subs} 个订阅`);
    } catch {
      /* ignore */
    }
  }
  const historyRaw = cfg.data?.['viewingHistory'];
  if (typeof historyRaw === 'string') {
    try {
      const h = JSON.parse(historyRaw);
      if (Array.isArray(h)) parts.push(`${h.length} 条观看历史`);
    } catch {
      /* ignore */
    }
  }
  return parts.length > 0 ? `该备份包含 ${parts.join('、')}` : '该备份未包含可恢复的数据';
}

function SourceForm({
  visible,
  initial,
  onCancel,
  onSubmit,
}: {
  visible: boolean;
  initial?: { key: string; name: string; url: string; detail?: string; isAdult?: boolean };
  onCancel: () => void;
  onSubmit: (data: { name: string; url: string; detail?: string; isAdult?: boolean }) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [detail, setDetail] = useState(initial?.detail ?? '');
  const [isAdult, setIsAdult] = useState(initial?.isAdult ?? false);
  const { toast } = useToast();

  useEffect(() => {
    if (visible) {
      setName(initial?.name ?? '');
      setUrl(initial?.url ?? '');
      setDetail(initial?.detail ?? '');
      setIsAdult(initial?.isAdult ?? false);
    }
  }, [visible, initial]);

  if (!visible) return null;

  const submit = () => {
    const n = name.trim();
    const u = url.trim().replace(/\/+$/, '');
    if (!n || !u) {
      toast('请输入点播源名称和 API 地址', 'warning');
      return;
    }
    if (!validateSourceUrl(u)) {
      toast('API 地址需以 http:// 或 https:// 开头', 'warning');
      return;
    }
    onSubmit({ name: n, url: u, detail: detail.trim() || undefined, isAdult });
  };

  return (
    <div className="space-y-2 border border-line rounded-xl p-3 bg-chip mb-2">
      <input
        className="input w-full"
        aria-label="点播源名称"
        placeholder="点播源名称"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className="input w-full"
        aria-label="API 地址"
        placeholder="API 地址，如 https://example.com/api.php/provide/vod"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <input
        className="input w-full"
        aria-label="详情页地址（可选）"
        placeholder="详情页地址（可选），如 https://example.com"
        value={detail}
        onChange={(e) => setDetail(e.target.value)}
      />
      <label className="flex items-center gap-2 text-xs text-muted">
        <input
          type="checkbox"
          className="h-3.5 w-3.5 accent-pink-500"
          checked={isAdult}
          onChange={(e) => setIsAdult(e.target.checked)}
        />
        标记为成人内容源（受成人过滤控制）
      </label>
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
