package org.qtv.app.data.live

/**
 * M3U / M3U8 直播播放列表解析（1:1 移植 `src/lib/m3u-parser.ts`）。
 *
 * 兼容标准与非标准 EXTINF（属性写在标题后）、`#EXTGRP:` 补充分组；
 * 单趟扫描、按 URL 去重、仅保留 http(s) 流地址。
 */
data class LiveChannel(
    val id: String,
    val name: String,
    val url: String,
    val logo: String?,
    val group: String?,
    val tvgId: String?,
    val rawName: String?,
)

object M3uParser {

    private val ATTR_RE = Regex("([a-zA-Z0-9_-]+)=\"([^\"]*)\"")
    private val ATTR_STRIP_RE = Regex("[a-zA-Z0-9_-]+=\"[^\"]*\"")

    /** djb2 变体，32 位无符号语义（与 TS 版稳定短 id 一致） */
    fun stableId(input: String): String {
        var h = 5381L
        for (ch in input) {
            h = ((h shl 5) + h + ch.code) and 0xFFFFFFFFL
        }
        return java.lang.Long.toString(h, 36)
    }

    /** 相对地址按订阅 URL 解析为绝对地址；仅放行 http(s) */
    fun normalizeStreamUrl(raw: String, baseUrl: String?): String? {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return null
        return try {
            val resolved = if (baseUrl.isNullOrBlank()) java.net.URI(trimmed)
            else java.net.URI(baseUrl).resolve(trimmed)
            val scheme = resolved.scheme?.lowercase()
            if (scheme != "http" && scheme != "https") null else resolved.toString()
        } catch (_: Exception) {
            null
        }
    }

    private fun nameFromUrl(url: String): String {
        return try {
            val u = java.net.URI(url)
            val last = (u.path ?: "").split('/').filter { it.isNotEmpty() }.lastOrNull()
            if (last != null) {
                val decoded = try { java.net.URLDecoder.decode(last, "UTF-8") } catch (_: Exception) { last }
                val cleaned = decoded.replace(Regex("\\.(m3u8?|flv|ts|mp4)$", RegexOption.IGNORE_CASE), "")
                if (cleaned.isNotEmpty()) cleaned else u.host ?: "未命名频道"
            } else u.host ?: "未命名频道"
        } catch (_: Exception) {
            "未命名频道"
        }
    }

    fun parseM3u(content: String, baseUrl: String? = null): List<LiveChannel> {
        val channels = ArrayList<LiveChannel>()
        if (content.isEmpty()) return channels

        val seen = HashSet<String>()
        var attrs: Map<String, String>? = null
        var title: String? = null
        var extGroup = ""

        for (rawLine in content.split(Regex("\\r?\\n"))) {
            val line = rawLine.trim()
            if (line.isEmpty()) continue

            if (line.uppercase().startsWith("#EXTINF")) {
                val map = LinkedHashMap<String, String>()
                for (m in ATTR_RE.findAll(line)) {
                    map[m.groupValues[1].lowercase()] = m.groupValues[2].trim()
                }
                val stripped = ATTR_STRIP_RE.replace(line, "").replace(Regex("^#EXTINF\\s*:\\s*", RegexOption.IGNORE_CASE), "")
                val commaIdx = stripped.indexOf(',')
                val t = (if (commaIdx >= 0) stripped.substring(commaIdx + 1) else stripped)
                    .trim().trim('"')
                attrs = map
                title = t
                extGroup = ""
                continue
            }

            if (line.uppercase().startsWith("#EXTGRP:")) {
                val g = line.substring("#EXTGRP:".length).trim()
                if (attrs != null && g.isNotEmpty() && attrs!!["group-title"] == null) extGroup = g
                continue
            }

            if (line.startsWith("#")) continue

            val url = normalizeStreamUrl(line, baseUrl)
            val cur = attrs
            val curTitle = title
            val curExtGroup = extGroup
            attrs = null; title = null; extGroup = ""
            if (url == null || !seen.add(url)) continue

            val tvgId = cur?.get("tvg-id")?.ifEmpty { null }
            val logo = cur?.get("tvg-logo")?.let { normalizeStreamUrl(it, baseUrl) }
            channels.add(
                LiveChannel(
                    id = tvgId ?: stableId(url),
                    name = curTitle?.ifEmpty { null } ?: nameFromUrl(url),
                    url = url,
                    logo = logo,
                    group = cur?.get("group-title")?.ifEmpty { null } ?: curExtGroup.ifEmpty { null },
                    tvgId = tvgId,
                    rawName = cur?.get("tvg-name")?.ifEmpty { null },
                )
            )
        }
        return channels
    }
}
