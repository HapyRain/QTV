import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  UserCancelledError,
  detectSavingCapability,
  nativeSaveBridge,
  nativeSaveBusy,
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
    getLastSavedPath: () => '/storage/emulated/0/Download/demo.mp4',
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

  it('保存成功后能拿到原生报告的位置（离线播放入口依赖它）', async () => {
    installBridge();
    const target = nativeSaveTarget('demo.mp4');
    expect(target.getSavedPath?.()).toBeNull();
    await target.write(new Uint8Array([1]));
    await target.close();
    expect(target.getSavedPath?.()).toBe('/storage/emulated/0/Download/demo.mp4');
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

  it('原生桥是单槽位：前一个保存未收尾时，另一个任务必须明确失败而不是共用句柄', async () => {
    installBridge();
    const first = nativeSaveTarget('第 1 集.mp4');
    await first.write(new Uint8Array([1, 2, 3]));
    expect(nativeSaveBusy()).toBe(true);

    // 第二个任务抢占同一个单槽位：必须抛错，不能把两集分片写进同一个文件
    const second = nativeSaveTarget('第 2 集.mp4');
    await expect(second.write(new Uint8Array([4, 5, 6]))).rejects.toThrow('另一个保存任务正在进行');

    // 第一个任务正常收尾后，槽位释放，后续任务可以继续
    await first.close();
    expect(nativeSaveBusy()).toBe(false);
    const third = nativeSaveTarget('第 3 集.mp4');
    await third.write(new Uint8Array([7]));
    await third.close();
  });

  it('保存失败也要释放槽位，避免后续下载永久被卡住', async () => {
    installBridge(false);
    const failed = nativeSaveTarget('bad.mp4');
    await failed.write(new Uint8Array([1]));
    await expect(failed.close()).rejects.toThrow('保存到设备失败');
    expect(nativeSaveBusy()).toBe(false);
  });
});
