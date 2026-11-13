#!/usr/bin/env node
/**
 * 前端静态导出 → Android & iOS 双端资产 一键构建（跨平台，Node 18+）
 *
 *   node scripts/build-web.mjs
 *
 * 做的是「构建期手术」，前端源码零改动：
 *   1. 复制 web/ 到 .web-build/（排除 node_modules/.next/.git，node_modules 用软链复用）
 *   2. 删除 src/app/api（App 内 API 全部由 Android Kotlin / iOS Swift 本地层实现）
 *   3. next.config 打开 output:'export'；manifest 路由补 force-static
 *   4. Service Worker 置空（WebView 下会干扰原生请求拦截）
 *   5. 给所有 HTML 注入 fetch 补丁：POST → GET + base64 __body
 *      （Android shouldInterceptRequest 与 iOS WKURLSchemeHandler 读不到 POST body）
 *   6. out/ 同时同步到 Android (app/src/main/assets/www) 与 iOS (ios/QTV/Resources/www)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const webDir = path.join(root, 'web');
const buildDir = path.join(root, '.web-build');
const outDir = path.join(buildDir, 'out');
const androidWwwDir = path.join(root, 'app', 'src', 'main', 'assets', 'www');
const iosWwwDir = path.join(root, 'ios', 'QTV', 'Resources', 'www');

const log = (msg) => console.log(msg);
const fail = (msg) => {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
};

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.status !== 0) fail(`${cmd} ${args.join(' ')} 失败（exit ${res.status}）`);
}

function runNode(entry, args, cwd) {
  const res = spawnSync(process.execPath, [entry, ...args], { cwd, stdio: 'inherit' });
  if (res.status !== 0) fail(`${path.basename(entry)} ${args.join(' ')} 失败（exit ${res.status}）`);
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full));
  }
  return out;
}

if (!fs.existsSync(path.join(webDir, 'package.json'))) fail('web/package.json 不存在，仓库不完整');

// 1) 准备临时副本
log('[1/6] 准备临时副本…');
if (!fs.existsSync(path.join(webDir, 'node_modules'))) {
  log('  web/node_modules 缺失，先 npm install…');
  run('npm', ['install', '--no-audit', '--no-fund'], webDir);
}
fs.rmSync(buildDir, { recursive: true, force: true });
const skip = new Set(['node_modules', '.next', '.git']);
fs.cpSync(webDir, buildDir, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(webDir, src);
    if (!rel) return true;
    const top = rel.split(path.sep)[0];
    if (skip.has(top)) return false;
    if (/\.env(\.|$)/.test(path.basename(src))) return false;
    if (src.endsWith('.log')) return false;
    return true;
  },
});
fs.symlinkSync(
  path.join(webDir, 'node_modules'),
  path.join(buildDir, 'node_modules'),
  process.platform === 'win32' ? 'junction' : 'dir',
);

// 2) 构建期手术
log('[2/6] 构建期手术（api 路由 / export / SW）…');
fs.rmSync(path.join(buildDir, 'src', 'app', 'api'), { recursive: true, force: true });

const nextConfigPath = path.join(buildDir, 'next.config.ts');
let nextConfig = fs.readFileSync(nextConfigPath, 'utf8');
const standaloneLine = "output: process.env.DOCKER_BUILD === '1' ? 'standalone' : undefined,";
if (nextConfig.includes(standaloneLine)) {
  nextConfig = nextConfig.replace(standaloneLine, "output: 'export',");
} else if (/output:\s*'export'/.test(nextConfig)) {
  // 已经是 export
} else {
  fail('next.config.ts 未找到 output 配置行，构建脚本需要同步更新');
}
fs.writeFileSync(nextConfigPath, nextConfig);

fs.writeFileSync(
  path.join(buildDir, 'public', 'sw.js'),
  "self.addEventListener('install', (e) => self.skipWaiting());self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));\n",
  'ascii',
);

const manifestPath = path.join(buildDir, 'src', 'app', 'manifest.ts');
let manifest = fs.readFileSync(manifestPath, 'utf8');
if (!manifest.includes('force-static')) {
  fs.writeFileSync(manifestPath, "export const dynamic = 'force-static';\n" + manifest);
}

// 3) 静态导出
log('[3/6] next build（静态导出）…');
runNode(path.join(buildDir, 'node_modules', 'next', 'dist', 'bin', 'next'), ['build'], buildDir);
if (!fs.existsSync(path.join(outDir, 'index.html'))) fail('静态导出失败：out/index.html 不存在');

// 4) 注入 fetch 补丁
log('[4/6] 注入 fetch 补丁（POST → GET + base64 __body）…');
const patch =
  '<script>(function(){var o=window.fetch;window.fetch=function(i,x){try{var m=((x&&x.method)||(i&&i.method)||"GET").toUpperCase();var u=(typeof i==="string")?i:(i&&i.url);if(m==="POST"&&u&&u.indexOf("/api/")>-1&&x&&typeof x.body==="string"){var enc=new TextEncoder().encode(x.body);var bin="";for(var k=0;k<enc.length;k++)bin+=String.fromCharCode(enc[k]);var a=new URL(u,location.href);a.searchParams.set("__body",btoa(bin));a.searchParams.set("__bodyEnc","1");var o2=Object.assign({},x,{method:"GET"});delete o2.body;if(o2.headers){try{delete o2.headers["Content-Type"];delete o2.headers["content-type"];}catch(e){}}return o(a.pathname+a.search,o2);}}catch(e){}return o(i,x);};})();</script>';
for (const rel of walk(outDir).filter((f) => f.endsWith('.html'))) {
  const file = path.join(outDir, rel);
  let html = fs.readFileSync(file, 'utf8');
  if (html.includes('__body')) continue;
  if (!html.includes('<head>')) fail(`${rel} 里没有 <head>，无法注入 fetch 补丁`);
  html = html.replace('<head>', `<head>${patch}`);
  fs.writeFileSync(file, html);
  log(`  patched: ${rel}`);
}

// 5) 同步到 Android 与 iOS 资产目录
log('[5/6] 同步到 Android (app/src/main/assets/www) 与 iOS (ios/QTV/Resources/www)…');
fs.rmSync(androidWwwDir, { recursive: true, force: true });
fs.cpSync(outDir, androidWwwDir, { recursive: true });

if (fs.existsSync(path.join(root, 'ios'))) {
  fs.rmSync(iosWwwDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(iosWwwDir), { recursive: true });
  fs.cpSync(outDir, iosWwwDir, { recursive: true });
}

const count = walk(androidWwwDir).length;
const bytes = walk(androidWwwDir).reduce((sum, f) => sum + fs.statSync(path.join(androidWwwDir, f)).size, 0);
log(`[6/6] 完成：${count} 个文件，${(bytes / 1024 / 1024).toFixed(2)} MB`);
log('Android 构建：./gradlew :app:assembleDebug');
log('iOS 构建：使用 Xcode 打开 ios/QTV.xcodeproj 或通过 GitHub Actions 构建 IPA');
