package org.qtv.app.api

import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.nio.charset.StandardCharsets
import java.util.concurrent.LinkedBlockingQueue
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.qtv.app.BuildConfig
import org.qtv.app.core.network.NetClient
import org.qtv.app.data.cms.CmsApi
import org.qtv.app.data.cms.CmsParser
import org.qtv.app.data.cms.SearchItem
import org.qtv.app.data.cms.SearchRepository
import org.qtv.app.data.cms.SourceConfig
import org.qtv.app.data.cms.SourceOutcome
import org.qtv.app.data.live.EpgProgram
import org.qtv.app.data.live.M3uParser
import org.qtv.app.data.live.XmltvParser
import org.qtv.app.data.quality.QualityProbe
import org.qtv.app.data.subscription.SubscriptionParser

/**
 * 本地 /api/... 实现层（独立版核心）：网页前端原封不动，其全部服务端请求
 * 由本层在 App 内消化 —— 无电脑、无密码、无端口。
 *
 * 契约对齐 LibreTV `src/lib/client-api.ts`：
 * - POST 请求已被 www 注入的 fetch 补丁改写为 GET + `__body` 查询参数（拦截器拿不到 POST body）；
 * - /api/search?stream=1 返回 NDJSON（逐源结算即推 + done），非流式返回 SearchResponse；
 * - /api/proxy 直连转发（UA/Referer 防盗链，封面与 m3u8 分片全走这里，天然绕开 CORS）。
 */
/** 原生侧宿主回调：播放状态（沉浸式状态栏）、亮度、音量——由 MainActivity 实现 */
interface PlayerHost {
    fun onPlaybackPaused(paused: Boolean)
    fun onFullscreenChanged(fullscreen: Boolean) {}
    fun setBrightness(value: Float)
    fun setVolume(value: Float)
    /** 当前窗口亮度（0..1），-1 = 未知（交给前端回退） */
    fun currentBrightness(): Float
    /** 当前媒体音量（0..1） */
    fun currentVolume(): Float
}

object LocalApi {

    /**
     * 后台任务池（搜索 / 画质 / 测活共用）。
     * 之前每处都直接 `Thread { }.start()`：请求被中止或快速切页时线程数没有上界，
     * 高频探测能把进程线程数顶到几百个。这里固定上限 + 有界队列，提交失败时
     * 立即 finish 队列，前端拿到空结果而不是挂住。
     */
    private val ioPool = java.util.concurrent.ThreadPoolExecutor(
        2,
        8,
        30L,
        java.util.concurrent.TimeUnit.SECONDS,
        java.util.concurrent.ArrayBlockingQueue(32),
        { r -> Thread(r, "qtv-local-api").apply { isDaemon = true } },
        java.util.concurrent.ThreadPoolExecutor.AbortPolicy(),
    )

    /** 提交后台任务；池已满/已关闭时立即收尾队列，让前端拿到结束信号而不是一直等 */
    private fun submit(queue: QueueInputStream, task: () -> Unit) {
        try {
            ioPool.execute { try { task() } catch (_: Throwable) { /* 已兜底 */ } finally { queue.finish() } }
        } catch (_: Throwable) {
            queue.finish()
        }
    }

    /**
     * 批量探测专用池：/api/quality 一次最多 50 条目，外层 ioPool 若用它并行会自锁
     * （任务线程 join 同池任务），所以单独一个 6 线程池兜住并发。
     */
    private val probePool = java.util.concurrent.Executors.newFixedThreadPool(6) { r ->
        Thread(r, "qtv-probe").apply { isDaemon = true }
    }

    /** MainActivity 注入；为空时 /api/player-state 只回 204 */
    @Volatile
    var playerHost: PlayerHost? = null

    /** MainActivity 注入的 applicationContext：/api/local-file 读缓存文件用（contentResolver + 下载目录） */
    @Volatile
    var appContext: android.content.Context? = null

    fun handle(request: WebResourceRequest): WebResourceResponse? {
        val uri = request.url ?: return null
        val path = uri.path ?: return null
        return try {
            when {
                path == "/api/status" -> json(statusJson())
                path == "/api/auth" -> json("""{"success":true}""")
                path == "/api/search" -> search(
                    decodeBody(uri.getQueryParameter("__body"), uri.getQueryParameter("__bodyEnc") == "1"),
                    uri.getBooleanQuery("stream"),
                )
                path == "/api/detail" -> detail(uri)
                path == "/api/player-state" -> playerState(uri)
                path == "/api/local-file" -> localFile(uri, request.requestHeaders)
                path == "/api/proxy" || path == "/api/live/stream" -> proxy(uri.getQueryParameter("url"), uri.getBooleanQuery("adFilter"))
                path == "/api/quality" -> quality(
                    decodeBody(uri.getQueryParameter("__body"), uri.getQueryParameter("__bodyEnc") == "1"),
                    uri.getBooleanQuery("stream"),
                )
                path == "/api/source/test" -> sourceTest(
                    decodeBody(uri.getQueryParameter("__body"), uri.getQueryParameter("__bodyEnc") == "1"),
                )
                path == "/api/source-list" -> sourceList(uri.getQueryParameter("url"))
                path == "/api/publish" -> jsonErr("App 版暂不支持发布")
                path == "/api/douban" || path == "/api/hot-list" -> douban(uri)
                path == "/api/bangumi/calendar" -> json("""{"days":[]}""")
                path == "/api/live/playlist" -> livePlaylist(uri)
                path == "/api/live/epg" -> liveEpg(uri)
                path == "/api/live/probe" -> liveProbe(
                    decodeBody(uri.getQueryParameter("__body"), uri.getQueryParameter("__bodyEnc") == "1"),
                    uri.getBooleanQuery("stream"),
                )
                else -> jsonErr("未知接口 $path", 404)
            }
        } catch (e: Throwable) {
            jsonErr(e.message ?: "本地接口异常", 500)
        }
    }

