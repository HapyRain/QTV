#!/usr/bin/env node
/**
 * Windows 桌面端冒烟测试：真正拉起 Electron，用 CDP 截图并断言关键运行时状态。
 *
 *   node scripts/smoke-desktop.mjs [--out <目录>] [--keep-open]
 *
 * 断言：
 *   1. 窗口起来后 <html> 带 `qtv-desktop`（说明桌面形态已生效）
 *   2. preload 注入的 window.QTVDesktop 存在且带窗口控制方法
 *   3. 本地 API 服务可用（/api/status 返回版本号）
 *   4. 左侧导航栏渲染出预期数量的入口
 *   5. 首屏截图落盘，便于人工/CI 复核
 *
 * 为什么用 CDP 而不是 electron 的测试框架：本仓库不引入新依赖，
 * Node 20+ 自带 WebSocket 与 fetch，足够驱动 DevTools 协议。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const winDir = path.join(root, 'windows');
const port = 9333;
// 独立配置目录：用户可能正开着 QTV（单实例锁会让新进程直接退出），冒烟必须用干净 profile
const userDataDir = path.join(process.env.TEMP || '.', 'qtv-smoke-profile');

const outArgIndex = process.argv.indexOf('--out');
const outDir = outArgIndex > 0 ? process.argv[outArgIndex + 1] : path.join(root, '.smoke');
const keepOpen = process.argv.includes('--keep-open');

fs.mkdirSync(outDir, { recursive: true });

// 看门狗：Electron/CDP 任何一步无响应都要失败退出，不能把 CI/本地脚本挂死
const watchdog = setTimeout(() => {
  console.error('\n✗ 冒烟超时（120s）：Electron 或 CDP 无响应');
  process.exit(1);
}, 120000);
watchdog.unref?.();

function log(msg) {
  console.log(msg);
}

function waitFor(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询 CDP 列表，拿到页面 target 的 webSocketDebuggerUrl */
async function waitForTarget(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && /127\.0\.0\.1/.test(t.url));
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      /* electron 还没起来 */
    }
    await waitFor(500);
  }
  throw new Error('等待 Electron CDP target 超时');
}

/** 极简 CDP 客户端（一条命令一个 id，按 id 匹配响应） */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let seq = 0;

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (err) => reject(err));
  });

  return {
    ready,
    send(method, params = {}) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }, 10000);
        pending.set(id, {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      ws.close();
    },
  };
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

async function main() {
  const env = { ...process.env };
  // electron 二进制被当成 node 跑会莫名报 ESM 解析错误，这个变量必须清掉
  delete env.ELECTRON_RUN_AS_NODE;

  // --exe 指向打包后的可执行文件（验证 asar 里的 www 能否被本地服务读到）；
  // 默认用 node_modules 里的 electron 跑源码，迭代更快。
  const exeArgIndex = process.argv.indexOf('--exe');
  const packagedExe = exeArgIndex > 0 ? process.argv[exeArgIndex + 1] : null;
  const electronBin =
    packagedExe || path.join(winDir, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(electronBin)) throw new Error(`可执行文件不存在：${electronBin}`);

  log(`[1/5] 启动 ${path.basename(electronBin)} …`);
  const child = spawn(
    electronBin,
    packagedExe
      ? [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`]
      : [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, '.'],
    {
      cwd: packagedExe ? path.dirname(electronBin) : winDir,
      env,
      stdio: 'ignore',
    }
  );
  if (!keepOpen) {
    process.on('exit', () => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    });
  }

  const target = await waitForTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await waitFor(2500); // 等首屏渲染 + 桌面形态切换 + 豆瓣请求

  log('[2/5] 断言桌面形态 …');
  const htmlClass = await evaluate(client, 'document.documentElement.className');
  if (!String(htmlClass).includes('qtv-desktop')) throw new Error(`<html> 未带 qtv-desktop：${htmlClass}`);

  const desktopKeys = await evaluate(client, 'Object.keys(window.QTVDesktop || {}).sort().join(",")');
  for (const key of ['minimize', 'maximize', 'close', 'togglePin', 'toggleMini', 'getState']) {
    if (!String(desktopKeys).includes(key)) throw new Error(`window.QTVDesktop 缺少 ${key}`);
  }
  // 下载桥必须与前端 NativeSaveBridge 契约一致
  const saveKeys = await evaluate(client, 'Object.keys(window.QTV || {}).sort().join(",")');
  for (const key of ['saveBegin', 'saveChunk', 'saveEnd', 'saveAbort']) {
    if (!String(saveKeys).includes(key)) throw new Error(`window.QTV 下载桥缺少 ${key}`);
  }

  log('[3/5] 断言本地 API 服务 …');
  const status = await evaluate(
    client,
    `fetch('/api/status').then(r => r.json()).then(j => JSON.stringify({ version: j.version, platform: j.platform }))`
  );
  const parsed = JSON.parse(status);
  if (!parsed.version) throw new Error('/api/status 未返回版本号');

  log('[4/5] 断言左侧导航 …');
  const navCount = await evaluate(
    client,
    `document.querySelectorAll('aside[aria-label="主导航"] a, aside[aria-label="主导航"] button').length`
  );
  if (Number(navCount) < 5) throw new Error(`左侧导航入口数量异常：${navCount}`);

  if (process.argv.includes('--metrics')) {
    for (const route of ['/', '/live', '/watch']) {
      await evaluate(client, `location.href='${route}'`);
      await waitFor(1800);
      const metrics = await evaluate(
      client,
      `(() => {
        const rect = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), display: cs.display, flex: cs.flex, minH: cs.minHeight };
        };
        return JSON.stringify({
          route: location.pathname,
          body: rect('body'),
          main: rect('.desktop-main'),
          grid: rect('.desktop-main > div'),
          left: rect('.desktop-main section'),
          header: rect('header'),
          playerArea: rect('.desktop-main .bg-black'),
          aspect: rect('.desktop-main .aspect-video'),
          sidePanel: rect('.desktop-main > div > div:last-child'),
          innerH: window.innerHeight,
        });
      })()`
      );
      log(`  metrics ${route}: ${metrics}`);
    }
  }

  log('[5/5] 截图 …');
  // 首次启动会弹使用向导，截图前把它标记为已看过并刷新，拿到干净首页
  await evaluate(client, `localStorage.setItem('qtv-desktop-onboarded-v1', '1')`);
  await client.send('Page.reload', {});
  await waitFor(2600);

  for (const [name, expr] of [
    ['desktop-home', null],
    ['desktop-live', `location.href = '/live'`],
    ['desktop-watch', `location.href = '/watch'`],
  ]) {
    if (expr) {
      await evaluate(client, expr);
      await waitFor(1800);
    }
    const shot = await client.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(outDir, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    log(`  ${file}`);
  }

  client.close();
  if (!keepOpen) child.kill();
  log(`\n✔ 冒烟通过：html=qtv-desktop，桥=${desktopKeys} / ${saveKeys}，API v${parsed.version}，导航 ${navCount} 项`);
}

main().catch((err) => {
  console.error(`\n✗ 冒烟失败：${err.message}`);
  process.exit(1);
});
