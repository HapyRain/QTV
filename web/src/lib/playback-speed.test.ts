import { describe, expect, it } from 'vitest';
import { afterEach, vi } from 'vitest';
import { firstSegment, parseMasterPlaylist, probePlaybackSpeed, requiredKbpsForHeight, verdictOf } from './playback-speed';

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080
1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
720/index.m3u8
`;

const MEDIA = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:6.0,
seg-0.ts
#EXTINF:6.0,
seg-1.ts
`;

describe('playback-speed · 播放前测速', () => {
  it('解析 master 的码率与分辨率，并把相对地址绝对化', () => {
    const variants = parseMasterPlaylist(MASTER, 'https://cdn.example.com/hls/master.m3u8');
    expect(variants).toHaveLength(2);
    expect(variants[0]).toMatchObject({ bandwidth: 8_000_000, height: 1080 });
    expect(variants[0].uri).toBe('https://cdn.example.com/hls/1080/index.m3u8');
    expect(variants[1].height).toBe(720);
  });

  it('媒体列表取第一个分片，跳过 EXT 标签', () => {
    expect(firstSegment(MEDIA, 'https://cdn.example.com/hls/1080/index.m3u8')).toBe(
      'https://cdn.example.com/hls/1080/seg-0.ts'
    );
  });

  it('结论带安全余量：1.5x 流畅，1.1x 一般，以下判卡顿', () => {
    expect(verdictOf(9_000, 5_000)).toBe('smooth');
    expect(verdictOf(6_000, 5_000)).toBe('ok');
    expect(verdictOf(3_000, 5_000)).toBe('slow');
    expect(verdictOf(0, 5_000)).toBe('unknown');
  });

  it('没有码率信息时按分辨率兜底，再没有就按绝对速率', () => {
    expect(requiredKbpsForHeight(1080)).toBe(5_000);
    expect(requiredKbpsForHeight(720)).toBe(3_000);
    expect(requiredKbpsForHeight(undefined)).toBe(0);
    expect(verdictOf(5_000, 0)).toBe('smooth');
    expect(verdictOf(2_000, 0)).toBe('ok');
    expect(verdictOf(800, 0)).toBe('slow');
  });
});

describe('playback-speed · 真实采样', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('按 master → media → 首片段读取 256KB，算出速率并给结论', async () => {
    const media = `#EXTM3U
#EXTINF:6.0,
seg-0.ts
`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = decodeURIComponent(String(input));
        if (url.includes('master.m3u8')) {
          return new Response(MASTER, { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
        }
        if (url.includes('1080/index.m3u8')) {
          return new Response(media, { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
        }
        if (url.includes('seg-0.ts')) {
          return new Response(new Uint8Array(262_144), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      })
    );
    const result = await probePlaybackSpeed('https://cdn.example.com/hls/master.m3u8');
    expect(result.kbps).toBeGreaterThan(0);
    expect(result.requiredKbps).toBe(8_000);
    expect(['smooth', 'ok', 'slow']).toContain(result.verdict);
  });

  it('源站回 HTML（防盗链）时给 unknown，而不是把 HTML 当列表', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>blocked</html>', { status: 200 })));
    const result = await probePlaybackSpeed('https://cdn.example.com/hls/blocked.m3u8');
    expect(result.verdict).toBe('unknown');
    expect(result.error).toContain('不是 m3u8');
  });
});