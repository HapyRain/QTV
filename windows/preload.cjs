/**
 * QTV for Windows - Preload Bridge
 * Exposes:
 * - window.QTVDesktop (Frameless window controls, Always-on-Top Pin, Mini-Player, Folder Reveal)
 * - window.QTV & window.LJJTV (Stream-to-Disk MP4 Download Saver)
 */

const { contextBridge, ipcRenderer } = require('electron');

const desktopBridge = {
  isDesktop: true,
  platform: 'windows',
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  togglePin: () => ipcRenderer.invoke('window:toggle-pin'),
  toggleMini: () => ipcRenderer.invoke('window:toggle-mini'),
  getState: () => ipcRenderer.invoke('window:get-state'),
  setFullscreen: (flag) => ipcRenderer.invoke('window:set-fullscreen', flag),
  openDownloadFolder: () => ipcRenderer.invoke('download:open-folder'),
  onStateChange: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('window:state-changed', listener);
    return () => ipcRenderer.removeListener('window:state-changed', listener);
  },
};

// 前端契约（web/src/lib/download-saver.ts 的 NativeSaveBridge）是四个不带 id 的方法，
// 所以「当前下载 id」只能由 preload 自己记住。
let activeDownloadId = '';
// 上一次 download:finish 返回的落盘路径，供前端拿到「播放/打开」入口；失败清空
let lastSavedPath = '';

const nativeDownloadBridge = {
  saveBegin: (name) => {
    // 新任务落下来时上一个还没收尾：先丢弃旧流，否则新分片会写进旧文件
    if (activeDownloadId) {
      ipcRenderer.sendSync('download:abort', { id: activeDownloadId });
      activeDownloadId = '';
    }
    const id = ipcRenderer.sendSync('download:begin', { filename: name });
    activeDownloadId = typeof id === 'string' ? id : '';
  },
  saveChunk: (b64) => {
    if (!activeDownloadId) return;
    ipcRenderer.sendSync('download:write', { id: activeDownloadId, base64Chunk: b64 });
  },
  saveEnd: () => {
    if (!activeDownloadId) return false;
    const id = activeDownloadId;
    activeDownloadId = '';
    // sendSync 的 returnValue 就是主进程的落盘结果 { ok, path }，前端据此决定要不要报「保存失败」
    const result = ipcRenderer.sendSync('download:finish', { id });
    lastSavedPath = result && result.ok ? String(result.path || '') : '';
    return Boolean(result && result.ok === true);
  },
  saveAbort: () => {
    if (!activeDownloadId) return;
    const id = activeDownloadId;
    activeDownloadId = '';
    ipcRenderer.sendSync('download:abort', { id });
  },
  getLastSavedPath: () => lastSavedPath,
  openSavedFile: (targetPath) =>
    ipcRenderer.sendSync('download:open-file', String(targetPath || '')) === true,
  openDownloadFolder: () => ipcRenderer.sendSync('download:open-folder') === true,
};

contextBridge.exposeInMainWorld('QTVDesktop', desktopBridge);
contextBridge.exposeInMainWorld('QTV', nativeDownloadBridge);
contextBridge.exposeInMainWorld('LJJTV', nativeDownloadBridge);
