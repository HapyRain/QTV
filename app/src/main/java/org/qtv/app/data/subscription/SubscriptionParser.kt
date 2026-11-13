package org.qtv.app.data.subscription

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * 数据源订阅解析（1:1 移植 `src/lib/source-list.ts` + `src/lib/tvbox-parser.ts`）。
 *
 * 自动识别三种格式：TVBOX 配置（sites/lives）→ 接口目录（裸数组全带 baseUrl）
 * → LibreTV-SourceList。兼容 `//` 注释、尾随逗号、字符串内裸控制字符
 * （TVBOX 客户端 fastjson 容忍的写法）。仅做字段裁剪/去重/上限，无网络。
 */
object SubscriptionParser {

    const val MAX_VOD_SOURCES = 100
    const val MAX_LIVE_SOURCES = 50

    const val SITE_TYPE_XML = 0
    const val SITE_TYPE_JSON = 1
    const val SITE_TYPE_SPIDER = 3
    const val SITE_TYPE_API = 4
    const val LIVE_TYPE_PLAYLIST = 0

    private val SPIDER_PATTERN = Regex("""^csp_|\.(?:jar|js|py)(?:[?#].*)?$""", RegexOption.IGNORE_CASE)
    private val LOCAL_ASSET_PATTERN = Regex("""^\.{0,2}/""")
    private val CMS_API_PATTERN = Regex("""/api\.php/provide/vod(?![^?#]*/at/xml)(?:[/?#]|$)""", RegexOption.IGNORE_CASE)
    private val M3U_PATTERN = Regex("""\.m3u8?(?:[?#].*)?$""", RegexOption.IGNORE_CASE)
    private val TXT_PATTERN = Regex("""\.txt(?:[?#].*)?$""", RegexOption.IGNORE_CASE)
    private const val SKIPPED_SAMPLE_LIMIT = 3

    private val SKIP_REASON_LABELS = mapOf(
        "spider" to "Spider 引擎", "xml" to "XML 接口", "unsearchable" to "不支持搜索",
        "nonM3uLive" to "非 M3U 直播", "disabled" to "已停用", "invalidUrl" to "地址不可用",
    )
    private val SKIP_REASON_ORDER = listOf("spider", "xml", "unsearchable", "nonM3uLive", "disabled", "invalidUrl")

    class SubscriptionFormatException(message: String) : Exception(message)

    data class SubSource(val name: String, val url: String, val detail: String?, val isAdult: Boolean)
    data class SubLiveSource(val name: String, val url: String, val epg: String?)
    data class SubStats(
        val format: String,
        val skipped: Int,
        val skippedByReason: Map<String, Int>,
        val skippedSamples: List<String>?,
        val truncated: Int,
    )
    data class SubPayload(
        val name: String?,
        val sources: List<SubSource>,
        val liveSources: List<SubLiveSource>,
        val stats: SubStats?,
    )

    private class SkipCounter {
        var count = 0
        val byReason = LinkedHashMap<String, Int>()
        val samples = ArrayList<String>()
    }

    // —— JSON 容错（先注释、后尾随逗号；仅作用于字符串外部） ——
    fun parseSubscriptionJson(text: String): JsonElement {
        val cleaned = stripJsonArtifacts(text.removePrefix("﻿"))
        return try {
            Json.parseToJsonElement(cleaned)
        } catch (_: Exception) {
            throw SubscriptionFormatException("订阅内容不是合法的 JSON")
        }
    }

    private fun stripJsonArtifacts(text: String): String = stripTrailingCommas(stripComments(text))

    private fun escapeControlChar(code: Int): String = when (code) {
        0x0a -> "\\n"
        0x0d -> "\\r"
        0x09 -> "\\t"
        else -> "\\u" + code.toString(16).padStart(4, '0')
    }

    private fun stripComments(text: String): String {
        val out = StringBuilder()
        var inString = false
        var inLine = false
        var inBlock = false
        var i = 0
        while (i < text.length) {
            val ch = text[i]
            val next = text.getOrNull(i + 1)
            when {
                inLine -> {
                    if (ch == '\n' || ch == '\r') { inLine = false; out.append(ch) }
                }
                inBlock -> {
                    if (ch == '*' && next == '/') { inBlock = false; i += 1 }
                }
                inString -> {
                    val code = ch.code
                    if (code < 0x20) {
                        out.append(escapeControlChar(code))
                    } else {
                        out.append(ch)
                        if (ch == '\\') { next?.let { out.append(it) }; i += 1 }
                        else if (ch == '"') inString = false
                    }
                }
                ch == '"' -> { inString = true; out.append(ch) }
                ch == '/' && next == '/' -> { inLine = true; i += 1 }
                ch == '/' && next == '*' -> { inBlock = true; i += 1 }
                else -> out.append(ch)
            }
            i += 1
        }
        return out.toString()
    }

