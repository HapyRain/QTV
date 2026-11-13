'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Artplayer from 'artplayer';
import Hls, { type HlsConfig } from 'hls.js';

import { PlaybackRecovery, describeHlsError } from '@/lib/playback-recovery';
import { createHlsLoader } from '@/lib/hls-loader';
import {
  getVideoPrefetcher,
  getNextEpisodePrefetcher,
} from '@/lib/video-prefetcher';
import { attachVolumeBoost, type VolumeBoostHandle } from '@/lib/volume-boost';
import { CONTROL_SHOW_CLASS, syncMiniProgressBar } from '@/lib/mini-progress-bar';
import { loadCacheSettings } from '@/lib/video-cache';
import { cn, formatTime } from '@/lib/utils';
import { prefersTouchPointer } from '@/lib/touch-pointer';
import { createTapArbiter, decideGestureAxis } from '@/lib/touch-gestures';
import {
  findActiveSegment,
  findCrossedEnding,
  resolveSegments,
  SEGMENT_COLORS,
  SEGMENT_LABELS,
  type ResolvedSegment,
  type SkipMark,
  type SkipSegment,
} from '@/lib/skip-marks';
import {
  ART_DEFAULT_CONTROL_HIDE_MS,
  DESKTOP_CONTROL_HIDE_MS,
  TOUCH_CONTROL_HIDE_MS,
} from '@/lib/control-hide';

/** 片段时间统一保留 1 位小数：与面板展示保持一致，避免浮点尾巴 */
const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * 播放器 → 原生桥（/api/player-state，本地 App 壳承接）：
 * 播放/暂停 → 全屏沉浸式系统栏显隐；亮度/音量 → 系统设置。
 * 浏览器里该请求 404/失败，静默忽略，无副作用。
 */
export function sendPlayerState(params: { paused?: boolean; brightness?: number; volume?: number; fullscreen?: boolean }): void {
  try {
    const q = new URLSearchParams();
    if (params.paused !== undefined) q.set('paused', params.paused ? '1' : '0');
    if (params.brightness !== undefined) q.set('brightness', params.brightness.toFixed(3));
    if (params.volume !== undefined) q.set('volume', params.volume.toFixed(3));
    if (params.fullscreen !== undefined) q.set('fullscreen', params.fullscreen ? '1' : '0');
    void fetch(`/api/player-state?${q.toString()}`).catch(() => undefined);
  } catch {
    /* 忽略 */
  }
}

/** App 壳当前真实的亮度/音量（0..1）；负数或读取失败 → null（浏览器 / 老壳） */
export interface NativePlayerState {
  brightness: number | null;
  volume: number | null;
}

const known = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(1, Math.max(0, v)) : null;