    // —— 工具 ——
    private fun android.net.Uri.getBooleanQuery(key: String): Boolean =
        getQueryParameter(key) == "1" || getQueryParameter(key) == "true"

    private fun json(body: String, code: Int = 200): WebResourceResponse =
        WebResourceResponse(
            "application/json", "utf-8", code, "OK", corsHeaders(), ByteArrayInputStream(body.toByteArray())
        )

    private fun jsonErr(msg: String, code: Int = 400): WebResourceResponse =
        json(JSONObject().put("error", msg).toString(), code)

    private fun ndjson(body: String): WebResourceResponse =
        WebResourceResponse(
            "application/x-ndjson", "utf-8", 200, "OK", corsHeaders(), ByteArrayInputStream(body.toByteArray())
        )

    private fun corsHeaders(): Map<String, String> =
        mapOf("Access-Control-Allow-Origin" to "*", "Cache-Control" to "no-store")

    /** body 经查询串传输：新版 base64（__bodyEnc=1），旧版明文兜底（URLSearchParams 与 Android Uri 的 '+' 语义不一致，明文会暗损） */
    private fun decodeBody(raw: String?, base64: Boolean): String {
        if (raw.isNullOrBlank()) return "{}"
        if (!base64) return raw
        return try {
            String(android.util.Base64.decode(raw, android.util.Base64.DEFAULT), Charsets.UTF_8)
        } catch (_: Exception) {
            raw
        }
    }
    private fun parseBody(raw: String?): JSONObject = try {
        JSONObject(raw ?: "{}")
    } catch (_: Exception) {
        JSONObject()
    }

    // —— /api/status：无密码、无需登录（用户需求「密码删了」） ——
    private fun statusJson(): String = JSONObject()
        .put("passwordRequired", false)
        .put("verified", true)
        .put("version", BuildConfig.VERSION_NAME)
        .put("instanceId", "local")
        .put("defaultSources", JSONArray())
        .put("defaultLiveSources", JSONArray())
        .put("defaultSubscriptions", JSONArray())
        .put("defaultRecommendSource", JSONObject.NULL)
        .put("defaultImageMode", JSONObject.NULL)
        .toString()

    // —— /api/search ——
    private fun search(bodyRaw: String?, stream: Boolean): WebResourceResponse {
        val body = parseBody(bodyRaw)
        val wd = body.optString("wd", "")
        val filterAdult = body.optBoolean("filterAdult", true)
        val sources = parseSources(body.optJSONArray("sources"))
        if (sources.isEmpty()) return json(bridgeLostDone(stream))
        if (!stream) {
            // 非流式也异步返回：shouldInterceptRequest 拿到 QueueInputStream 立即返回，
            // 不再用 runBlocking 占住 WebView 的请求线程（多源并发时会互相饿死）
            val queue = QueueInputStream()
            submit(queue) {
                try {
                    val outcomes = ArrayList<SourceOutcome>()
                    runBlocking {
                        SearchRepository.search(wd, sources, filterAdult) { outcomes.add(it) }
                    }
                    queue.offer((buildDone(outcomes).toString() + "\n").toByteArray())
                } catch (e: Throwable) {
                    queue.offer(
                        (JSONObject().put("type", "done").put("list", JSONArray()).put("failures", JSONArray()).toString() + "\n").toByteArray()
                    )
                }
            }
            return WebResourceResponse("application/json", "utf-8", 200, "OK", corsHeaders(), queue)
        }
        // NDJSON 流：逐源结算即推（前端边搜边渲染的体验与网页版一致）
        val queue = QueueInputStream()
        submit(queue) {
            try {
                runBlocking {
                    val outcomes = ArrayList<SourceOutcome>()
                    SearchRepository.search(wd, sources, filterAdult) { o ->
                        outcomes.add(o)
                        queue.offer((sourceEvent(o).toString() + "\n").toByteArray())
                    }
                    queue.offer((buildDone(outcomes).toString() + "\n").toByteArray())
                }
            } catch (e: Throwable) {
                queue.offer((JSONObject().put("type", "done").put("list", JSONArray()).put("failures", JSONArray()).toString() + "\n").toByteArray())
            }
        }
        return WebResourceResponse("application/x-ndjson", "utf-8", 200, "OK", corsHeaders(), queue)
    }

