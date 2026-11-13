/*
 * LibreTV Service Worker —— 仅静态资源加速与离线兜底（plan v2 L5 修正版）。
 *
 * 边界（勿扩大）：
 * - 只缓存 /_next/static/*（content-hash 天然不可变 → cache-first 安全）与
 *   图标/manifest（stale-while-revalidate）。
 * - 不缓存 HTML 与 RSC 载荷：App Router 的导航依赖 flight 数据，陈旧 HTML 会
 *   引用已被新构建删除的 chunk → 点击导航白屏（只在刚升级的窗口期出现，最难排查）。
 * - 绝不拦截 /api/* 与媒体分片：分片缓存是 video-cache.ts（Cache Storage + 自定义
 *   hls loader）的职责，其文件头注释明确不用 SW 接管（opaque response 问题）。
 * - 导航 network-first，失败回 offline.html；不做离线数据（方案不承诺 http 下离线）。
 */

const VERSION = 'libretv-v1';
const STATIC_CACHE = VERSION + '-static';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll([OFFLINE_URL]))
      .catch(() => undefined)
  );
  // 不 skipWaiting：新版本停在 waiting，由页面提示用户确认后经 SKIP_WAITING 消息激活
  // （视频站点不能自动刷新打断播放）
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith('libretv-') && key !== STATIC_CACHE)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/** /_next/static/*：文件名带 content hash，永远不可变 */
function isImmutableAsset(pathname) {
  return pathname.startsWith('/_next/static/');
}

/** 图标与 manifest：可小幅陈旧，刷新时后台校正 */
function isStaticMeta(pathname) {
  return (
    pathname.startsWith('/icons/') ||
    pathname === '/favicon.ico' ||
    pathname === '/manifest.webmanifest'
  );
}

/** 明确永不接管的请求（除 origin/method 过滤外的第二道闸） */
function mustBypass(url, pathname) {
  if (pathname.startsWith('/api/')) return true;
  if (pathname.startsWith('/_next/static/') || pathname.startsWith('/icons/')) return false;
  // 媒体与分片：交回给页面里的 video-cache / hls.js 自己管
  return /\.(m3u8|mpd|ts|m4s|mp4|m4a|aac|webm|key|png|jpe?g|webp|gif|svg)(\?|$)/i.test(pathname);
}

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  if (hit) return hit;
  const response = await network;
  return response || new Response('', { status: 504, statusText: 'Offline' });
}

async function networkFirstNavigation(request) {
  try {
    return await fetch(request);
  } catch {
    const offline = await caches.match(OFFLINE_URL);
    return (
      offline ||
      new Response('网络不可用', {
        status: 503,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      })
    );
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (mustBypass(url, url.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }
  if (isImmutableAsset(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (isStaticMeta(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
  // 其余（页面内动态请求等）：不拦截，全部走网络——宁可慢，不可陈旧
});
