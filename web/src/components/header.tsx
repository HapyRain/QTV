'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { SourceManagerDrawer } from './source-manager';
import { HistoryPanel } from './history-panel';
import { Icon, type IconName } from './icon';
import { useTheme } from './theme';
import { useAppStore } from '@/lib/store';
import { syncSourceSubscription } from '@/lib/subscription-sync';
import { useToast } from './toast';
import { cn } from '@/lib/utils';
import { useAuth } from '@/components/auth';
import { useDesktopShell } from '@/lib/desktop';

export function requestShowHistory(): void {
  window.dispatchEvent(new CustomEvent('libretv:open-history'));
}

export function requestShowSettings(tab?: 'sources' | 'prefs' | 'data'): void {
  window.dispatchEvent(new CustomEvent('libretv:open-settings', { detail: tab }));
}

export function requestShowOnboarding(): void {
  window.dispatchEvent(new CustomEvent('qtv:open-onboarding'));
}

const ONBOARD_KEY = 'qtv-desktop-onboarded-v1';

export function Header({ showSearch = false }: { showSearch?: boolean }) {
  void showSearch;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { resolved: themeMode, setTheme } = useTheme();
  // 版本号统一取原生 /api/status（桌面本地服务返回 package 版本），界面里不再硬编码
  const { version } = useAuth();
  const { toast } = useToast();
  // 首帧恒为 false，静态导出的 HTML 与移动端一致，避免桌面壳 hydration 不匹配
  const desktop = useDesktopShell();

  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const liveSelectedUrls = useAppStore((s) => s.liveSelectedUrls);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [onboardOpen, setOnboardOpen] = useState(false);
  const [quickQuery, setQuickQuery] = useState(searchParams?.get('s') || '');
  const [winState, setWinState] = useState({ isMaximized: false, isAlwaysOnTop: false, isMiniMode: false });
  const searchInputRef = useRef<HTMLInputElement>(null);

  const currentTab = searchParams?.get('tab') || '';
  const isLive = pathname?.startsWith('/live');
  const isWatch = pathname?.startsWith('/watch');
  const isSettings = pathname === '/about' || (pathname === '/' && currentTab === 'profile');
  const isExplore = !isLive && !isWatch && !isSettings;
  // 移动端原版把播放页也算在「探索」里，桌面侧栏则排除 /watch
  const isExploreMobile = !isLive && !isSettings;

  useEffect(() => {
    setQuickQuery(searchParams?.get('s') || '');
  }, [searchParams]);

  useEffect(() => {
    // 向导是桌面专属弹窗，移动端分支不渲染它，别留下无法关闭的状态
    if (!desktop) return;
    try {
      if (!localStorage.getItem(ONBOARD_KEY)) {
        setOnboardOpen(true);
      }
    } catch {
      /* ignore */
    }
  }, [desktop]);

  useEffect(() => {
    const desk = (window as unknown as { QTVDesktop?: { getState?: () => Promise<typeof winState>; onStateChange?: (cb: (s: typeof winState) => void) => () => void } }).QTVDesktop;
    if (desk?.getState) {
      desk.getState().then((s) => s && setWinState(s)).catch(() => {});
    }
    if (desk?.onStateChange) {
      return desk.onStateChange((s) => s && setWinState(s));
    }
  }, []);

  useEffect(() => {
    // 桌面端：历史 / 设置 / 缓存 / 片源改成独立整页，事件只做路由跳转；
    // 移动端保持原抽屉行为（底部导航与「我的」页仍依赖它）。
    const onShowHistory = () => {
      if (desktop) router.push('/history');
      else setHistoryOpen(true);
    };
    const onShowOnboarding = () => setOnboardOpen(true);
    const onShowSettings = (e: Event) => {
      const detail = (e as CustomEvent<string | undefined>).detail;
      if (desktop) {
        router.push(detail === 'sources' ? '/sources' : '/settings');
        return;
      }
      if (detail) {
        try {
          const raw = localStorage.getItem('libretv-settings-tab');
          const parsed = raw ? JSON.parse(raw) : {};
          localStorage.setItem('libretv-settings-tab', JSON.stringify({ ...parsed, primary: detail }));
        } catch {
          /* ignore */
        }
      }
      setSettingsOpen(true);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener('libretv:open-history', onShowHistory);
    window.addEventListener('libretv:open-settings', onShowSettings);
    window.addEventListener('qtv:open-onboarding', onShowOnboarding);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('libretv:open-history', onShowHistory);
      window.removeEventListener('libretv:open-settings', onShowSettings);
      window.removeEventListener('qtv:open-onboarding', onShowOnboarding);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [router, desktop]);

  const submitGlobalSearch = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) {
      router.push('/', { scroll: false });
      return;
    }
    router.push('/?s=' + encodeURIComponent(trimmed), { scroll: false });
  };

  const handleWinControl = (action: 'minimize' | 'maximize' | 'close' | 'pin' | 'mini') => {
    const desk = (window as unknown as { QTVDesktop?: Record<string, () => Promise<boolean>> }).QTVDesktop;
    if (action === 'minimize') {
      desk?.minimize?.();
    } else if (action === 'maximize') {
      if (desk?.maximize) {
        desk.maximize().then((max) => setWinState((prev) => ({ ...prev, isMaximized: Boolean(max) })));
      } else if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else {
        document.documentElement.requestFullscreen?.().catch(() => {});
      }
    } else if (action === 'close') {
      if (desk?.close) desk.close();
      else window.close();
    } else if (action === 'pin') {
      if (desk?.togglePin) {
        desk.togglePin().then((pinned) => {
          setWinState((prev) => ({ ...prev, isAlwaysOnTop: Boolean(pinned) }));
          toast(pinned ? '已开启窗口置顶' : '已取消窗口置顶', 'info');
        });
      } else {
        setWinState((prev) => {
          const next = !prev.isAlwaysOnTop;
          toast(next ? '已开启窗口置顶' : '已取消窗口置顶', 'info');
          return { ...prev, isAlwaysOnTop: next };
        });
      }
    } else if (action === 'mini') {
      if (desk?.toggleMini) {
        desk.toggleMini().then((mini) => setWinState((prev) => ({ ...prev, isMiniMode: Boolean(mini) })));
      }
    }
  };

  const navItems: { label: string; icon: IconName; href: string; active: boolean }[] = [
    { label: '探索', icon: 'compass', href: '/', active: isExplore },
    { label: '直播', icon: 'tv', href: '/live', active: Boolean(isLive) },
    { label: '历史', icon: 'clock', href: '/history', active: pathname === '/history' },
    { label: '缓存', icon: 'download', href: '/cache', active: pathname === '/cache' },
    { label: '片源', icon: 'link', href: '/sources', active: pathname === '/sources' },
    { label: '设置', icon: 'sliders', href: '/settings', active: pathname === '/settings' || pathname === '/about' },
  ];

  if (!desktop) {
    return (
      <>
        {/* 移动端原版底部毛玻璃悬浮三栏导航（探索 · 直播 · 我的） */}
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
                isExploreMobile ? 'text-accent bg-accent/14 font-semibold' : 'text-muted hover:text-content'
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
                isSettings ? 'text-accent bg-accent/14 font-semibold' : 'text-muted hover:text-content'
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

  return (
    <>
      {/* Windows 11 Frameless Acrylic Titlebar */}
      <header className="fixed top-0 inset-x-0 z-50 desktop-titlebar border-b border-line/60 flex items-center justify-between px-4 select-none">
        <div className="flex items-center gap-2.5 w-[200px] shrink-0">
          <img src="/icons/icon-96.png" alt="QTV" className="w-6 h-6 rounded-md object-cover ring-1 ring-white/15" />
          <span className="text-sm font-bold tracking-tight text-content">QTV</span>
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-chip text-muted tabular-nums">{version ?? '1.1'}</span>
        </div>

        {/* Center Command & Search Omnibox */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitGlobalSearch(quickQuery);
          }}
          className="desktop-no-drag flex-1 max-w-xl mx-4 flex items-center gap-2 h-8 px-3 rounded-lg bg-chip/90 border border-line/80 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent/40 transition-all"
        >
          <Icon name="search" className="w-3.5 h-3.5 text-faint shrink-0" />
          <input
            ref={searchInputRef}
            type="text"
            value={quickQuery}
            onChange={(e) => setQuickQuery(e.target.value)}
            placeholder="全局搜索影视名称..."
            className="flex-1 bg-transparent text-xs text-content placeholder:text-faint focus:outline-none"
          />
          {quickQuery && (
            <button
              type="button"
              onClick={() => {
                setQuickQuery('');
                if (pathname === '/' && searchParams?.get('s')) {
                  router.push('/', { scroll: false });
                }
              }}
              className="text-faint hover:text-content p-0.5"
              aria-label="清空"
            >
              <Icon name="close" className="w-3 h-3" />
            </button>
          )}
          <span className="kbd-cap">Ctrl K</span>
        </form>

        {/* Right Utility & Native Window Controls */}
        <div className="desktop-no-drag flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => requestShowSettings('sources')}
            className="flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-chip/80 hover:bg-hover text-xs text-muted hover:text-content transition-colors mr-1"
          >
            <span className={cn('w-1.5 h-1.5 rounded-full', selectedKeys.length > 0 ? 'bg-success' : 'bg-warning')} />
            <span className="tabular-nums">{selectedKeys.length} 点播</span>
            <span className="text-line">·</span>
            <span className="tabular-nums">{liveSelectedUrls.length} 直播</span>
          </button>

          <button
            type="button"
            onClick={() => setOnboardOpen(true)}
            className="win-caption-btn"
            title="使用向导"
            aria-label="使用向导"
          >
            <Icon name="sparkles" className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={() => setTheme(themeMode === 'dark' ? 'light' : 'dark')}
            className="win-caption-btn"
            title={themeMode === 'dark' ? '切换浅色外观' : '切换深色外观'}
            aria-label="切换外观"
          >
            <Icon name={themeMode === 'dark' ? 'sun' : 'moon'} className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={() => handleWinControl('pin')}
            className={cn('win-caption-btn', winState.isAlwaysOnTop && 'text-accent bg-accent/15')}
            title="窗口置顶"
            aria-label="窗口置顶"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 3l5 5-4 4-2-2-4 4v4l-2 2-3-3-4 4-1-1 4-4-3-3 2-2h4l4-4-2-2 4-4z" />
            </svg>
          </button>

          <div className="h-4 w-px bg-line/70 mx-1" />

          <button
            type="button"
            onClick={() => handleWinControl('minimize')}
            className="win-caption-btn"
            aria-label="最小化"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeWidth={2} d="M5 12h14" />
            </svg>
          </button>

          <button
            type="button"
            onClick={() => handleWinControl('maximize')}
            className="win-caption-btn"
            aria-label="最大化"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <rect x="4" y="4" width="16" height="16" rx="2" strokeWidth={2} />
            </svg>
          </button>

          <button
            type="button"
            onClick={() => handleWinControl('close')}
            className="win-caption-btn win-caption-close"
            aria-label="关闭窗口"
          >
            <Icon name="close" className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Left Navigation Rail */}
      <aside
        aria-label="主导航"
        className="fixed left-0 bottom-0 z-40 desktop-sidebar flex flex-col justify-between select-none"
      >
        <div className="space-y-1 px-3 pt-4">
          {navItems.map((item) => (
            <Link
              key={item.label}
              href={item.href}
              scroll={false}
              className={cn('desk-nav-item', item.active && 'desk-nav-item-active')}
            >
              <Icon name={item.icon} className="w-[17px] h-[17px] shrink-0" />
              <span>{item.label}</span>
            </Link>
          ))}
        </div>

        <div className="px-3 pb-4 space-y-3">
          <div className="desk-mycard">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted font-medium">我的片源</span>
              <span className="inline-flex items-center gap-1 text-[11px] text-success font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-success" />
                正常
              </span>
            </div>
            <div className="grid grid-cols-2 gap-1.5 text-[11px] mt-2.5">
              <div className="px-2.5 py-1.5 rounded-lg bg-chip/70">
                <div className="text-faint">点播源</div>
                <div className="text-content font-semibold tabular-nums mt-0.5">{selectedKeys.length}</div>
              </div>
              <div className="px-2.5 py-1.5 rounded-lg bg-chip/70">
                <div className="text-faint">直播源</div>
                <div className="text-content font-semibold tabular-nums mt-0.5">{liveSelectedUrls.length}</div>
              </div>
            </div>
            <Link href="/sources" scroll={false} className="desk-mycard-btn">
              添加片源
            </Link>
          </div>
          <div className="flex items-center gap-2.5 px-1">
            <span className="w-7 h-7 rounded-full bg-accent text-on-accent grid place-items-center text-[11px] font-bold">Q</span>
            <div className="min-w-0">
              <div className="text-xs text-content truncate">QTV</div>
              <div className="text-[10px] text-faint truncate">本地模式</div>
            </div>
          </div>
        </div>
      </aside>

      {onboardOpen && (
        <OnboardingModal
          version={version}
          onClose={() => {
            try {
              localStorage.setItem(ONBOARD_KEY, '1');
            } catch {
              /* ignore */
            }
            setOnboardOpen(false);
          }}
          onOpenSources={() => {
            try {
              localStorage.setItem(ONBOARD_KEY, '1');
            } catch {
              /* ignore */
            }
            setOnboardOpen(false);
            requestShowSettings('sources');
          }}
        />
      )}
    </>
  );
}