    private fun stripTrailingCommas(text: String): String {
        val out = StringBuilder()
        var inString = false
        var i = 0
        while (i < text.length) {
            val ch = text[i]
            if (inString) {
                out.append(ch)
                if (ch == '\\') { text.getOrNull(i + 1)?.let { out.append(it) }; i += 1 }
                else if (ch == '"') inString = false
            } else if (ch == '"') {
                inString = true; out.append(ch)
            } else if (ch == ',') {
                var j = i + 1
                while (j < text.length && text[j].isWhitespace()) j += 1
                if (text.getOrNull(j) == '}' || text.getOrNull(j) == ']') {
                    // 尾随逗号：丢弃
                } else out.append(ch)
            } else out.append(ch)
            i += 1
        }
        return out.toString()
    }

    // —— 归一化 ——
    fun normalizeSubscriptionUrl(raw: String): String =
        raw.trim().replace(Regex("[?#]+$"), "").replace(Regex("/+$"), "")

    fun normalizeUrl(raw: Any?, trimTrailingSlash: Boolean): String? {
        val s = (raw as? String)?.trim()?.ifEmpty { return null } ?: return null
        if (!s.startsWith("http://", true) && !s.startsWith("https://", true)) return null
        val withoutEmptyTail = s.replace(Regex("[?#]+$"), "")
        try { java.net.URI(withoutEmptyTail) } catch (_: Exception) { return null }
        return if (trimTrailingSlash) withoutEmptyTail.replace(Regex("/+$"), "") else withoutEmptyTail
    }

    private fun optionalString(raw: Any?): String? =
        (raw as? String)?.trim()?.ifEmpty { null }

    private fun hostnameOf(url: String): String =
        try { java.net.URI(url).host ?: url } catch (_: Exception) { url }

    private fun prim(el: JsonElement?): String? {
        val p = el as? JsonPrimitive ?: return null
        return p.content.trim().ifEmpty { null }
    }

    private fun toNumber(raw: JsonElement?): Int? {
        val p = raw as? JsonPrimitive ?: return null
        val s = p.content.trim()
        if (s.isEmpty()) return null
        return s.toIntOrNull() ?: s.toDoubleOrNull()?.toInt()
    }

    private fun markSkipped(c: SkipCounter, reason: String, name: String? = null) {
        c.count += 1
        c.byReason[reason] = (c.byReason[reason] ?: 0) + 1
        if (!name.isNullOrEmpty() && c.samples.size < SKIPPED_SAMPLE_LIMIT && !c.samples.contains(name)) {
            c.samples.add(name)
        }
    }

    private fun describeReasons(byReason: Map<String, Int>): String =
        SKIP_REASON_ORDER.filter { (byReason[it] ?: 0) > 0 }
            .joinToString("、") { "${SKIP_REASON_LABELS[it]} ${byReason[it]}" }

    fun describeParseStats(stats: SubStats?, includeSamples: Boolean = true): String {
        if (stats == null) return ""
        val parts = ArrayList<String>()
        if (stats.skipped > 0) parts.add("跳过 ${stats.skipped} 个不可用条目（${describeReasons(stats.skippedByReason)}）")
        if (includeSamples && !stats.skippedSamples.isNullOrEmpty()) {
            parts.add("如「" + stats.skippedSamples.joinToString("」「") + "」")
        }
        if (stats.truncated > 0) parts.add("超出上限截断 ${stats.truncated} 条")
        return parts.joinToString("，")
    }

