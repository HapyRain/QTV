package org.qtv.app.core.network

import okhttp3.OkHttpClient
import okhttp3.Request
import java.nio.charset.Charset
import java.util.concurrent.TimeUnit

/**
 * 全局 HTTP 客户端：统一 UA/Referer/超时，响应体按 UTF-8 → GBK 兜底解码。
 * 无 SSRF/密码/代理层——纯客户端直连（PLAN §4.1）。
 */
object NetClient {

    /** 与 LibreTV cmsRequestHeaders 保持一致的桌面 UA */
    const val UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"

    val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .followRedirects(true)
        .build()

    /** 目标 URL 的 origin（scheme://host[:port]/）——防盗链 Referer 用（PLAN §4.2） */
    fun originOf(url: String): String {
        return try {
            val u = java.net.URI(url)
            val scheme = (u.scheme ?: "http").lowercase()
            val defaultPort = if (scheme == "https") 443 else 80
            val port = if (u.port != -1 && u.port != defaultPort) ":${u.port}" else ""
            "$scheme://${u.host}$port/"
        } catch (_: Exception) {
            ""
        }
    }

    /**
     * GET 文本：UA + Referer=源 origin。
     * 编码：Content-Type charset → UTF-8 → GBK（老 CMS 详情页常见 GBK，PLAN §4.4）。
     * 返回 Pair(文本, 最终 URL——重定向后）。
     */
    /** 响应体读取默认上限：整读无上限是 OOM 闪退的头号来源（详见 REVIEW_NATIVE.md） */
    const val DEFAULT_MAX_BYTES = 8 * 1024 * 1024
    /** 单请求总死线：阻塞式逐次 read 超时只兜单次 read，慢滴源能把一次请求拖到几分钟 */
    const val DEFAULT_DEADLINE_MS = 12_000L

    /**
     * 限额读取流：同时受「体积上限」与「总死线」约束。
     * 超限时返回已读部分（调用方按不完整内容处理），不抛异常、不把连接挂着。
     */
    private fun readCapped(input: java.io.InputStream, maxBytes: Int, deadlineMs: Long): ByteArray {
        val t0 = System.currentTimeMillis()
        val out = java.io.ByteArrayOutputStream()
        val buf = ByteArray(8 * 1024)
        input.use { stream ->
            while (true) {
                if (System.currentTimeMillis() - t0 > deadlineMs) break
                val n = try { stream.read(buf) } catch (_: Exception) { break }
                if (n < 0) break
                out.write(buf, 0, n)
                if (out.size() >= maxBytes) break
            }
        }
        return out.toByteArray()
    }

    fun getText(
        url: String,
        referer: String? = null,
        maxBytes: Int = DEFAULT_MAX_BYTES,
        deadlineMs: Long = DEFAULT_DEADLINE_MS,
    ): Pair<String, String>? {
        return try {
            val builder = Request.Builder().url(url).header("User-Agent", UA)
            builder.header("Referer", referer ?: originOf(url))
            builder.header("Accept", "*/*")
            val call = client.newCall(builder.build())
            call.execute().use { resp ->
                if (!resp.isSuccessful) return null
                val body = resp.body ?: return null
                val bytes = readCapped(body.byteStream(), maxBytes, deadlineMs)
                if (bytes.isEmpty()) return null
                val finalUrl = resp.request.url.toString()
                Pair(decodeBytes(bytes, resp.header("Content-Type")), finalUrl)
            }
        } catch (_: Exception) {
            null
        }
    }

    /** GET 原始字节（画质探测等场景） */
    fun getBytes(
        url: String,
        referer: String? = null,
        maxBytes: Int = DEFAULT_MAX_BYTES,
        deadlineMs: Long = DEFAULT_DEADLINE_MS,
    ): ByteArray? {
        return try {
            val builder = Request.Builder().url(url).header("User-Agent", UA)
            builder.header("Referer", referer ?: originOf(url))
            builder.header("Accept", "*/*")
            client.newCall(builder.build()).execute().use { resp ->
                if (!resp.isSuccessful) return null
                val body = resp.body ?: return null
                readCapped(body.byteStream(), maxBytes, deadlineMs)
            }
        } catch (_: Exception) {
            null
        }
    }

    /** charset 嗅探 + UTF-8/GBK 兜底（替换字符率过高则回退重解） */
    fun decodeBytes(bytes: ByteArray, contentType: String? = null): String {
        val declared = charsetFromContentType(contentType)
        if (declared != null) {
            return try { String(bytes, declared) } catch (_: Exception) { fallbackDecode(bytes) }
        }
        return fallbackDecode(bytes)
    }

    private fun charsetFromContentType(ct: String?): Charset? {
        if (ct == null) return null
        val m = Regex("charset=([\\w-]+)", RegexOption.IGNORE_CASE).find(ct) ?: return null
        return try { Charset.forName(m.groupValues[1]) } catch (_: Exception) { null }
    }

    private fun fallbackDecode(bytes: ByteArray): String {
        val utf8 = String(bytes, Charsets.UTF_8)
        val bad = utf8.count { it == '\uFFFD' }
        return if (bad > 0 && bad * 50 > utf8.length) {
            try { String(bytes, Charset.forName("GBK")) } catch (_: Exception) { utf8 }
        } else {
            utf8
        }
    }
}
