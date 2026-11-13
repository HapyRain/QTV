'use client';

import { useEffect, useRef, useState } from 'react';
import Artplayer from 'artplayer';
import Hls, { type HlsConfig } from 'hls.js';
import { Spinner } from './states';
import { prefersTouchPointer } from '@/lib/touch-pointer';
import { createTapArbiter } from '@/lib/touch-gestures';
import { ART_DEFAULT_CONTROL_HIDE_MS, TOUCH_CONTROL_HIDE_MS } from '@/lib/control-hide';
import { attachVolumeBoost, type VolumeBoostHandle } from '@/lib/volume-boost';
import { sendPlayerState } from './player-shell';

const STREAM_PROXY_PREFIX = '/api/live/stream';
const STREAM_PROXY_BASE = '/api/live/stream?url=';

export function isFlvUrl(url: string): boolean {
  return /\.flv(\?|$)/i.test(url);
}

const NATIVE_MEDIA_RE = /\.(mp4|m4v|webm|ogv|ogg|mov)(\?|$)/i;

type Engine = 'hls' | 'flv' | 'native';

function engineOf(url: string): Engine {
  if (isFlvUrl(url)) return 'flv';
  if (NATIVE_MEDIA_RE.test(url)) return 'native';
  return 'hls';
}

function proxyUrl(url: string): string {
  return STREAM_PROXY_BASE + encodeURIComponent(url);
}

interface LivePlayerProps {
  url: string;
  title: string;
  onPrevChannel?: () => void;
  onNextChannel?: () => void;
  volumeBoost: boolean;
}

