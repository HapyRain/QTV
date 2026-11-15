/**
 * QTV for Windows - Native Electron Main Process
 * Features:
 * - Frameless Windows 11 Mica/Acrylic Window with custom caption controls
 * - Embedded 127.0.0.1 LocalApi HTTP server (zero external backend required)
 * - Always-on-Top Pin & 16:9 Floating Mini-Player Mode
 * - Native Chunked Stream-to-Disk MP4 Downloader (saves directly to Videos\QTV)
 * - System Tray & Window Bounds Persistence
 */

import { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createLocalServer } from './local-api-server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Hardware video decoding & smooth compositing flags for Windows
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport,HardwareMediaKeyHandling');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');

let mainWindow = null;
let tray = null;
let serverPort = 18689;
let isMiniMode = false;
let normalBounds = { width: 1440, height: 900 };
// 只有托盘「退出」/app.quit() 才真正退出，关窗默认只是隐藏到托盘
let isQuitting = false;
let stateSaveTimer = null;
const activeDownloads = new Map();

function getStateFilePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  try {
    const raw = fs.readFileSync(getStateFilePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.width >= 1024 && parsed.height >= 640) {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return { width: 1440, height: 900, isMaximized: false };
}

function saveWindowState() {
  if (stateSaveTimer) {
    clearTimeout(stateSaveTimer);
    stateSaveTimer = null;
  }
  if (!mainWindow || isMiniMode) return;
  try {
    const isMaximized = mainWindow.isMaximized();
    // 最大化时存 normalBounds 作为还原尺寸；最小化时 getBounds 是最小化坐标，同样不能存
    const bounds =
      isMaximized || mainWindow.isMinimized() ? normalBounds : mainWindow.getBounds();
    fs.writeFileSync(
      getStateFilePath(),
      JSON.stringify({ ...bounds, isMaximized }),
      'utf-8'
    );
  } catch {
    /* ignore */
  }
}

function scheduleWindowStateSave() {
  if (stateSaveTimer) clearTimeout(stateSaveTimer);
  // 拖动/缩放会连发高频 resize，落盘防抖 300ms
  stateSaveTimer = setTimeout(() => {
    stateSaveTimer = null;
    saveWindowState();
  }, 300);
}

function getDefaultDownloadDir() {
  const videosDir = app.getPath('videos') || path.join(os.homedir(), 'Videos');
  const qtvDir = path.join(videosDir, 'QTV');
  fs.mkdirSync(qtvDir, { recursive: true });
  return qtvDir;
}

/** shell.openPath 是异步的（返回错误串），同步回包前只能先做存在性校验 */
function revealPath(target) {
  shell
    .openPath(target)
    .then((err) => {
      if (err) console.error('[QTV] 打开失败:', target, err);
    })
    .catch((err) => console.error('[QTV] 打开失败:', target, err?.message || err));
}

/** 打开下载目录；失败返回空串 */
function openDownloadDir() {
  try {
    const dir = getDefaultDownloadDir();
    revealPath(dir);
    return dir;
  } catch (err) {
    console.error('[QTV] 打开缓存目录失败:', err?.message || err);
    return '';
  }
}

/** 只允许打开下载目录内的文件：渲染层传来的路径不可信，出界一律拒绝 */
function openDownloadedFile(target) {
  try {
    const dir = getDefaultDownloadDir();
    const norm = (p) => path.resolve(p).toLowerCase();
    const file = norm(String(target || ''));
    if (!file.startsWith(norm(dir) + path.sep)) return false;
    if (!fs.statSync(file).isFile()) return false;
    revealPath(file);
    return true;
  } catch (err) {
    console.error('[QTV] 打开缓存文件失败:', target, err?.message || err);
    return false;
  }
}

async function startEmbeddedServer() {
  const server = createLocalServer({
    wwwDir: fs.existsSync(path.join(__dirname, 'www', 'index.html'))
      ? path.join(__dirname, 'www')
      : path.resolve(__dirname, '..', 'app', 'src', 'main', 'assets', 'www'),
    // /api/local-file 只允许读这个目录，和下载落盘目录必须是同一个
    downloadDir: getDefaultDownloadDir(),
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      serverPort = typeof addr === 'object' && addr ? addr.port : 18689;
      resolve(serverPort);
    });
  });
}

