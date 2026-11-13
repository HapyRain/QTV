import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  UserCancelledError,
  detectSavingCapability,
  nativeSaveBridge,
  nativeSaveTarget,
  pickSaveTarget,
} from './download-saver';

/** 模拟 Android WebView 注入的 LJJTV 保存桥，记录调用顺序 */
function installBridge(endReturns = true) {
  const calls: string[] = [];
  const bridge = {
    saveBegin: (name: string) => calls.push(`begin:${name}`),
    saveChunk: (b64: string) => calls.push(`chunk:${b64}`),
    saveEnd: () => {
      calls.push('end');
      return endReturns;
    },
    saveAbort: () => calls.push('abort'),
  };
  (globalThis as unknown as { window: unknown }).window = { LJJTV: bridge };
  return calls;
}

const decode = (b64: string) => Buffer.from(b64, 'base64');

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.restoreAllMocks();
});

describe('download-saver · App 壳原生保存', () => {
  it('有原生桥时能力判定为 native，且不碰 showSaveFilePicker', async () => {
    const calls = installBridge();
    const picker = vi.fn();
    (globalThis as unknown as { window: { showSaveFilePicker?: unknown } }).window.showSaveFilePicker = picker;

    expect(nativeSaveBridge()).not.toBeNull();
    expect(detectSavingCapability()).toBe('native');
    const target = await pickSaveTarget('第 1 集.mp4');
    expect(target.kind).toBe('native');
    expect(picker).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('边下边写：每次 write 只分块推给原生，不攒整集', async () => {
    const calls = installBridge();
    const target = nativeSaveTarget('demo.mp4');
    const data = new Uint8Array(120 * 1024).fill(7);
    await target.write(data);
    // 120KB / 49KB → 3 块
    expect(calls[0]).toBe('begin:demo.mp4');
    expect(calls.filter((c) => c.startsWith('chunk:'))).toHaveLength(3);
    const secondChunk = calls[2].slice('chunk:'.length);
    expect(decode(secondChunk).length).toBe(49_152);
    await target.close();
    expect(calls.at(-1)).toBe('end');
  });

  it('saveEnd 返回 false 时抛错（不静默产出空文件）', async () => {
    installBridge(false);
    const target = nativeSaveTarget('bad.mp4');
    await target.write(new Uint8Array([1, 2, 3]));
    await expect(target.close()).rejects.toThrow('保存到设备失败');
  });

  it('abort 调原生 saveAbort', async () => {
    const calls = installBridge();
    const target = nativeSaveTarget('x.mp4');
    await target.abort();
    expect(calls).toEqual(['abort']);
  });

  it('无原生桥：能力退回 memory（没有 showSaveFilePicker 的 WebView/浏览器）', () => {
    (globalThis as unknown as { window: unknown }).window = {};
    expect(nativeSaveBridge()).toBeNull();
    expect(detectSavingCapability()).toBe('memory');
  });

  it('浏览器取消文件选择器 → UserCancelledError（只在这种情况才提示已取消）', async () => {
    (globalThis as unknown as { window: unknown }).window = {
      showSaveFilePicker: async () => {
        throw new DOMException('dismissed', 'AbortError');
      },
    };
    await expect(pickSaveTarget('a.mp4')).rejects.toBeInstanceOf(UserCancelledError);
  });
});