export function LivePlayer({ url, title, onPrevChannel, onNextChannel, volumeBoost }: LivePlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const artRef = useRef<any>(null);
  const hlsRef = useRef<Hls | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mpegtsRef = useRef<any>(null);
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  const [loading, setLoading] = useState(true);
  const [retryNonce, setRetryNonce] = useState(0);
  const [showPoster, setShowPoster] = useState(true);
  const [osdTitle, setOsdTitle] = useState('');
  const osdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const volumeBoostRef = useRef<VolumeBoostHandle | null>(null);
  const volumeBoostSettingRef = useRef(volumeBoost);
  volumeBoostSettingRef.current = volumeBoost;

  useEffect(() => {
    if (!url) return;
    setOsdTitle(title);
    if (osdTimerRef.current) clearTimeout(osdTimerRef.current);
    osdTimerRef.current = setTimeout(() => setOsdTitle(''), 2500);
    return () => {
      if (osdTimerRef.current) clearTimeout(osdTimerRef.current);
    };
  }, [url, title]);

  const showHint = (text: string) => {
    setHint(text);
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setHint(''), 2500);
  };

  useEffect(() => {
    if (!containerRef.current || !url) return;
    setError('');
    setLoading(true);
    setShowPoster(true);

    let playbackStarted = false;
    let disposed = false;
    let destroyed = false;
    let nativeCleanup: (() => void) | null = null;

    const cleanupEngines = () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
      if (mpegtsRef.current) {
        try { mpegtsRef.current.pause(); } catch { /* 忽略 */ }
        try { mpegtsRef.current.destroy(); } catch { /* 忽略 */ }
        mpegtsRef.current = null;
      }
      if (nativeCleanup) {
        try { nativeCleanup(); } catch { /* 忽略 */ }
        nativeCleanup = null;
      }
    };

    const setupNative = (
      video: HTMLVideoElement,
      mediaUrl: string,
      allowProxyFallback: boolean,
      failMessage?: string
    ) => {
      cleanupEngines();
      const onError = () => {
        video.removeEventListener('error', onError);
        nativeCleanup = null;
        if (disposed || destroyed) return;
        if (allowProxyFallback && !mediaUrl.startsWith(STREAM_PROXY_PREFIX)) {
          showHint('直连受限，自动切换代理线路...');
          setupNative(video, proxyUrl(url), false, failMessage);
          return;
        }
        setError(failMessage || '该频道流暂不可用，请切换其他频道');
      };
      video.addEventListener('error', onError);
      nativeCleanup = () => video.removeEventListener('error', onError);
      video.src = mediaUrl;
      video.load();
      video.play().catch(() => {});
    };

    const setupHls = (video: HTMLVideoElement, mediaUrl: string, stage: 'direct' | 'proxy') => {
      cleanupEngines();
      let liveNetRetryCount = 0;
      let mediaRecoverCount = 0;
      const hlsConfig: Partial<HlsConfig> = {
        debug: false,
        enableWorker: true,
        liveSyncDurationCount: 3,
        lowLatencyMode: false,
        backBufferLength: 30,
        maxBufferLength: 20,
        maxMaxBufferLength: 40,
        manifestLoadingMaxRetry: 2,
        manifestLoadingRetryDelay: 1000,
        fragLoadingMaxRetry: 4,
        fragLoadingRetryDelay: 800,
      };
      const hls = new Hls(hlsConfig);
      hlsRef.current = hls;
      hls.loadSource(mediaUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, (_evt, manifestData) => {
        const videoCodecs = (manifestData.levels || []).map((l) => l.videoCodec || '').join(',');
        if (/hvc1|hev1|hevc/i.test(videoCodecs)) {
          const support = video.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"');
          if (!support) {
            showHint('该频道为 HEVC 高清编码，若画面黑屏请切换其他同台信号');
          }
        }
        video.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (disposed || destroyed) return;
        const httpCode = data.response?.code;
        const codeHint = httpCode ? `（HTTP ${httpCode}）` : '';
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          if (mediaRecoverCount < 2) {
            mediaRecoverCount++;
            hls.recoverMediaError();
            return;
          }
          setError('频道流解码异常，请尝试切换其他频道');
          return;
        }
        if (!playbackStarted) {
          if (
            stage === 'direct' &&
            !mediaUrl.startsWith(STREAM_PROXY_PREFIX) &&
            (data.details === 'manifestLoadError' || data.type === Hls.ErrorTypes.NETWORK_ERROR)
          ) {
            showHint('直连受限，自动切换代理线路...');
            setupHls(video, proxyUrl(url), 'proxy');
            return;
          }
          showHint('正在尝试原生解码播放...');
          setupNative(video, url, true, `直播流加载失败${codeHint}，请尝试切换其他频道`);
          return;
        }
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          liveNetRetryCount++;
          if (liveNetRetryCount > 5) {
            setError(`信号中断${codeHint}，请尝试切换其他频道`);
            return;
          }
          hls.startLoad();
        }
      });
    };

    const setupFlv = async (
      video: HTMLVideoElement,
      mediaUrl: string,
      allowProxyFallback: boolean
    ) => {
      cleanupEngines();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let Mpegts: any;
      try {
        Mpegts = (await import('mpegts.js')).default;
      } catch {
        setError('FLV 解码模块加载失败');
        return;
      }
      if (disposed || destroyed) return;
      if (!Mpegts.getFeatureList().mseLivePlayback) {
        setError('当前设备不支持 FLV 直播流');
        return;
      }
      const player = Mpegts.createPlayer(
        {
          type: 'flv',
          isLive: true,
          url: mediaUrl,
        },
        {
          enableWorker: false,
          enableStashBuffer: false,
          stashInitialSize: 128,
          liveBufferLatencyChasing: true,
          lazyLoad: false,
        }
      );
      mpegtsRef.current = player;
      player.attachMediaElement(video);
      player.load();
      player.on(Mpegts.Events.ERROR, (errType: string) => {
        if (disposed || destroyed) return;
        if (!playbackStarted && allowProxyFallback && !mediaUrl.startsWith(STREAM_PROXY_PREFIX)) {
          showHint('直连受限，自动切换代理线路...');
          void setupFlv(video, proxyUrl(url), false);
          return;
        }
        setError(`直播信号异常（${errType}），请切换其他频道`);
      });
      player.play().catch(() => {});
    };

    const engine = engineOf(url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const controls: any[] = [];
    const channelBtnSvg = (path: string) =>
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px"><path d="${path}"/></svg>`;
    if (onPrevChannel) {
      controls.push({
        name: 'prev-channel',
        position: 'left',
        index: 0,
        html: channelBtnSvg('M11 19l-7-7 7-7m8 14l-7-7 7-7'),
        tooltip: '上一台',
        click: () => onPrevChannel(),
      });
    }
    if (onNextChannel) {
      controls.push({
        name: 'next-channel',
        position: 'left',
        index: 1,
        html: channelBtnSvg('M13 5l7 7-7 7M5 5l7 7-7 7'),
        tooltip: '下一台',
        click: () => onNextChannel(),
      });
    }
    const touchPointer = prefersTouchPointer();
    if (touchPointer) Artplayer.CONTROL_HIDE_TIME = TOUCH_CONTROL_HIDE_MS;

    const art = new Artplayer({
      container: containerRef.current,
      url,
      type: engine === 'flv' ? 'flv' : engine === 'native' ? 'mp4' : 'm3u8',
      volume: 0.9,
      autoplay: true,
      pip: true,
      screenshot: false,
      setting: false,
      playbackRate: false,
      aspectRatio: false,
      fullscreen: true,
      fullscreenWeb: true,
      miniProgressBar: false,
      hotkey: false,
      mutex: true,
      backdrop: true,
      playsInline: true,
      airplay: true,
      theme: '#38bdf8',
      controls,
      lang: navigator.language.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en',
      moreVideoAttr: { playsInline: true },
      customType: {
        m3u8: (video: HTMLVideoElement) => {
          setupHls(video, url, 'direct');
        },
        flv: (video: HTMLVideoElement) => {
          void setupFlv(video, url, true);
        },
        mp4: (video: HTMLVideoElement) => {
          setupNative(video, url, true);
        },
      },
    });
    artRef.current = art;
    art.on('video:loadedmetadata', () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (art as any).title = title;
      } catch { /* 忽略 */ }
    });
    art.on('video:playing', () => {
      sendPlayerState({ paused: false });
      playbackStarted = true;
      setLoading(false);
      setShowPoster(false);
      setError('');
      if (volumeBoostSettingRef.current && !volumeBoostRef.current) {
        volumeBoostRef.current = attachVolumeBoost(art.video);
      }
    });
    art.on('video:pause', () => {
      sendPlayerState({ paused: true });
    });
    art.on('video:error', () => {
      if (!mpegtsRef.current) setError('频道信号加载失败，请切换其他频道');
    });
    art.on('ready', () => {
      try {
        const progress = art.controls?.progress as HTMLElement | undefined;
        if (progress) progress.style.display = 'none';
      } catch { /* 忽略 */ }
    });

    if (touchPointer) {
      art.on('fullscreen', (state: boolean) => {
        try {
          const orient = screen.orientation as ScreenOrientation & {
            lock?: (orientation: string) => Promise<void>;
          };
          if (state) {
            const p = orient.lock?.('landscape');
            if (p && typeof p.catch === 'function') p.catch(() => {});
          } else {
            orient.unlock?.();
          }
        } catch { /* 忽略 */ }
      });
      art.on('fullscreenError', () => {
        try {
          const video = art.video as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | undefined;
          video?.webkitEnterFullscreen?.();
        } catch { /* 忽略 */ }
      });
    }

    const tapArbiter = createTapArbiter();
    let revealTimer: ReturnType<typeof setTimeout> | null = null;
    let tapStart: { x: number; y: number; t: number; touches: number } | null = null;
    const gestureEl = art.template.$player as HTMLElement | null;
    const TAP_MOVE_TOLERANCE_PX = 10;
    const TAP_MAX_DURATION_MS = 350;
    const onLiveTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      tapStart = touch
        ? { x: touch.clientX, y: touch.clientY, t: Date.now(), touches: e.touches.length }
        : null;
    };
    const onLiveTouchEnd = (e: TouchEvent) => {
      const st = tapStart;
      tapStart = null;
      if (!touchPointer || !st || e.type === 'touchcancel') return;
      if (st.touches !== 1 || e.touches.length !== 0) return;
      if (e.target !== art.video) return;
      if (art.video?.paused) return;
      const now = Date.now();
      if (now - st.t > TAP_MAX_DURATION_MS) return;
      const end = e.changedTouches[0];
      if (!end) return;
      if (Math.abs(end.clientX - st.x) > TAP_MOVE_TOLERANCE_PX || Math.abs(end.clientY - st.y) > TAP_MOVE_TOLERANCE_PX) return;
      e.preventDefault();
      const decision = tapArbiter.decide({ now, controlsVisible: art.controls.show, xRatio: 0.5 });
      switch (decision.kind) {
        case 'hide':
          art.controls.show = false;
          break;
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
        case 'seek':
        case 'absorb':
          break;
      }
    };
    gestureEl?.addEventListener('touchstart', onLiveTouchStart, { passive: true });
    gestureEl?.addEventListener('touchend', onLiveTouchEnd, { passive: false });
    gestureEl?.addEventListener('touchcancel', onLiveTouchEnd);

    const startTimer = setTimeout(() => {
      if (!playbackStarted && !disposed && !destroyed) {
        setError('频道响应超时，请尝试切换其他频道');
      }
    }, 15000);

    return () => {
      disposed = true;
      clearTimeout(startTimer);
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
      gestureEl?.removeEventListener('touchstart', onLiveTouchStart);
      gestureEl?.removeEventListener('touchend', onLiveTouchEnd);
      gestureEl?.removeEventListener('touchcancel', onLiveTouchEnd);
      if (revealTimer) clearTimeout(revealTimer);
      cleanupEngines();
      volumeBoostRef.current?.dispose();
      volumeBoostRef.current = null;
      sendPlayerState({ paused: true });
      art.destroy();
      artRef.current = null;
      if (touchPointer) Artplayer.CONTROL_HIDE_TIME = ART_DEFAULT_CONTROL_HIDE_MS;
      destroyed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, retryNonce, onPrevChannel, onNextChannel]);

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

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" />
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
      {!error && (
        <div className="absolute top-3 right-3 flex items-center gap-1.5 bg-black/65 backdrop-blur-md px-2.5 py-1 rounded-full pointer-events-none border border-white/10">
          <span className="live-dot" />
          <span className="text-[10px] font-bold text-white tracking-wider">LIVE</span>
        </div>
      )}
      {osdTitle && !error && (
        <div className="absolute top-3 left-3 flex items-center max-w-[70%] bg-black/65 backdrop-blur-md px-3 py-1.5 rounded-full pointer-events-none animate-fade-in border border-white/10">
          <span className="text-xs font-semibold text-white truncate">{osdTitle}</span>
        </div>
      )}
      {loading && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 pointer-events-none">
          <Spinner size="lg" tone="onDark" />
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-black/85 px-6 text-center">
          <p className="text-danger text-xs font-medium">{error}</p>
          <button
            className="btn-ghost btn-sm !bg-white/15 !text-white"
            onClick={() => {
              setError('');
              setHint('');
              setRetryNonce((n) => n + 1);
            }}
          >
            重试信号
          </button>
        </div>
      )}
      {hint && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-black/75 backdrop-blur-md text-white text-xs px-3.5 py-1.5 rounded-full pointer-events-none animate-fade-in border border-white/10">
          {hint}
        </div>
      )}
    </div>
  );
}