/** 读取 App 壳的亮度/音量。浏览器里该路由不存在 → 返回 null，静默降级 */
export async function readPlayerState(): Promise<NativePlayerState | null> {
  try {
    const res = await fetch('/api/player-state?read=1', { cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as { brightness?: unknown; volume?: unknown };
    const brightness = known(body?.brightness);
    const volume = known(body?.volume);
    if (brightness === null && volume === null) return null;
    return { brightness, volume };
  } catch {
    return null;
  }
}

/**
 * 播放器外壳：ArtPlayer + hls.js（旧版 player.js 的 React 化）。
 * 保留：广告分片过滤、自动连播回调、进度回调、快捷键、移动端长按倍速、错误恢复。
 * 移除：DOM 手工操作、watch.html 跳转链、localStorage 状态总线。
 *
 * 关键设计：ArtPlayer 实例只在挂载时创建一次，换集（url 变化）只「切换 HLS 源」
 * 而不销毁重建。否则在「网页全屏（页面全屏）」下整实例重建会丢失全屏上下文、
 * 重建 <video> 元素，触发「黑屏有声」的渲染竞态。
 */

/** 暴露给播放页的读取接口：「记录当前」需要比 5s 节流进度回调更精确的位置 */
export interface PlayerSkipApi {
  getCurrentTime(): number;
  getDuration(): number;
  /** 跳转到指定位置（「试跳」/标记片段起点用） */
  seek(seconds: number): void;
  /** 暂停播放：记录标记前先定格，避免点击到读取之间视频继续走 */
  pause(): void;
  /** 当前是否处于暂停状态 */
  isPaused(): boolean;
}

interface PlayerShellProps {
  url: string;
  title: string;
  adFilter: boolean;
  autoplayNext: boolean;
  /** 当前剧的跳过片段标记（父级按归一化剧名查好后传入，换集/换源不变） */
  skipMark?: SkipMark;
  /**
   * 自动跳过标记的片段：片头/中段跳到片段末尾，片尾（连续播放越过起点）结束本集。
   * 是否连播下一集仍由 autoplayNext 决定。
   */
  autoSkipSegments: boolean;
  /**
   * 音量放大（Web Audio 增益链）：默认 false。
   * 关闭时完全不接入音频链路；播放中改开关由 setBoost 走「直通/增益」切换。
   */
  volumeBoost: boolean;
  /**
   * 底部细进度条（默认 true）：控制栏收起后是否在画面底边常驻一条 3px 进度线。
   * 关闭后收起即完全隐藏。类名同步见 lib/mini-progress-bar.ts。
   */
  miniProgressBar?: boolean;
  /** 中段两步态的起点：由页面层持有，面板与快捷键共用同一份状态 */
  pendingStart: number | null;
  /** 更新中段起点；null 表示取消或已消费 */
  onPendingStart: (start: number | null) => void;
  /** 播放器创建/销毁时回调，供播放页读取精确播放位置 */
  onPlayerApi?: (api: PlayerSkipApi | null) => void;
  /** 快捷键（Shift+I/O/S/E）记录片段时回调，由父级做校验与写入 */
  onRecordSegment?: (segment: SkipSegment) => void;
  /** 剧集标识 `${source}:${vodId}:${episodeIndex}`（片段缓存按集淘汰的分组键） */
  episodeKey?: string;
  /** 下一集 m3u8 地址：当前集预取完成后预热下一集前 7 分钟 */
  nextUrl?: string;
  nextEpisodeKey?: string;
  /** 进度恢复：优先 URL position，其次查询该回调（返回 0 表示无记录） */
  getRestorePosition?: () => number | Promise<number>;
  onTimeUpdate?: (position: number, duration: number) => void;
  onEnded?: () => void;
  onPause?: (position: number, duration: number) => void;
  /**
   * 实测画质（视频高度，像素）。
   * 单码率 m3u8 / 直链的分辨率只能等解码后才知道，播放一次后回写缓存，
   * 下次搜索同一部剧就能直接显示画质，不必再探测。
   */
  onQuality?: (height: number) => void;
  /** 恢复策略判源不可用（重试耗尽/格式硬失败）时回调：父级弹出换源面板 */
  onRequestSwitchSource?: (reason: string) => void;
  /** 控制条上的上一集 / 下一集：不在播放器里也能切集，省得回到页面按钮 */
  onPrevEpisode?: () => void;
  onNextEpisode?: () => void;
  hasPrevEpisode?: boolean;
  hasNextEpisode?: boolean;
}

export function PlayerShell({
  url,
  title,
  adFilter,
  autoplayNext,
  skipMark,
  autoSkipSegments,
  volumeBoost,
  miniProgressBar = true,
  pendingStart,
  onPendingStart,
  onPlayerApi,
  onRecordSegment,
  episodeKey,
  nextUrl,
  nextEpisodeKey,
  getRestorePosition,
  onTimeUpdate,
  onEnded,
  onPause,
  onQuality,
  onRequestSwitchSource,
  onPrevEpisode,
  onNextEpisode,
  hasPrevEpisode,
  hasNextEpisode,
}: PlayerShellProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const artRef = useRef<any>(null);
  const hlsRef = useRef<Hls | null>(null);
  const volumeBoostRef = useRef<VolumeBoostHandle | null>(null);
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  // 全屏侧滑手势指示器（左亮度/右音量）：跟手显示，松手淡出
  const [gestureUi, setGestureUi] = useState<{
    mode: 'brightness' | 'volume';
    value: number;
    visible: boolean;
  } | null>(null);
  // 起播前的品牌占位图（沿用旧版 nomedia 素材），实际开始播放后隐藏
  const [showPoster, setShowPoster] = useState(true);
  // 全屏覆盖层（亮度/音量 HUD、提示、跳过按钮）必须挂进 ArtPlayer 的 $player：
  // 元素全屏 / 网页全屏时只有全屏元素子树会被渲染，挂在 React 外层容器里会整组消失
  const [overlayHost, setOverlayHost] = useState<HTMLDivElement | null>(null);
  // App 壳当前的亮度/音量（0..1）。null = 浏览器，没有原生桥可读
  const nativeStateRef = useRef<NativePlayerState | null>(null);
  // 全屏横滑跳进度的预览（与亮度/音量 HUD 互斥，同一时刻只会有一个）
  const [seekUi, setSeekUi] = useState<{ target: number; duration: number } | null>(null);
  const seekUiTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 始终持有最新 props/回调，避免重建播放器
  const propsRef = useRef({
    url, title, adFilter, autoplayNext, skipMark, autoSkipSegments, volumeBoost, miniProgressBar,
    pendingStart, onPendingStart, onPlayerApi, onRecordSegment,
    episodeKey, nextUrl, nextEpisodeKey,
    getRestorePosition, onTimeUpdate, onEnded, onPause, onQuality, onRequestSwitchSource,
    onPrevEpisode, onNextEpisode, hasPrevEpisode, hasNextEpisode,
  });
  propsRef.current = {
    url, title, adFilter, autoplayNext, skipMark, autoSkipSegments, volumeBoost, miniProgressBar,
    pendingStart, onPendingStart, onPlayerApi, onRecordSegment,
    episodeKey, nextUrl, nextEpisodeKey,
    getRestorePosition, onTimeUpdate, onEnded, onPause, onQuality, onRequestSwitchSource,
    onPrevEpisode, onNextEpisode, hasPrevEpisode, hasNextEpisode,
  };

  /** 上报实测画质：多次上报取大值由调用方决定，这里只管把拿到的高度传出去 */
  const reportQuality = (height: number) => {
    if (height > 0) propsRef.current.onQuality?.(height);
  };

  // 跨集共享、每次换集重置的播放链路状态
  // 媒体健康度：音频轨可播不代表视频轨正常（「黑屏但有声」的假死态）。
  // 仅当有分片真正进入 MSE buffer 后才视为恢复，错误遮罩才能被清除。
  const mediaHealthyRef = useRef(true);
  const playbackStartedRef = useRef(false);
  // 起播阶段的 video 元素级错误允许自愈重试一次（重建 hls/MSE）
  const videoErrorRetryUsedRef = useRef(false);
  // 进度恢复每集只执行一次（MANIFEST_PARSED 可能因代理回退再次触发）
  const restoredRef = useRef(false);
  // 某些 HLS 源在 MANIFEST_PARSED 时 duration 仍未就绪，延迟到媒体元数据可用后恢复
  const restoreCleanupRef = useRef<(() => void) | null>(null);
  // timeupdate 续跑预取的游标：必须按集清零，否则会沿用上一集的时间戳推迟首次续跑
  const lastPrefetchEnsureRef = useRef(0);
  // setupHls 可能改走代理形式，video:error 重试要用最近一次的地址
  const currentMediaUrlRef = useRef(url);
  // 本集的恢复策略实例：跨直连/代理两级重建共享计数
  const recoveryRef = useRef<PlaybackRecovery | null>(null);
  // 自然播完标记，卸载时不回写进度（避免覆盖「已看完」记录）
  const endedRef = useRef(false);
  // 跳过片段：每集已处理的片段（按 type:start 去重），换集时重置（见 loadEpisode）
  const handledSegmentsRef = useRef<Set<string>>(new Set());
  // 被「撤销」过的片段：本集不再自动跳（否则撤回到片段内会被立刻再跳走），但仍保留提示按钮
  const suppressedAutoRef = useRef<Set<string>>(new Set());
  // 上一次 timeupdate 的位置：用于区分「连续播放越过片尾」与「拖动进度条」
  const lastSampleRef = useRef(0);
  // 跳过按钮提示；用 ref 比较，避免 timeupdate 每 250ms 触发重渲染
  const [skipPrompt, setSkipPrompt] = useState<ResolvedSegment | null>(null);
  const skipPromptRef = useRef<ResolvedSegment | null>(null);
  // 刚跳过的片段：给一个撤销窗口，误标导致跳掉正片时不必手动拖回去
  const [undoSkip, setUndoSkip] = useState<{ from: number; segment: ResolvedSegment } | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showHint = (text: string) => {
    setHint(text);
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setHint(''), 2500);
  };

  // 片段缓存开启时调大 hls.js 自身缓冲，缓冲之外的空窗由预取器补齐
  const buildHlsConfig = (): Partial<HlsConfig> => {
    const p = propsRef.current;
    const cacheSettings = loadCacheSettings();
    const cacheEnabled = cacheSettings.enabled && !!p.episodeKey;
    return {
      debug: false,
      enableWorker: true,
      backBufferLength: 90,
      maxBufferLength: cacheEnabled ? 120 : 30,
      maxMaxBufferLength: cacheEnabled ? 600 : 60,
      maxBufferSize: (cacheEnabled ? 90 : 30) * 1000 * 1000,
      maxBufferHole: 0.5,
      fragLoadingMaxRetry: 6,
      fragLoadingRetryDelay: 1000,
      manifestLoadingMaxRetry: 3,
      manifestLoadingRetryDelay: 1000,
      startLevel: -1,
      abrEwmaDefaultEstimate: 500_000,
      appendErrorMaxRetry: 5,
      // 组合 loader：广告过滤（blockAd 随设置）+ 片段缓存命中（cacheEnabled）
      loader: createHlsLoader(Hls, { blockAd: p.adFilter }) as unknown as HlsConfig['loader'],
    };
  };

  // 当前集预取（episodeKey 缺省 = 关闭，见 ensure 内部 settings.enabled 判断）
  const ensurePrefetch = (mediaUrl: string, currentTime: number, horizonSeconds?: number) => {
    const p = propsRef.current;
    if (!p.episodeKey) return;
    getVideoPrefetcher().ensure({
      m3u8Url: mediaUrl,
      currentTime,
      episodeKey: p.episodeKey,
      horizonSeconds,
      onProgress: (stats) => {
        // 当前集预取完成且存在下一集：用独立预取器预热下一集前 7 分钟
        if (stats.state === 'done' && p.nextUrl && p.nextEpisodeKey) {
          getNextEpisodePrefetcher().ensure({
            m3u8Url: p.nextUrl,
            currentTime: 0,
            episodeKey: p.nextEpisodeKey,
            horizonSeconds: 420,
          });
        }
      },
    });
  };

  /** 切换提示状态；值相同直接返回，避免 timeupdate 高频 setState */
  const updateSkipPrompt = (next: ResolvedSegment | null) => {
    const prev = skipPromptRef.current;
    const same =
      prev === next ||
      (prev !== null &&
        next !== null &&
        prev.type === next.type &&
        prev.start === next.start &&
        prev.end === next.end);
    if (same) return;
    skipPromptRef.current = next;
    setSkipPrompt(next);
  };

  /** 片段去重键：按类型 + 起点，同一集内每段只处理一次 */
  const segmentKey = (s: ResolvedSegment) => `${s.type}:${s.start}`;

  /** 进度条区间可视化：在进度条轨道叠加半透明色带（颜色与面板图例共用 SEGMENT_COLORS） */
  const renderSkipMarks = () => {
    const art = artRef.current;
    const progress = art?.template.$progress;
    if (!progress) return;
    progress.querySelectorAll('[data-skip-segment]').forEach((el: Element) => el.remove());
    const duration = art.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const segments = resolveSegments(propsRef.current.skipMark, duration);
    for (const seg of segments) {
      const el = document.createElement('div');
      el.dataset.skipSegment = '1';
      el.title = `跳过${SEGMENT_LABELS[seg.type]}`;
      const left = (seg.start / duration) * 100;
      const width = Math.max(0.4, ((seg.end - seg.start) / duration) * 100);
      el.style.cssText = `position:absolute;left:${left}%;width:${width}%;top:0;bottom:0;background:${SEGMENT_COLORS[seg.type]};pointer-events:none;`;
      progress.appendChild(el);
    }
  };

  /**
   * 跳到片段末尾并续跑预取；同步 lastSampleRef，避免下一拍被误判为「连续越过片尾」。
   * 返回是否成功：媒体未就绪导致赋值失败时返回 false，调用方不置已处理标记，
   * 下一次 timeupdate 会重新判定（保证「可重试」）。
   */
  const skipTo = (seconds: number): boolean => {
    const art = artRef.current;
    if (!art || !Number.isFinite(seconds) || seconds < 0) return false;
    try {
      art.currentTime = seconds;
    } catch {
      return false;
    }
    lastSampleRef.current = seconds;
    ensurePrefetch(currentMediaUrlRef.current, seconds);
    return true;
  };

  /** 记录一次跳过（跳转前的位置）：给 12s 撤销窗口，误标导致跳掉正片时不用手动拖回去 */
  const rememberSkip = (from: number, segment: ResolvedSegment) => {
    setUndoSkip({ from, segment });
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = setTimeout(() => setUndoSkip(null), 12_000);
  };

  const undoLastSkip = () => {
    const last = undoSkip;
    if (!last) return;
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    // 撤销后把片段从「已处理」移除（按钮会重新出现），同时本集不再自动跳它：
    // 否则回到片段内会被下一次 timeupdate 立刻再跳走，形成"撤销→又被跳过"的死循环
    handledSegmentsRef.current.delete(segmentKey(last.segment));
    suppressedAutoRef.current.add(segmentKey(last.segment));
    skipTo(last.from);
    setUndoSkip(null);
    showHint('已撤回跳过');
  };

  /**
   * 跳过片尾：与自然播完共用 onEnded 链路（清进度 + 依 autoplayNext 连播下一集）。
   * endedRef 置 true 同时阻止 video:ended 重复回调，也避免卸载时把片尾进度回写。
   */
  const finishBySkip = (ending?: ResolvedSegment) => {
    const art = artRef.current;
    if (ending) handledSegmentsRef.current.add(segmentKey(ending));
    endedRef.current = true;
    updateSkipPrompt(null);
    setUndoSkip(null);
    try {
      art?.pause();
    } catch {
      /* 忽略 */
    }
    showHint('已跳过片尾');
    propsRef.current.onEnded?.();
  };

  /**
   * 初始化/切换 HLS。allowProxyFallback：直连致命网络错误（CORS/防盗链/分片被拒）时，
   * 自动改走同源 cookie 鉴权的 /api/proxy 重试一次。
   * 注意：不销毁 ArtPlayer，只销毁并重建 hls，从而保留网页全屏等播放器状态。
   */
  const setupHls = (video: HTMLVideoElement, mediaUrl: string, allowProxyFallback: boolean) => {
    restoreCleanupRef.current?.();
    restoreCleanupRef.current = null;
    hlsRef.current?.destroy();
    hlsRef.current = null;
    currentMediaUrlRef.current = mediaUrl;

    let restoreInFlight = false;
    const restoreAndStart = async () => {
      if (restoredRef.current || restoreInFlight) return;

      // MANIFEST_PARSED 早于 loadedmetadata 的 HLS 源很常见；没有有效时长时
      // 先不消费 restoredRef，等 loadedmetadata/durationchange 后再重试。
      const duration = artRef.current?.duration || video.duration || 0;
      if (!Number.isFinite(duration) || duration <= 0) return;

      restoreInFlight = true;
      try {
        const saved = (await propsRef.current.getRestorePosition?.()) ?? 0;
        const currentDuration = artRef.current?.duration || video.duration || duration;
        let prefetchAnchor = video.currentTime;
        if (saved > 10 && Number.isFinite(currentDuration) && saved < currentDuration - 2) {
          if (artRef.current) artRef.current.currentTime = saved;
          prefetchAnchor = saved;
          showHint(`已从 ${formatTime(saved)} 继续播放`);
        }
        restoredRef.current = true;
        restoreCleanupRef.current?.();
        restoreCleanupRef.current = null;
        ensurePrefetch(mediaUrl, prefetchAnchor);
        video.play().catch(() => {});
      } catch {
        // IndexedDB 读取失败时不阻塞播放，后续事件仍可再次尝试恢复。
      } finally {
        restoreInFlight = false;
      }
    };

    const restoreEvents = ['loadedmetadata', 'durationchange', 'canplay'] as const;
    const onRestoreEvent = () => { void restoreAndStart(); };
    restoreEvents.forEach((event) => video.addEventListener(event, onRestoreEvent));
    restoreCleanupRef.current = () => {
      restoreEvents.forEach((event) => video.removeEventListener(event, onRestoreEvent));
    };

    // iOS WKWebView 原生 HLS 路径：当 MSE (Hls.isSupported()) 不可用时，走系统 WebKit 硬件解码，
    // 若开启去广告则通过本地 /api/proxy?adFilter=1 剥离广告分片并重写相对路径
    if (!Hls.isSupported() && video.canPlayType("application/vnd.apple.mpegurl")) {
      const targetSrc =
        propsRef.current.adFilter && !mediaUrl.startsWith("/api/proxy")
          ? `/api/proxy?url=${encodeURIComponent(mediaUrl)}&adFilter=1`
          : mediaUrl;
      currentMediaUrlRef.current = targetSrc;
      const onNativeErr = () => {
        video.removeEventListener("error", onNativeErr);
        if (allowProxyFallback && !targetSrc.startsWith("/api/proxy")) {
          showHint("直连受限，改用代理重试...");
          setupHls(video, `/api/proxy?url=${encodeURIComponent(mediaUrl)}&adFilter=${propsRef.current.adFilter ? "1" : "0"}`, false);
        }
      };
      video.addEventListener("error", onNativeErr);
      video.src = targetSrc;
      video.load();
      video.play().catch(() => {});
      return;
    }

    const hls = new Hls(buildHlsConfig());
    hlsRef.current = hls;
    hls.loadSource(mediaUrl);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      recoveryRef.current?.markHealthy();
      // master playlist 的档位高度：多码率源在这里就能拿到上限
      const heights = hls.levels
        .map((level) => level.height)
        .filter((h): h is number => typeof h === 'number' && h > 0);
      if (heights.length > 0) reportQuality(Math.max(...heights));
      // 进度恢复改由 restoreAndStart 处理：duration 未就绪时不消费标记，挂事件重试
      void restoreAndStart();
    });
    // 播放链路恢复（FRAG_LOADED / MANIFEST_PARSED）：静默窗外清零连续失败计数
    hls.on(Hls.Events.FRAG_LOADED, () => recoveryRef.current?.markHealthy());
    // 单码率源在 MANIFEST 阶段拿不到 height（清单尚未解析），这里补一次。
    // 注意 data.level 是档位下标，分辨率在 levelInfo 上
    hls.on(Hls.Events.LEVEL_LOADED, (_evt, data) => {
      const height = data.levelInfo?.height;
      if (typeof height === 'number') reportQuality(height);
    });
    // 分片真正进入 MSE buffer 才算媒体恢复：此时视频轨可渲染，错误态可解除
    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      mediaHealthyRef.current = true;
    });

    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (!data.fatal) return;
      const recovery = recoveryRef.current;
      if (!recovery) return;
      const decision = recovery.onFatal(data.type, data.details);
      switch (decision.action) {
        case 'ignore':
          break;
        case 'retry': {
          // 前两次重试保留直连；达到退避阈值或清单级错误时升级为代理形式
          // （同源 cookie 鉴权，规避 CORS/防盗链/分片被拒）
          if (
            allowProxyFallback &&
            !mediaUrl.startsWith('/api/proxy') &&
            (decision.attempt >= 2 || data.details === 'manifestLoadError')
          ) {
            showHint('直连失败，改用代理重试...');
            setupHls(video, `/api/proxy?url=${encodeURIComponent(mediaUrl)}`, false);
            return;
          }
          showHint(`${decision.reason}（第 ${decision.attempt} 次）...`);
          recovery.schedule(decision.delayMs, () => hls.startLoad());
          break;
        }
        case 'recover-media': {
          showHint(`${decision.reason}（第 ${decision.attempt} 次）...`);
          if (decision.swapAudio) hls.swapAudioCodec?.();
          hls.recoverMediaError();
          break;
        }
        case 'switch-source': {
          // 覆盖播放开始后的场景：起播失败走 setError 遮罩；
          // 播放中失败走回调弹换源面板（父级未提供回调时同样 setError）
          const message = `${describeHlsError(data.type, data.details)}：${decision.reason}`;
          if (playbackStartedRef.current) {
            showHint(message);
            propsRef.current.onRequestSwitchSource?.(decision.reason);
          } else {
            setError(`视频加载失败，${message}，请尝试其他视频源`);
          }
          break;
        }
      }
    });
  };

  /** 换集：重置每集状态并切换到新 HLS 源（不重建 ArtPlayer）。 */
  const loadEpisode = (targetUrl: string) => {
    if (!targetUrl) return;
    mediaHealthyRef.current = true;
    playbackStartedRef.current = false;
    videoErrorRetryUsedRef.current = false;
    restoredRef.current = false;
    lastPrefetchEnsureRef.current = 0;
    // 跳过片段按集重置：上一集已处理过不意味新一集也处理过
    handledSegmentsRef.current.clear();
    suppressedAutoRef.current.clear();
    lastSampleRef.current = 0;
    endedRef.current = false;
    updateSkipPrompt(null);
    setUndoSkip(null);
    recoveryRef.current = new PlaybackRecovery();
    // 换集时清掉上一集的预取窗口，避免带宽被旧集占用
    getVideoPrefetcher().stop();
    setError('');
    setShowPoster(true);
    const art = artRef.current;
    if (!art) return;
    setupHls(art.video, targetUrl, true);
  };

  // —— 创建播放器（仅一次，挂载即创建） ——
  useEffect(() => {
    if (!containerRef.current || !propsRef.current.url) return;
    const initialUrl = propsRef.current.url;
    // ArtPlayer 默认 3 秒才隐藏控制栏；桌面失去鼠标悬停后缩短为 0.8 秒。
    // 触屏没有 hover，自动隐藏会让按钮来不及点（issue #937）：改为常驻，
    // 由「点按视频 toggle」收起。CONTROL_HIDE_TIME 是 static，创建后修改立即生效。
    const touchPointer = prefersTouchPointer();
    Artplayer.CONTROL_HIDE_TIME = touchPointer ? TOUCH_CONTROL_HIDE_MS : DESKTOP_CONTROL_HIDE_MS;

    // 初始化每集状态
    mediaHealthyRef.current = true;
    playbackStartedRef.current = false;
    videoErrorRetryUsedRef.current = false;
    restoredRef.current = false;
    recoveryRef.current = new PlaybackRecovery();
    endedRef.current = false;
    handledSegmentsRef.current.clear();
    suppressedAutoRef.current.clear();
    lastSampleRef.current = 0;

    let lastSave = 0;

    const art = new Artplayer({
      container: containerRef.current,
      url: initialUrl,
      type: 'm3u8',
      volume: 0.8,
      autoplay: true,
      pip: true,
      autoMini: true,
      screenshot: true,
      setting: true,
      playbackRate: true,
      aspectRatio: true,
      fullscreen: true,
      fullscreenWeb: true,
      // 恒传 true，不跟设置项走：库的 miniProgressBar 插件只在构造时注册、运行时不可换，
      // 而它正是「控制栏显示时摘掉 art-mini-progress-bar」的唯一维护者。设置项只负责
      // 「关掉时不保留类名」（见下方 control 监听 + 开关变化的 useEffect）。
      // 若这里按设置传 false，播放中把开关拨回「开」就没人再管这个类名，只能手动挂类，
      // 而挂上去就会常驻——同组 CSS 会连带关掉底部渐变遮罩与进度圆点（实测过）。
      miniProgressBar: true,
      mutex: true,
      backdrop: true,
      playsInline: true,
      airplay: true,
      hotkey: false,
      // 关闭库自带的「视频上横滑跳进度」：它和我们全屏竖滑（亮度/音量）共用同一个
      // 视频面，斜向拖动会两边都触发（竖滑带横移就跳进度、横滑带上浮就改亮度）。
      // 下面用 decideGestureAxis 统一做轴向互斥，横滑跳进度由我们自己接管。
      gesture: false,
      theme: '#4cc9f0',
      lang: navigator.language.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en',
      moreVideoAttr: { crossOrigin: 'anonymous', playsInline: true },
      // 上/下集放在播放键右侧：换集是看剧最高频的动作，不该让用户滚回页面下方找按钮
      controls: [
        {
          name: 'prev-episode',
          index: 11,
          position: 'left',
          html: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"><path fill="currentColor" d="M6 6h2v12H6V6zm3.5 6l8.5 6V6l-8.5 6z"/></svg>',
          tooltip: '上一集',
          click: () => {
            if (propsRef.current.hasPrevEpisode) propsRef.current.onPrevEpisode?.();
          },
        },
        {
          name: 'next-episode',
          index: 12,
          position: 'left',
          html: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"><path fill="currentColor" d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>',
          tooltip: '下一集',
          click: () => {
            if (propsRef.current.hasNextEpisode) propsRef.current.onNextEpisode?.();
          },
        },
      ],
      customType: {
        m3u8: (video: HTMLVideoElement, mediaUrl: string) => {
          setupHls(video, mediaUrl, true);
        },
      },
    });
    artRef.current = art;

    // 覆盖层宿主：挂进 $player，全屏（元素全屏 / fullscreenWeb）时随全屏子树一起渲染。
    // 放在 React 外层容器里的话，全屏后亮度/音量 HUD、快进提示、跳过按钮全都会消失。
    const overlayHost = document.createElement('div');
    overlayHost.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:30;';
    art.template.$player.appendChild(overlayHost);
    setOverlayHost(overlayHost);
    // 进页面先读一次壳里的真实亮度/音量，手势起始值不再瞎猜 0.5
    void readPlayerState().then((state) => {
      nativeStateRef.current = state;
    });

    // 音量放大：起播后（src 已就绪）才挂 Web Audio 增益图，避免空 src / CORS 误判。
    // 默认关闭（设置项 volumeBoost）：不接入时完全不碰音频链路。
    // 纯附加：不改动 ArtPlayer 的 volume/滑块/快捷键；失败时原样播放。
    art.on('video:playing', () => {
      if (!propsRef.current.volumeBoost) return;
      if (!volumeBoostRef.current) {
        volumeBoostRef.current = attachVolumeBoost(art.video);
      }
    });

    // 底部细进度条：库插件先按 control 事件挂/摘类，我们紧随其后把类名收敛到
    // 「设置开启 且 控制栏已收起」这一个目标态。本监听注册在构造之后，同一次事件里
    // 跑在插件处理器后面，所以关闭态下刚挂上的类会立刻被摘掉，收起后什么都不留。
    art.on('control', (show: boolean) => {
      syncMiniProgressBar(art.template?.$player?.classList, {
        enabled: propsRef.current.miniProgressBar,
        controlsShown: show,
      });
    });

    // 进度条区间可视化：初始渲染一次，换集 duration 变化时重绘
    renderSkipMarks();
    art.on('video:durationchange', renderSkipMarks);
    // 全屏切换 / 播放器尺寸变化会重建控件，色带随之被清掉，这里补一次重绘
    art.on('fullscreen', renderSkipMarks);
    art.on('fullscreenWeb', renderSkipMarks);
    art.on('resize', renderSkipMarks);

    // —— 触屏全屏 = 传统横屏全屏 ——
    // Android/桌面：元素全屏成功后锁横屏（规范要求只能在全屏态内锁定，失败静默——
    // iOS/桌面浏览器/WebView 不支持时保持系统方向，画面由 object-fit: contain 等比适配）。
    // iOS Safari：不支持对非 <video> 元素做元素全屏，screenfull 会走 error →
    // 退回原生视频全屏（webkitEnterFullscreen：自动旋转、传统控制条，即 iOS 的标准全屏）。
    if (touchPointer) {
      art.on('fullscreen', (state: boolean) => {
        try {
          // TS 的 lib.dom 未声明实验性的 ScreenOrientation.lock：按结构化能力探测
          const orient = screen.orientation as ScreenOrientation & {
            lock?: (orientation: string) => Promise<void>;
          };
          if (state) {
            const p = orient.lock?.('landscape');
            if (p && typeof p.catch === 'function') p.catch(() => { /* 不支持：保持系统方向 */ });
          } else {
            orient.unlock?.();
          }
        } catch { /* 部分实现不完整：忽略 */ }
      });
      art.on('fullscreenError', () => {
        try {
          const video = art.video as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | undefined;
          video?.webkitEnterFullscreen?.();
        } catch { /* 无该能力：维持原状 */ }
      });
    }

    /**
     * 倍速跨集保持（issue #955）。
     *
     * 换源会让媒体元素重新走一遍 load 算法，而该算法只动一个播放属性：
     * `playbackRate = defaultPlaybackRate`。所以只要让 defaultPlaybackRate 始终
     * 等于用户选的倍速，这次「归位」就变成空操作——而且一次覆盖全部重载路径：
     * 换集、直连失败转代理、video:error 重建，以及 hls.js 内部
     * recoverMediaError 的 detach/attach（那条路径不经过 setupHls，只在
     * loadEpisode 里补写 playbackRate 是够不着的）。
     *
     * 判断依据：归位时新值必然等于 defaultPlaybackRate，跳过即可。必须跳过——
     * 归位确实会派发 ratechange，无差别同步会把默认值自己写成 1，机制当场失效。
     */
    art.on('video:ratechange', () => {
      const video = art.video;
      if (video && video.playbackRate !== video.defaultPlaybackRate) {
        video.defaultPlaybackRate = video.playbackRate;
      }
    });

    // 播放页「记录当前」需要精确时间：不能依赖 5s 节流的 onTimeUpdate
    propsRef.current.onPlayerApi?.({
      getCurrentTime: () => {
        const current = artRef.current?.currentTime;
        return typeof current === 'number' && Number.isFinite(current) ? current : 0;
      },
      getDuration: () => {
        const duration = artRef.current?.duration;
        return typeof duration === 'number' && Number.isFinite(duration) ? duration : 0;
      },
      seek: (seconds) => {
        if (!Number.isFinite(seconds) || seconds < 0) return;
        try {
          artRef.current.currentTime = seconds;
        } catch {
          /* 忽略 */
        }
      },
      pause: () => {
        try {
          artRef.current?.pause();
        } catch {
          /* 忽略 */
        }
      },
      isPaused: () => artRef.current?.video?.paused ?? true,
    });

    /**
     * 读解码后的真实分辨率。
     * 单码率 m3u8 / mp4 直链的清单里没有画质字段，服务端无论如何探测不到，
     * 只有 video 元素的 videoHeight 是真的——这是「播放一次即记住画质」链路的唯一数据源。
     * loadedmetadata 在部分浏览器上 videoHeight 仍为 0，因此 resize / canplay / playing
     * 各补一次机会，不能只赌单一事件时机。
     */
    const reportVideoHeight = () => {
      const height = art.video?.videoHeight;
      if (typeof height === 'number' && height > 0) reportQuality(height);
    };
    art.on('video:loadedmetadata', reportVideoHeight);
    art.on('video:canplay', reportVideoHeight);
    // resize 不在 ArtPlayer 的视频事件转发表里，直接挂原生事件
    art.video?.addEventListener('resize', reportVideoHeight);

    art.on('video:loadedmetadata', () => {
      // ArtPlayer 运行时支持 title 选项（类型定义未覆盖），用于界面标题展示
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (art as any).title = propsRef.current.title;
      } catch { /* 忽略 */ }
    });

    art.on('video:playing', () => {
      // 原生桥：恢复播放 → 全屏沉浸（藏系统栏）
      sendPlayerState({ paused: false });
      playbackStartedRef.current = true;
      setShowPoster(false);
      // 仅在媒体真正恢复（有分片进入 buffer）后清错误遮罩：
      // 否则「视频轨挂了、音频轨先播出来」时会清掉遮罩，留下黑屏假死态
      if (mediaHealthyRef.current) setError('');
      reportVideoHeight();
    });
    art.on('video:error', () => {
      mediaHealthyRef.current = false;
      // 起播阶段的 video 元素级错误（MSE/解码偶发失败）：重建一次播放链路自愈，
      // 而不是直接钉死错误遮罩——重建后视频轨重新 append，黑屏有声即可解除
      if (!playbackStartedRef.current && !videoErrorRetryUsedRef.current) {
        videoErrorRetryUsedRef.current = true;
        showHint('播放异常，正在重试...');
        setupHls(art.video, currentMediaUrlRef.current, true);
        return;
      }
      setError('视频播放失败，请尝试其他视频源');
    });
    art.on('video:timeupdate', () => {
      const now = Date.now();
      if (now - lastSave > 5000) {
        lastSave = now;
        propsRef.current.onTimeUpdate?.(art.currentTime, art.duration);
      }
      // 每 30s 续跑一次前向预取窗口（ensure 幂等，窗口未覆盖足够余量才会重建）
      if (now - lastPrefetchEnsureRef.current > 30_000) {
        lastPrefetchEnsureRef.current = now;
        // 用 currentMediaUrlRef（代理回退后的实际地址）：否则预取的 key 与
        // loader 读取的 key 不一致，缓存永不命中且直连 fetch 白耗流量
        ensurePrefetch(currentMediaUrlRef.current, art.currentTime);
      }

      // —— 跳过片段判定 ——
      const p = propsRef.current;
      const current = art.currentTime;
      const duration = art.duration;
      const previous = lastSampleRef.current;
      lastSampleRef.current = current;
      const segments = resolveSegments(p.skipMark, duration);

      // 结尾片段：只认连续播放越过起点；拖动进度条、刚写入标记、进度恢复造成的大跳变
      // 都不自动结束，只显示按钮由用户决定。是否结束由合并后的 autoSkipSegments 控制
      // （片头/中段跳段，片尾结束本集，是否连播下一集仍看 autoplayNext）。
      if (
        p.autoSkipSegments &&
        restoredRef.current &&
        playbackStartedRef.current &&
        findCrossedEnding(segments, previous, current)
      ) {
        const ending = segments.find(
          (s) => s.type === 'ending' && previous < s.start && current >= s.start
        );
        finishBySkip(ending);
        return;
      }

      // 片头/中段片段：命中则自动跳到末尾（同一类操作，共用 autoSkipSegments 开关）；
      // 已处理过的片段本集不再反复拉扯。
      const active = findActiveSegment(segments, current);
      if (
        active &&
        active.type !== 'ending' &&
        p.autoSkipSegments &&
        !handledSegmentsRef.current.has(segmentKey(active)) &&
        !suppressedAutoRef.current.has(segmentKey(active)) &&
        restoredRef.current &&
        playbackStartedRef.current
      ) {
        if (skipTo(active.end)) {
          handledSegmentsRef.current.add(segmentKey(active));
          rememberSkip(current, active);
          showHint(active.type === 'opening' ? '已跳过片头' : '已跳过中段');
        }
      }

      // 按钮提示：当前落在某个未处理片段内（结尾片段显示「跳过片尾」）
      const prompt =
        active && !handledSegmentsRef.current.has(segmentKey(active)) ? active : null;
      updateSkipPrompt(prompt);
    });
    art.on('video:seeked', () => {
      ensurePrefetch(currentMediaUrlRef.current, art.currentTime);
      // seek 是用户主动行为：拉平采样基准，避免下一拍被误判为「连续越过片尾」。
      // 暂停中 seek 不会触发 timeupdate，这里也同步刷新按钮的显隐。
      const current = art.currentTime;
      lastSampleRef.current = current;
      const segments = resolveSegments(propsRef.current.skipMark, art.duration);
      const active = findActiveSegment(segments, current);
      const prompt =
        active && !handledSegmentsRef.current.has(segmentKey(active)) ? active : null;
      updateSkipPrompt(prompt);
    });
    art.on('video:pause', () => {
      // 原生桥：全屏暂停时露出系统状态栏（App 壳承接；浏览器无副作用）
      sendPlayerState({ paused: true });
      // 跳过片尾会主动 pause：此时已按「看完」处理，不能再把片尾位置写回进度
      if (!endedRef.current) propsRef.current.onPause?.(art.currentTime, art.duration);
      // 暂停 = 预取黄金窗口：解除限速并无限铺满整集（用户主动行为，带宽占用可接受）
      // waiting 触发的限速在此解除，否则黄金窗口会被 500ms 轮询冻结
      getVideoPrefetcher().setThrottled(false);
      ensurePrefetch(currentMediaUrlRef.current, art.currentTime, 0);
    });
    art.on('video:waiting', () => {
      // 卡顿：预取临时让出带宽给播放
      getVideoPrefetcher().setThrottled(true);
    });
    art.on('video:playing', () => {
      getVideoPrefetcher().setThrottled(false);
    });
    art.on('video:ended', () => {
      // finishBySkip 已经手动走过结束链路：这里不能重复触发 onEnded
      if (endedRef.current) return;
      endedRef.current = true;
      updateSkipPrompt(null);
      propsRef.current.onEnded?.();
    });

    // —— 键盘快捷键（旧版 hotkey:false + 自定义逻辑的移植） ——
    const shortcuts = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      // 输入框或按钮获得焦点时不劫持按键：否则空格会吞掉按钮的默认激活
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.closest('button')) return;
      const current = artRef.current;
      if (!current) return;
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); return; } // 由父层处理集数切换
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); return; }
      switch (e.key) {
        case 'ArrowLeft':
          if (current.currentTime > 5) { current.currentTime -= 5; showHint('快退 5s'); e.preventDefault(); }
          break;
        case 'ArrowRight':
          if (current.duration - current.currentTime > 5) { current.currentTime += 5; showHint('快进 5s'); e.preventDefault(); }
          break;
        case 'ArrowUp':
          if (current.volume < 1) { current.volume = Math.min(1, current.volume + 0.1); showHint(`音量 ${Math.round(current.volume * 100)}%`); e.preventDefault(); }
          break;
        case 'ArrowDown':
          if (current.volume > 0) { current.volume = Math.max(0, current.volume - 0.1); showHint(`音量 ${Math.round(current.volume * 100)}%`); e.preventDefault(); }
          break;
        case ' ':
          current.toggle(); showHint('播放/暂停'); e.preventDefault();
          break;
        case 'f': case 'F':
          current.fullscreen = !current.fullscreen; e.preventDefault();
          break;
        // 标记类快捷键一律要求 Shift：这几键会直接写盘并影响整部剧，
        // 单键太容易误触（误记片头 = 之后每集都被跳过一大段）
        case 'i': case 'I':
          if (!e.shiftKey) break;
          propsRef.current.onRecordSegment?.({
            type: 'opening',
            start: 0,
            end: round1(current.currentTime),
          });
          e.preventDefault();
          break;
        case 'o': case 'O':
          if (!e.shiftKey) break;
          propsRef.current.onRecordSegment?.({
            type: 'ending',
            start: round1(current.currentTime),
            end: -1,
          });
          e.preventDefault();
          break;
        case 's': case 'S':
          if (!e.shiftKey) break;
          propsRef.current.onPendingStart(round1(current.currentTime));
          showHint('片段起点已记录，播放到终点后按 Shift+E');
          e.preventDefault();
          break;
        case 'e': case 'E': {
          if (!e.shiftKey) break;
          const start = propsRef.current.pendingStart;
          if (start === null) {
            showHint('请先按 Shift+S 记录片段起点');
          } else {
            const end = round1(current.currentTime);
            propsRef.current.onPendingStart(null);
            propsRef.current.onRecordSegment?.({ type: 'middle', start, end });
          }
          e.preventDefault();
          break;
        }
      }
    };
    document.addEventListener('keydown', shortcuts);

    // —— 移动端长按 3 倍速 + 轻点仲裁（双击快进快退，方案 A 见 MOBILE_APP_PLAN_V2 §8.2） ——
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    let isLongPress = false;
    let originalRate = 1.0;
    // 手势监听挂在 ArtPlayer 根节点而不是外层 containerRef：网页全屏（fullscreenWeb）
    // 会把 $player 移到 body 下（Artplayer.FULLSCREEN_WEB_IN_BODY 默认 true），
    // 挂在外层容器上会让全部触控手势在网页全屏里失效
    const el = containerRef.current;
    const gestureEl = art.template.$player ?? el;
    // 轻点候选：touchstart 记录、touchend 消费；仅「单指 + 短按 + 小位移 + 视频面」才算轻点
    let tapStart: { x: number; y: number; t: number; touches: number } | null = null;
    const tapArbiter = createTapArbiter();
    let revealTimer: ReturnType<typeof setTimeout> | null = null;
    // —— 全屏侧滑手势（左半亮度 / 右半音量 / 横滑跳进度，PLAN §5.1） ——
    // 轴向一次性锁定：竖滑进入亮度/音量后忽略横向分量，横滑进入 seek 后忽略竖向分量，
    // 从根上消除「调亮度顺手把进度拖了」「拖进度顺手把音量改了」的双触发。
    let dragMode: null | 'brightness' | 'volume' = null;
    let seekMode = false;
    let seekAnchorX = 0;
    let seekAnchorTime = 0;
    let dragStartY = 0;
    let dragStartValue = 0;
    let dragLastValue = 0;
    let dragLastSent = -1;
    /** 本次手势起点是否落在控件上（进度条/控制栏/设置面板）：是则整段手势不归我们管 */
    let blockedGesture = false;

    const readGestureStart = (mode: 'brightness' | 'volume'): number => {
      // 优先用 App 壳里的真实值（进页面时读过一次），没有原生桥再退回本地记录/默认值
      if (mode === 'brightness') {
        const native = nativeStateRef.current?.brightness;
        if (typeof native === 'number') return native;
        const saved = Number.parseFloat(localStorage.getItem('ltv_brightness') ?? '');
        return Number.isFinite(saved) ? Math.min(1, Math.max(0, saved)) : 0.5;
      }
      const nativeVolume = nativeStateRef.current?.volume;
      if (typeof nativeVolume === 'number') return nativeVolume;
      // 浏览器网页版没有原生桥，音量就是 video 元素的 volume
      const v = art.video?.volume;
      return typeof v === 'number' ? Math.min(1, Math.max(0, v)) : 0.5;
    };

    const applyDrag = (y: number) => {
      if (!dragMode) return;
      // 上滑为增、下滑为减；300px 走完全程，手感接近主流播放器
      const value = Math.min(1, Math.max(0, dragStartValue + (dragStartY - y) / 300));
      dragLastValue = value;
      setGestureUi((prev) => (prev ? { ...prev, value } : prev));
      if (dragMode === 'brightness') {
        if (nativeStateRef.current) nativeStateRef.current = { ...nativeStateRef.current, brightness: value };
      } else {
        if (nativeStateRef.current) nativeStateRef.current = { ...nativeStateRef.current, volume: value };
        else if (art.video) art.video.volume = value; // 浏览器：直接改 video 音量
      }
      // 2% 步进通知原生：避免每个 touchmove 都打一发桥接
      if (Math.abs(value - dragLastSent) >= 0.02 || value === 0 || value === 1) {
        dragLastSent = value;
        sendPlayerState(dragMode === 'brightness' ? { brightness: value } : { volume: value });
      }
    };

    /** 横滑跳进度：整屏横滑跨度 ≈ min(90s, 片长 20%)，跟手更新并显示落点时间 */
    const applySeek = (clientX: number) => {
      const duration = art.duration;
      if (!duration || !Number.isFinite(duration) || duration <= 0) return;
      const width = art.video?.getBoundingClientRect().width || window.innerWidth;
      if (!width || width <= 0) return;
      const span = Math.min(90, Math.max(30, duration * 0.2));
      const target = Math.min(Math.max(seekAnchorTime + ((clientX - seekAnchorX) / width) * span, 0), duration);
      art.currentTime = target;
      setSeekUi({ target, duration });
    };

    // 全屏时播放器覆盖整个视口，无法依赖 mouseleave 判断“移出播放器”。
    // 改为按鼠标活动计时：停止移动后快速收起控制栏，移动时立即显示。
    let controlHideTimer: ReturnType<typeof setTimeout> | null = null;
    const showControlsOnPointerMove = () => {
      art.controls.show = true;
      if (controlHideTimer) clearTimeout(controlHideTimer);
      controlHideTimer = setTimeout(() => {
        if (!art.setting.show) art.controls.show = false;
      }, 800);
    };
    const hideControlsOnMouseLeave = () => {
      if (controlHideTimer) clearTimeout(controlHideTimer);
      controlHideTimer = null;
      art.controls.show = false;
    };
    // 触屏不监听 mousemove/mouseleave，也跳过初始显示：iOS 点按视频的合成事件
    // 序列是 mousemove → click，若 mousemove 先把 show 置 true，紧跟的 ArtPlayer
    // click toggle 会把它翻回 false——控制栏「闪一下即隐」，正是 issue #937 的病灶
    if (!touchPointer) {
      el?.addEventListener('mousemove', showControlsOnPointerMove);
      el?.addEventListener('mouseleave', hideControlsOnMouseLeave);
      showControlsOnPointerMove();
    }

    /** 轻点判定：位移超过该值视为滑动（不接管） */
    const TAP_MOVE_TOLERANCE_PX = 10;
    /** 轻点判定：按住超过该时长视为「按住」而非轻点（不接管，走原生 click） */
    const TAP_MAX_DURATION_MS = 350;

    const onTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      tapStart = touch
        ? { x: touch.clientX, y: touch.clientY, t: Date.now(), touches: e.touches.length }
        : null;
      dragMode = null;
      seekMode = false;
      // 起点落在控件/进度条上：整段手势交给控件自己（拖进度、点按钮），
      // 不再叠加亮度/音量或横滑，否则「拖进度时手抖」会改音量。
      blockedGesture = !!(e.target as HTMLElement).closest?.(
        '.art-controls, .art-progress, .art-settings, .art-selector, .art-contextmenus, input, [role="slider"]'
      );
      if (blockedGesture) tapStart = null;
      if (art.video?.paused) return;
      // 已有触控在处理时忽略新手指：否则第二指会把 originalRate 捕获成 3.0，
      // 松手后倍速永久卡在 3x；旧定时器句柄也会被覆盖成无法清除的幽灵触发
      if (isLongPress || longPressTimer) { tapStart = null; return; }
      // 控制栏 / 设置面板上的长按不触发倍速（按住进度条拖动、长按倍速菜单项会误触）
      if ((e.target as HTMLElement).closest?.('.art-controls, .art-settings')) return;
      originalRate = art.video.playbackRate;
      longPressTimer = setTimeout(() => {
        if (art.video?.paused) return;
        art.video.playbackRate = 3.0;
        isLongPress = true;
        showHint('3 倍速');
      }, 500);
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      if (dragMode) {
        // 侧滑结束：亮度持久化；指示器淡出后卸载
        if (dragMode === 'brightness') {
          try {
            localStorage.setItem('ltv_brightness', String(dragLastValue));
          } catch { /* 隐私模式忽略 */ }
        }
        setGestureUi((prev) => (prev ? { ...prev, visible: false } : prev));
        setTimeout(() => setGestureUi(null), 520);
        dragMode = null;
        return;
      }
      if (seekMode) {
        // 松手后保留一小段预览，能看清落点时间
        seekMode = false;
        tapStart = null;
        if (seekUiTimerRef.current) clearTimeout(seekUiTimerRef.current);
        seekUiTimerRef.current = setTimeout(() => {
          setSeekUi(null);
          seekUiTimerRef.current = null;
        }, 600);
        return;
      }
      const wasLongPress = isLongPress;
      if (isLongPress) {
        art.video.playbackRate = originalRate;
        isLongPress = false;
        showHint(`${originalRate} 倍速`);
      }
      const st = tapStart;
      tapStart = null;
      if (wasLongPress || e.type === 'touchcancel') return;

      // —— 轻点接管（方案 A）：仅触屏粗指针的视频面轻点；其余场景原样交给
      //    ArtPlayer 内置 click 处理（桌面点击、慢按、滑动、多指、控件/海报/暂停态） ——
      if (!touchPointer || !st) return;
      if (st.touches !== 1 || e.touches.length !== 0) return;
      if (e.target !== art.video) return;
      if (art.video?.paused) return;
      const now = Date.now();
      if (now - st.t > TAP_MAX_DURATION_MS) return;
      const end = e.changedTouches[0];
      if (!end) return;
      if (Math.abs(end.clientX - st.x) > TAP_MOVE_TOLERANCE_PX || Math.abs(end.clientY - st.y) > TAP_MOVE_TOLERANCE_PX) return;
      // 设置面板打开时交回原生：点视频先由库内逻辑收面板，我们不叠加第二次动作
      if (art.setting.show) return;

      // 从此刻起接管：阻止合成 click，否则 ArtPlayer 的内置单/双击处理会与我们叠加执行
      e.preventDefault();

      // 坐标系用 video 元素自身的盒模型：原生全屏时 $player 才是全屏元素、网页全屏时
      // $player 在 body 下铺满视口，外层 containerRef 的矩形在这两种模式下都不等于
      // 触点所在的视口坐标系，拿它算 xRatio 会让左右分区错位
      const rect = art.video?.getBoundingClientRect() ?? el?.getBoundingClientRect();
      const xRatio = rect && rect.width > 0 ? (end.clientX - rect.left) / rect.width : 0.5;
      const decision = tapArbiter.decide({ now, controlsVisible: art.controls.show, xRatio });
      switch (decision.kind) {
        case 'hide':
          art.controls.show = false;
          break;
        case 'seek': {
          const duration = art.duration;
          const target = art.currentTime + decision.seconds;
          art.currentTime =
            duration && Number.isFinite(duration)
              ? Math.min(Math.max(target, 0), duration)
              : Math.max(target, 0);
          showHint(decision.seconds > 0 ? '快进 10 秒' : '快退 10 秒');
          break;
        }
        case 'toggle-play':
          art.toggle();
          break;
        case 'reveal': {
          const token = decision.token;
          if (revealTimer) clearTimeout(revealTimer);
          revealTimer = setTimeout(() => {
            revealTimer = null;
            if (tapArbiter.takeReveal(token)) art.controls.show = true;
          }, tapArbiter.windowMs);
          break;
        }
        case 'absorb':
          break;
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (isLongPress) {
        e.preventDefault();
        return;
      }
      const t = e.touches[0];
      if (!touchPointer || !t || e.target !== art.video || !tapStart || blockedGesture) return;

      // 拖动中：禁止页面滚动，跟手更新；已锁定轴向就不再响应另一侧
      if (dragMode) {
        e.preventDefault();
        applyDrag(t.clientY);
        return;
      }
      if (seekMode) {
        e.preventDefault();
        applySeek(t.clientX);
        return;
      }

      const dx = t.clientX - tapStart.x;
      const dy = t.clientY - tapStart.y;
      // 有位移就取消长按候选：拖动手势不该触发 3 倍速
      if (Math.abs(dx) > TAP_MOVE_TOLERANCE_PX || Math.abs(dy) > TAP_MOVE_TOLERANCE_PX) {
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
      }

      // 全屏才做侧滑手势（页面内滑动留给页面滚动）
      if (!(art.fullscreen || art.fullscreenWeb)) return;
      // 轴向互斥：横竖只有一方明显占优才认；斜向继续等，绝不两边同时触发
      const axis = decideGestureAxis(dx, dy);
      if (axis === 'vertical') {
        dragMode = t.clientX < window.innerWidth / 2 ? 'brightness' : 'volume';
        dragStartY = t.clientY;
        dragStartValue = readGestureStart(dragMode);
        dragLastValue = dragStartValue;
        dragLastSent = -1;
        setGestureUi({ mode: dragMode, value: dragStartValue, visible: true });
        e.preventDefault();
      } else if (axis === 'seek') {
        seekMode = true;
        seekAnchorX = t.clientX;
        seekAnchorTime = art.currentTime || 0;
        if (seekUiTimerRef.current) {
          clearTimeout(seekUiTimerRef.current);
          seekUiTimerRef.current = null;
        }
        applySeek(t.clientX);
        e.preventDefault();
      }
    };
    // ArtPlayer 的 contextmenu 组件只在桌面端初始化（移动端构造函数里跳过 init），
    // 长按倍速因而会连带呼出系统原生菜单/气泡。播放器表面没有可用的原生菜单，统一抑制
    const onContextMenu = (e: Event) => e.preventDefault();
    gestureEl?.addEventListener('touchstart', onTouchStart, { passive: false });
    gestureEl?.addEventListener('touchend', onTouchEnd, { passive: false });
    gestureEl?.addEventListener('touchcancel', onTouchEnd);
    gestureEl?.addEventListener('touchmove', onTouchMove, { passive: false });
    gestureEl?.addEventListener('contextmenu', onContextMenu);

    // 卸载与页面隐藏时保存进度
    const saveOnHide = () => {
      if (document.visibilityState === 'hidden' && !endedRef.current) {
        propsRef.current.onPause?.(art.currentTime, art.duration);
      }
    };
    document.addEventListener('visibilitychange', saveOnHide);

    return () => {
      // 卸载前刷一次最终进度，避免丢失最后几秒。
      // 已自然播完的集数不回写，避免覆盖 onEnded 里清除的「已看完」记录
      if (!endedRef.current) {
        try {
          propsRef.current.onPause?.(art.currentTime, art.duration);
        } catch { /* 忽略 */ }
      }
      document.removeEventListener('keydown', shortcuts);
      document.removeEventListener('visibilitychange', saveOnHide);
      volumeBoostRef.current?.dispose();
      volumeBoostRef.current = null;
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
      if (seekUiTimerRef.current) clearTimeout(seekUiTimerRef.current);
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
      gestureEl?.removeEventListener('touchstart', onTouchStart);
      gestureEl?.removeEventListener('touchend', onTouchEnd);
      gestureEl?.removeEventListener('touchcancel', onTouchEnd);
      gestureEl?.removeEventListener('touchmove', onTouchMove);
      if (revealTimer) clearTimeout(revealTimer);
      gestureEl?.removeEventListener('contextmenu', onContextMenu);
      art.video?.removeEventListener('resize', reportVideoHeight);
      el?.removeEventListener('mousemove', showControlsOnPointerMove);
      el?.removeEventListener('mouseleave', hideControlsOnMouseLeave);
      if (controlHideTimer) clearTimeout(controlHideTimer);
      restoreCleanupRef.current?.();
      restoreCleanupRef.current = null;
      // 先摘掉全屏覆盖层宿主，再销毁播放器（$player 被销毁后子节点已无意义）
      overlayHost.remove();
      setOverlayHost(null);
      Artplayer.CONTROL_HIDE_TIME = ART_DEFAULT_CONTROL_HIDE_MS;
      hlsRef.current?.destroy();
      hlsRef.current = null;
      recoveryRef.current?.dispose();
      getVideoPrefetcher().stop();
      // 播放页可能仍持有读取接口：销毁前显式置空，避免「记录当前」读到已销毁实例
      propsRef.current.onPlayerApi?.(null);
      sendPlayerState({ paused: true }); // 卸载即视为停止播放，系统栏恢复
      art.destroy();
      artRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // —— 触屏首次进入横屏：一次性手势提示（引导双击 seek/长按倍速，plan P0-2） ——
  //    不做自动全屏：iOS Safari 的容器全屏需要用户手势，自动触发大概率被静默拒绝
  useEffect(() => {
    if (!prefersTouchPointer()) return;
    let hinted = false;
    const mq = window.matchMedia('(orientation: landscape)');
    const onChange = () => {
      if (!mq.matches || hinted || !artRef.current?.playing) return;
      hinted = true;
      showHint('横屏：双击两侧快进/快退 · 长按 3 倍速');
    };
    mq.addEventListener('change', onChange);
    onChange();
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // —— 音量放大开关：播放中改设置即时生效，不必等重新起播 ——
  // 关闭走「单位增益直通」而不是拆链：createMediaElementSource 之后元素输出只走
  // 音频图，拆链会永久静音且无法恢复直连，所以只旁路增益与限幅。
  useEffect(() => {
    const video = artRef.current?.video as HTMLVideoElement | undefined;
    if (!video) return;
    if (volumeBoost) {
      volumeBoostRef.current = attachVolumeBoost(video) ?? volumeBoostRef.current;
      volumeBoostRef.current?.setBoost(true);
    } else {
      volumeBoostRef.current?.setBoost(false);
    }
  }, [volumeBoost]);

  // —— 底部细进度条开关：播放中改设置即时生效，不用重开视频 ——
  // 按「当前可见状态 + 设置」收敛，而不是无条件挂类：控制栏可见时挂着类名虽然不会让
  // 控制栏跳位（库样式里 art-control-show 的规则排在后面），但同组的
  // background-image:none 与 .art-progress-indicator{display:none!important} 会无条件
  // 生效——底部渐变遮罩和进度圆点就这么没了。所以任何时候都不留常驻类名。
  useEffect(() => {
    const player = artRef.current?.template?.$player;
    if (!player) return;
    syncMiniProgressBar(player.classList, {
      enabled: miniProgressBar,
      controlsShown: player.classList.contains(CONTROL_SHOW_CLASS),
    });
  }, [miniProgressBar]);

  // —— 上/下集禁用态：走 ArtPlayer 的 controls API 更新样式，不直接改 DOM ——
  // 直接 querySelector 改 style 在控件重建（切全屏/播放器重绘）后不会恢复，且依赖内部 class 名。
  useEffect(() => {
    const controls = artRef.current?.controls;
    if (!controls) return;
    controls.update({
      name: 'prev-episode',
      style: { opacity: hasPrevEpisode ? '1' : '0.4', pointerEvents: hasPrevEpisode ? 'auto' : 'none' },
    });
    controls.update({
      name: 'next-episode',
      style: { opacity: hasNextEpisode ? '1' : '0.4', pointerEvents: hasNextEpisode ? 'auto' : 'none' },
    });
  }, [hasPrevEpisode, hasNextEpisode, url]);

  // —— 标记变化：重置采样基准并立即刷新提示 ——
  // 刚写入片段时当前时间可能恰好等于新边界，若沿用上一拍采样会被判成
  // 「连续越过」而当场触发；把基准拉平后本集只保留手动按钮，下一集才自动。
  // 顺带覆盖暂停中修改标记的场景（没有 timeupdate 也要让按钮即时出现/消失）。
  useEffect(() => {
    const art = artRef.current;
    if (!art) return;
    const current = art.currentTime;
    lastSampleRef.current = Number.isFinite(current) ? current : 0;
    const segments = resolveSegments(skipMark, art.duration);
    const active = findActiveSegment(segments, current);
    const prompt =
      active && !handledSegmentsRef.current.has(segmentKey(active)) ? active : null;
    updateSkipPrompt(prompt);
    renderSkipMarks();
  }, [skipMark]);

  // —— 换集：仅切换 HLS 源，不重建播放器（保留网页全屏等状态） ——
  const firstUrlRef = useRef(true);
  useEffect(() => {
    // 挂载时的首次由创建 effect 的 customType 触发，跳过避免重复加载
    if (firstUrlRef.current) { firstUrlRef.current = false; return; }
    loadEpisode(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // —— 广告过滤开关变化：重建 HLS loader（无需重建整个播放器） ——
  const firstAdFilterRef = useRef(true);
  useEffect(() => {
    if (firstAdFilterRef.current) { firstAdFilterRef.current = false; return; }
    if (artRef.current && hlsRef.current) {
      // 用当前实际媒体地址：代理回退生效时切广告过滤不应跳回直连形式
      loadEpisode(currentMediaUrlRef.current || propsRef.current.url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adFilter]);

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" style={{ WebkitTouchCallout: 'none' }} />
      {showPoster && !error && (
        <div
          className="absolute inset-0 bg-black pointer-events-none"
          style={{
            backgroundImage: 'url(/player-poster.png)',
            backgroundSize: 'contain',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
          }}
        />
      )}
      {/* 以下覆盖层全部 portal 进 ArtPlayer 的 $player：全屏时只有全屏元素子树会被渲染，
          否则亮度/音量 HUD、快进提示、跳过按钮在全屏里全部不可见（全屏手势调参后看不到值） */}
      {overlayHost &&
        createPortal(
          <>
            {/* 亮度/音量 HUD：顶部居中毛玻璃胶囊，图标 + 纵向填充条 + 百分比 + 名称 */}
            {gestureUi && (
              <div
                className="pointer-events-none absolute inset-x-0 top-[9%] flex justify-center"
                role="status"
                aria-live="polite"
                aria-label={
                  gestureUi.mode === 'brightness'
                    ? `亮度 ${Math.round(gestureUi.value * 100)}%`
                    : `音量 ${Math.round(gestureUi.value * 100)}%`
                }
              >
                <div
                  className={cn(
                    'flex items-center gap-3 rounded-full border border-white/10 bg-black/65 py-2 pl-4 pr-3 shadow-[0_12px_40px_rgba(0,0,0,.55)] backdrop-blur-xl',
                    gestureUi.visible ? 'gesture-pop' : 'gesture-fade'
                  )}
                >
                  <span className="text-white/85">
                    {gestureUi.mode === 'brightness' ? (
                      <svg className="h-[18px] w-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
                        />
                      </svg>
                    ) : (
                      <svg className="h-[18px] w-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"
                        />
                      </svg>
                    )}
                  </span>
                  <div className="relative h-1.5 w-36 overflow-hidden rounded-full bg-white/20">
                    <div
                      className="absolute inset-y-0 left-0 rounded-full bg-white transition-[width] duration-75 ease-out"
                      style={{ width: `${Math.round(gestureUi.value * 100)}%` }}
                    />
                  </div>
                  <span className="min-w-[3.2em] text-right text-[13px] font-semibold tabular-nums text-white">
                    {Math.round(gestureUi.value * 100)}%
                  </span>
                  <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-medium tracking-wide text-white/70">
                    {gestureUi.mode === 'brightness' ? '亮度' : '音量'}
                  </span>
                </div>
              </div>
            )}
            {/* 横滑跳进度预览：跟手显示落点时间，松手后淡出 */}
            {seekUi && (
              <div
                className="pointer-events-none absolute inset-x-0 top-[9%] flex justify-center"
                role="status"
                aria-live="polite"
                aria-label={`进度 ${formatTime(seekUi.target)}，共 ${formatTime(seekUi.duration)}`}
              >
                <div className="gesture-pop flex items-baseline gap-2 rounded-full border border-white/10 bg-black/65 px-4 py-2 shadow-[0_12px_40px_rgba(0,0,0,.55)] backdrop-blur-xl">
                  <span className="text-[15px] font-semibold tabular-nums text-white">{formatTime(seekUi.target)}</span>
                  <span className="text-[11px] tabular-nums text-white/50">/ {formatTime(seekUi.duration)}</span>
                  <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-medium tracking-wide text-white/70">
                    进度
                  </span>
                </div>
              </div>
            )}
            {!error && skipPrompt && (
              <button
                type="button"
                className="pointer-events-auto absolute bottom-16 left-1/2 -translate-x-1/2 z-10 rounded-full bg-black/70 px-4 py-2 text-sm text-white transition-colors hover:bg-black/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                onClick={() => {
                  if (skipPrompt.type === 'ending') {
                    finishBySkip(skipPrompt);
                    return;
                  }
                  const from = artRef.current?.currentTime ?? 0;
                  if (skipTo(skipPrompt.end)) {
                    handledSegmentsRef.current.add(segmentKey(skipPrompt));
                    rememberSkip(from, skipPrompt);
                    updateSkipPrompt(null);
                    showHint(skipPrompt.type === 'opening' ? '已跳过片头' : '已跳过中段');
                  }
                }}
              >
                {skipPrompt.type === 'ending'
                  ? '跳过片尾'
                  : skipPrompt.type === 'opening'
                    ? '跳过片头'
                    : '跳过中段'}
              </button>
            )}
            {(hint || undoSkip) && (
              <div className="pointer-events-none absolute top-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-sm text-white animate-fade-in">
                {/* 撤销窗口比普通提示长：hint 已淡出时仍要让用户知道刚才跳过了什么 */}
                <span className="pointer-events-none">
                  {hint || (undoSkip ? `已跳过${SEGMENT_LABELS[undoSkip.segment.type]}` : '')}
                </span>
                {undoSkip && (
                  <button
                    type="button"
                    className="pointer-events-auto shrink-0 rounded-full bg-white/20 px-2 py-0.5 text-xs font-medium transition-colors hover:bg-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    onClick={undoLastSkip}
                  >
                    撤销
                  </button>
                )}
              </div>
            )}
            {autoplayNext && !error && (
              <div className="pointer-events-none absolute bottom-16 right-3 z-10 rounded bg-black/50 px-2 py-0.5 text-[10px] text-muted">
                自动连播已开启
              </div>
            )}
            {error && (
              <div className="pointer-events-auto absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80">
                <p className="text-danger text-sm">{error}</p>
                <button className="btn-ghost text-xs" onClick={() => location.reload()}>
                  重新加载
                </button>
              </div>
            )}
          </>,
          overlayHost
        )}
    </div>
  );
}
