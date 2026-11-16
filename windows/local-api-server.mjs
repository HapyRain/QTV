#!/usr/bin/env node
/**
 * QTV Windows Local API & Static Asset Server (Zero External Dependencies, Node 18+)
 * Implements all /api/* routes locally on 127.0.0.1 for QTV Desktop.
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import dns from 'node:dns/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 QTVDesktop/1.0';

const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

function decodeBuffer(buf, contentType = '') {
  const ct = contentType.toLowerCase();
  if (ct.includes('gbk') || ct.includes('gb2312') || ct.includes('gb18030')) {
    try {
      return new TextDecoder('gb18030').decode(buf);
    } catch {
      /* fallback */
    }
  }
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (utf8.includes('\uFFFD')) {
    try {
      return new TextDecoder('gb18030').decode(buf);
    } catch {
      /* fallback */
    }
  }
  return utf8;
}

/** 出网校验失败（4xx 语义）：带状态码，交给外层统一回包 */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** 响应体积上限：代理/分片类 64MB，其余 JSON 接口 16MB，超限立即中止防内存打爆 */
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
/** 跟随重定向最多 3 跳，且每跳都重新校验目标（防「公网 302 到内网」绕过） */
const MAX_REDIRECTS = 3;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** IPv4 私网/回环/链路本地/未指定：0/8、10/8、127/8、169.254/16、172.16/12、192.168/16 */
function isPrivateV4(ip) {
  const parts = ip.split('.').map((x) => Number(x));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

/** IPv6 私网（fc00::/7）、链路本地（fe80::/10）、回环/未指定；IPv4-mapped/compat 先还原成 v4 再判 */
function isPrivateAddress(rawIp) {
  const ip = rawIp.trim().replace(/^\[+|\]+$/g, '');
  const family = net.isIP(ip);
  if (family === 4) return isPrivateV4(ip);
  if (family !== 6) return false;
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  const dotted = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  if (dotted) return isPrivateV4(dotted[1]);
  const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v);
  if (hex) {
    const n = ((parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16)) >>> 0;
    return isPrivateV4(`${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`);
  }
  return /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v);
}

/**
 * 出网目标校验：只允许公网 http/https。
 * 主机名必须先解析出**全部**地址逐个校验 —— 只查字面量 IP 挡不住
 * 「域名第一次解析到公网、请求时再解析到 127.0.0.1」的 DNS rebinding 套路。
 */
export const ADULT_KEYWORDS = [
  '伦理片', '福利', '倫理片', '福利片', '日本伦理', '日本福利', '日本福利片', '日本伦理片',
  '擦边短剧', '擦边', '韩国伦理', '里番动漫', '门事件', '萝莉少女', '制服诱惑', '国产传媒',
  'cosplay', '黑丝诱惑', '无码', '日本无码', '有码', '日本有码', 'SWAG',
  '网红主播', '色情片', '同性片', '福利视频', '无码高清', '有码高清', '91视频', '自拍偷拍',
  'mini传媒',
];

/** 与 Android CmsParser.isAdultContent 对齐：typeName 命中关键词即视为成人内容 */
function isAdultTypeName(typeName) {
  const t = String(typeName || '').toLowerCase();
  return ADULT_KEYWORDS.some((k) => t.includes(k.toLowerCase()));
}

/** 受限并发：一次只放 limit 个源出网，避免几百源同时打满 FD */
async function mapLimit(items, limit, fn) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      await fn(items[index], index);
    }
  });
  await Promise.all(workers);
}

async function assertPublicHttpUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new HttpError(400, '无效的目标地址');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpError(400, `不支持的协议：${parsed.protocol}`);
  }
  const host = parsed.hostname.replace(/^\[+|\]+$/g, '');
  if (!host) throw new HttpError(400, '缺少目标主机');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new HttpError(403, '不允许访问私有/保留网络地址');
    return parsed;
  }
  if (host.toLowerCase() === 'localhost' || host.toLowerCase().endsWith('.localhost')) {
    throw new HttpError(403, '不允许访问本机地址');
  }
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw new HttpError(502, `无法解析目标主机：${host}`);
  }
  if (!addresses.length) throw new HttpError(502, `无法解析目标主机：${host}`);
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw new HttpError(403, '目标地址解析到私有/保留网络');
  }
  return parsed;
}

