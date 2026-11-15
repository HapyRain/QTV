'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useDesktopMode } from '@/lib/desktop';

/**
 * 桌面整页版式：历史 / 缓存 / 片源 / 设置共用。
 * 这些页只在桌面壳里可达（侧栏导航），移动端误入时回首页。
 */
export function DesktopPage({
  kicker,
  title,
  description,
  actions,
  children,
}: {
  kicker: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="desktop-main">
      <div className="desktop-scroll flex-1 min-h-0 desk-page">
        <header className="desk-page-head">
          <div className="min-w-0">
            <div className="desk-kicker">{kicker}</div>
            <h1>{title}</h1>
            {description && <p>{description}</p>}
          </div>
          {actions && <div className="desk-page-actions">{actions}</div>}
        </header>
        {children}
      </div>
    </div>
  );
}

/** 桌面专属页的守卫：pending 时先渲染空底，确认移动端后回首页 */
export function useDesktopOnly(): boolean {
  const mode = useDesktopMode();
  const router = useRouter();
  useEffect(() => {
    if (mode === 'mobile') router.replace('/');
  }, [mode, router]);
  return mode === 'desktop';
}