    // —— LibreTV-SourceList ——
    fun parseSourceListPayload(json: JsonElement): Pair<String?, Pair<List<SubSource>, List<SubLiveSource>>> {
        val arr = json as? JsonArray
        val obj = json as? JsonObject
        val rawVod = arr ?: ((obj?.get("sources") as? JsonArray) ?: JsonArray(emptyList()))
        val rawLive = (obj?.get("liveSources") as? JsonArray) ?: JsonArray(emptyList())
        if (rawVod.isEmpty() && rawLive.isEmpty()) {
            throw SubscriptionFormatException("订阅内容格式不正确（缺少 sources / liveSources 数组）")
        }
        val sources = ArrayList<SubSource>()
        val seenVod = HashSet<String>()
        for (el in rawVod) {
            if (sources.size >= MAX_VOD_SOURCES) break
            val item = el as? JsonObject ?: continue
            val url = normalizeUrl((item["url"] as? JsonPrimitive)?.content, true) ?: continue
            if (!seenVod.add(url)) continue
            sources.add(
                SubSource(
                    name = optionalString(prim(item["name"])) ?: hostnameOf(url),
                    url = url,
                    detail = optionalString(prim(item["detail"])),
                    isAdult = item["isAdult"]?.let { it is JsonPrimitive && it.content == "true" } ?: false,
                )
            )
        }
        val liveSources = ArrayList<SubLiveSource>()
        val seenLive = HashSet<String>()
        for (el in rawLive) {
            if (liveSources.size >= MAX_LIVE_SOURCES) break
            val item = el as? JsonObject ?: continue
            val url = normalizeUrl((item["url"] as? JsonPrimitive)?.content, false) ?: continue
            if (!seenLive.add(url)) continue
            liveSources.add(
                SubLiveSource(
                    name = optionalString(prim(item["name"])) ?: hostnameOf(url),
                    url = url,
                    epg = normalizeUrl((item["epg"] as? JsonPrimitive)?.content, false),
                )
            )
        }
        return Pair(optionalString(prim(obj?.get("name"))), Pair(sources, liveSources))
    }

    // —— 统一入口：自动识别三格式 ——
    fun parseSubscriptionPayload(json: JsonElement): SubPayload {
        if (isTvboxPayload(json)) return parseTvboxPayload(json)
        if (isSourceCatalogPayload(json)) return parseSourceCatalogPayload(json)
        if (isMixedCatalogPayload(json)) {
            throw SubscriptionFormatException(
                "订阅内容混用了 baseUrl 与 url 两种条目，请统一为一种格式（接口目录用 baseUrl，LibreTV 源列表用 url）"
            )
        }
        val (name, pair) = parseSourceListPayload(json)
        return SubPayload(name, pair.first, pair.second, SubStats("libretv", 0, emptyMap(), null, 0))
    }

    private fun isTvboxPayload(json: JsonElement): Boolean {
        val obj = json as? JsonObject ?: return false
        return obj["sites"] is JsonArray || obj["lives"] is JsonArray
    }

    private fun isCatalogEntry(el: JsonElement): Boolean {
        val obj = el as? JsonObject ?: return false
        return obj.containsKey("baseUrl")
    }

    private fun isSourceCatalogPayload(json: JsonElement): Boolean =
        (json as? JsonArray)?.let { it.isNotEmpty() && it.all { e -> isCatalogEntry(e) } } ?: false

    private fun isMixedCatalogPayload(json: JsonElement): Boolean =
        (json as? JsonArray)?.let { it.any { e -> isCatalogEntry(e) } && !it.all { e -> isCatalogEntry(e) } } ?: false

    // —— 接口目录 ——
    fun parseSourceCatalogPayload(json: JsonElement): SubPayload {
        val entries = json as? JsonArray ?: JsonArray(emptyList())
        val skipped = SkipCounter()
        val seen = HashSet<String>()
        val sources = ArrayList<SubSource>()
        var truncated = 0
        for (el in entries) {
            val entry = el as? JsonObject
            if (entry == null) { markSkipped(skipped, "invalidUrl"); continue }
            val name = optionalString(prim(entry["name"]))
            val enabled = entry["enabled"]
            if (enabled is JsonPrimitive && enabled.content == "false") {
                markSkipped(skipped, "disabled", name); continue
            }
            val url = normalizeUrl((entry["baseUrl"] as? JsonPrimitive)?.content, true)
            if (url == null) { markSkipped(skipped, "invalidUrl", name); continue }
            if (seen.contains(url)) continue
            if (sources.size >= MAX_VOD_SOURCES) { truncated += 1; continue }
            seen.add(url)
            sources.add(SubSource(name ?: hostnameOf(url), url, null, false))
        }
        if (sources.isEmpty()) {
            throw SubscriptionFormatException(
                if (skipped.count > 0) "配置中没有可导入的接口源：已跳过 ${skipped.count} 个条目（${describeReasons(skipped.byReason)}）"
                else "配置中没有可用的接口源"
            )
        }
        return SubPayload(
            null, sources, emptyList(),
            SubStats("source-catalog", skipped.count, skipped.byReason, skipped.samples.ifEmpty { null }, truncated),
        )
    }