/** 带上限读响应体；Content-Length 只作预检，分块传输同样按实际字节数掐断 */
async function readBodyCapped(res, maxBytes) {
  const limitMb = Math.round(maxBytes / 1024 / 1024);
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > maxBytes) {
    try {
      await res.body?.cancel();
    } catch {
      /* 已断开 */
    }
    throw new HttpError(413, `上游响应超过 ${limitMb}MB 上限`);
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* 已断开 */
      }
      throw new HttpError(413, `上游响应超过 ${limitMb}MB 上限`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function fetchBuffer(
  targetUrl,
  { timeoutMs = 12000, headers = {}, maxBytes = MAX_JSON_BYTES, head = false } = {}
) {
  let current = targetUrl;
  for (let hop = 0; ; hop++) {
    await assertPublicHttpUrl(current);
    let originRef = undefined;
    try {
      const u = new URL(current);
      originRef = `${u.protocol}//${u.host}/`;
    } catch {
      /* 上面已校验 */
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(current, {
        signal: ctrl.signal,
        redirect: 'manual', // 手动跟跳，每一跳都重新过校验
        headers: {
          'User-Agent': DEFAULT_UA,
          Accept: '*/*',
          ...(originRef ? { Referer: originRef } : {}),
          ...headers,
        },
      });
      if (REDIRECT_STATUS.has(res.status)) {
        const location = res.headers.get('location');
        try {
          await res.body?.cancel();
        } catch {
          /* 已断开 */
        }
        if (!location) throw new HttpError(502, `上游返回 ${res.status} 但缺少跳转地址`);
        if (hop >= MAX_REDIRECTS) throw new HttpError(502, '重定向次数超过 3 次');
        let nextUrl;
        try {
          nextUrl = new URL(location, current).toString();
        } catch {
          throw new HttpError(502, '上游返回了无效的跳转地址');
        }
        current = nextUrl;
        continue;
      }
      const result = {
        ok: res.ok,
        status: res.status,
        finalUrl: current,
        contentType: res.headers.get('content-type') || '',
        headers: res.headers,
      };
      if (head) {
        // 只关心响应头（测活/分片可达性）：立刻断开，不下载媒体数据
        try {
          await res.body?.cancel();
        } catch {
          /* 已断开 */
        }
        return { ...result, buffer: Buffer.alloc(0) };
      }
      return { ...result, buffer: await readBodyCapped(res, maxBytes) };
    } finally {
      clearTimeout(timer);
    }
  }
}

async function fetchText(targetUrl, opts = {}) {
  const r = await fetchBuffer(targetUrl, opts);
  return {
    ...r,
    text: decodeBuffer(r.buffer, r.contentType),
  };
}

/** Strip ad discontinuity groups from M3U8 playlist */
export function stripM3u8Ads(content) {
  if (!content || !content.includes('#EXTM3U')) return content;
  const lines = content.split(/\r?\n/);
  const adPathRe = /(?:ad|ads|advert|preroll|midroll|sponsor|commercial|guanggao)[/_.-]/i;

  // Group into discontinuity blocks
  const headerLines = [];
  const groups = [[]];
  let inSegments = false;
  let pendingTags = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-DISCONTINUITY') && !line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')) {
      inSegments = true;
      groups.push([]);
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      inSegments = true;
      pendingTags.push(line);
      continue;
    }
    if (!line.startsWith('#')) {
      inSegments = true;
      const durMatch = pendingTags.find((t) => t.startsWith('#EXTINF:'))?.match(/#EXTINF:\s*([\d.]+)/);
      const duration = durMatch ? parseFloat(durMatch[1]) : 0;
      groups[groups.length - 1].push({
        tags: [...pendingTags],
        uri: line,
        duration: Number.isFinite(duration) ? duration : 0,
      });
      pendingTags = [];
      continue;
    }
    if (!inSegments) {
      headerLines.push(line);
    } else {
      pendingTags.push(line);
    }
  }

  const nonEmptyGroups = groups.filter((g) => g.length > 0);
  if (nonEmptyGroups.length <= 1) {
    // Only filter explicit ad URLs
    const filtered = (nonEmptyGroups[0] || []).filter((seg) => !adPathRe.test(seg.uri));
    const out = [...headerLines];
    for (const seg of filtered) {
      out.push(...seg.tags, seg.uri);
    }
    if (!out.some((l) => l.startsWith('#EXT-X-ENDLIST')) && content.includes('#EXT-X-ENDLIST')) {
      out.push('#EXT-X-ENDLIST');
    }
    return out.join('\n') + '\n';
  }

  // Find dominant group by total duration
  const totals = nonEmptyGroups.map((g) => g.reduce((acc, s) => acc + s.duration, 0));
  const maxTotal = Math.max(...totals, 1);

  const keptGroups = nonEmptyGroups.filter((g, idx) => {
    const totalDur = totals[idx];
    const hasAdUrl = g.some((s) => adPathRe.test(s.uri));
    if (hasAdUrl && totalDur < maxTotal * 0.5) return false;
    if (g.length <= 6 && totalDur <= 45 && maxTotal > 120) return false;
    return true;
  });

  const out = [...headerLines];
  const finalGroups = keptGroups.length > 0 ? keptGroups : nonEmptyGroups;
  finalGroups.forEach((g, idx) => {
    if (idx > 0) out.push('#EXT-X-DISCONTINUITY');
    for (const seg of g) {
      if (!adPathRe.test(seg.uri)) {
        out.push(...seg.tags, seg.uri);
      }
    }
  });
  if (content.includes('#EXT-X-ENDLIST') && !out.includes('#EXT-X-ENDLIST')) {
    out.push('#EXT-X-ENDLIST');
  }
  return out.join('\n') + '\n';
}

export function rewriteM3u8Urls(content, baseUrl, proxyPrefix, stripAds = false) {
  const cleaned = stripAds ? stripM3u8Ads(content) : content;
  const lines = cleaned.split(/\r?\n/);
  const resolveRef = (ref) => {
    try {
      return new URL(ref, baseUrl).toString();
    } catch {
      return ref;
    }
  };
  const wrapUrl = (raw) => {
    const abs = resolveRef(raw.trim());
    if (!/^https?:\/\//i.test(abs)) return raw;
    const suffix = stripAds ? '&adFilter=1' : '';
    return `${proxyPrefix}${encodeURIComponent(abs)}${suffix}`;
  };

  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${wrapUrl(u)}"`);
      }
      return wrapUrl(trimmed);
    })
    .join('\n');
}

/** Parse AppleCMS JSON or XML response */
function parseCmsSearch(text, source) {
  const trimmed = text.trim();
  // 采集接口只回 JSON/XML；返回网页说明地址填错（或撞了防盗链），当失败上报而不是静默出空结果
  if (/^<(?:!doctype|html)/i.test(trimmed)) throw new Error('源返回网页而不是采集接口');
  if (trimmed.startsWith('<')) {
    const items = [];
    const videoBlocks = trimmed.match(/<video>[\s\S]*?<\/video>/gi) || [];
    for (const block of videoBlocks) {
      const tag = (name) => {
        const m = block.match(new RegExp(`<${name}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${name}>|<${name}>([\\s\\S]*?)<\\/${name}>`, 'i'));
        return (m ? m[1] ?? m[2] ?? '' : '').trim();
      };
      const id = tag('id');
      const name = tag('name');
      if (!id || !name) continue;
      items.push({
        sourceKey: source.key,
        sourceName: source.name || source.key,
        sourceUrl: source.url,
        vodId: id,
        name,
        pic: tag('pic') || undefined,
        typeName: tag('type') || undefined,
        year: tag('year') || undefined,
        area: tag('area') || undefined,
        remarks: tag('note') || undefined,
      });
    }
    return items;
  }
  const data = JSON.parse(trimmed);
  const list = Array.isArray(data.list) ? data.list : [];
  return list
    .map((item) => ({
      sourceKey: source.key,
      sourceName: source.name || source.key,
      sourceUrl: source.url,
      vodId: String(item.vod_id ?? ''),
      name: String(item.vod_name ?? '').trim(),
      pic: item.vod_pic ? String(item.vod_pic).trim() : undefined,
      typeName: item.type_name ? String(item.type_name).trim() : undefined,
      year: item.vod_year ? String(item.vod_year).trim() : undefined,
      area: item.vod_area ? String(item.vod_area).trim() : undefined,
      remarks: item.vod_remarks ? String(item.vod_remarks).trim() : undefined,
    }))
    .filter((x) => x.vodId && x.name);
}

function extractM3u8PlayList(playUrlStr, playFromStr = '') {
  if (!playUrlStr) return [];
  const fromGroups = playFromStr ? playFromStr.split('$$$') : [];
  const urlGroups = playUrlStr.split('$$$');

  // Prefer group whose name or URLs contain .m3u8
  let bestGroup = '';
  for (let i = 0; i < urlGroups.length; i++) {
    const g = urlGroups[i];
    const fromName = (fromGroups[i] || '').toLowerCase();
    if (fromName.includes('m3u8') || /\.m3u8/i.test(g)) {
      bestGroup = g;
      break;
    }
  }
  if (!bestGroup) bestGroup = urlGroups[0] || '';

  const episodes = [];
  for (const part of bestGroup.split('#')) {
    const seg = part.trim();
    if (!seg) continue;
    const dollarIdx = seg.indexOf('$');
    const urlCandidate = dollarIdx >= 0 ? seg.slice(dollarIdx + 1).trim() : seg;
    if (/^https?:\/\//i.test(urlCandidate)) {
      episodes.push(urlCandidate);
    }
  }
  return episodes;
}

