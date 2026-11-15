/**
 * Windows 本地 API 契约测试（node:test，零依赖）
 *
 * 背景：桌面端的前端与本地服务是「手写两份、靠约定对齐」的，字段名漂移过一次
 * （搜索读 `query` 而前端发 `wd`，详情把 `source` 当 key 用），导致搜索永远空、详情 400。
 * 这里用真实的前端请求形态把契约钉住，避免同类问题再回归。
 *
 *   node --test windows/local-api-server.test.mjs
 *
 * 出网请求全部用桩替代（不依赖外网），所以 CI 里也能跑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalServer } from './local-api-server.mjs';

/** CMS 采集接口的搜索响应（最小可用结构） */
const CMS_SEARCH_XML = `<?xml version="1.0" encoding="utf-8"?>
<rss version="5.1"><list page="1" pagecount="1" pagesize="20" recordcount="1">
<video><id>101</id><name>测试影片</name><pic>https://img.example.com/101.jpg</pic>
<type>剧情</type><year>2024</year><area>大陆</area><note>HD</note></video>
</list></rss>`;

/** 成人内容夹具：用于验证 filterAdult */
const CMS_SEARCH_ADULT_XML = `<?xml version="1.0" encoding="utf-8"?>
<rss version="5.1"><list page="1" pagecount="1" pagesize="20" recordcount="1">
<video><id>202</id><name>成人测试</name><pic>https://img.example.com/202.jpg</pic>
<type>伦理片</type><year>2024</year><area>日本</area><note>HD</note></video>
</list></rss>`;

/** CMS 采集接口的详情响应 */
const CMS_DETAIL_XML = `<?xml version="1.0" encoding="utf-8"?>
<rss version="5.1"><list page="1" pagecount="1" pagesize="20" recordcount="1">
<video><id>101</id><name>测试影片</name><pic>https://img.example.com/101.jpg</pic>
<type>剧情</type><year>2024</year><note>HD</note><des>简介</des>
<dl><dd flag="m3u8">第1集$https://93.184.216.34/hls/index.m3u8#第2集$https://93.184.216.34/hls/2.m3u8</dd></dl>
</video></list></rss>`;