    private fun parseSources(arr: JSONArray?): List<SourceConfig> {
        if (arr == null) return emptyList()
        val out = ArrayList<SourceConfig>()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val url = o.optString("url", "")
            if (url.isBlank()) continue
            out.add(
                SourceConfig(
                    key = o.optString("key", "src_$i"),
                    name = o.optString("name", url),
                    url = url,
                    detail = o.optString("detail", "").ifBlank { null },
                    isAdult = o.optBoolean("isAdult", false),
                )
            )
        }
        return out
    }

    private fun stamp(item: SearchItem, src: SourceConfig): JSONObject = JSONObject()
        .put("sourceKey", src.key)
        .put("sourceName", src.name)
        .put("vodId", item.vodId)
        .put("name", item.name)
        .put("pic", item.pic ?: JSONObject.NULL)
        .put("typeName", item.typeName ?: JSONObject.NULL)
        .put("year", item.year ?: JSONObject.NULL)
        .put("area", item.area ?: JSONObject.NULL)
        .put("remarks", item.remarks ?: JSONObject.NULL)
        .put("sourceUrl", src.url)
        .put("isAdult", src.isAdult)

    private fun sourceEvent(o: SourceOutcome): JSONObject = JSONObject()
        .put("type", "source")
        .put("sourceKey", o.source.key)
        .put("ok", o.ok)
        .put("list", JSONArray().apply { o.list.forEach { put(stamp(it, o.source)) } })
        .put("error", o.error ?: JSONObject.NULL)
        .put("timedOut", o.timedOut)
        .put("ms", o.ms)

    /** done 事件：聚合（去重 → 排序），结构与 SearchResponse 一致 */
    private fun buildDone(outcomes: List<SourceOutcome>): JSONObject {
        val seen = HashSet<String>()
        val merged = ArrayList<Pair<SourceConfig, SearchItem>>()
        for (o in outcomes) for (item in o.list) {
            val key = "${o.source.key}_${item.vodId}"
            if (seen.add(key)) merged.add(o.source to item)
        }
        val sorted = merged.sortedWith(
            compareBy<Pair<SourceConfig, SearchItem>> {
                // 精确命中优先按查询归一化比较交给前端已排序顺序；此处与 aggregateOutcomes 对齐：
                // 名称序为主（前端 done 直接用此列表）
                it.second.name
            }
        )
        val list = JSONArray().apply { sorted.forEach { (src, item) -> put(stamp(item, src)) } }
        val failures = JSONArray().apply {
            outcomes.filter { !it.ok }.forEach {
                put(
                    JSONObject()
                        .put("sourceKey", it.source.key)
                        .put("error", it.error ?: "请求失败")
                        .put("timedOut", it.timedOut)
                )
            }
        }
        return JSONObject().put("type", "done").put("list", list).put("failures", failures)
    }

    /** /api/source-list：拉取远程订阅并解析三格式（LibreTV-SourceList / TVBOX / 接口目录） */
    private fun sourceList(rawUrl: String?): WebResourceResponse {
        val target = SubscriptionParser.normalizeSubscriptionUrl(rawUrl ?: "")
        if (!target.startsWith("http://", true) && !target.startsWith("https://", true)) {
            return jsonErr("无效的订阅地址")
        }
        val (text, _) = NetClient.getText(target) ?: return jsonErr("订阅拉取失败", 502)
        val payload = try {
            SubscriptionParser.parseSubscriptionPayload(SubscriptionParser.parseSubscriptionJson(text))
        } catch (e: SubscriptionParser.SubscriptionFormatException) {
            return jsonErr(e.message ?: "订阅内容格式不正确")
        } catch (_: Exception) {
            return jsonErr("订阅内容格式不正确")
        }
        if (payload.sources.isEmpty() && payload.liveSources.isEmpty()) {
            val detail = SubscriptionParser.describeParseStats(payload.stats)
            return jsonErr(if (detail.isNotEmpty()) "订阅未导入任何可用源：$detail" else "订阅内容为空")
        }
        val sourcesArr = JSONArray().apply {
            payload.sources.forEach {
                put(JSONObject().put("name", it.name).put("url", it.url)
                    .put("detail", it.detail ?: JSONObject.NULL).put("isAdult", it.isAdult))
            }
        }
        val liveArr = JSONArray().apply {
            payload.liveSources.forEach {
                put(JSONObject().put("name", it.name).put("url", it.url)
                    .put("epg", it.epg ?: JSONObject.NULL))
            }
        }
        val root = JSONObject()
            .put("name", payload.name ?: JSONObject.NULL)
            .put("sources", sourcesArr)
            .put("liveSources", liveArr)
        payload.stats?.let { st ->
            root.put("stats", JSONObject()
                .put("format", st.format)
                .put("skipped", st.skipped)
                .put("skippedByReason", JSONObject(st.skippedByReason as Map<*, *>))
                .put("skippedSamples", JSONArray(st.skippedSamples ?: emptyList<String>()))
                .put("truncated", st.truncated))
        }
        return json(root.toString())
    }
    /** 本地桥接没拿到源列表时：返回带失败原因的 done，让前端把问题显示出来而不是静默「未找到」 */
    private fun bridgeLostDone(stream: Boolean): String {
        val fail = JSONObject()
            .put("sourceKey", "__bridge__")
            .put("error", "本地桥接未收到数据源（请重新搜索一次，若仍失败请反馈）")
            .put("timedOut", false)
        val done = JSONObject()
            .put("type", "done")
            .put("list", JSONArray())
            .put("failures", JSONArray().put(fail))
        return if (stream) done.toString() + "\n" else done.toString()
    }
    /** /api/source/test：以搜索 "test" 的耗时与结果量衡量源可用性 */
    private fun sourceTest(bodyRaw: String?): WebResourceResponse {
        val body = parseBody(bodyRaw)
        val url = body.optString("url", "")
        if (url.isBlank()) return jsonErr("缺少 url", 400)
        val t0 = System.currentTimeMillis()
        val src = SourceConfig(key = "test", name = "test", url = url)
        val result = CmsApi.search(src, "test", 1)
        val ms = System.currentTimeMillis() - t0
        return if (result != null) {
            json(JSONObject().put("ok", true).put("ms", ms).put("count", result.first.size).toString())
        } else {
            json(JSONObject().put("ok", false).put("ms", ms).put("error", "请求失败或格式错误").toString())
        }
    }
    // —— /api/detail ——
    private fun detail(uri: android.net.Uri): WebResourceResponse {
        val id = uri.getQueryParameter("id") ?: return jsonErr("缺少 id", 400)
        val srcJson = parseBody(uri.getQueryParameter("source"))
        val src = SourceConfig(
            key = srcJson.optString("key", "src"),
            name = srcJson.optString("name", ""),
            url = srcJson.optString("url", ""),
            detail = srcJson.optString("detail", "").ifBlank { null },
        )
        if (src.url.isBlank()) return jsonErr("缺少源地址", 400)
        var d = CmsApi.detail(src, id)
        if (d == null || d.defaultLine?.episodes.isNullOrEmpty()) {
            d = CmsApi.detailPage(src, id) ?: d
        }
        if (d == null) return jsonErr("获取到的详情内容无效", 404)
        val episodes = JSONArray().apply { (d.defaultLine?.episodes ?: emptyList()).forEach { put(it) } }
        val info = JSONObject()
            .put("title", d.title ?: JSONObject.NULL)
            .put("cover", d.cover ?: JSONObject.NULL)
            .put("desc", d.desc ?: JSONObject.NULL)
            .put("typeName", d.typeName ?: JSONObject.NULL)
            .put("year", d.year ?: JSONObject.NULL)
            .put("area", d.area ?: JSONObject.NULL)
            .put("director", d.director ?: JSONObject.NULL)
            .put("actor", d.actor ?: JSONObject.NULL)
            .put("remarks", d.remarks ?: JSONObject.NULL)
            .put("sourceKey", src.key)
            .put("sourceName", src.name)
            .put("sourceUrl", src.url)
        return json(JSONObject().put("episodes", episodes).put("videoInfo", info).toString())
    }

    // —— /api/player-state：播放器状态桥（全屏沉浸式 / 亮度 / 音量） ——
    private fun playerState(uri: android.net.Uri): WebResourceResponse {
        val host = playerHost
        // read=1：返回当前亮度/音量（0..1；-1 = 未知），全屏侧滑 HUD 用它显示真实起始值
        if (uri.getQueryParameter("read") == "1") {
            val b = String.format(java.util.Locale.US, "%.3f", host?.currentBrightness() ?: -1f)
            val v = String.format(java.util.Locale.US, "%.3f", host?.currentVolume() ?: -1f)
            return json("""{"brightness":$b,"volume":$v}""")
        }
        try {
            uri.getQueryParameter("paused")?.let { p ->
                val paused = p == "1" || p.equals("true", true)
                android.os.Handler(android.os.Looper.getMainLooper()).post {
                    host?.onPlaybackPaused(paused)
                }
            }
            uri.getQueryParameter("brightness")?.toFloatOrNull()?.let { v ->
                android.os.Handler(android.os.Looper.getMainLooper()).post { host?.setBrightness(v) }
            }
            uri.getQueryParameter("volume")?.toFloatOrNull()?.let { v ->
                android.os.Handler(android.os.Looper.getMainLooper()).post { host?.setVolume(v) }
            }
            uri.getQueryParameter("fullscreen")?.let { f ->
                val fs = f == "1" || f.equals("true", true)
                android.os.Handler(android.os.Looper.getMainLooper()).post { host?.onFullscreenChanged(fs) }
            }
        } catch (_: Throwable) { /* 桥接失败不影响播放 */ }
        return json("""{"ok":true}""")
    }

    // —— /api/local-file：把已缓存视频以本地流回给 <video>（拖动依赖 Range/206） ——
    private fun localFile(uri: android.net.Uri, headers: Map<String, String>?): WebResourceResponse {
        val ctx = appContext ?: return jsonErr("本地服务未初始化", 500)
        val raw = uri.getQueryParameter("path") ?: return jsonErr("缺少 path 参数", 400)

        // 只放行 App 自己写下的两类位置：MediaStore 下载 content://、App 下载目录内的绝对路径
        var input: InputStream? = null
        var total = 0L
        try {
            if (raw.startsWith("content://")) {
                val u = android.net.Uri.parse(raw)
                if (u.authority != android.provider.MediaStore.AUTHORITY ||
                    !(u.path ?: "").startsWith("/external/downloads")
                ) {
                    return jsonErr("不允许读取该路径", 403)
                }
                // openAssetFileDescriptor：流关闭时一并关掉 ParcelFileDescriptor（openFileDescriptor 只给裸 fd，易双关）
                val afd = ctx.contentResolver.openAssetFileDescriptor(u, "r")
                    ?: return jsonErr("缓存文件不存在", 404)
                val stream = afd.createInputStream()
                input = stream
                total = if (afd.length >= 0) afd.length else stream.channel.size()
            } else {
                val f = File(raw)
                val root = ctx.getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS)?.canonicalPath
                    ?: return jsonErr("下载目录不可用", 404)
                if (!f.isAbsolute || !f.canonicalPath.startsWith(root + File.separator)) {
                    return jsonErr("不允许读取该路径", 403)
                }
                input = FileInputStream(f)
                total = f.length()
            }
        } catch (_: Throwable) {
            return jsonErr("读取缓存文件失败", 404)
        }
        val data = input ?: return jsonErr("文件不可读", 404)

        var start = 0L
        var end = total - 1
        var partial = false
        // Range: bytes=start-end / start- / -suffix；解析不出来的按无 Range 整文件返回（RFC 允许忽略）
        val rangeHeader = headers?.entries?.firstOrNull { it.key.equals("Range", true) }?.value?.trim()
        val range = if (total > 0 && rangeHeader != null) {
            Regex("^bytes=(\\d*)-(\\d*)$", RegexOption.IGNORE_CASE).find(rangeHeader)?.groupValues
        } else {
            null
        }
        if (range != null) {
            val from = range[1].toLongOrNull()
            val to = range[2].toLongOrNull()
            if (from != null && from < total) {
                start = from
                end = minOf(to ?: (total - 1), total - 1)
                if (end < start) {
                    start = 0          // bytes=9-3 这类非法区间：忽略，给整文件
                    end = total - 1
                } else {
                    partial = true
                }
            } else if (from != null) {
                try { data.close() } catch (_: Throwable) { /* 忽略 */ }
                return WebResourceResponse(
                    "video/mp4", null, 416, "Range Not Satisfiable",
                    mapOf(
                        "Accept-Ranges" to "bytes",
                        "Content-Range" to "bytes */$total",
                        "Access-Control-Allow-Origin" to "*",
                    ),
                    ByteArrayInputStream(ByteArray(0)),
                )
            } else if (to != null && to > 0) {
                start = maxOf(0L, total - to)     // bytes=-N：末尾 N 字节
                partial = true
            }
        }
        var skipped = 0L
        while (skipped < start) {
            val n = data.skip(start - skipped)
            if (n <= 0) break
            skipped += n
        }
        if (skipped < start) {
            // 提供者给的不是可定位文件（管道流）：宁可不播，也不把文件头当成 Range 起点回出去
            try { data.close() } catch (_: Throwable) { /* 忽略 */ }
            return jsonErr("缓存文件不支持定位读取", 500)
        }
        val length = end - start + 1
        val respHeaders = linkedMapOf(
            "Accept-Ranges" to "bytes",
            "Content-Length" to length.toString(),
            "Access-Control-Allow-Origin" to "*",
        )
        if (partial) respHeaders["Content-Range"] = "bytes $start-$end/$total"
        return WebResourceResponse(
            guessContentType(raw).takeUnless { it == "application/octet-stream" } ?: "video/mp4",
            null,
            if (partial) 206 else 200,
            if (partial) "Partial Content" else "OK",
            respHeaders,
            BoundedStream(data, length),
        )
    }
    // —— /api/quality：画质嗅探（两级策略见 QualityProbe；并发 3，stream=1 逐条推送 + 首字节心跳） ——
    private fun quality(bodyRaw: String?, stream: Boolean): WebResourceResponse {
        val body = parseBody(bodyRaw)
        val arr = body.optJSONArray("items") ?: return jsonErr("请提供待探测的条目", 400)
        val items = ArrayList<Pair<SourceConfig, String>>()
        for (i in 0 until minOf(arr.length(), 50)) {
            val o = arr.optJSONObject(i) ?: continue
            val src = o.optJSONObject("source") ?: continue
            val url = src.optString("url", "")
            val id = o.optString("id", "")
            if (url.isBlank() || id.isBlank() || id.length > 64) continue
            items.add(
                SourceConfig(
                    key = src.optString("key", "src"),
                    name = src.optString("name", url),
                    url = url,
                    detail = src.optString("detail", "").ifBlank { null },
                ) to id,
            )
        }
        if (items.isEmpty()) return jsonErr("条目格式无效", 400)

        fun resultJson(r: QualityProbe.ProbeResult): JSONObject = JSONObject()
            .put("sourceKey", r.sourceKey)
            .put("vodId", r.vodId)
            .put("height", r.height ?: JSONObject.NULL)
            .put("error", r.error ?: JSONObject.NULL)

        fun runAll(onEach: (JSONObject) -> Unit) {
            // 固定 6 线程池：一次最多 50 条目，之前每条目一个 Thread 会让线程数随批次线性增长
            val futures = items.map { (src, id) ->
                try {
                    probePool.submit { onEach(resultJson(QualityProbe.probeQuality(src, id))) }
                } catch (_: Throwable) {
                    null
                }
            }
            futures.forEach { f -> try { f?.get() } catch (_: Throwable) {} }
        }

        if (!stream) {
            // 同样异步：逐条请求在 WebView 线程池里不再阻塞等待探测完成
            val queue = QueueInputStream()
            submit(queue) {
                try {
                    val results = java.util.concurrent.ConcurrentLinkedQueue<JSONObject>()
                    runAll { results.add(it) }
                    queue.offer(JSONObject().put("results", JSONArray(results.toList())).toString().toByteArray())
                } catch (_: Throwable) {
                    queue.offer(JSONObject().put("results", JSONArray()).toString().toByteArray())
                }
            }
            return WebResourceResponse("application/json", "utf-8", 200, "OK", corsHeaders(), queue)
        }

        val queue = QueueInputStream()
        submit(queue) {
            queue.offer((JSONObject().put("ping", true).toString() + "\n").toByteArray())
            runAll { queue.offer((it.toString() + "\n").toByteArray()) }
        }
        return WebResourceResponse("application/x-ndjson", "utf-8", 200, "OK", corsHeaders(), queue)
    }
    // —— /api/live/playlist：拉取并解析 M3U 订阅 ——
    private fun livePlaylist(uri: android.net.Uri): WebResourceResponse {
        val target = uri.getQueryParameter("url")?.trim()
        if (target.isNullOrBlank()) return jsonErr("缺少 url 参数", 400)
        val format = uri.getQueryParameter("format") ?: "json"
        val (text, _) = NetClient.getText(target) ?: return jsonErr("订阅地址请求失败", 502)
        val channels = M3uParser.parseM3u(text, target)
        val groups = channels.mapNotNull { it.group }.filter { it.isNotEmpty() }.distinct()
            .sortedWith(java.text.Collator.getInstance(java.util.Locale.SIMPLIFIED_CHINESE))
        val name = Regex("^#PLAYLIST:(.+)$", RegexOption.MULTILINE).find(text)?.groupValues?.get(1)?.trim()

        if (format == "m3u") {
            // 订阅导出用：解析后的标准 M3U 文本
            val esc = { s: String -> s.replace("\"", "'") }
            val lines = ArrayList<String>()
            lines.add("#EXTM3U")
            name?.let { lines.add("#PLAYLIST:$it") }
            for (c in channels) {
                val attrs = listOf(
                    "tvg-id=\"${esc(c.tvgId ?: c.id)}\"",
                    c.rawName?.let { "tvg-name=\"${esc(it)}\"" },
                    c.logo?.let { "tvg-logo=\"${esc(it)}\"" },
                    "group-title=\"${esc(c.group ?: "")}\"",
                ).filterNotNull().joinToString(" ")
                lines.add("#EXTINF:-1 $attrs,${c.name}")
                lines.add(c.url)
            }
            return WebResourceResponse(
                "audio/x-mpegurl", "utf-8", 200, "OK", corsHeaders(),
                ByteArrayInputStream(lines.joinToString("\n").toByteArray()),
            )
        }

        val channelsArr = JSONArray().apply {
            for (c in channels) {
                put(
                    JSONObject()
                        .put("id", c.id)
                        .put("name", c.name)
                        .put("url", c.url)
                        .put("logo", c.logo ?: JSONObject.NULL)
                        .put("group", c.group ?: JSONObject.NULL)
                        .put("tvgId", c.tvgId ?: JSONObject.NULL)
                        .put("rawName", c.rawName ?: JSONObject.NULL),
                )
            }
        }
        val root = JSONObject()
            .put("name", name ?: JSONObject.NULL)
            .put("channels", channelsArr)
            .put("groups", JSONArray(groups))
        return json(root.toString())
    }

    // —— /api/live/epg：XMLTV 节目单（gzip 自动识别，24h 窗口） ——
    private fun liveEpg(uri: android.net.Uri): WebResourceResponse {
        val target = uri.getQueryParameter("url")?.trim()
        if (target.isNullOrBlank()) return jsonErr("缺少 url 参数", 400)
        val channelId = uri.getQueryParameter("channel") ?: ""
        val bytes = NetClient.getBytes(target, maxBytes = 32 * 1024 * 1024, deadlineMs = 15_000)
            ?: return jsonErr("EPG 地址请求失败", 502)
        val text = XmltvParser.decodeMaybeGzip(bytes)
        val all = XmltvParser.parseXmltv(text)
        val programs = all[channelId] ?: emptyList()
        val (current, next) = XmltvParser.currentAndNext(programs)
        fun pgJson(p: EpgProgram?): JSONObject? = p?.let {
            JSONObject()
                .put("channelId", it.channelId)
                .put("start", it.start)
                .put("stop", it.stop)
                .put("title", it.title)
                .put("desc", it.desc ?: JSONObject.NULL)
        }
        val root = JSONObject()
            .put("channelId", channelId)
            .put("current", pgJson(current) ?: JSONObject.NULL)
            .put("next", pgJson(next) ?: JSONObject.NULL)
            .put("programs", JSONArray().apply { programs.forEach { put(pgJson(it)) } })
        return json(root.toString())
    }

    // —— /api/live/probe：批量测活（可达性 + 延迟，单批最多 50） ——
    private fun liveProbe(bodyRaw: String?, stream: Boolean): WebResourceResponse {
        val body = parseBody(bodyRaw)
        val arr = body.optJSONArray("urls") ?: JSONArray()
        val urls = ArrayList<String>()
        for (i in 0 until minOf(arr.length(), 50)) {
            val u = arr.optString(i, "").trim()
            if (u.isNotEmpty()) urls.add(u)
        }
        if (!stream) {
            val results = JSONArray().apply { urls.forEach { put(probeOne(it)) } }
            return json(JSONObject().put("results", results).toString())
        }
        val queue = QueueInputStream()
        submit(queue) {
            for (u in urls) queue.offer((probeOne(u).toString() + "\n").toByteArray())
        }
        return WebResourceResponse("application/x-ndjson", "utf-8", 200, "OK", corsHeaders(), queue)
    }

    private fun probeOne(url: String): JSONObject {
        val t0 = System.currentTimeMillis()
        val isM3u8 = url.substringBefore('?').lowercase().endsWith(".m3u8")
        return try {
            val req = okhttp3.Request.Builder().url(url)
                .header("User-Agent", NetClient.UA)
                .header("Referer", NetClient.originOf(url))
                .build()
            val call = NetClient.client.newBuilder()
                .connectTimeout(4, java.util.concurrent.TimeUnit.SECONDS)
                .readTimeout(4, java.util.concurrent.TimeUnit.SECONDS)
                .build()
                .newCall(req)
            call.execute().use { resp ->
                val ms = System.currentTimeMillis() - t0
                if (!resp.isSuccessful) {
                    JSONObject().put("url", url).put("ok", false).put("status", resp.code)
                        .put("ms", ms).put("level", if (isM3u8) "manifest" else "head")
                        .put("error", "HTTP ${resp.code}")
                } else {
                    JSONObject().put("url", url).put("ok", true).put("status", resp.code)
                        .put("ms", ms).put("level", if (isM3u8) "manifest" else "head")
                }
            }
        } catch (e: java.net.SocketTimeoutException) {
            JSONObject().put("url", url).put("ok", false).put("timedOut", true)
                .put("level", if (isM3u8) "manifest" else "head").put("error", "请求超时")
        } catch (e: Exception) {
            JSONObject().put("url", url).put("ok", false)
                .put("level", if (isM3u8) "manifest" else "head")
                .put("error", e.message ?: "请求失败")
        }
    }
    // —— /api/proxy：封面 / m3u8 / 分片（防盗链 Referer + UA；前端 hls-loader 负责广告过滤） ——
    private fun rewriteM3u8Playlist(content: String, baseUrl: String, adFilter: Boolean): String {
        val filtered = if (adFilter) org.qtv.app.player.hls.AdFilter.stripAdGroups(content) else content
        val baseUri = try { java.net.URI(baseUrl) } catch (_: Exception) { return filtered }
        fun wrapProxy(raw: String): String {
            val resolved = try { baseUri.resolve(raw.trim()).toString() } catch (_: Exception) { raw.trim() }
            if (!resolved.startsWith("http://", true) && !resolved.startsWith("https://", true)) return raw
            return "/api/proxy?url=" + java.net.URLEncoder.encode(resolved, "UTF-8") + (if (adFilter) "&adFilter=1" else "")
        }
        val uriAttrRe = Regex("""URI="([^"]+)"""")
        return filtered.lineSequence().map { line ->
            val trimmed = line.trim()
            when {
                trimmed.isEmpty() -> line
                trimmed.startsWith("#") -> uriAttrRe.replace(line) { m -> "URI=\"" + wrapProxy(m.groupValues[1]) + "\"" }
                else -> wrapProxy(trimmed)
            }
        }.joinToString("\n")
    }

    private fun proxy(rawUrl: String?, adFilter: Boolean = false): WebResourceResponse {
        if (rawUrl.isNullOrBlank()) return jsonErr("缺少 url", 400)
        val target = rawUrl
        val referer = NetClient.originOf(target)
        val req = okhttp3.Request.Builder()
            .url(target)
            .header("User-Agent", NetClient.UA)
            .header("Referer", referer)
            .header("Accept", "*/*")
            .build()
        val resp = NetClient.client.newCall(req).execute()
        if (!resp.isSuccessful) {
            resp.close()
            return WebResourceResponse("text/plain", "utf-8", resp.code, "Upstream Error", corsHeaders(), ByteArrayInputStream(ByteArray(0)))
        }
        val finalUrl = resp.request.url.toString()
        val contentType = resp.header("Content-Type") ?: guessContentType(finalUrl)
        val isM3u8 = finalUrl.substringBefore('?').lowercase().endsWith(".m3u8") || contentType.contains("mpegurl", true)
        if (isM3u8) {
            val text = resp.use { r ->
                val bytes = r.body?.bytes() ?: ByteArray(0)
                NetClient.decodeBytes(bytes, contentType)
            }
            val rewritten = rewriteM3u8Playlist(text, finalUrl, adFilter)
            return WebResourceResponse("application/vnd.apple.mpegurl", "utf-8", 200, "OK", corsHeaders(), ByteArrayInputStream(rewritten.toByteArray()))
        }
        val stream = resp.body?.byteStream() ?: ByteArrayInputStream(ByteArray(0))
        return WebResourceResponse(contentType, null, 200, "OK", corsHeaders(), WrappedStream(stream, resp))
    }


    // 豆瓣热播：与 Windows 本地服务同一套 rexxar 接口与移动 UA/Referer。
    // 电影榜单按 hot -> top250 -> showing 依次兜底，避免单个 collection 被风控时整块空白。
    private fun douban(uri: android.net.Uri): WebResourceResponse {
        val type = uri.getQueryParameter("type") ?: "tv"
        val start = uri.getQueryParameter("pageStart")?.toIntOrNull()?.coerceIn(0, 200) ?: 0
        val size = uri.getQueryParameter("pageSize")?.toIntOrNull()?.coerceIn(1, 50) ?: 20
        val collections = if (type == "movie") {
            listOf("movie_hot", "movie_top250", "movie_showing")
        } else {
            listOf("tv_hot", "tv_chinese_best_weekly")
        }
        for (collection in collections) {
            try {
                val url = "https://m.douban.com/rexxar/api/v2/subject_collection/${collection}/items?start=$start&count=$size"
                val req = okhttp3.Request.Builder().url(url)
                    .header("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
                    .header("Referer", "https://m.douban.com/")
                    .header("Accept", "application/json")
                    .build()
                val body = NetClient.client.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) null else resp.body?.string()
                } ?: continue
                val arr = JSONObject(body).optJSONArray("subject_collection_items") ?: continue
                if (arr.length() == 0) continue
                val items = JSONArray()
                for (i in 0 until arr.length()) {
                    val o = arr.optJSONObject(i) ?: continue
                    val title = o.optString("title")
                    if (title.isBlank()) continue
                    val item = JSONObject()
                    item.put("id", o.optString("id"))
                    item.put("title", title)
                    val pic = o.optJSONObject("pic")
                    val coverObj = o.optJSONObject("cover")
                    item.put(
                        "cover",
                        pic?.optString("large")?.takeIf { it.isNotBlank() }
                            ?: pic?.optString("normal")?.takeIf { it.isNotBlank() }
                            ?: coverObj?.optString("url")
                            ?: ""
                    )
                    val rating = o.optJSONObject("rating")?.optDouble("value", 0.0) ?: 0.0
                    if (rating > 0) item.put("rating", String.format(java.util.Locale.US, "%.1f", rating))
                    item.put("isTv", collection.startsWith("tv"))
                    items.put(item)
                }
                if (items.length() == 0) continue
                val out = JSONObject()
                out.put("items", items)
                return json(out.toString())
            } catch (_: Exception) {
                // 换下一个榜单
            }
        }
        return json("""{"items":[]}""")
    }

    private fun guessContentType(url: String): String {
        val p = url.substringBefore('?').lowercase()
        return when {
            p.endsWith(".m3u8") -> "application/vnd.apple.mpegurl"
            p.endsWith(".ts") -> "video/mp2t"
            p.endsWith(".mp4") -> "video/mp4"
            p.endsWith(".key") -> "application/octet-stream"
            p.endsWith(".jpg") || p.endsWith(".jpeg") -> "image/jpeg"
            p.endsWith(".png") -> "image/png"
            p.endsWith(".webp") -> "image/webp"
            p.endsWith(".gif") -> "image/gif"
            else -> "application/octet-stream"
        }
    }

    /** 关闭响应体时一并断开 OkHttp 连接 */
    private class WrappedStream(private val inner: InputStream, private val resp: okhttp3.Response) : InputStream() {
        override fun read(): Int = inner.read()
        override fun read(b: ByteArray, off: Int, len: Int): Int = inner.read(b, off, len)
        override fun close() {
            try { inner.close() } finally { resp.close() }
        }
    }

    /** 最多吐 [remaining] 字节：Range 响应体不能越过 Content-Length 把整个文件续下去 */
    private class BoundedStream(private val inner: InputStream, private var remaining: Long) : InputStream() {
        override fun read(): Int {
            if (remaining <= 0) return -1
            val b = inner.read()
            if (b >= 0) remaining--
            return b
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (len == 0) return 0
            if (remaining <= 0) return -1
            val n = inner.read(b, off, minOf(len.toLong(), remaining).toInt())
            if (n > 0) remaining -= n
            return n
        }

        override fun close() = inner.close()
    }

}
