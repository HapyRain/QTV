/**
 * 播放前的「加载速度」探测。
 *
 * 画质探测只回答「这集最高多少 P」，不回答「现在这个网络能不能流畅播」。
 * 这里用同一套本地代理通道，按真实播放的路径走一遍：
 *   master m3u8 → 码率最高的子播放列表 → 第一个分片，读最多 256KB 计时。
 * 结果只依赖 /api/proxy，所以 Android / iOS / Windows 三端通用，不需要改原生实现。
 */

export type PlaybackVerdict = 'smooth' | 'ok' | 'slow' | 'unknown';

export interface PlaybackSpeedResult {
  verdict: PlaybackVerdict;
  /** 实测下载速率（kbps） */
  kbps?: number;
  /** 首个分片的采样耗时（毫秒） */
  ms?: number;
  /** 解析出的码率（kbps），用于判断「够不够」 */
  requiredKbps?: number;
  error?: string;
}

const PROXY = '/api/proxy';
const SAMPLE_BYTES = 262_144;
const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; result: PlaybackSpeedResult }>();

const proxyUrl = (u: string) => `${PROXY}?url=${encodeURIComponent(u)}&adFilter=0`;

/**
 * /api/proxy 返回 m3u8 时会把里面的地址改写成自己的相对路径（/api/proxy?url=...）。
 * 解析时先还原成原始 CDN 地址，否则会自己套自己，最后拿到的是本地 HTML。
 */
function unwrapLocalProxy(raw: string): string {
  try {
    const absolute = new URL(raw, typeof location !== 'undefined' ? location.origin : 'http://127.0.0.1');
    if (absolute.pathname === PROXY || absolute.pathname.startsWith(`${PROXY}/`)) {
      const inner = absolute.searchParams.get('url');
      if (inner) return inner;
    }
  } catch {
    /* 不是合法地址就按原样处理 */
  }
  return raw;
}

