import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from '@/components/providers';

export const metadata: Metadata = {
  title: {
    default: 'QTV - 私人影视与直播聚合影院',
    template: '%s - QTV',
  },
  description:
    'QTV 是一个移动端影视与电视直播聚合播放器：多源聚合搜索、直播频道、离线缓存，全部在本机播放，无需注册。',
  applicationName: 'QTV',
  // iOS「添加到主屏幕」全屏启动：不带这些字段时会残留 Safari 地址栏，独立 App 感弱。
  // statusBarStyle=black-translucent 使状态栏透明覆盖页面——依赖 viewportFit=cover
  // 与顶栏的 env(safe-area-inset-top) 内边距成套生效
  appleWebApp: {
    capable: true,
    title: 'QTV',
    statusBarStyle: 'black-translucent',
  },
  // 移动端「电话/日期/地址」自动识别会把文本变蓝误触；关掉
  formatDetection: {
    telephone: false,
    date: false,
    address: false,
    email: false,
    url: false,
  },
  manifest: '/manifest.webmanifest',
  // QTV 图标：同一张 artwork 导出的多尺寸 + 根目录 favicon.ico 兜底。
  // 只声明单张 512 时，抓取端只能拿大图缩放，小尺寸下易糊、看起来「没填满」。
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '48x48' },
      { url: '/icons/icon-96.png', sizes: '96x96', type: 'image/png' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

export const viewport: Viewport = {
  themeColor: '#06080c',
  width: 'device-width',
  initialScale: 1,
  // 铺满到刘海/灵动岛下方：不声明时 env(safe-area-inset-*) 恒为 0（规范行为），
  // 现有与新增的安全区内边距都依赖它才生效；桌面端 inset 为 0，无视觉变化
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/* 首屏前同步主题，避免亮暗闪烁 */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('libretv-theme')||'dark';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}})()",
          }}
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
