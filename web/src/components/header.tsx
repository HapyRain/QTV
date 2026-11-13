'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { SourceManagerDrawer } from './source-manager';
import { HistoryPanel } from './history-panel';
import { requestShowDownloadManager } from './download-manager';
import { Icon } from './icon';
import { cn } from '@/lib/utils';

/** 全局事件：任何页面或组件可唤起观看历史或设置面板 */
export function requestShowHistory(): void {
  window.dispatchEvent(new CustomEvent('libretv:open-history'));
}

export function requestShowSettings(tab?: 'sources' | 'prefs' | 'data'): void {
  window.dispatchEvent(new CustomEvent('libretv:open-settings', { detail: tab }));
}

/**
 * 移动端全局导航壳（替代旧版桌面端顶栏 Header）：
 * - 固定在屏幕底部的 Apple TV+ / Infuse 风格毛玻璃悬浮三栏导航（探索 · 直播 · 我的）；
 * - 挂载全局 `SourceManagerDrawer` 与 `HistoryPanel`，响应全局事件；
 * - 保持 `Header` 与 `requestShowHistory` 导出名 100% 兼容。
 */
export function Header({ showSearch = false }: { showSearch?: boolean }) {
  void showSearch;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const currentTab = searchParams?.get('tab') || '';
  const isLive = pathname?.startsWith('/live');
  const isProfile = pathname === '/about' || (pathname === '/' && currentTab === 'profile');
  const isExplore = !isLive && !isProfile;

  useEffect(() => {
    const onShowHistory = () => setHistoryOpen(true);
    const onShowSettings = (e: Event) => {
      const detail = (e as CustomEvent<string | undefined>).detail;
      if (detail) {
        try {
          const raw = localStorage.getItem('libretv-settings-tab');
          const parsed = raw ? JSON.parse(raw) : {};
          localStorage.setItem(
            'libretv-settings-tab',
            JSON.stringify({ ...parsed, primary: detail })
          );
        } catch {
          /* 忽略 */
        }
      }
      setSettingsOpen(true);
    };
    window.addEventListener('libretv:open-history', onShowHistory);
    window.addEventListener('libretv:open-settings', onShowSettings);
    return () => {
      window.removeEventListener('libretv:open-history', onShowHistory);
      window.removeEventListener('libretv:open-settings', onShowSettings);
    };
  }, []);

  return (
    <>
      {/* 底部毛玻璃悬浮三栏导航（探索 · 直播 · 我的） */}
      <nav
        aria-label="主导航"
        className="fixed inset-x-0 bottom-0 z-40 pointer-events-none flex justify-center px-4 pb-[calc(0.65rem_+_env(safe-area-inset-bottom))]"
      >
        <div className="pointer-events-auto glass-pill flex items-center justify-around w-full max-w-[340px] h-[58px] px-2 rounded-full border border-white/10">
          <Link
            href="/"
            scroll={false}
            onClick={(e) => {
              if (pathname === '/' && currentTab === 'profile') {
                e.preventDefault();
                router.push('/', { scroll: false });
              }
            }}
            className={cn(
              'pressable relative flex flex-1 flex-col items-center justify-center gap-0.5 h-[46px] rounded-full transition-all duration-200',
              isExplore ? 'text-accent bg-accent/14 font-semibold' : 'text-muted hover:text-content'
            )}
          >
            <Icon name="compass" className="w-5 h-5" />
            <span className="text-[11px] leading-none tracking-tight">探索</span>
          </Link>

          <Link
            href="/live"
            scroll={false}
            className={cn(
              'pressable relative flex flex-1 flex-col items-center justify-center gap-0.5 h-[46px] rounded-full transition-all duration-200',
              isLive ? 'text-accent bg-accent/14 font-semibold' : 'text-muted hover:text-content'
            )}
          >
            <Icon name="tv" className="w-5 h-5" />
            <span className="text-[11px] leading-none tracking-tight">直播</span>
          </Link>

          <Link
            href="/?tab=profile"
            scroll={false}
            className={cn(
              'pressable relative flex flex-1 flex-col items-center justify-center gap-0.5 h-[46px] rounded-full transition-all duration-200',
              isProfile ? 'text-accent bg-accent/14 font-semibold' : 'text-muted hover:text-content'
            )}
          >
            <Icon name="user" className="w-5 h-5" />
            <span className="text-[11px] leading-none tracking-tight">我的</span>
          </Link>
        </div>
      </nav>

      <SourceManagerDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <HistoryPanel open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </>
  );
}