function parseCmsDetail(text, source) {
  const trimmed = text.trim();
  if (trimmed.startsWith('<')) {
    const block = (trimmed.match(/<video>[\s\S]*?<\/video>/i) || [''])[0];
    const tag = (name) => {
      const m = block.match(new RegExp(`<${name}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${name}>|<${name}>([\\s\\S]*?)<\\/${name}>`, 'i'));
      return (m ? m[1] ?? m[2] ?? '' : '').trim();
    };
    const dds = [...block.matchAll(/<dd[^>]*>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/dd>/gi)].map(
      (m) => (m[1] ?? m[2] ?? '').trim()
    );
    const episodes = extractM3u8PlayList(dds.join('$$$'));
    return {
      episodes,
      videoInfo: {
        title: tag('name'),
        cover: tag('pic') || undefined,
        desc: tag('des')?.replace(/<[^>]+>/g, '').trim() || undefined,
        typeName: tag('type') || undefined,
        year: tag('year') || undefined,
        area: tag('area') || undefined,
        director: tag('director') || undefined,
        actor: tag('actor') || undefined,
        remarks: tag('note') || undefined,
        sourceKey: source.key,
        sourceName: source.name || source.key,
        sourceUrl: source.url,
      },
    };
  }
  const data = JSON.parse(trimmed);
  const item = Array.isArray(data.list) && data.list[0] ? data.list[0] : {};
  const episodes = extractM3u8PlayList(
    String(item.vod_play_url ?? ''),
    String(item.vod_play_from ?? '')
  );
  return {
    episodes,
    videoInfo: {
      title: String(item.vod_name ?? '').trim() || undefined,
      cover: item.vod_pic ? String(item.vod_pic).trim() : undefined,
      desc: item.vod_content
        ? String(item.vod_content).replace(/<[^>]+>/g, '').trim()
        : undefined,
      typeName: item.type_name ? String(item.type_name).trim() : undefined,
      year: item.vod_year ? String(item.vod_year).trim() : undefined,
      area: item.vod_area ? String(item.vod_area).trim() : undefined,
      director: item.vod_director ? String(item.vod_director).trim() : undefined,
      actor: item.vod_actor ? String(item.vod_actor).trim() : undefined,
      remarks: item.vod_remarks ? String(item.vod_remarks).trim() : undefined,
      sourceKey: source.key,
      sourceName: source.name || source.key,
      sourceUrl: source.url,
    },
  };
}

function parseM3uPlaylist(text) {
  const lines = text.split(/\r?\n/);
  const channels = [];
  let current = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const attr = (key) => {
        const m = line.match(new RegExp(`${key}="([^"]*)"`, 'i'));
        return m ? m[1].trim() : undefined;
      };
      const commaIdx = line.lastIndexOf(',');
      const name = commaIdx >= 0 ? line.slice(commaIdx + 1).trim() : '未知频道';
      current = {
        name: name || '未知频道',
        tvgId: attr('tvg-id') || undefined,
        rawName: attr('tvg-name'),
        logo: attr('tvg-logo'),
        group: attr('group-title') || '默认分组',
      };
    } else if (!line.startsWith('#')) {
      if (line.includes(',') && !current) {
        // Genre/Title,http://... format
        const [title, url] = line.split(',');
        if (url && /^https?:\/\//i.test(url.trim())) {
          channels.push({
            id: url.trim(),
            name: title.trim() || '频道',
            url: url.trim(),
            group: '默认分组',
          });
        }
      } else if (/^https?:\/\//i.test(line)) {
        channels.push({
          id: current?.tvgId || line,
          name: current?.name || '未知频道',
          url: line,
          logo: current?.logo,
          group: current?.group || '默认分组',
          tvgId: current?.tvgId,
          rawName: current?.rawName,
        });
        current = null;
      }
    }
  }
  return channels;
}

function parseSourceListPayload(rawText) {
  let cleaned = rawText.trim();
  // Strip JS-style comments in TVBox configs
  cleaned = cleaned
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  const data = JSON.parse(cleaned);
  const sources = [];
  const liveSources = [];
  // 统计口径按前端 SubscriptionParseStats：前端靠 skippedByReason 说明「为什么少导入了」
  const skippedByReason = {};
  const skip = (reason) => {
    skippedByReason[reason] = (skippedByReason[reason] || 0) + 1;
  };
  const buildStats = (format) => ({
    format,
    skipped: Object.values(skippedByReason).reduce((a, b) => a + b, 0),
    skippedByReason,
    skippedSamples: [],
    truncated: 0,
  });

  // 裸数组：接口目录格式 [{ name, baseUrl, enabled }]，仅点播
  if (Array.isArray(data)) {
    for (const item of data) {
      if (!item || typeof item !== 'object') continue;
      if (item.enabled === false) {
        skip('disabled');
        continue;
      }
      const apiUrl = String(item.baseUrl || item.url || '');
      if (!/^https?:\/\//i.test(apiUrl)) {
        skip('invalidUrl');
        continue;
      }
      sources.push({
        key: String(item.key || item.name || `catalog_${sources.length}`),
        name: String(item.name || '未命名源'),
        url: apiUrl.trim(),
      });
    }
    return { name: undefined, sources, liveSources, stats: buildStats('source-catalog') };
  }

  if (
    Array.isArray(data.sources) ||
    Array.isArray(data.liveSources) ||
    data.name === 'QTV-SourceList' ||
    data.name === 'LibreTV-SourceList'
  ) {
    for (const s of data.sources || []) {
      if (s && typeof s.url === 'string' && /^https?:\/\//i.test(s.url)) {
        sources.push({
          key: String(s.key || s.name || `src_${sources.length}`),
          name: String(s.name || s.key || '未命名源'),
          url: s.url.trim(),
          detail: s.detail ? String(s.detail).trim() : undefined,
        });
      }
    }
    for (const l of data.live || data.liveSources || []) {
      if (l && typeof l.url === 'string' && /^https?:\/\//i.test(l.url)) {
        liveSources.push({
          name: String(l.name || '直播源'),
          url: l.url.trim(),
          epg: l.epg ? String(l.epg).trim() : undefined,
        });
      }
    }
    return { name: data.name || 'QTV-SourceList', sources, liveSources, stats: buildStats('libretv') };
  }

  // TVBox sites[] & lives[]
  if (Array.isArray(data.sites)) {
    for (const site of data.sites) {
      if (!site || typeof site !== 'object') continue;
      const apiStr = String(site.api ?? '');
      if (site. searchable === 0) {
        skip('unsearchable');
        continue;
      }
      if (site.type === 0) {
        skip('xml');
        continue;
      }
      if (site.type !== 1 || apiStr.startsWith('csp_')) {
        skip('spider');
        continue;
      }
      if (!/^https?:\/\//i.test(apiStr)) {
        skip('invalidUrl');
        continue;
      }
      sources.push({
        key: String(site.key || site.name || `tvbox_${sources.length}`),
        name: String(site.name || site.key || '采集源'),
        url: apiStr.trim(),
      });
    }
  }
  if (Array.isArray(data.lives)) {
    for (const lv of data.lives) {
      if (lv && typeof lv.url === 'string' && /^https?:\/\//i.test(lv.url)) {
        liveSources.push({
          name: String(lv.name || 'TVBox 直播'),
          url: lv.url.trim(),
          epg: lv.epg ? String(lv.epg).trim() : undefined,
        });
      } else if (lv && Array.isArray(lv.channels)) {
        for (const ch of lv.channels) {
          for (const u of ch.urls || []) {
            const real = String(u).split('ext=')[0];
            if (/^https?:\/\//i.test(real)) {
              liveSources.push({ name: String(ch.name || 'TVBox 直播'), url: real.trim() });
            }
          }
        }
      }
    }
  }
  return { name: data.name || 'TVBox 订阅', sources, liveSources, stats: buildStats('tvbox') };
}

