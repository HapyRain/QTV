/**
 * 下载文件的保存目标：
 * - App 壳（Android WebView）：原生保存桥 `window.QTV`（兼容 `window.LJJTV`） 分块 base64 流式落盘到「下载」目录，
 *   不需要文件选择器，也不在 WebView 里攒整集字节（整集几百 MB，攒完必崩）；
 * - Chromium（Edge/Chrome）：showSaveFilePicker 边下边写盘（FS Access API），
 *   必须在**用户手势内**调用（点击处理器的同步栈中）；
 * - 其余环境：内存聚合为 Blob 后触发浏览器下载（>500MB 时让用户确认）。
 *
 * 有意不做 StreamSaver（mitm.html + SW 中转）：云平台域名下 SW 注册受限，
 * 复杂度高、收益边际——大文件场景建议直接使用 FS Access 浏览器。
 */

/** App 壳注入的原生保存桥（见 MainActivity.SaveBridge） */
interface NativeSaveBridge {
  saveBegin(name: string): void;
  saveChunk(b64: string): void;
  saveEnd(): boolean;
  saveAbort?(): void;
}

/** 原生保存桥存在时返回它（Android WebView 壳），否则 null */
export function nativeSaveBridge(): NativeSaveBridge | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    QTV?: Partial<NativeSaveBridge>;
    LJJTV?: Partial<NativeSaveBridge>;
  };
  const bridge = w.QTV ?? w.LJJTV;
  if (
    bridge &&
    typeof bridge.saveBegin === 'function' &&
    typeof bridge.saveChunk === 'function' &&
    typeof bridge.saveEnd === 'function'
  ) {
    return bridge as NativeSaveBridge;
  }
  return null;
}

/** Uint8Array → base64（分小段转换，避免 apply 参数过长爆栈） */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    const slice = bytes.subarray(i, i + 8192);
    bin += String.fromCharCode(...(slice as unknown as number[]));
  }
  return btoa(bin);
}
export interface SaveTarget {
  /** 'native' = App 壳原生桥流式落盘；'fs' = 磁盘直写；'memory' = 内存聚合 */
  kind: 'native' | 'fs' | 'memory';
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export function supportsFileSystemAccess(): boolean {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window;
}

export function detectSavingCapability(): 'native' | 'fs-access' | 'memory' {
  if (nativeSaveBridge()) return 'native';
  return supportsFileSystemAccess() ? 'fs-access' : 'memory';
}

export class UserCancelledError extends Error {
  constructor() {
    super('用户取消了保存');
  }
}

/** 每块 base64 的原始字节数：49KB 在 JS 侧不占栈、原生侧一次落盘也足够快 */
const NATIVE_CHUNK_BYTES = 49_152;

/**
 * App 壳原生保存目标：write 即分块交给原生，边下边写。
 * 之前这里走「内存聚合 + 结束时一次性写桥」，整集几百 MB 会先把 WebView 内存打爆；
 * 而且 WebView 里 showSaveFilePicker 不存在，pickSaveTarget 会落到内存分支。
 */
export function nativeSaveTarget(filename: string): SaveTarget {
  const bridge = nativeSaveBridge();
  if (!bridge) throw new Error('当前环境不支持原生保存');
  let opened = false;
  const ensureOpen = () => {
    if (opened) return;
    opened = true;
    bridge.saveBegin(filename);
  };
  return {
    kind: 'native',
    async write(data) {
      ensureOpen();
      for (let i = 0; i < data.byteLength; i += NATIVE_CHUNK_BYTES) {
        bridge.saveChunk(bytesToBase64(data.subarray(i, i + NATIVE_CHUNK_BYTES)));
      }
    },
    async close() {
      ensureOpen();
      opened = false;
      if (!bridge.saveEnd()) throw new Error('保存到设备失败');
    },
    async abort() {
      opened = false;
      try {
        bridge.saveAbort?.();
      } catch {
        /* 已关闭则忽略 */
      }
    },
  };
}

function memoryTarget(filename: string, confirmOverBytes = 500 * 1024 * 1024): SaveTarget {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let done = false;
  const flush = () => {
    if (done) return;
    done = true;
    const blob = new Blob(chunks.map((c) => c.buffer as ArrayBuffer));
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    chunks.length = 0;
  };
  return {
    kind: 'memory',
    async write(data) {
      if (done) return;
      bytes += data.byteLength;
      if (bytes > confirmOverBytes && bytes - data.byteLength <= confirmOverBytes) {
        if (!window.confirm(`下载体积已超过 ${Math.round(confirmOverBytes / 1024 / 1024)}MB，继续将暂存在内存中，可能导致页面卡顿。是否继续？`)) {
          throw new UserCancelledError();
        }
      }
      chunks.push(data);
    },
    async close() {
      flush();
    },
    async abort() {
      done = true;
      chunks.length = 0;
    },
  };
}

/**
 * 选择保存目标。App 壳里直接给原生流式目标（无手势要求、无弹窗）；
 * 浏览器里 showSaveFilePicker 必须在用户手势内调用，因此本函数应在点击处理器里被 await。
 * 用户取消文件选择器时抛出 UserCancelledError。
 */
export async function pickSaveTarget(filename: string, estimatedBytes?: number): Promise<SaveTarget> {
  // 原生桥优先：WebView 里没有可用的 showSaveFilePicker，且大文件不能走内存聚合
  if (nativeSaveBridge()) return nativeSaveTarget(filename);
  if (supportsFileSystemAccess()) {
    try {
      // Safari 会暴露 showSaveFilePicker 之外的旧实现；直接 try/catch 兜底
      const picker = (
        window as unknown as {
          showSaveFilePicker: (opts: {
            suggestedName: string;
          }) => Promise<{ createWritable: () => Promise<WritableStream> }>;
        }
      ).showSaveFilePicker;
      const handle = await picker({ suggestedName: filename });
      const writable = await handle.createWritable();
      const writer = writable.getWriter();
      return {
        kind: 'fs',
        async write(data) {
          await writer.write(data);
        },
        async close() {
          await writer.close();
        },
        async abort() {
          try {
            await writer.abort();
          } catch { /* 已关闭则忽略 */ }
        },
      };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new UserCancelledError();
      }
      // 文件选择失败（权限/环境）→ 落到内存聚合
    }
  }
  if (estimatedBytes && estimatedBytes > 500 * 1024 * 1024) {
    if (!window.confirm('该视频体积较大（未提供磁盘直写能力的环境），将暂存在内存中，可能导致页面卡顿。是否继续？')) {
      throw new UserCancelledError();
    }
  }
  return memoryTarget(filename);
}
