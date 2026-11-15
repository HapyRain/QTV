'use client';

import { Header } from '@/components/header';
import { HistoryPanel } from '@/components/history-panel';
import { DesktopPage, useDesktopOnly } from '@/components/desktop/page';

export default function HistoryPage() {
  const desktop = useDesktopOnly();
  if (!desktop) return <div className="min-h-screen bg-page" />;
  return (
    <>
      <DesktopPage
        kicker="HISTORY"
        title="观看记录"
        description="进度只保存在本机，换设备不会同步。清空记录不会删除已缓存的文件。"
      >
        <HistoryPanel inline open onClose={() => {}} />
      </DesktopPage>
      <Header />
    </>
  );
}
