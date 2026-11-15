'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { Icon } from '@/components/icon';
import { useToast } from '@/components/toast';
import { Header } from '@/components/header';
import { DesktopPage, useDesktopOnly } from '@/components/desktop/page';
import { cancelDownloadTask, pauseResumeDownloadTask } from '@/components/download-manager';
import { db, type DownloadTaskEntry } from '@/lib/db';
import { nativeSaveBridge } from '@/lib/download-saver';

const STATUS_LABEL: Record<DownloadTaskEntry['status'], string> = {
  waiting: '排队中',
  downloading: '正在缓存',
  paused: '已暂停',
  completed: '已完成',
  error: '下载中断',
};

const nameOf = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

export default function CachePage() {
  const desktop = useDesktopOnly();
  const { toast } = useToast();
  const tasks = useLiveQuery(() => db.downloads.orderBy('createdAt').reverse().toArray(), []);

  if (!desktop) return <div className="min-h-screen bg-page" />;

  const list = tasks ?? [];
  const completed = list.filter((t) => t.status === 'completed');
  const active = list.filter((t) => t.status === 'downloading' || t.status === 'waiting');

  const openFile = (path: string) => {
    if (!nativeSaveBridge()?.openSavedFile?.(path)) toast('无法直接打开，请在系统文件管理里查看', 'info');
  };
  const openFolder = () => {
    if (!nativeSaveBridge()?.openDownloadFolder?.()) toast('请在系统文件管理里查看已下载文件', 'info');
  };

  return (
    <>
      <DesktopPage
        kicker="OFFLINE"
        title="离线缓存"
        description="文件保存在「视频\QTV」。缓存过的集数回到播放页会自动走本地文件，断网也能看。"
        actions={<button className="desk-btn" onClick={openFolder}>打开下载目录</button>}
      >
        <div className="desk-stats">
          <div className="desk-stat"><div className="k">已完成</div><div className="v">{completed.length}<small>部</small></div></div>
          <div className="desk-stat"><div className="k">进行中</div><div className="v">{active.length}<small>个任务</small></div></div>
          <div className="desk-stat"><div className="k">全部记录</div><div className="v">{list.length}<small>条</small></div></div>
        </div>

        {list.length === 0 ? (
          <div className="desk-card desk-empty">
            <p>还没有离线缓存。去播放页点右上角的「缓存」，就会出现在这里。</p>
          </div>
        ) : (
          <div className="desk-card desk-list">
            {list.map((t) => {
              const pct = t.total > 0 ? Math.min(100, Math.round((t.finished / t.total) * 100)) : 0;
              return (
                <div className="desk-row" key={t.id}>
                  <div className="desk-row-main">
                    <b>{t.title}</b>
                    <span>
                      {t.format.toUpperCase()} · {STATUS_LABEL[t.status]}
                      {t.status === 'downloading' && t.total > 0 ? ` · ${pct}%` : ''}
                      {t.filePath ? ` · 已保存：${nameOf(t.filePath)}` : ''}
                    </span>
                    {(t.status === 'downloading' || t.status === 'paused') && t.total > 0 && (
                      <div className="desk-progress"><i style={{ width: `${pct}%` }} /></div>
                    )}
                  </div>
                  <div className="desk-row-actions">
                    {t.status === 'completed' && t.filePath && (
                      <>
                        <button className="desk-btn desk-btn-primary" onClick={() => openFile(t.filePath!)}>
                          <Icon name="play" className="w-3.5 h-3.5" />播放
                        </button>
                        <button className="desk-btn" onClick={openFolder}>打开位置</button>
                      </>
                    )}
                    {(t.status === 'downloading' || t.status === 'paused' || t.status === 'waiting' || t.status === 'error') && (
                      <button className="desk-btn" onClick={() => pauseResumeDownloadTask(t.id)}>
                        {t.status === 'downloading' ? '暂停' : '继续'}
                      </button>
                    )}
                    <button className="desk-btn desk-btn-danger" onClick={() => cancelDownloadTask(t.id)}>删除</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </DesktopPage>
      <Header />
    </>
  );
}
