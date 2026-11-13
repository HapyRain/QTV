'use client';

import { useState } from 'react';
import { useAuth } from '@/components/auth';
import { cn } from '@/lib/utils';

/**
 * 专属定制铭牌（替代旧版请求 GitHub API 的桌面端页脚 SiteFooter）：
 * - 完全离线，不再发起任何 GitHub tags 检查请求；
 * - 展示「QTV vX · 本机播放器」精致徽章，轻点有微光互动反馈。
 */
export function SiteFooter({ className }: { className?: string }) {
  const { version } = useAuth();
  const [sparkle, setSparkle] = useState(false);

  return (
    <footer className={cn('py-6 px-4 text-center select-none', className)}>
      <button
        type="button"
        onClick={() => {
          setSparkle(true);
          window.setTimeout(() => setSparkle(false), 900);
        }}
        className={cn(
          'pressable inline-flex items-center gap-2 rounded-full border border-line/60 bg-card/70 px-4 py-1.5',
          'text-[11px] text-faint shadow-card transition-all duration-300',
          sparkle && 'border-accent/50 text-accent shadow-glow scale-[1.02]'
        )}
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
        <span className="font-semibold tracking-tight text-muted">
          QTV{version ? ` v${version.replace(/-app$/, '')}` : ''}
        </span>
        <span className="text-line">·</span>
        <span className="text-faint">本机播放器</span>
      </button>
    </footer>
  );
}