function OnboardingModal({
  version,
  onClose,
  onOpenSources,
}: {
  version?: string | null;
  onClose: () => void;
  onOpenSources: () => void;
}) {
  const [step, setStep] = useState(0);
  const [subUrl, setSubUrl] = useState('');
  const [syncing, setSyncing] = useState(false);
  const { toast } = useToast();

  const handleQuickSync = async () => {
    const trimmed = subUrl.trim();
    if (!trimmed) return;
    setSyncing(true);
    try {
      useAppStore.getState().addSubscription(trimmed);
      // syncSourceSubscription 成功返回计数、失败直接抛错（失败状态已写进订阅列表）
      const { vodCount, liveCount } = await syncSourceSubscription(trimmed);
      toast(`已导入 ${vodCount} 个点播源与 ${liveCount} 个直播源`, 'success');
      setSubUrl('');
      setStep(2);
    } catch (err) {
      toast(err instanceof Error ? err.message : '订阅同步失败', 'error');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-6 bg-black/70 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-3xl acrylic-modal border border-line/80 rounded-2xl overflow-hidden grid grid-cols-12 min-h-[440px]">
        {/* Left Brand & Step Column */}
        <div className="col-span-4 bg-surface/90 border-r border-line/60 p-6 flex flex-col justify-between">
          <div className="space-y-6">
            <div className="flex items-center gap-3">
              <img src="/icons/icon-192.png" alt="QTV" className="w-10 h-10 rounded-xl ring-1 ring-white/15" />
              <div>
                <div className="text-base font-bold text-content">QTV</div>
                <div className="text-xs text-faint">你的私人影院</div>
              </div>
            </div>

            <div className="space-y-2 pt-2">
              {[
                { idx: 0, title: '欢迎使用' },
                { idx: 1, title: '添加片源' },
                { idx: 2, title: '快捷操作' },
              ].map((s) => (
                <button
                  key={s.idx}
                  type="button"
                  onClick={() => setStep(s.idx)}
                  className={cn(
                    'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left text-xs font-medium transition-colors',
                    step === s.idx ? 'bg-accent/15 text-accent font-semibold' : 'text-muted hover:text-content'
                  )}
                >
                  <span className="w-5 h-5 rounded-md bg-chip flex items-center justify-center text-[11px] tabular-nums">
                    0{s.idx + 1}
                  </span>
                  <span>{s.title}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="text-[11px] text-faint">v{version ?? '1.1'} · 免费开源</div>
        </div>

        {/* Right Interactive Step Content */}
        <div className="col-span-8 p-8 flex flex-col justify-between">
          {step === 0 && (
            <div className="space-y-5">
              <div>
                <div className="text-xs font-semibold text-accent uppercase tracking-wider">第 1 步</div>
                <h3 className="text-xl font-bold text-content mt-1">看片，从这里开始</h3>
              </div>
              <div className="grid grid-cols-1 gap-3">
                <div className="p-4 rounded-xl bg-chip/60 border border-line/60">
                  <div className="text-sm font-semibold text-content">一个入口，找遍全网</div>
                  <div className="text-xs text-muted mt-1">把你常用的片源加进来，一次搜索同时检索所有源，自动按画质排序。</div>
                </div>
                <div className="p-4 rounded-xl bg-chip/60 border border-line/60">
                  <div className="text-sm font-semibold text-content">插播广告自动跳过</div>
                  <div className="text-xs text-muted mt-1">自动识别并跳过正片里的插播广告，一集看完不被打断。</div>
                </div>
                <div className="p-4 rounded-xl bg-chip/60 border border-line/60">
                  <div className="text-sm font-semibold text-content">看到哪，存到哪</div>
                  <div className="text-xs text-muted mt-1">喜欢的内容一键缓存到本机，没网也能接着看。</div>
                </div>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-5">
              <div>
                <div className="text-xs font-semibold text-accent uppercase tracking-wider">第 2 步</div>
                <h3 className="text-xl font-bold text-content mt-1">添加你的第一个片源</h3>
              </div>
              <div className="p-4 rounded-xl bg-chip/60 border border-line/60 space-y-3">
                <div className="text-xs font-medium text-content">粘贴订阅链接，一键导入</div>
                <div className="flex gap-2">
                  <input
                    type="url"
                    value={subUrl}
                    onChange={(e) => setSubUrl(e.target.value)}
                    placeholder="https://example.com/sources.json"
                    className="input flex-1 !py-2 text-xs"
                  />
                  <button
                    type="button"
                    disabled={!subUrl.trim() || syncing}
                    onClick={handleQuickSync}
                    className="btn-primary btn-sm shrink-0"
                  >
                    {syncing ? '同步中' : '立即同步'}
                  </button>
                </div>
              </div>
              <div className="p-4 rounded-xl bg-chip/40 border border-line/50 flex items-center justify-between">
                <div>
                  <div className="text-xs font-semibold text-content">也可以自己挑</div>
                  <div className="text-xs text-faint mt-0.5">支持单条片源地址、电视直播源，或导入之前的备份</div>
                </div>
                <button type="button" onClick={onOpenSources} className="btn-ghost btn-sm shrink-0">
                  打开片源管理
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-5">
              <div>
                <div className="text-xs font-semibold text-accent uppercase tracking-wider">第 3 步</div>
                <h3 className="text-xl font-bold text-content mt-1">这些快捷键，看片更快</h3>
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                {[
                  ['Ctrl + K', '搜索影视'],
                  ['Space', '播放 / 暂停'],
                  ['F', '全屏 / 退出全屏'],
                  ['← / →', '快退 / 快进'],
                  ['↑ / ↓', '音量调节'],
                  ['Esc', '退出全屏 / 关闭弹窗'],
                ].map(([key, label]) => (
                  <div key={key} className="flex items-center justify-between px-3.5 py-2.5 rounded-xl bg-chip/60 border border-line/60 text-xs">
                    <span className="text-muted">{label}</span>
                    <span className="kbd-cap">{key}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center justify-between pt-4 border-t border-line/60">
            <button type="button" onClick={onClose} className="text-xs text-muted hover:text-content">
              跳过向导
            </button>
            <div className="flex items-center gap-2">
              {step > 0 && (
                <button type="button" onClick={() => setStep(step - 1)} className="btn-ghost btn-sm">
                  上一步
                </button>
              )}
              {step < 2 ? (
                <button type="button" onClick={() => setStep(step + 1)} className="btn-primary btn-sm">
                  下一步
                </button>
              ) : (
                <button type="button" onClick={onClose} className="btn-primary btn-sm">
                  进入 QTV
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
