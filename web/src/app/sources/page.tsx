'use client';

import { useState } from 'react';
import { Header } from '@/components/header';
import { DesktopPage, useDesktopOnly } from '@/components/desktop/page';
import {
  ConfigIoPanel,
  SourceSubscriptions,
  VodSourcesPanel,
} from '@/components/source-manager';
import { LiveSourceManager } from '@/components/live-source-manager';

type Tab = 'vod' | 'live' | 'subs' | 'io';

const TABS: { id: Tab; label: string }[] = [
  { id: 'vod', label: '点播源' },
  { id: 'live', label: '直播源' },
  { id: 'subs', label: '聚合订阅' },
  { id: 'io', label: '备份恢复' },
];

export default function SourcesPage() {
  const desktop = useDesktopOnly();
  const [tab, setTab] = useState<Tab>('vod');
  if (!desktop) return <div className="min-h-screen bg-page" />;

  return (
    <>
      <DesktopPage
        kicker="SOURCES"
        title="片源管理"
        description="点播源决定能搜到什么，直播源决定能看哪些台。关掉某个源不会删除已缓存的文件。"
      >
        <div className="desk-tabs" role="tablist" aria-label="片源分类">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? 'desk-tab desk-tab-on' : 'desk-tab'}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="desk-card desk-panel">
          {tab === 'vod' && <VodSourcesPanel />}
          {tab === 'live' && <LiveSourceManager />}
          {tab === 'subs' && <SourceSubscriptions />}
          {tab === 'io' && <ConfigIoPanel />}
        </div>
      </DesktopPage>
      <Header />
    </>
  );
}