/** Read request JSON body or decode __body query param */
async function readRequestBody(req, urlObj) {
  if (urlObj.searchParams.get('__bodyEnc') === '1' && urlObj.searchParams.get('__body')) {
    const raw = Buffer.from(urlObj.searchParams.get('__body'), 'base64').toString('utf-8');
    return JSON.parse(raw);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_JSON_BYTES) throw new HttpError(413, '请求体过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** XMLTV 时间戳 "20261114120000 +0800" → epoch ms；缺时区按 UTC */
function parseXmltvTime(value) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(String(value || '').trim());
  if (!m) return 0;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  if (!m[7]) return ms;
  const sign = m[7][0] === '-' ? -1 : 1;
  return ms - sign * (Number(m[7].slice(1, 3)) * 60 + Number(m[7].slice(3, 5))) * 60000;
}

/** 解析 XMLTV 节目单；channelId 为空时返回全部频道，非空时按台号过滤（大小写不敏感） */
function parseXmltvPrograms(xml, channelId) {
  const wanted = String(channelId || '').toLowerCase();
  const programs = [];
  const re = /<programme\s+([^>]+)>([\s\S]*?)<\/programme>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const inner = m[2];
    const channel = (attrs.match(/channel="([^"]+)"/i) || [])[1] || '';
    if (wanted && channel.toLowerCase() !== wanted) continue;
    const start = parseXmltvTime((attrs.match(/start="([^"]+)"/i) || [])[1]);
    const stop = parseXmltvTime((attrs.match(/stop="([^"]+)"/i) || [])[1]);
    const title = ((inner.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '')
      .replace(/<!\[CDATA\[|\]\]>/g, '')
      .trim();
    const desc = ((inner.match(/<desc[^>]*>([\s\S]*?)<\/desc>/i) || [])[1] || '')
      .replace(/<!\[CDATA\[|\]\]>/g, '')
      .trim();
    if (!title || !start) continue;
    programs.push({ channelId: channel, start, stop, title, ...(desc ? { desc } : {}) });
  }
  programs.sort((a, b) => a.start - b.start);
  return programs;
}

/** master playlist 的第一个 variant；不是 master 时返回 null */
function m3u8FirstVariant(text, baseUrl) {
  if (!/#EXT-X-STREAM-INF/i.test(text)) return null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('#EXT-X-STREAM-INF')) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j].trim();
      if (!line || line.startsWith('#')) continue;
      try {
        return new URL(line, baseUrl).toString();
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** media playlist 的最后一个分片（取最新而非首个：直播窗口首个分片最接近过期） */
function m3u8LastSegment(text, baseUrl) {
  let last;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    try {
      last = new URL(line, baseUrl).toString();
    } catch {
      /* 忽略坏行 */
    }
  }
  return last;
}

/**
 * 单条直播测活：入口 →（master 时穿透 variant）→ 最新分片，只取响应头不下载媒体。
 * 结果字段对齐前端 LiveProbeResult：level 标明探测深度，timedOut 用于区分「慢」与「挂」。
 */
async function probeLiveUrl(url) {
  const t0 = Date.now();
  let referer;
  try {
    referer = `${new URL(url).origin}/`;
  } catch {
    /* 校验会拦下非法地址 */
  }
  const headers = { Accept: '*/*', ...(referer ? { Referer: referer } : {}) };
  const isM3u8Hint = /\.m3u8(\?|$)/i.test(url);
  try {
    // 扩展名像 m3u8 才读响应体；否则先只取响应头，免得对着 FLV 直播流把整个 body 读进内存
    const entry = await fetchBuffer(url, { timeoutMs: 6500, headers, head: !isM3u8Hint });
    const ct = entry.contentType.toLowerCase();
    const isM3u8 = ct.includes('mpegurl') || isM3u8Hint;
    if (!entry.ok) {
      return {
        url,
        ok: false,
        status: entry.status,
        ms: Date.now() - t0,
        level: isM3u8 ? 'manifest' : 'head',
        error: `HTTP ${entry.status}`,
      };
    }
    if (!isM3u8) {
      // 200 的 HTML/JSON 错误页不能当成流
      if (/text\/html|application\/json|text\/xml|application\/xml/.test(ct)) {
        return {
          url,
          ok: false,
          status: entry.status,
          ms: Date.now() - t0,
          level: 'head',
          error: `返回内容不是流媒体（${ct.split(';')[0]}）`,
        };
      }
      return { url, ok: true, status: entry.status, ms: Date.now() - t0, level: 'head' };
    }
    // 扩展名不像 HLS 但响应是 m3u8（少见）：补一次正文，否则拿不到 playlist 内容
    let body = entry.buffer;
    if (body.length === 0) {
      body = (await fetchBuffer(url, { timeoutMs: 6500, headers })).buffer;
    }
    const text = decodeBuffer(body, 'utf-8').replace(/^\uFEFF/, '').trimStart();
    if (!/^#EXTM3U/.test(text)) {
      return {
        url,
        ok: false,
        status: entry.status,
        ms: Date.now() - t0,
        level: 'manifest',
        error: '返回内容不是有效的 m3u8',
      };
    }
    const codec = (text.match(/CODECS="([^"]+)"/i) || [])[1];
    let mediaText = text;
    let mediaUrl = entry.finalUrl;
    const variant = m3u8FirstVariant(text, entry.finalUrl);
    if (variant) {
      const sub = await fetchBuffer(variant, { timeoutMs: 6500, headers });
      const subText = decodeBuffer(sub.buffer, 'utf-8').replace(/^\uFEFF/, '').trimStart();
      if (!sub.ok || !/^#EXTM3U/.test(subText)) {
        return {
          url,
          ok: false,
          status: sub.status,
          ms: Date.now() - t0,
          level: 'manifest',
          error: `子播放列表响应 ${sub.status}`,
        };
      }
      mediaText = subText;
      mediaUrl = sub.finalUrl;
    }
    const segment = m3u8LastSegment(mediaText, mediaUrl);
    if (!segment) {
      return {
        url,
        ok: true,
        status: entry.status,
        ms: Date.now() - t0,
        level: 'manifest',
        ...(codec ? { codec } : {}),
      };
    }
    const segStart = Date.now();
    const seg = await fetchBuffer(segment, {
      timeoutMs: 4000,
      head: true,
      headers: { ...headers, Range: 'bytes=0-1' },
    });
    if (!seg.ok) {
      return {
        url,
        ok: false,
        status: seg.status,
        ms: Date.now() - segStart,
        level: 'segment',
        ...(codec ? { codec } : {}),
        error: `分片响应 ${seg.status}`,
      };
    }
    return {
      url,
      ok: true,
      status: seg.status,
      ms: Date.now() - segStart,
      level: 'segment',
      ...(codec ? { codec } : {}),
    };
  } catch (err) {
    const timedOut = err?.name === 'AbortError';
    return {
      url,
      ok: false,
      ms: Date.now() - t0,
      ...(timedOut ? { timedOut: true } : {}),
      error: err instanceof HttpError ? err.message : timedOut ? '请求超时' : '不可达',
    };
  }
}

/**
 * 把 ?path= 收敛到缓存目录内：resolve 归一化 `..`（绝对路径也直接覆盖基准目录），
 * 再用 realpath 挡目录内指向外部的符号链接/junction。出界 403，缺失 404。
 */
function resolveLocalFile(rawPath, baseDir) {
  // 跨平台：Windows 盘符路径在 POSIX 上会被当成相对子目录（"C:/x" 会被拼进缓存目录），
  // 词法上落在围栏内、realpath 却 404 —— 两端判定必须一致，这里统一按出界 403 处理
  if (process.platform !== 'win32' && /^[a-zA-Z]:[\\/]/.test(rawPath)) {
    throw new HttpError(403, '只允许访问缓存目录内的文件');
  }
  const norm = (p) => path.resolve(p).toLowerCase();
  // 两步校验，基准不能混用：
  // 词法阶段用原始 baseDir，realpath 阶段用 realpath 后的 baseDir。
  // 混用会误杀合法文件——Windows 的 8.3 短名（RUNNER~1）与展开后的长名不一致，
  // path.resolve 之后再比前缀恒为 false。
  const lexicalBase = path.resolve(baseDir);
  const target = path.resolve(lexicalBase, rawPath);
  if (!norm(target).startsWith(norm(lexicalBase) + path.sep)) {
    throw new HttpError(403, '只允许访问缓存目录内的文件');
  }
  let real;
  try {
    real = fs.realpathSync.native(target);
  } catch {
    throw new HttpError(404, '文件不存在');
  }
  // junction / 目录重定向会让词法路径与真实路径不一致：出界判定以真实路径为准
  let realBase;
  try {
    realBase = fs.realpathSync.native(baseDir);
  } catch {
    realBase = lexicalBase;
  }
  if (!norm(real).startsWith(norm(realBase) + path.sep)) {
    throw new HttpError(403, '只允许访问缓存目录内的文件');
  }
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new HttpError(404, '文件不存在');
  return { file: real, size: stat.size };
}

export function createLocalServer({ wwwDir, downloadDir } = {}) {
  // 必须先 resolve：调用方传进来的 wwwDir 可能带正斜杠（"E:/x/www"），
  // 而下面 candidate.startsWith(resolvedWww + path.sep) 比较的是反斜杠，不归一化会全部 404
  const resolvedWww = path.resolve(
    wwwDir ||
      (fs.existsSync(path.join(__dirname, 'www', 'index.html'))
        ? path.join(__dirname, 'www')
        : path.join(ROOT_DIR, 'app', 'src', 'main', 'assets', 'www'))
  );
  // 离线缓存目录：主进程传入 app.getPath('videos')/QTV；CLI/测试直接跑时退回用户 Videos
  const resolvedVideos = path.resolve(downloadDir || path.join(os.homedir(), 'Videos', 'QTV'));

  return http.createServer(async (req, res) => {
    try {
      // DNS rebinding 防护：只接受本机 Host，恶意域名解析到 127.0.0.1 也会被这里挡掉
      const hostName = String(req.headers.host || '')
        .toLowerCase()
        .replace(/:\d+$/, '')
        .replace(/^\[|\]$/g, '');
      if (!['127.0.0.1', 'localhost', '::1'].includes(hostName)) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('bad host');
        return;
      }
      const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = urlObj.pathname;

      if (req.method === 'OPTIONS') {
        // 不返回 Access-Control-Allow-Origin：服务只面向同源前端，
        // 任意网页都不该被允许跨域读取本地接口（同源 fetch 本就不需要该头）
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
      }

      // 1B. /api/player-state
      if (pathname === '/api/player-state') {
        // 前端 sendPlayerState 用 GET 查询参数传状态（同名同义），POST body 保留兼容
        const incoming = req.method === 'POST' ? await readRequestBody(req, urlObj) : {};
        for (const key of ['paused', 'fullscreen']) {
          const raw = urlObj.searchParams.get(key);
          if (raw !== null) incoming[key] = raw === '1' || raw === 'true';
        }
        for (const key of ['brightness', 'volume']) {
          const raw = urlObj.searchParams.get(key);
          const num = raw === null ? NaN : Number(raw);
          if (Number.isFinite(num)) incoming[key] = num;
        }
        if (Object.keys(incoming).length > 0) {
          globalThis.__qtvPlayerState = {
            ...(globalThis.__qtvPlayerState || {}),
            ...incoming,
            updatedAt: Date.now(),
          };
        }
        sendJson(res, 200, { ok: true, state: globalThis.__qtvPlayerState || null });
        return;
      }

      // 1. /api/status
      if (pathname === '/api/status') {
        sendJson(res, 200, {
          ok: true,
          protected: false,
          verified: true,
          setupRequired: false,
          version: '1.1',
          platform: 'windows',
          // 前端 AuthStatusResponse 契约字段：本机无密码、无预置源
          passwordRequired: false,
          defaultSources: [],
          defaultLiveSources: [],
          defaultSubscriptions: [],
          defaultRecommendSource: null,
          defaultImageMode: null,
          sources: [],
          subscriptions: [],
          liveSources: [],
        });
        return;
      }

      // 2. /api/auth
      if (pathname === '/api/auth') {
        sendJson(res, 200, { ok: true, verified: true });
        return;
      }

      // 3. /api/douban —— 走 m.douban.com 的 rexxar 榜单接口。
      // 旧的 movie.douban.com/j/search_subjects 已下线（稳定 404/超时），首页推荐因此一直是空的。
      if (pathname === '/api/douban') {
        const type = urlObj.searchParams.get('type') === 'movie' ? 'movie' : 'tv';
        const tag = urlObj.searchParams.get('tag') || '热门';
        const pageSize = Math.min(50, Math.max(1, parseInt(urlObj.searchParams.get('pageSize') || '24', 10) || 24));
        const pageStart = Math.max(0, parseInt(urlObj.searchParams.get('pageStart') || '0', 10) || 0);
        // 「高分」用经典榜单，其余用热播榜；两者都是 rexxar 的 subject_collection
        const highRated = /高分|口碑|豆瓣高分/.test(tag);
        const collection =
          type === 'tv'
            ? highRated
              ? 'tv_chinese_best_weekly'
              : 'tv_hot'
            : highRated
              ? 'movie_top250'
              : 'movie_hot';
        const target = `https://m.douban.com/rexxar/api/v2/subject_collection/${collection}/items?start=${pageStart}&count=${pageSize}`;
        try {
          const r = await fetchText(target, {
            timeoutMs: 9000,
            headers: {
              Referer: 'https://m.douban.com/',
              // rexxar 接口对 UA 敏感：桌面 UA 会被判成爬虫返回空体
              'User-Agent':
                'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
              Accept: 'application/json',
            },
          });
          const data = JSON.parse(r.text);
          const list = Array.isArray(data.subject_collection_items) ? data.subject_collection_items : [];
          const items = list
            .map((s) => {
              const rating = Number(s?.rating?.value ?? 0);
              const cover = String(s?.pic?.large || s?.pic?.normal || s?.cover?.url || '');
              return {
                id: String(s?.id || ''),
                title: String(s?.title || ''),
                cover,
                ...(rating > 0 ? { rating: rating.toFixed(1) } : {}),
                isTv: type === 'tv' || s?.type === 'tv',
              };
            })
            .filter((s) => s.id && s.title);
          sendJson(res, 200, { items });
        } catch {
          sendJson(res, 200, { items: [] });
        }
        return;
      }

      // 4. /api/bangumi/calendar
      if (pathname === '/api/bangumi/calendar') {
        try {
          const r = await fetchText('https://api.bgm.tv/calendar', { timeoutMs: 9000 });
          const days = JSON.parse(r.text);
          const calendar = (Array.isArray(days) ? days : []).map((d) => ({
            weekday: d.weekday?.id || 1,
            items: (d.items || []).map((it) => ({
              id: String(it.id || ''),
              title: String(it.name_cn || it.name || ''),
              cover: String(it.images?.large || it.images?.common || ''),
              rating: it.rating?.score ? String(it.rating.score) : undefined,
            })),
          }));
          sendJson(res, 200, { days: calendar });
        } catch {
          sendJson(res, 200, { days: [] });
        }
        return;
      }

      // 5. /api/hot-list
      if (pathname === '/api/hot-list') {
        sendJson(res, 200, { items: [] });
        return;
      }

      // 6. /api/search
      if (pathname === '/api/search') {
        const body = await readRequestBody(req, urlObj);
        // 前端 POST 体字段是 wd（query 仅为历史兼容）
        const query = String(
          body.wd || body.query || urlObj.searchParams.get('wd') || urlObj.searchParams.get('q') || ''
        ).trim();
        const sources = (Array.isArray(body.sources) ? body.sources : []).filter(
          (s) => s && typeof s.url === 'string' && s.url
        );
        const stream = urlObj.searchParams.get('stream') === '1' || body.stream === true;
        const filterAdult = body.filterAdult !== false;

        if (!query || sources.length === 0) {
          const empty = { list: [], failures: [] };
          if (stream) {
            // 流式模式下也按 NDJSON 回包，前端的 done 解析逻辑保持单一
            res.writeHead(200, {
              'Content-Type': 'application/x-ndjson; charset=utf-8',
              'Cache-Control': 'no-store',
            });
            res.end(JSON.stringify({ type: 'done', ...empty }) + '\n');
          } else {
            sendJson(res, 200, empty);
          }
          return;
        }

        if (stream) {
          res.writeHead(200, {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-store',
          });
        }
        const writeEvent = (event) => {
          if (!stream || res.writableEnded || res.destroyed) return;
          try {
            res.write(JSON.stringify(event) + '\n');
          } catch {
            /* 客户端已断开 */
          }
        };

        const allResults = [];
        const failures = [];

        await mapLimit(sources, 6, async (src) => {
            const t0 = Date.now();
            try {
              const sep = src.url.includes('?') ? '&' : '?';
              const target = `${src.url}${sep}ac=videolist&wd=${encodeURIComponent(query)}`;
              const r = await fetchText(target, { timeoutMs: 10000 });
              const rawList = parseCmsSearch(r.text, src);
              const list = filterAdult ? rawList.filter((item) => !isAdultTypeName(item.typeName)) : rawList;
              allResults.push(...list);
              writeEvent({ type: 'source', sourceKey: src.key, ok: true, list, ms: Date.now() - t0 });
            } catch (err) {
              const isTimeout = err?.name === 'AbortError';
              const errorMsg =
                err instanceof HttpError
                  ? err.message
                  : isTimeout
                    ? '请求超时'
                    : String(err?.message || '请求失败');
              failures.push({ sourceKey: src.key, error: errorMsg, timedOut: isTimeout });
              writeEvent({
                type: 'source',
                sourceKey: src.key,
                ok: false,
                list: [],
                error: errorMsg,
                timedOut: isTimeout,
                ms: Date.now() - t0,
              });
            }
        });

        if (stream) {
          writeEvent({ type: 'done', list: allResults, failures });
          res.end();
        } else {
          sendJson(res, 200, { list: allResults, failures });
        }
        return;
      }

      // 7. /api/detail
      if (pathname === '/api/detail') {
        // 前端实际用 GET ?id=..&source=<SourceConfig JSON>；POST body 保留兼容
        const body = req.method === 'POST' ? await readRequestBody(req, urlObj) : {};
        const id = String(body.id || urlObj.searchParams.get('id') || '').trim();
        let source = body.source;
        if (!source) {
          const raw = urlObj.searchParams.get('source') || '';
          try {
            source = raw ? JSON.parse(raw) : null;
          } catch {
            // 兼容老调用方把 source 当 key 传、地址放在 sourceUrl 的情况
            source = {
              key: raw || 'custom',
              name: urlObj.searchParams.get('sourceName') || '视频源',
              url: urlObj.searchParams.get('sourceUrl') || '',
            };
          }
        }
        if (!id || !source?.url) {
          sendJson(res, 400, { error: '缺少影片 ID 或数据源地址' });
          return;
        }
        const sep = source.url.includes('?') ? '&' : '?';
        const target = `${source.url}${sep}ac=videolist&ids=${encodeURIComponent(id)}`;
        try {
          const r = await fetchText(target, { timeoutMs: 12000 });
          sendJson(res, 200, parseCmsDetail(r.text, source));
        } catch (err) {
          if (err instanceof HttpError) throw err;
          sendJson(res, 502, { error: `详情获取失败：${err?.message || '未知错误'}` });
        }
        return;
      }

      // 8. /api/source/test
      if (pathname === '/api/source/test') {
        const body = await readRequestBody(req, urlObj);
        const url = String(body.url || urlObj.searchParams.get('url') || '').trim().replace(/\/+$/, '');
        const t0 = Date.now();
        try {
          const sep = url.includes('?') ? '&' : '?';
          const r = await fetchText(`${url}${sep}ac=videolist&wd=test`, { timeoutMs: 6000 });
          const list = parseCmsSearch(r.text, { key: 'test', name: 'test', url });
          sendJson(res, 200, { ok: true, ms: Date.now() - t0, count: list.length });
        } catch (err) {
          const isTimeout = err?.name === 'AbortError';
          sendJson(res, 200, {
            ok: false,
            ms: Date.now() - t0,
            error: err instanceof HttpError ? err.message : isTimeout ? '连接超时' : String(err?.message || '无法连接'),
          });
        }
        return;
      }

      // 9. /api/source-list
      if (pathname === '/api/source-list') {
        const body = req.method === 'POST' ? await readRequestBody(req, urlObj) : {};
        const url = String(body.url || urlObj.searchParams.get('url') || '').trim();
        if (!url) {
          sendJson(res, 400, { error: '缺少订阅地址' });
          return;
        }
        let r;
        try {
          r = await fetchText(url, { timeoutMs: 12000, headers: { Accept: 'application/json' } });
        } catch (err) {
          if (err instanceof HttpError) throw err;
          sendJson(res, 502, { error: `订阅地址请求失败：${err?.message || '未知错误'}` });
          return;
        }
        if (!r.ok) {
          sendJson(res, 502, { error: `订阅地址返回 HTTP ${r.status}` });
          return;
        }
        let parsed;
        try {
          parsed = parseSourceListPayload(r.text);
        } catch {
          sendJson(res, 400, { error: '订阅内容格式不正确' });
          return;
        }
        sendJson(res, 200, parsed);
        return;
      }

      // 10. /api/live/playlist
      if (pathname === '/api/live/playlist') {
        const url = String(urlObj.searchParams.get('url') || '').trim();
        if (!url) {
          sendJson(res, 400, { error: '缺少直播源地址' });
          return;
        }
        let r;
        try {
          r = await fetchText(url, { timeoutMs: 12000 });
        } catch (err) {
          if (err instanceof HttpError) throw err;
          sendJson(res, 502, { error: `订阅地址请求失败：${err?.message || '未知错误'}` });
          return;
        }
        if (!r.ok) {
          sendJson(res, 502, { error: `订阅地址返回 HTTP ${r.status}` });
          return;
        }
        const channels = parseM3uPlaylist(r.text);
        const groups = [...new Set(channels.map((c) => c.group).filter(Boolean))].sort((a, b) =>
          a.localeCompare(b, 'zh')
        );
        const name = (r.text.match(/^#PLAYLIST:(.+)$/m) || [])[1]?.trim() || undefined;
        if (urlObj.searchParams.get('format') === 'm3u') {
          // 订阅导出：前端把这个地址直接当 .m3u 下载链接用
          const esc = (s) => String(s || '').replace(/"/g, "'");
          const lines = ['#EXTM3U'];
          if (name) lines.push(`#PLAYLIST:${name}`);
          for (const c of channels) {
            const attrs = [
              `tvg-id="${esc(c.tvgId || c.id)}"`,
              c.rawName ? `tvg-name="${esc(c.rawName)}"` : '',
              c.logo ? `tvg-logo="${esc(c.logo)}"` : '',
              `group-title="${esc(c.group || '')}"`,
            ]
              .filter(Boolean)
              .join(' ');
            lines.push(`#EXTINF:-1 ${attrs},${c.name}`);
            lines.push(c.url);
          }
          res.writeHead(200, {
            'Content-Type': 'audio/x-mpegurl; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(lines.join('\n'));
          return;
        }
        sendJson(res, 200, { name, channels, groups });
        return;
      }

      // 11. /api/live/epg
      if (pathname === '/api/live/epg') {
        const url = String(urlObj.searchParams.get('url') || '').trim();
        // 两个参数名都收：client-api 传 channel，部分打包产物传 tvgId
        const channelId = String(
          urlObj.searchParams.get('channel') || urlObj.searchParams.get('tvgId') || ''
        ).trim();
        if (!url) {
          sendJson(res, 400, { error: '缺少 url 参数' });
          return;
        }
        try {
          const r = await fetchBuffer(url, { timeoutMs: 15000 });
          let xmlBuf = r.buffer;
          if (url.endsWith('.gz') || (xmlBuf[0] === 0x1f && xmlBuf[1] === 0x8b)) {
            xmlBuf = zlib.gunzipSync(xmlBuf);
          }
          const programs = parseXmltvPrograms(decodeBuffer(xmlBuf, 'utf-8'), channelId);
          const now = Date.now();
          const current = programs.find((p) => p.start <= now && p.stop > now);
          const next = programs.find((p) => p.start > now);
          sendJson(res, 200, {
            channelId,
            ...(current ? { current } : {}),
            ...(next ? { next } : {}),
            programs,
          });
        } catch (err) {
          if (err instanceof HttpError) throw err;
          // 节目单拿不到不该打断直播：按时长空节目单降级
          sendJson(res, 200, { channelId, programs: [] });
        }
        return;
      }

      // 12. /api/live/probe
      if (pathname === '/api/live/probe') {
        const body = await readRequestBody(req, urlObj);
        const urls = [
          ...new Set(
            (Array.isArray(body.urls) ? body.urls : []).filter(
              (u) => typeof u === 'string' && /^https?:\/\//i.test(u)
            )
          ),
        ].slice(0, 50);
        const stream = urlObj.searchParams.get('stream') === '1';

        if (!stream) {
          // 非流式：前端 liveTest/批量测活一次拿整批
          const results = await Promise.all(urls.map((u) => probeLiveUrl(u)));
          sendJson(res, 200, { results });
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        const writeResult = (result) => {
          if (res.writableEnded || res.destroyed) return;
          try {
            res.write(JSON.stringify(result) + '\n');
          } catch {
            /* 客户端已断开 */
          }
        };
        await Promise.all(
          urls.map(async (u) => writeResult(await probeLiveUrl(u)))
        );
        res.end();
        return;
      }

      // 13. /api/quality
      if (pathname === '/api/quality') {
        const body = await readRequestBody(req, urlObj);
        const items = (Array.isArray(body.items) ? body.items : [])
          .filter(
            (it) =>
              it &&
              it.source &&
              typeof it.source.url === 'string' &&
              typeof it.id === 'string' &&
              it.id.length > 0
          )
          .slice(0, 50);
        const stream = urlObj.searchParams.get('stream') === '1';

        const probeItem = async (it) => {
          try {
            const sep = it.source.url.includes('?') ? '&' : '?';
            const detailRes = await fetchText(
              `${it.source.url}${sep}ac=videolist&ids=${encodeURIComponent(it.id)}`,
              { timeoutMs: 7000 }
            );
            const detail = parseCmsDetail(detailRes.text, it.source);
            const firstEp = detail.episodes[0];
            if (!firstEp) return { sourceKey: it.source.key, vodId: it.id };
            const m3uRes = await fetchText(firstEp, { timeoutMs: 6000 });
            const resMatches = [...m3uRes.text.matchAll(/RESOLUTION=(\d+)x(\d+)/gi)];
            if (resMatches.length > 0) {
              const maxH = Math.max(...resMatches.map((m) => parseInt(m[2], 10)));
              return { sourceKey: it.source.key, vodId: it.id, height: maxH };
            }
            // 没有 RESOLUTION = 测不出（单码率 m3u8/直链），不是失败
            return { sourceKey: it.source.key, vodId: it.id };
          } catch (err) {
            const isTimeout = err?.name === 'AbortError';
            return {
              sourceKey: it.source.key,
              vodId: it.id,
              error: err instanceof HttpError ? err.message : isTimeout ? '请求超时' : '探测失败',
            };
          }
        };

        if (!stream) {
          const results = await Promise.all(items.map(probeItem));
          sendJson(res, 200, { results });
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        // 首字节心跳：前端据此区分「请求没进应用」与「探测本身失败」
        res.write(JSON.stringify({ ping: true }) + '\n');
        const writeResult = (result) => {
          if (res.writableEnded || res.destroyed) return;
          try {
            res.write(JSON.stringify(result) + '\n');
          } catch {
            /* 客户端已断开 */
          }
        };
        await Promise.all(items.map(async (it) => writeResult(await probeItem(it))));
        res.end();
        return;
      }

      // 14. /api/proxy & /api/live/stream
      if (pathname.startsWith('/api/proxy') || pathname.startsWith('/api/live/stream')) {
        const isLiveStream = pathname.startsWith('/api/live/stream');
        let targetUrl = urlObj.searchParams.get('url') || '';
        if (!targetUrl) {
          const prefix = isLiveStream ? '/api/live/stream/' : '/api/proxy/';
          if (pathname.startsWith(prefix)) {
            try {
              targetUrl = decodeURIComponent(pathname.slice(prefix.length));
            } catch {
              sendJson(res, 400, { error: '无效的代理目标地址' });
              return;
            }
          }
        }
        if (!targetUrl) {
          sendJson(res, 400, { error: '缺少代理目标地址' });
          return;
        }
        // 前端去广告开关是 adFilter，旧调用方传 stripAds，两者同义
        const adFilter =
          urlObj.searchParams.get('adFilter') === '1' || urlObj.searchParams.get('stripAds') === '1';
        // 目标校验（协议白名单 + DNS 全量解析）+ 64MB 上限都在 fetchBuffer 内完成
        const r = await fetchBuffer(targetUrl, { timeoutMs: 15000, maxBytes: MAX_MEDIA_BYTES });
        const ct = r.contentType.toLowerCase();
        const looksLikeM3u8 =
          ct.includes('mpegurl') ||
          /\.m3u8(\?|$)/i.test(r.finalUrl) ||
          r.buffer.subarray(0, 16).toString('utf-8').startsWith('#EXTM3U');

        if (looksLikeM3u8) {
          const text = decodeBuffer(r.buffer, 'utf-8');
          const proxyPrefix = isLiveStream ? '/api/live/stream?url=' : '/api/proxy?url=';
          const rewritten = rewriteM3u8Urls(text, r.finalUrl, proxyPrefix, adFilter);
          res.writeHead(200, {
            'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(rewritten);
          return;
        }

        res.writeHead(r.status || 200, {
          'Content-Type': r.contentType || 'application/octet-stream',
          'Cache-Control': 'public, max-age=3600',
        });
        res.end(r.buffer);
        return;
      }

      // 15. /api/local-file —— 播放 Videos\QTV 里已缓存的文件（Range 是拖动进度条的前提）
      if (pathname === '/api/local-file') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { error: '只支持 GET/HEAD' });
          return;
        }
        const rawPath = String(urlObj.searchParams.get('path') || '');
        if (!rawPath) {
          sendJson(res, 400, { error: '缺少 path 参数' });
          return;
        }
        const { file, size } = resolveLocalFile(rawPath, resolvedVideos);
        const rangeHeader = String(req.headers.range || '').trim();
        // 只支持 bytes=start-end / bytes=start-；纯后缀（bytes=-N）与非法格式按不可满足处理
        const range = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
        const unsatisfiable = () => {
          res.writeHead(416, {
            'Content-Range': `bytes */${size}`,
            'Content-Type': 'text/plain; charset=utf-8',
          });
          res.end('Range Not Satisfiable');
        };
        if (rangeHeader && !range) {
          unsatisfiable();
          return;
        }
        let status = 200;
        let start = 0;
        let end = size - 1;
        if (range) {
          start = Number(range[1]);
          end = range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
          if (start >= size || end < start) {
            unsatisfiable();
            return;
          }
          status = 206;
        }
        const headers = {
          'Content-Type': 'video/mp4',
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
          'Content-Length': String(status === 206 ? end - start + 1 : size),
        };
        if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
        res.writeHead(status, headers);
        // HEAD 只要头；空文件没有可流的字节（createReadStream 的 end 会是 -1）
        if (req.method === 'HEAD' || size === 0) {
          res.end();
          return;
        }
        const stream = fs.createReadStream(file, { start, end });
        // 头已发出，读错误只能掐连接，回不了状态码
        stream.on('error', () => res.destroy());
        stream.pipe(res);
        return;
      }

      // 16. Static File Serving for Windows Desktop UI
      let relPath;
      try {
        relPath = decodeURIComponent(pathname);
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('bad path');
        return;
      }
      if (relPath === '/') relPath = '/index.html';
      // 解码后的 %2f/.. 不能被 path.join 归一化后带出 www 目录
      if (relPath.includes('\0') || relPath.split(/[\\/]+/).includes('..')) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }

      const candidates = [
        path.join(resolvedWww, relPath),
        path.join(resolvedWww, `${relPath}.html`),
        path.join(resolvedWww, relPath, 'index.html'),
      ];

      for (const candidate of candidates) {
        if (
          candidate.startsWith(resolvedWww + path.sep) &&
          fs.existsSync(candidate) &&
          fs.statSync(candidate).isFile()
        ) {
          const ext = path.extname(candidate).toLowerCase();
          res.writeHead(200, {
            'Content-Type': MIME_MAP[ext] || 'application/octet-stream',
            'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
          });
          fs.createReadStream(candidate).pipe(res);
          return;
        }
      }

      // Fallback 404
      const notFoundPage = path.join(resolvedWww, '404.html');
      if (fs.existsSync(notFoundPage)) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        fs.createReadStream(notFoundPage).pipe(res);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
      }
    } catch (err) {
      // 已经开流（NDJSON/代理）时响应头已发出，不能再回 JSON
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          /* 已断开 */
        }
        return;
      }
      // 出网校验失败按 4xx 语义回包（私有地址是 403，不是超时 502）
      const status = err instanceof HttpError ? err.status : 500;
      sendJson(res, status, { error: String(err?.message || 'Internal Server Error') });
    }
  });
}

// Allow direct CLI execution: `node windows/local-api-server.mjs [port]`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = parseInt(process.argv[2] || process.env.QTV_PORT || '18689', 10);
  const server = createLocalServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`QTV Windows Local Server listening on http://127.0.0.1:${port}`);
  });
}
