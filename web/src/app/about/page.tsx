'use client';

import HomePage from '../page';
import Link from 'next/link';
import { Header } from '@/components/header';
import { DesktopPage } from '@/components/desktop/page';
import { useAuth } from '@/components/auth';
import { useDesktopMode } from '@/lib/desktop';

/**
 * /about：移动端继续展示「我的 / 关于」中心（历史兼容）；
 * 桌面端给一个真正的整页说明——旧实现直接渲染 HomePage，桌面分支会落到探索页，
 * 看起来就像「点查看说明跳回首页且没有内容」。
 */
export default function AboutPage() {
  const mode = useDesktopMode();
  const { version } = useAuth();

  if (mode === 'pending') return <div className="min-h-screen bg-page" />;
  if (mode !== 'desktop') return <HomePage />;

  return (
    <>
      <DesktopPage
        kicker="ABOUT"
        title="关于 QTV"
        description="一个完全跑在本机的影视聚合播放器：不提供内容，只负责把你自己的片源聚合到一起。"
        actions={
          <Link href="/settings" className="desk-btn">
            返回设置
          </Link>
        }
      >
        <section className="desk-card desk-section">
          <h2>这是什么</h2>
          <p>QTV 把搜索、播放、直播与离线缓存放在同一个桌面窗口里，所有请求都走本机，不需要账号。</p>
          <div className="desk-field">
            <div>
              <b>版本</b>
              <span>{version ?? '1.1'} · Windows 桌面端</span>
            </div>
            <span className="desk-kicker">AGPL-3.0</span>
          </div>
          <div className="desk-field">
            <div>
              <b>数据来源</b>
              <span>你自行添加的第三方片源与公开榜单；应用不托管、不分发任何视频文件。</span>
            </div>
          </div>
          <div className="desk-field">
            <div>
              <b>隐私</b>
              <span>观看记录、缓存与设置只存在本机；不上传、不统计、不需要登录。</span>
            </div>
          </div>
        </section>

        <section className="desk-card desk-section">
          <h2>致谢</h2>
          <p>站在这些开源项目与公开数据源的肩膀上。</p>
          <div className="desk-field">
            <div>
              <b>播放与传输</b>
              <span>ArtPlayer · hls.js · Next.js · Electron</span>
            </div>
          </div>
          <div className="desk-field">
            <div>
              <b>数据</b>
              <span>豆瓣公开榜单接口，以及所有公开片源接口的作者。</span>
            </div>
          </div>
        </section>
      </DesktopPage>
      <Header />
    </>
  );
}