function resolvePlaylistUrl(raw: string, baseUrl: string): string | null {
  const cleaned = unwrapLocalProxy(raw);
  try {
    const resolved = new URL(cleaned, baseUrl).toString();
    return /^https?:\/\//i.test(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

export interface Variant {
  uri: string;
  bandwidth?: number;
  height?: number;
}

/** 解析 master playlist 的所有码率档位；没有 STREAM-INF 时返回空数组（代表它本身是媒体列表） */
export function parseMasterPlaylist(text: string, baseUrl: string): Variant[] {
  const lines = text.split(/\r?\n/);
  const out: Variant[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
    const bandwidth = Number(/BANDWIDTH=(\d+)/i.exec(line)?.[1] || 0);
    const resolution = /RESOLUTION=(\d+)x(\d+)/i.exec(line);
    let j = i + 1;
    while (j < lines.length && (!lines[j].trim() || lines[j].trim().startsWith('#'))) j++;
    const uri = lines[j]?.toString().trim();
    if (!uri) continue;
    try {
      const resolved = resolvePlaylistUrl(uri, baseUrl);
      if (!resolved) continue;
      out.push({
        uri: resolved,
        ...(bandwidth > 0 ? { bandwidth } : {}),
        ...(resolution ? { height: Number(resolution[2]) } : {}),
      });
    } catch {
      /* 相对地址解不出来就跳过这个档位 */
    }
  }
  return out;
}

/** 媒体列表里的第一个分片（跳过 #EXT-X-* 与注释） */
export function firstSegment(mediaText: string, baseUrl: string): string | null {
  for (const raw of mediaText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    return resolvePlaylistUrl(line, baseUrl);
  }
  return null;
}

/** 各档位大概需要多少 kbps 才能稳定播放（无 BANDWIDTH 时的兜底） */
export function requiredKbpsForHeight(height?: number): number {
  if (!height) return 0;
  if (height >= 2160) return 12_000;
  if (height >= 1440) return 8_000;
  if (height >= 1080) return 5_000;
  if (height >= 720) return 3_000;
  if (height >= 540) return 2_200;
  if (height >= 480) return 1_800;
  return 1_200;
}

/** 实测速率 vs 所需码率 → 结论；留 1.5x / 1.1x 安全余量，避免「刚好够」被判流畅 */
export function verdictOf(kbps?: number, requiredKbps?: number): PlaybackVerdict {
  if (!kbps || !Number.isFinite(kbps) || kbps <= 0) return 'unknown';
  if (!requiredKbps || requiredKbps <= 0) {
    if (kbps >= 4_000) return 'smooth';
    if (kbps >= 1_500) return 'ok';
    return 'slow';
  }
  if (kbps >= requiredKbps * 1.5) return 'smooth';
  if (kbps >= requiredKbps * 1.1) return 'ok';
  return 'slow';
}

async function fetchText(url: string, signal: AbortSignal, stage = ''): Promise<string> {
  const res = await fetch(proxyUrl(url), { signal });
  if (!res.ok) throw new Error(`${stage} HTTP ${res.status}`.trim());
  const text = await res.text();
  // 防盗链/反爬常回 200 + HTML：不能把 HTML 当播放列表继续解析
  if (!text.includes('#EXTM3U')) throw new Error(`${stage} 不是 m3u8`.trim());
  return text;
}

/** 只读前 256KB：够算速率，又不至于为了测速把整集拉下来 */
async function sampleSegment(url: string, signal: AbortSignal): Promise<{ bytes: number; ms: number }> {
  const res = await fetch(proxyUrl(url), { signal });
  if (!res.ok) throw new Error(`segment HTTP ${res.status}`);
  // 从拿到响应头之后开始计时：建连 + 代理 TTFB 不属于「下载速度」，
  // 256KB 的小样本里首包延迟占比很高，算进去会系统性低估带宽
  const started = performance.now();
  const reader = res.body?.getReader();
  let bytes = 0;
  if (reader) {
    try {
      while (bytes < SAMPLE_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  } else {
    bytes = (await res.arrayBuffer()).byteLength;
  }
  return { bytes, ms: Math.max(1, performance.now() - started) };
}

/**
 * 探测一条 m3u8 的播放流畅度。失败一律返回 unknown（不影响画质徽章）。
 * 结果缓存 10 分钟，避免同一集在详情/换源之间来回测。
 */
export async function probePlaybackSpeed(
  m3u8Url: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<PlaybackSpeedResult> {
  const key = m3u8Url;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 7_000);
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  let result: PlaybackSpeedResult;
  try {
    const master = await fetchText(m3u8Url, controller.signal, 'master');
    const variants = parseMasterPlaylist(master, m3u8Url).sort(
      (a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0)
    );
    let mediaUrl = m3u8Url;
    let mediaText = master;
    let variant: Variant | undefined;
    if (variants.length > 0) {
      variant = variants[0];
      mediaUrl = variant.uri;
      mediaText = await fetchText(mediaUrl, controller.signal, 'media');
    }
    const segment = firstSegment(mediaText, mediaUrl);
    if (!segment) throw new Error('没有分片');
    if (!/^https?:\/\//i.test(segment)) throw new Error('分片地址无效');
    const { bytes, ms } = await sampleSegment(segment, controller.signal);
    const kbps = Math.round((bytes * 8) / ms);
    const requiredKbps = variant?.bandwidth ? Math.round(variant.bandwidth / 1000) : requiredKbpsForHeight(variant?.height);
    result = { verdict: verdictOf(kbps, requiredKbps), kbps, ms: Math.round(ms), requiredKbps };
  } catch (err) {
    result = { verdict: 'unknown', error: err instanceof Error ? err.message : '测速失败' };
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener('abort', onAbort);
  }

  // 只缓存有效结论：超时/abort/防盗链得到的 unknown 是即时状态，缓存 10 分钟会让用户
  // 在网络恢复或换集之后仍然看到「测速失败」，且期间无法重新测速
  if (result.verdict !== 'unknown') {
    cache.set(key, { at: Date.now(), result });
  }
  return result;
}

export function verdictLabel(verdict: PlaybackVerdict): string {
  switch (verdict) {
    case 'smooth':
      return '流畅';
    case 'ok':
      return '一般';
    case 'slow':
      return '可能卡顿';
    default:
      return '测速失败';
  }
}
