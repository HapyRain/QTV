/**
 * 封面图持久缓存：Cache Storage 存原图，页面用 object URL 直接命中。
 *
 * 豆瓣图床首次加载慢，且 WebView 的 HTTP 缓存不可靠；这里在图片 onLoad 后
 * 通过本地 /api/proxy 再取一份存进 Cache Storage，下次启动/回首页直接读缓存。
 * 只缓存豆瓣封面，避免把普通 CMS 图也重复拉一遍。
 */

const CACHE_NAME = 'qtv-images-v1';
const memory = new Map<string, string>();
const MAX_MEMORY = 200;

function remember(url: string, objectUrl: string) {
  memory.set(url, objectUrl);
  while (memory.size > MAX_MEMORY) {
    const oldest = memory.keys().next().value;
    if (!oldest) break;
    const oldUrl = memory.get(oldest);
    memory.delete(oldest);
    if (oldUrl) URL.revokeObjectURL(oldUrl);
  }
}

const cacheable = (url: string) => /doubanio\.com|douban\.com/i.test(url);

async function openCache(): Promise<Cache | null> {
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null; // 隐私模式/老 WebView 没有 Cache Storage：退回普通 img
  }
}

export async function getCachedImage(url: string): Promise<string | undefined> {
  if (!cacheable(url)) return undefined;
  const remembered = memory.get(url);
  if (remembered) return remembered;
  const cache = await openCache();
  if (!cache) return undefined;
  try {
    const hit = await cache.match(url);
    if (!hit) return undefined;
    const objectUrl = URL.createObjectURL(await hit.blob());
    remember(url, objectUrl);
    return objectUrl;
  } catch {
    return undefined;
  }
}

export async function warmImageCache(url: string): Promise<void> {
  if (!cacheable(url) || memory.has(url)) return;
  const cache = await openCache();
  if (!cache) return;
  try {
    if (await cache.match(url)) return;
    const res = await fetch(`/api/proxy?url=${encodeURIComponent(url)}`);
    if (!res.ok) return;
    await cache.put(url, res.clone());
    remember(url, URL.createObjectURL(await res.blob()));
  } catch {
    /* 缓存失败不影响图片显示 */
  }
}
