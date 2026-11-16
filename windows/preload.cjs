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
// 待发送分片：sendSync 会阻塞渲染进程，49KB 一块发一次等于一集上万次同步 IPC。
// 攒到 ~768KB 再发，往返次数降到原来的 1/15。注意不能直接拼 base64 字符串：
// 最后一块可能带填充符，拼接后会出现在中间导致解码错位，所以按字节缓存。
const FLUSH_BYTES = 768 * 1024;
let pendingChunks = [];
let pendingBytes = 0;
let chunkFailed = false;

function flushChunks() {
  if (pendingBytes === 0) return true;
  const chunk = Buffer.concat(pendingChunks, pendingBytes);
  pendingChunks = [];
  pendingBytes = 0;
  if (chunkFailed) return false;
  const ok = ipcRenderer.sendSync('download:write', { id: activeDownloadId, base64Chunk: chunk.toString('base64') });
  if (ok !== true) {
    // 磁盘满/句柄失效：后续分片不再入队，让 finish 如实回报失败
    chunkFailed = true;
    return false;
  }
  return true;
}

const nativeDownloadBridge = {
  saveBegin: (name) => {
    // 新任务落下来时上一个还没收尾：先丢弃旧流，否则新分片会写进旧文件
    if (activeDownloadId) {
      pendingChunks = [];
      pendingBytes = 0;
      chunkFailed = false;
      ipcRenderer.sendSync('download:abort', { id: activeDownloadId });
      activeDownloadId = '';
    }
    const id = ipcRenderer.sendSync('download:begin', { filename: name });
    activeDownloadId = typeof id === 'string' ? id : '';
    pendingChunks = [];
    pendingBytes = 0;
    chunkFailed = false;
  },
  saveChunk: (b64) => {
    if (!activeDownloadId || chunkFailed) return;
    const buf = Buffer.from(b64, 'base64');
    pendingChunks.push(buf);
    pendingBytes += buf.length;
    if (pendingBytes >= FLUSH_BYTES) flushChunks();
  },
  saveEnd: () => {
    if (!activeDownloadId) return false;
    // 先落最后一批分片，再收尾：否则尾部数据会丢在缓冲区里
    flushChunks();
    const id = activeDownloadId;
    activeDownloadId = '';
    pendingChunks = [];
    pendingBytes = 0;
    // sendSync 的 returnValue 就是主进程的落盘结果 { ok, path }，前端据此决定要不要报「保存失败」
    const result = ipcRenderer.sendSync('download:finish', { id });
    lastSavedPath = result && result.ok ? String(result.path || '') : '';
    chunkFailed = false;
    return Boolean(result && result.ok === true);
  },
  saveAbort: () => {
    pendingChunks = [];
    pendingBytes = 0;
    chunkFailed = false;
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
