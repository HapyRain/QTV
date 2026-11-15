'use client';

import Link from 'next/link';
import { Header } from '@/components/header';
import { DesktopPage, useDesktopOnly } from '@/components/desktop/page';
import { ConfigIoPanel, ImagePanel, PlaybackPanel } from '@/components/source-manager';
import { useTheme } from '@/components/theme';
import { useAuth } from '@/components/auth';

export default function SettingsPage() {
  const desktop = useDesktopOnly();
  const { resolved, setTheme } = useTheme();
  const { version } = useAuth();
  if (!desktop) return <div className="min-h-screen bg-page" />;

  return (
    <>
      <DesktopPage
        kicker="PREFERENCES"
        title="设置"
        description="所有设置只影响本机，不需要账号，也不会回传任何数据。"
      >
        <section className="desk-card desk-section">
          <h2>外观</h2>
          <p>深色更适合看电影；浅色适合白天浏览。两套界面是同一套组件。</p>
          <div className="desk-field">
            <div>
              <b>主题</b>
              <span>当前：{resolved === 'dark' ? '深色' : '浅色'}</span>
            </div>
            <div className="desk-seg">
              <button
                type="button"
                className={resolved === 'dark' ? 'desk-seg-on' : ''}
                onClick={() => setTheme('dark')}
              >
                深色
              </button>
              <button
                type="button"
                className={resolved === 'light' ? 'desk-seg-on' : ''}
                onClick={() => setTheme('light')}
              >
                浅色
              </button>
            </div>
          </div>
        </section>

        <section className="desk-card desk-section">
          <h2>播放</h2>
          <p>这些选项对正在播放的视频立即生效。</p>
          <PlaybackPanel />
        </section>

        <section className="desk-card desk-section">
          <h2>海报与图片</h2>
          <p>海报加载失败或加载慢时，可以换一种取图方式。</p>
          <ImagePanel />
        </section>

        <section className="desk-card desk-section">
          <h2>备份与恢复</h2>
          <p>配置只保存在本机，换机前建议导出一次。</p>
          <ConfigIoPanel />
        </section>

        <section className="desk-card desk-section">
          <h2>关于</h2>
          <div className="desk-field">
            <div>
              <b>QTV</b>
              <span>版本 {version ?? '1.1'} · 免费开源 · AGPL-3.0</span>
            </div>
            <Link href="/about" className="desk-btn">查看说明</Link>
          </div>
        </section>
      </DesktopPage>
      <Header />
    </>
  );
}