    // —— TVBOX ——
    fun parseTvboxPayload(json: JsonElement): SubPayload {
        val record = json as? JsonObject ?: JsonObject(emptyMap())
        val rawSites = record["sites"] as? JsonArray ?: JsonArray(emptyList())
        val rawLives = record["lives"] as? JsonArray ?: JsonArray(emptyList())
        val skipped = SkipCounter()
        val vod = collectVodSources(rawSites, skipped)
        val live = collectLiveSources(rawLives, skipped)
        if (vod.first.isEmpty() && live.first.isEmpty()) {
            throw SubscriptionFormatException(
                if (skipped.count > 0) "配置中没有可直接导入的源：已跳过 ${skipped.count} 个条目（${describeReasons(skipped.byReason)}）"
                else "配置中没有可用的站点（sites / lives 均为空）"
            )
        }
        return SubPayload(
            optionalString(prim(record["name"])), vod.first, live.first,
            SubStats("tvbox", skipped.count, skipped.byReason, skipped.samples.ifEmpty { null }, vod.second + live.second),
        )
    }

    private fun collectVodSources(rawSites: JsonArray, skipped: SkipCounter): Pair<List<SubSource>, Int> {
        val seen = HashSet<String>()
        val sources = ArrayList<SubSource>()
        var truncated = 0
        for (el in rawSites) {
            val site = el as? JsonObject ?: continue
            val name = optionalString(prim(site["name"]))
            val api = optionalString(prim(site["api"]))
            val type = toNumber(site["type"])
            if (api == null) { markSkipped(skipped, "invalidUrl", name); continue }
            if (type == SITE_TYPE_SPIDER || SPIDER_PATTERN.containsMatchIn(api)) {
                markSkipped(skipped, "spider", name); continue
            }
            if (!api.startsWith("http://", true) && !api.startsWith("https://", true)) {
                markSkipped(skipped, if (LOCAL_ASSET_PATTERN.containsMatchIn(api)) "spider" else "invalidUrl", name); continue
            }
            val searchable = site["searchable"]
            val searchableOff = (searchable is JsonPrimitive) &&
                (searchable.content == "0" || searchable.content == "false")
            if (searchableOff) { markSkipped(skipped, "unsearchable", name); continue }
            val importable = type == SITE_TYPE_JSON ||
                ((type == null || type == SITE_TYPE_XML || type == SITE_TYPE_API) && CMS_API_PATTERN.containsMatchIn(api))
            if (!importable) {
                markSkipped(skipped, if (type == SITE_TYPE_API) "spider" else "xml", name); continue
            }
            val url = normalizeUrl(api, true)
            if (url == null) { markSkipped(skipped, "invalidUrl", name); continue }
            if (seen.contains(url)) continue
            if (sources.size >= MAX_VOD_SOURCES) { truncated += 1; continue }
            seen.add(url)
            sources.add(SubSource(name ?: hostnameOf(url), url, null, false))
        }
        return Pair(sources, truncated)
    }

    private fun collectLiveSources(rawLives: JsonArray, skipped: SkipCounter): Pair<List<SubLiveSource>, Int> {
        val seen = HashSet<String>()
        val liveSources = ArrayList<SubLiveSource>()
        var truncated = 0
        for (el in rawLives) {
            val live = el as? JsonObject ?: continue
            val name = optionalString(prim(live["name"]))
            val url = normalizeUrl((live["url"] as? JsonPrimitive)?.content, false)
            if (url == null) { markSkipped(skipped, "invalidUrl", name); continue }
            val type = toNumber(live["type"])
            val badType = (type != null && type != LIVE_TYPE_PLAYLIST) || (!M3U_PATTERN.containsMatchIn(url) && TXT_PATTERN.containsMatchIn(url))
            if (badType) { markSkipped(skipped, "nonM3uLive", name); continue }
            if (seen.contains(url)) continue
            if (liveSources.size >= MAX_LIVE_SOURCES) { truncated += 1; continue }
            seen.add(url)
            liveSources.add(SubLiveSource(name ?: hostnameOf(url), url, normalizeUrl((live["epg"] as? JsonPrimitive)?.content, false)))
        }
        return Pair(liveSources, truncated)
    }
}