function createWindow(port) {
  const state = loadWindowState();
  normalBounds = { width: state.width, height: state.height, x: state.x, y: state.y };

  const iconPath = path.join(__dirname, 'assets', 'icon.ico');

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 1040,
    minHeight: 660,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#07090e',
    backgroundMaterial: 'mica',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      webSecurity: true,
    },
  });

  if (state.isMaximized) {
    mainWindow.maximize();
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window:state-changed', {
      isMaximized: true,
      isAlwaysOnTop: mainWindow.isAlwaysOnTop(),
      isMiniMode,
    });
  });

  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window:state-changed', {
      isMaximized: false,
      isAlwaysOnTop: mainWindow.isAlwaysOnTop(),
      isMiniMode,
    });
  });

  mainWindow.on('enter-full-screen', () => {
    mainWindow.webContents.send('window:state-changed', {
      isMaximized: mainWindow.isMaximized(),
      isAlwaysOnTop: mainWindow.isAlwaysOnTop(),
      isMiniMode,
      isFullscreen: true,
    });
  });

  mainWindow.on('leave-full-screen', () => {
    mainWindow.webContents.send('window:state-changed', {
      isMaximized: mainWindow.isMaximized(),
      isAlwaysOnTop: mainWindow.isAlwaysOnTop(),
      isMiniMode,
      isFullscreen: false,
    });
  });

  mainWindow.on('resize', () => {
    if (!mainWindow.isMaximized() && !isMiniMode) {
      normalBounds = mainWindow.getBounds();
      scheduleWindowStateSave();
    }
  });

  mainWindow.on('close', (event) => {
    saveWindowState();
    // 关窗 = 收进托盘；只有 before-quit 置位后（托盘退出/app.quit）才真正销毁
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // 只信任本地服务这一个源，其余跳转一律拦下（外链已由 setWindowOpenHandler 交给系统浏览器）
  const allowedOrigin = `http://127.0.0.1:${port}`;
  mainWindow.webContents.on('will-navigate', (event, url) => {
    let origin = '';
    try {
      origin = new URL(url).origin;
    } catch {
      /* 非法 URL 按站外处理 */
    }
    if (origin !== allowedOrigin) event.preventDefault();
  });

  // 摄像头/麦克风/通知/剪贴板等一概不需要，默认拒绝
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function setupTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.ico');
  if (!fs.existsSync(iconPath)) return;
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip('QTV');
  const menu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: showMainWindow,
    },
    {
      label: '打开离线缓存目录',
      click: () => {
        shell.openPath(getDefaultDownloadDir());
      },
    },
    { type: 'separator' },
    {
      label: '退出 QTV',
      click: () => {
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', showMainWindow);
}

function registerIpcHandlers() {
  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize();
  });

  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
      return false;
    } else {
      mainWindow.maximize();
      return true;
    }
  });

  ipcMain.handle('window:close', () => {
    mainWindow?.close();
  });

  ipcMain.handle('window:toggle-pin', () => {
    if (!mainWindow) return false;
    const next = !mainWindow.isAlwaysOnTop();
    mainWindow.setAlwaysOnTop(next, 'floating');
    mainWindow.webContents.send('window:state-changed', {
      isMaximized: mainWindow.isMaximized(),
      isAlwaysOnTop: next,
      isMiniMode,
    });
    return next;
  });

  ipcMain.handle('window:toggle-mini', () => {
    if (!mainWindow) return false;
    isMiniMode = !isMiniMode;
    if (isMiniMode) {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      normalBounds = mainWindow.getBounds();
      mainWindow.setMinimumSize(420, 250);
      mainWindow.setBounds({ width: 520, height: 310 });
      mainWindow.setAlwaysOnTop(true, 'floating');
    } else {
      mainWindow.setMinimumSize(1040, 660);
      mainWindow.setBounds(normalBounds);
      mainWindow.setAlwaysOnTop(false);
    }
    mainWindow.webContents.send('window:state-changed', {
      isMaximized: mainWindow.isMaximized(),
      isAlwaysOnTop: mainWindow.isAlwaysOnTop(),
      isMiniMode,
    });
    return isMiniMode;
  });

  ipcMain.handle('window:set-fullscreen', (_event, flag) => {
    if (!mainWindow) return false;
    mainWindow.setFullScreen(Boolean(flag));
    return mainWindow.isFullScreen();
  });

  ipcMain.handle('window:get-state', () => {
    if (!mainWindow) {
      return { isMaximized: false, isAlwaysOnTop: false, isMiniMode: false, platform: 'windows', version: '1.0' };
    }
    return {
      isMaximized: mainWindow.isMaximized(),
      isAlwaysOnTop: mainWindow.isAlwaysOnTop(),
      isMiniMode,
      isFullscreen: mainWindow.isFullScreen(),
      platform: 'windows',
      version: app.getVersion() || '1.0',
      downloadDir: getDefaultDownloadDir(),
    };
  });

  ipcMain.handle('download:open-folder', () => openDownloadDir());

  // preload 的 window.QTV 用 sendSync，和上面的 invoke 版共用同一频道：两个通道机制互不影响
  ipcMain.on('download:open-folder', (event) => {
    event.returnValue = openDownloadDir() !== '';
  });

  ipcMain.on('download:open-file', (event, target) => {
    event.returnValue = openDownloadedFile(target);
  });

  // Chunked stream-to-disk download bridge compatible with window.QTV
  ipcMain.on('download:begin', (event, { filename }) => {
    try {
      const safeName = String(filename || `QTV_${Date.now()}.mp4`).replace(/[<>:"/\\|?*]+/g, '_');
      const targetPath = path.join(getDefaultDownloadDir(), safeName);
      const id = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const stream = fs.createWriteStream(targetPath);
      const item = { stream, targetPath, error: '' };
      // 磁盘满/权限错误只会以异步 error 事件冒出来，同步 write 不会抛，
      // 所以先记下来，让后续 sendSync 如实返回 false
      stream.on('error', (err) => {
        item.error = err?.message || String(err);
        console.error('[QTV] 写下载分片失败:', targetPath, item.error);
      });
      activeDownloads.set(id, item);
      event.returnValue = id;
    } catch (err) {
      console.error('[QTV] 创建下载文件失败:', filename, err?.message || err);
      event.returnValue = '';
    }
  });

  ipcMain.on('download:write', (event, { id, base64Chunk }) => {
    const item = activeDownloads.get(id);
    if (!item || item.error) {
      event.returnValue = false;
      return;
    }
    try {
      item.stream.write(Buffer.from(base64Chunk, 'base64'));
      event.returnValue = !item.error;
    } catch (err) {
      item.error = err?.message || String(err);
      console.error('[QTV] 写下载分片失败:', item.targetPath, item.error);
      event.returnValue = false;
    }
  });

  ipcMain.on('download:finish', (event, { id }) => {
    // 回 { ok, path }：前端要拿落盘路径做「播放 / 打开文件夹」入口，只回 true/false 等于没存
    const failed = () => {
      event.returnValue = { ok: false, path: '' };
    };
    const item = activeDownloads.get(id);
    if (!item) {
      failed();
      return;
    }
    activeDownloads.delete(id);
    if (item.error) {
      failed();
      return;
    }
    try {
      item.stream.end();
      event.returnValue = { ok: true, path: item.targetPath };
    } catch (err) {
      console.error('[QTV] 收尾下载文件失败:', item.targetPath, err?.message || err);
      failed();
    }
  });

  ipcMain.on('download:abort', (event, { id }) => {
    const item = activeDownloads.get(id);
    if (item) {
      try {
        item.stream.destroy();
        fs.unlinkSync(item.targetPath);
      } catch {
        /* ignore */
      }
      activeDownloads.delete(id);
    }
    event.returnValue = true;
  });
}

// 单实例：第二个进程直接退出，避免两份窗口抢同一个 window-state 和本地端口
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  // 托盘「退出」/app.quit() 会先走 before-quit，close 处理器靠这个标志放行销毁
  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.whenReady().then(async () => {
    registerIpcHandlers();
    const port = await startEmbeddedServer();
    createWindow(port);
    setupTray();
  });
}