/** 带 RESOLUTION 的 master playlist，供画质探测 */
const M3U8_TEXT = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720
720/index.m3u8
`;

/** 出网桩：按 URL 返回上面的夹具；未覆盖的 URL 直接 404，避免测试偷偷联网 */
function installFetchStub() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(typeof input === 'string' ? input : input?.url || input);
    if (url.includes('/api.php/provide/vod') && url.includes('ac=videolist') && url.includes('ids=101')) {
      return new Response(CMS_DETAIL_XML, {
        status: 200,
        headers: { 'content-type': 'application/xml; charset=utf-8' },
      });
    }
    if (url.includes('adult=1')) {
      return new Response(CMS_SEARCH_ADULT_XML, {
        status: 200,
        headers: { 'content-type': 'application/xml; charset=utf-8' },
      });
    }
    if (url.includes('/api.php/provide/vod')) {
      return new Response(CMS_SEARCH_XML, {
        status: 200,
        headers: { 'content-type': 'application/xml; charset=utf-8' },
      });
    }
    if (url.includes('.m3u8')) {
      return new Response(M3U8_TEXT, {
        status: 200,
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      });
    }
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  };
  return () => {
    globalThis.fetch = realFetch;
  };
}

/** 启动一个监听随机端口的本地服务 */
async function startServer(options = {}) {
  const server = createLocalServer({ wwwDir: process.cwd() + '/windows/www', ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const request = (pathname, { method = 'GET', body, headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = http.request(
        `${base}${pathname}`,
        {
          method,
          headers: {
            ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              text: Buffer.concat(chunks).toString('utf-8'),
            })
          );
        }
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });

  return {
    base,
    request,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 本地缓存目录（/api/local-file 的围栏根）：测试用系统临时目录，别污染用户 Videos\QTV */
function makeDownloadDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qtv-downloads-'));
  return dir;
}

/** 前端 POST→GET 补丁的真实形态：base64 __body */
function patchedQuery(body) {
  const b64 = Buffer.from(JSON.stringify(body), 'utf-8').toString('base64');
  return `__bodyEnc=1&__body=${encodeURIComponent(b64)}`;
}

const SOURCE = { key: 's1', name: '测试源', url: 'https://93.184.216.34/api.php/provide/vod' };

test('本地 API 契约', async (t) => {
  const restoreFetch = installFetchStub();
  const server = await startServer();
  t.after(async () => {
    await server.close();
    restoreFetch();
  });

  await t.test('/api/search 读取前端字段 wd（POST）', async () => {
    const res = await server.request('/api/search', {
      method: 'POST',
      body: { wd: '测试', sources: [SOURCE], filterAdult: true },
    });
    assert.equal(res.status, 200);
    const data = JSON.parse(res.text);
    assert.equal(data.list.length, 1, 'wd 被正确读取后应搜到 1 条');
    assert.equal(data.list[0].vodId, '101');
    assert.deepEqual(data.failures, []);
  });

  await t.test('/api/search?stream=1 的 NDJSON 事件契约', async () => {
    const res = await server.request(`/api/search?stream=1&${patchedQuery({ wd: '测试', sources: [SOURCE] })}`);
    assert.equal(res.status, 200);
    const events = res.text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const sourceEvent = events.find((e) => e.type === 'source');
    const doneEvent = events.find((e) => e.type === 'done');
    assert.ok(sourceEvent, '应有 type=source 事件');
    assert.equal(sourceEvent.sourceKey, 's1');
    assert.equal(sourceEvent.ok, true);
    assert.equal(sourceEvent.list.length, 1);
    assert.ok(doneEvent, '应有 type=done 事件');
    assert.equal(doneEvent.list.length, 1);
  });

  await t.test('/api/detail 解析 GET 里的 source JSON', async () => {
    const res = await server.request(
      `/api/detail?id=101&source=${encodeURIComponent(JSON.stringify(SOURCE))}`
    );
    assert.equal(res.status, 200, '不应再 400「缺少影片 ID 或数据源地址」');
    const data = JSON.parse(res.text);
    assert.equal(data.videoInfo.title, '测试影片');
    assert.equal(data.episodes.length, 2);
    assert.match(data.episodes[0], /\.m3u8/);
  });

  await t.test('/api/quality?stream=1 先 ping 再逐条结果', async () => {
    const res = await server.request(`/api/quality?stream=1`, {
      method: 'POST',
      body: { items: [{ id: '101', source: SOURCE }] },
    });
    assert.equal(res.status, 200);
    const lines = res.text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.deepEqual(lines[0], { ping: true }, '第一行必须是 ping 心跳');
    const result = lines.find((line) => line.sourceKey === 's1');
    assert.ok(result, '应有探测结果');
    assert.equal(result.height, 1080, '应从 RESOLUTION 取到 1080');
  });

  await t.test('/api/player-state 支持 GET 查询参数（前端真实形态）', async () => {
    const res = await server.request('/api/player-state?paused=1&brightness=0.5&volume=0.8&fullscreen=1');
    assert.equal(res.status, 200);
    const data = JSON.parse(res.text);
    assert.equal(data.state.paused, true);
    assert.equal(data.state.fullscreen, true);
    assert.equal(data.state.brightness, 0.5);
    assert.equal(data.state.volume, 0.8);
  });

  await t.test('/api/status 不返回通配 CORS 头', async () => {
    const res = await server.request('/api/status');
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], undefined, '同源服务不应返回 *');
    assert.equal(JSON.parse(res.text).version, '1.1');
  });

  await t.test('/api/local-file 支持 Range 且只允许下载目录内文件', async () => {
    const downloadDir = makeDownloadDir();
    const payload = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    const file = path.join(downloadDir, 'demo.mp4');
    fs.writeFileSync(file, payload);

    const local = await startServer({ downloadDir });
    try {
      const url = (p) => `/api/local-file?path=${encodeURIComponent(p)}`;

      const full = await local.request(url(file));
      assert.equal(full.status, 200);
      assert.equal(full.headers['accept-ranges'], 'bytes');
      assert.equal(Number(full.headers['content-length']), payload.length);

      const range = await local.request(url(file), { headers: { Range: 'bytes=0-99' } });
      assert.equal(range.status, 206);
      assert.equal(range.headers['content-range'], `bytes 0-99/${payload.length}`);
      assert.equal(Number(range.headers['content-length']), 100);

      const over = await local.request(url(file), { headers: { Range: 'bytes=99999999-' } });
      assert.equal(over.status, 416);

      // 目录围栏：目录外文件必须 403
      const outside = await local.request(url('C:/Windows/win.ini'));
      assert.equal(outside.status, 403);
    } finally {
      await local.close();
      fs.rmSync(downloadDir, { recursive: true, force: true });
    }
  });

  await t.test('SSRF：代理私有 / 特殊协议地址必须被拒', async () => {
    for (const target of [
      'http://127.0.0.1:1/x',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/',
      'http://localhost:8080/',
    ]) {
      const res = await server.request(`/api/proxy?url=${encodeURIComponent(target)}`);
      assert.equal(res.status, 403, `${target} 应被 403 拒绝`);
    }
    const fileRes = await server.request(`/api/proxy?url=${encodeURIComponent('file:///C:/Windows/win.ini')}`);
    assert.equal(fileRes.status, 400, 'file:// 应被 400 拒绝');
  });
});

test('安全边界：Host / SSRF 保留段 / 成人过滤', async (t) => {
  const restoreFetch = installFetchStub();
  const server = await startServer();
  t.after(async () => {
    await server.close();
    restoreFetch();
  });

  await t.test('伪造 Host 必须 400（DNS rebinding）', async () => {
    const res = await server.request('/api/status', { headers: { host: 'evil-rebind.example' } });
    assert.equal(res.status, 400);
  });

  await t.test('CGNAT / 组播 / 保留段必须被 SSRF 闸门拒绝', async () => {
    for (const target of [
      'http://100.64.0.1/',
      'http://100.100.100.100/',
      'http://224.0.0.1/',
      'http://240.0.0.1/',
      'http://[ff02::1]/',
    ]) {
      const res = await server.request(`/api/proxy?url=${encodeURIComponent(target)}`);
      assert.equal(res.status, 403, `${target} 不应被放行`);
    }
  });

  await t.test('filterAdult 对条目级成人内容生效', async () => {
    const source = {
      key: 'adult',
      name: '成人源',
      url: 'https://93.184.216.34/api.php/provide/vod?adult=1',
    };
    const filtered = await server.request('/api/search', {
      method: 'POST',
      body: { wd: '测试', sources: [source], filterAdult: true },
    });
    assert.equal(filtered.status, 200);
    assert.equal(JSON.parse(filtered.text).list.length, 0, '开启过滤时应剔除伦理片');

    const raw = await server.request('/api/search', {
      method: 'POST',
      body: { wd: '测试', sources: [source], filterAdult: false },
    });
    assert.equal(raw.status, 200);
    assert.equal(JSON.parse(raw.text).list.length, 1, '关闭过滤时应保留');
  });
});