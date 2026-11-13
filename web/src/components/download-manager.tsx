'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Drawer } from './drawer';
import { Icon } from './icon';
import { useToast } from './toast';
import { db, type DownloadTaskEntry } from '@/lib/db';
import {
  PauseResumeController,
  clearDownloadChunks,
  runDownloadJob,
  supportsChunkCache,
  type DownloadProgress,
} from '@/lib/m3u8-downloader';
import { loadDownloadSettings, saveDownloadSettings } from '@/lib/download-settings';
import {
  UserCancelledError,
  detectSavingCapability,
  nativeSaveBridge,
  nativeSaveTarget,
  pickSaveTarget,
  type SaveTarget,
} from '@/lib/download-saver';
import { Switch } from './settings-shared';

const MAX_CONCURRENT_DOWNLOADS = 3;
const PROGRESS_PERSIST_INTERVAL_MS = 1000;
const ADD_TASK_EVENT = 'libretv:add-download';
const SHOW_MANAGER_EVENT = 'libretv:show-download-manager';
export const DOWNLOADS_UPDATED_EVENT = 'libretv:downloads-updated';

export interface AddDownloadPayload {
  url: string;
  title: string;
  format?: 'TS' | 'MP4';
}

interface RunningHandle {
  abort: AbortController;
  pause: PauseResumeController;
}

const filenameOf = (entry: { title: string; format?: string }) =>
  `${entry.title}.${(entry.format ?? 'MP4').toLowerCase()}`;

const pendingTargets = new Map<string, SaveTarget>();

const expiredTarget = (): SaveTarget => ({
  kind: 'memory',
  write: async () => {
    throw new Error('保存位置已失效，请点击「继续」重新选择');
  },
  close: async () => {},
  abort: async () => {},
});

