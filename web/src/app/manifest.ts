import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'QTV - 私人影视与直播聚合影院',
    short_name: 'QTV',
    description: '私人影视与直播聚合播放器',
    // id：同 id 的安装共享同一身份；换 origin（IP↔主机名）迁移靠它保持为「同一个 App」
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'any',
    categories: ['entertainment'],
    background_color: '#06080c',
    theme_color: '#06080c',
    icons: [
      {
        src: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      // maskable：满幅不透明底 + 居中 QTV 标（内容在 80% 安全圆内），
      // 启动器自适应遮罩裁切时不露白边（any 版本四角透明，直接用会被裁出白边）
      {
        src: '/icons/icon-maskable-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
    shortcuts: [
      {
        name: '直播频道',
        short_name: '直播',
        url: '/live',
        icons: [{ src: '/icons/icon-144.png', sizes: '144x144', type: 'image/png' }],
      },
      {
        name: '搜索影片',
        short_name: '搜索',
        url: '/',
        icons: [{ src: '/icons/icon-144.png', sizes: '144x144', type: 'image/png' }],
      },
    ],
  };
}