export function DownloadManager({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [tasks, setTasks] = useState<DownloadTaskEntry[]>([]);
  const [capability, setCapability] = useState<'native' | 'fs-access' | 'memory'>('native');
  const [chunkCache, setChunkCache] = useState(true);
  const [proxy, setProxy] = useState(false);
  const running = useRef(new Map<string, RunningHandle>());

  const refresh = useCallback(() => {
    void db.downloads.orderBy('createdAt').reverse().toArray().then(setTasks);
  }, []);

  const updateEntry = useCallback(async (id: string, patch: Partial<DownloadTaskEntry>) => {
    await db.downloads.update(id, { ...patch, updatedAt: Date.now() });
    refresh();
  }, [refresh]);

  useEffect(() => {
    setProxy(loadDownloadSettings().proxy);
  }, []);

  const startTask = useCallback(
    async (entry: DownloadTaskEntry) => {
      if (running.current.has(entry.id)) return;
      const abort = new AbortController();
      const pause = new PauseResumeController();
      running.current.set(entry.id, { abort, pause });
      await updateEntry(entry.id, { status: 'downloading' });

      let lastPersistAt = 0;
      const onProgress = (p: DownloadProgress) => {
        const status = p.status === 'done' ? 'completed' : p.status === 'error' ? 'error' : 'downloading';
        setTasks((prev) => prev.map((t) => (t.id === entry.id ? { ...t, finished: p.current, total: p.total, status } : t)));
        const now = Date.now();
        if (p.status === 'downloading' && now - lastPersistAt < PROGRESS_PERSIST_INTERVAL_MS) return;
        lastPersistAt = now;
        void db.downloads.update(entry.id, { finished: p.current, total: p.total, status, updatedAt: now });
      };

      const pending = pendingTargets.get(entry.id);
      pendingTargets.delete(entry.id);
      const target = pending ?? (nativeSaveBridge() ? nativeSaveTarget(filenameOf(entry)) : expiredTarget());

      const job = runDownloadJob({
        taskId: entry.id,
        url: entry.url,
        title: entry.title,
        format: entry.format,
        signal: abort.signal,
        pause,
        proxy,
        onProgress,
        target,
      });

      void job
        .then(async () => {
          await updateEntry(entry.id, { status: 'completed' });
          void clearDownloadChunks(entry.id);
          toast(`《${entry.title}》下载完成`, 'success');
        })
        .catch(async (err: Error) => {
          if (abort.signal.aborted) return;
          if (err instanceof UserCancelledError) {
            await db.downloads.delete(entry.id);
            refresh();
            toast(`《${entry.title}》已取消下载`, 'info');
            return;
          }
          await updateEntry(entry.id, { status: 'error' });
          toast(`《${entry.title}》下载失败：${err.message}`, 'error');
        })
        .finally(() => {
          running.current.delete(entry.id);
          scheduleNext();
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toast, updateEntry, proxy]
  );

  const scheduleNext = useCallback(() => {
    void (async () => {
      const runningCount = running.current.size;
      if (runningCount >= MAX_CONCURRENT_DOWNLOADS) return;
      const all = await db.downloads.orderBy('createdAt').toArray();
      const waiting = all.filter((t) => t.status === 'waiting' && !running.current.has(t.id));
      for (const t of waiting.slice(0, MAX_CONCURRENT_DOWNLOADS - runningCount)) {
        void startTask(t);
      }
    })();
  }, [startTask]);

  useEffect(() => {
    const onAdd = (e: Event) => {
      const detail = (e as CustomEvent<AddDownloadPayload>).detail;
      if (!detail?.url || !detail?.title) return;
      void (async () => {
        const format = detail.format ?? 'MP4';
        const id = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const entry: DownloadTaskEntry = {
          id,
          url: detail.url,
          title: detail.title,
          format,
          status: 'waiting',
          finished: 0,
          total: 0,
          errorNum: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        let target: SaveTarget;
        try {
          target = await pickSaveTarget(`${detail.title}.${format.toLowerCase()}`);
        } catch (err) {
          if (err instanceof UserCancelledError) {
            toast('已取消下载', 'info');
            return;
          }
          toast(`无法开始下载：${(err as Error).message || '未知错误'}`, 'error');
          return;
        }
        pendingTargets.set(id, target);
        await db.downloads.put(entry);
        refresh();
        scheduleNext();
        toast(`《${detail.title}》已加入离线缓存队列`, 'success');
      })();
    };

    window.addEventListener(ADD_TASK_EVENT, onAdd);
    return () => {
      window.removeEventListener(ADD_TASK_EVENT, onAdd);
    };
  }, [refresh, scheduleNext, toast]);

  useEffect(() => {
    if (!isOpen) return;
    setCapability(detectSavingCapability());
    setChunkCache(supportsChunkCache());
    setProxy(loadDownloadSettings().proxy);
    refresh();
    scheduleNext();
  }, [isOpen, refresh, scheduleNext]);

  const onToggleProxy = (next: boolean) => {
    setProxy(saveDownloadSettings({ proxy: next }).proxy);
    toast(
      next ? '已开启代理增强下载，新任务经内置通道加速' : '已切换为源站直连下载',
      'info'
    );
  };

  const onPauseResume = async (entry: DownloadTaskEntry) => {
    const handle = running.current.get(entry.id);
    if (handle && entry.status === 'downloading') {
      handle.pause.pause();
      await updateEntry(entry.id, { status: 'paused' });
      return;
    }
    if (entry.status === 'paused' || entry.status === 'waiting' || entry.status === 'error') {
      if (!nativeSaveBridge()) {
        try {
          pendingTargets.set(entry.id, await pickSaveTarget(filenameOf(entry)));
        } catch (err) {
          if (err instanceof UserCancelledError) toast('已取消', 'info');
          else toast(`无法恢复下载：${(err as Error).message || '未知错误'}`, 'error');
          return;
        }
      }
      if (running.current.has(entry.id)) return;
      await updateEntry(entry.id, { status: 'waiting' });
      scheduleNext();
      return;
    }
    void handle;
  };

  const onCancel = async (entry: DownloadTaskEntry) => {
    running.current.get(entry.id)?.abort.abort();
    running.current.delete(entry.id);
    await clearDownloadChunks(entry.id);
    await db.downloads.delete(entry.id);
    refresh();
    toast(
      entry.status === 'completed' || entry.status === 'error'
        ? `《${entry.title}》已移除记录`
        : `《${entry.title}》已取消下载`,
      'info'
    );
  };

  const statusLabel: Record<DownloadTaskEntry['status'], string> = {
    waiting: '排队中',
    downloading: '正在缓存',
    paused: '已暂停',
    completed: '已完成',
    error: '下载中断',
  };

  return (
    <Drawer open={isOpen} onClose={onClose} title="离线缓存中心" width="max-w-lg">
      <div className="space-y-3">
        <div className="card p-3.5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-content">内置代理加速模式</p>
            <p className="text-xs text-faint mt-0.5 leading-relaxed">
              遇到防盗链或直连缓慢时开启，自动通过本地代理通道拉取分片与密钥（仅对新任务生效）。
            </p>
          </div>
          <Switch checked={proxy} onChange={onToggleProxy} label="内置代理加速模式" />
        </div>
        <div className="flex items-center justify-between text-[11px] text-faint px-1 tabular-nums">
          <span>
            存储模式：
            {capability === 'native'
              ? '本机流式直存（自动写入系统下载目录）'
              : capability === 'fs-access'
                ? '本地文件直写'
                : '本机聚合导出'}
            {chunkCache ? ' · 支持分片续传' : ''}
          </span>
          <span>
            并发 {Math.min(running.current.size, MAX_CONCURRENT_DOWNLOADS)}/{MAX_CONCURRENT_DOWNLOADS}
          </span>
        </div>
        {tasks.length === 0 && (
          <div className="py-12 text-center text-sm text-faint">
            暂无离线缓存任务，在播放页轻点「缓存」即可边看边存。
          </div>
        )}
        {tasks.map((t) => {
          const pct = t.total > 0 ? Math.min(100, Math.round((t.finished / t.total) * 100)) : 0;
          return (
            <div key={t.id} className="card p-3.5 space-y-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-content truncate">{t.title}</p>
                  <p className="text-xs text-faint tabular-nums mt-0.5">
                    {t.format.toUpperCase()} · {statusLabel[t.status]}
                    {t.status === 'downloading' && t.total > 0 ? ` · ${t.finished}/${t.total} 分片 (${pct}%)` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {t.status === 'downloading' && (
                    <button
                      type="button"
                      className="px-2.5 py-1 rounded-lg bg-chip hover:bg-hover text-xs text-content transition-colors"
                      onClick={() => void onPauseResume(t)}
                    >
                      暂停
                    </button>
                  )}
                  {(t.status === 'paused' || t.status === 'waiting' || t.status === 'error') && (
                    <button
                      type="button"
                      className="px-2.5 py-1 rounded-lg bg-accent/15 text-accent text-xs font-medium transition-colors"
                      onClick={() => void onPauseResume(t)}
                    >
                      继续
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label="删除下载任务"
                    className="p-1.5 rounded-lg bg-chip hover:bg-hover text-muted hover:text-danger transition-colors"
                    onClick={() => void onCancel(t)}
                  >
                    <Icon name="close" className="w-4 h-4" />
                  </button>
                </div>
              </div>
              {(t.status === 'downloading' || t.status === 'paused' || t.status === 'completed') && t.total > 0 && (
                <div className="h-1.5 rounded-full bg-chip overflow-hidden">
                  <div
                    className="h-full bg-accent transition-all duration-300"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Drawer>
  );
}

export function enqueueDownload(payload: AddDownloadPayload): void {
  window.dispatchEvent(new CustomEvent(ADD_TASK_EVENT, { detail: payload }));
}

export function requestShowDownloadManager(): void {
  window.dispatchEvent(new CustomEvent(SHOW_MANAGER_EVENT));
}

export function GlobalDownloadManager() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onShow = () => setOpen(true);
    window.addEventListener(SHOW_MANAGER_EVENT, onShow);
    return () => window.removeEventListener(SHOW_MANAGER_EVENT, onShow);
  }, []);
  return <DownloadManager isOpen={open} onClose={() => setOpen(false)} />;
}
