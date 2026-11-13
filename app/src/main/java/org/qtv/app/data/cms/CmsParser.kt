package org.qtv.app.data.cms

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject

/**
 * Apple CMS 响应解析（1:1 移植 `src/lib/cms-parser.ts`，语义以 TS 真值表为准）。
 * 纯函数、无 IO。list:null 是空结果不是错误；量子/非凡首条线路是 /share/xxx
 * 网页中转页，优先取含 .m3u8 的组（extractEpisodesFromPlayUrl 注释实测结论）。
 */
data class SearchItem(
    val vodId: String,
    val name: String,
    val pic: String?,
    val typeName: String?,
    val year: String?,
    val area: String?,
    val remarks: String?,
)

data class PlayLine(val name: String, val episodes: List<String>)

data class VideoDetailResult(
    val lines: List<PlayLine>,
    val title: String?,
    val cover: String?,
    val desc: String?,
    val typeName: String?,
    val year: String?,
    val area: String?,
    val director: String?,
    val actor: String?,
    val remarks: String?,
) {
    /** 与旧单线路行为等价的默认选择：优先含 m3u8 的线路，否则第一条（PLAN §3.2.1） */
    val defaultLine: PlayLine?
    get() = lines.find { l -> l.episodes.any { it.contains(".m3u8") } } ?: lines.firstOrNull()
}

object CmsParser {

    const val CMS_UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"

    /** 成人关键词逐字照搬（改一处都算行为变更，PLAN §3.4） */
    val ADULT_KEYWORDS: List<String> = listOf(
        "伦理片", "福利", "倫理片", "福利片", "日本伦理", "日本福利", "日本福利片", "日本伦理片",
        "擦边短剧", "擦边", "韩国伦理", "里番动漫", "门事件", "萝莉少女", "制服诱惑", "国产传媒",
        "cosplay", "黑丝诱惑", "无码", "日本无码", "有码", "日本有码", "SWAG",
        "网红主播", "色情片", "同性片", "福利视频", "无码高清", "有码高清", "91视频", "自拍偷拍",
        "mini传媒", "福利片",
    )

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }
    private val M3U8_PATTERN = Regex("""\${'$'}https?://[^"'\s]+?\.m3u8""")


    // —— JSON 容错工具 ——
    private fun prim(el: JsonElement?): String? {
        val p = el as? JsonPrimitive ?: return null
        return p.content.trim().ifEmpty { null }
    }

    // —— 搜索列表 ——
    /** list:null / 缺失 → 空；字段强转失败回退空串（源站 vod_id/vod_year 混型常态） */
    fun parseSearchList(jsonText: String): List<SearchItem> {
        val root = try {
            json.parseToJsonElement(jsonText) as? JsonObject ?: return emptyList()
        } catch (_: Exception) {
            return emptyList()
        }
        when (val list = root["list"]) {
            null, is JsonNull -> return emptyList()
            is JsonArray -> {}
            else -> return emptyList() // 非数组：TS 版抛错，客户端降级为空
        }
        val arr = root["list"]!!.jsonArray
        return arr.mapNotNull { item ->
            val v = item as? JsonObject ?: return@mapNotNull null
            SearchItem(
                vodId = prim(v["vod_id"]) ?: "",
                name = prim(v["vod_name"]) ?: "",
                pic = prim(v["vod_pic"]),
                typeName = prim(v["type_name"]),
                year = prim(v["vod_year"]),
                area = prim(v["vod_area"]),
                remarks = prim(v["vod_remarks"]),
            )
        }
    }

    // —— 播放地址 ——
    /** vod_play_from + vod_play_url → 全部线路（PLAN §3.2.1：保留多线路） */
    fun extractPlayLines(playFrom: String?, playUrl: String): List<PlayLine> {
        if (playUrl.isBlank()) return emptyList()
        val names = (playFrom ?: "").split("$$$")
        val groups = playUrl.split("$$$")
        val lines = ArrayList<PlayLine>()
        for ((i, group) in groups.withIndex()) {
            val eps = group.split("#").mapNotNull { ep ->
                val parts = ep.split("$")
                val u = if (parts.size > 1) parts[1] else ""
                if (u.startsWith("http://") || u.startsWith("https://")) u else null
            }
            if (eps.isNotEmpty()) {
                lines.add(PlayLine(names.getOrNull(i)?.trim() ?: "线路${i + 1}", eps))
            }
        }
        return lines
    }

    /** 原样保留「优先含 m3u8 的组」单线路行为（TS 语义） */
    fun extractEpisodesFromPlayUrl(playUrl: String): List<String> {
        if (playUrl.isBlank()) return emptyList()
        val groups = playUrl.split("$$$").map { group ->
            group.split("#").mapNotNull { ep ->
                val parts = ep.split("$")
                val u = if (parts.size > 1) parts[1] else ""
                if (u.startsWith("http://") || u.startsWith("https://")) u else null
            }
        }.filter { it.isNotEmpty() }
        if (groups.isEmpty()) return emptyList()
        return groups.find { eps -> eps.any { it.contains(".m3u8") } } ?: groups[0]
    }

    /** 从简介文本兜底提取 m3u8 链接 */
    fun extractM3u8FromText(text: String): List<String> {
        if (text.isEmpty()) return emptyList()
        return M3U8_PATTERN.findAll(text).map { it.value.removePrefix("$") }.toList()
    }

    // —— 详情 ——
    fun parseDetail(jsonText: String): VideoDetailResult? {
        val root = try {
            json.parseToJsonElement(jsonText) as? JsonObject ?: return null
        } catch (_: Exception) {
            return null
        }
        val list = root["list"] as? JsonArray ?: return null
        if (list.isEmpty()) return null
        val vod = list[0] as? JsonObject ?: return null
        var lines = extractPlayLines(prim(vod["vod_play_from"]), prim(vod["vod_play_url"]) ?: "")
        if (lines.isEmpty()) {
            val eps = extractM3u8FromText(prim(vod["vod_content"]) ?: "")
            if (eps.isNotEmpty()) lines = listOf(PlayLine("默认", eps))
        }
        return VideoDetailResult(
            lines = lines,
            title = prim(vod["vod_name"]),
            cover = prim(vod["vod_pic"]),
            desc = prim(vod["vod_content"]),
            typeName = prim(vod["type_name"]),
            year = prim(vod["vod_year"]),
            area = prim(vod["vod_area"]),
            director = prim(vod["vod_director"]),
            actor = prim(vod["vod_actor"]),
            remarks = prim(vod["vod_remarks"]),
        )
    }

    /** 详情页 HTML 提取（通用 $…m3u8 → 非凡日期哈希特征 → <h1> / div.sketch） */
    fun parseDetailPageHtml(html: String, fallbackTitle: String?): VideoDetailResult? {
        var matches = Regex("""\${'$'}(https?://[^"'\s]+?\.m3u8)""").findAll(html).map { it.groupValues[1] }.toList()
        if (matches.isEmpty()) {
            matches = Regex("""\${'$'}(https?://[^"'\s]+?/\d{8}/\d+_[a-f0-9]+/index\.m3u8)""")
                .findAll(html).map { it.groupValues[1] }.toList()
        }
        val episodes = matches.map { u ->
            val paren = u.indexOf('(')
            if (paren > 0) u.substring(0, paren) else u
        }.distinct()
        val title = Regex("<h1[^>]*>([^<]+)</h1>").find(html)?.groupValues?.get(1)?.trim() ?: fallbackTitle
        val desc = Regex("""<div[^>]*class=["']sketch["'][^>]*>([\s\S]*?)</div>""")
            .find(html)?.groupValues?.get(1)?.replace(Regex("<[^>]+>"), " ")?.trim()
        val lines = if (episodes.isNotEmpty()) listOf(PlayLine("默认", episodes)) else emptyList()
        return VideoDetailResult(
            lines = lines, title = title, cover = null, desc = desc,
            typeName = null, year = null, area = null, director = null, actor = null, remarks = null,
        )
    }

    // —— 相关性 / 成人过滤 ——
    fun isAdultContent(typeName: String?): Boolean {
        if (typeName.isNullOrEmpty()) return false
        return ADULT_KEYWORDS.any { typeName.contains(it) }
    }

    fun filterAdultResults(items: List<SearchItem>): List<SearchItem> =
        items.filter { !isAdultContent(it.typeName) }

    /** 归一化标题/关键词：去空白、标点与符号，转小写（跨标点差异匹配） */
    fun normalizeTitle(s: String): String =
        s.lowercase().replace(Regex("""[\s\p{P}\p{S}]+"""), "")

    private data class Season(val base: String, val season: Int, val explicit: Boolean)

    /**
     * 季数后缀解析：`bareNeedsSpace` 区分两侧——查询侧 false（「庆余年2」无空格也认），
     * 标题侧 true（必须有空格，防「电影2」误判成第二季）。
     */
    private fun parseSeasonSuffix(title: String, allowAnnotations: Boolean = false, bareNeedsSpace: Boolean = true): Season? {
        val t = title.trim()
        val explicitPattern = if (allowAnnotations)
            Regex("""^(.*?)\s*第\s*([1-9]\d?|[一二两三四五六七八九十]{1,3})\s*季.*$""")
        else
            Regex("""^(.*?)\s*第\s*([1-9]\d?|[一二两三四五六七八九十]{1,3})\s*季$""")
        val explicit = explicitPattern.find(t)
        val barePattern = if (bareNeedsSpace) Regex("""^(.*?)\s+([1-9]\d?)$""") else Regex("""^(.*?)\s*([1-9]\d?)$""")
        val bare = barePattern.find(t)
        val match = explicit ?: bare ?: return null
        val base = match.groupValues[1]
        if (normalizeTitle(base).isEmpty()) return null
        val value = match.groupValues[2]
        val digits = "零一二三四五六七八九"
        var season: Int = value.toIntOrNull() ?: -1
        if (season < 0) {
            val chinese = value.replace('两', '二')
            season = when {
                Regex("^[一二三四五六七八九]$").matches(chinese) -> digits.indexOf(chinese[0])
                Regex("^[一二三四五六七八九]?十[一二三四五六七八九]?$").matches(chinese) -> {
                    val parts = chinese.split("十")
                    val tens = if (parts[0].isEmpty()) 1 else digits.indexOf(parts[0][0])
                    val units = if (parts.size > 1 && parts[1].isNotEmpty()) digits.indexOf(parts[1][0]) else 0
                    tens * 10 + units
                }
                else -> -1
            }
        }
        if (season < 0) return null
        return Season(base, season, explicit != null)
    }

    /** 数字必须完整命中：「第 2 季」不能误匹配 12/20 */
    private fun includesKeyword(title: String, keyword: String): Boolean {
        if (title.isEmpty() || keyword.isEmpty()) return false
        var index = title.indexOf(keyword)
        while (index >= 0) {
            val before = if (index > 0) title[index - 1] else ' '
            val afterIdx = index + keyword.length
            val after = if (afterIdx < title.length) title[afterIdx] else ' '
            val keywordStartsDigit = keyword.first().isDigit()
            val keywordEndsDigit = keyword.last().isDigit()
            if ((!keywordStartsDigit || !before.isDigit()) && (!keywordEndsDigit || !after.isDigit())) return true
            index = title.indexOf(keyword, index + 1)
        }
        return false
    }

    private data class PreparedQuery(val normalized: String, val season: Season?, val tokens: List<String>)

    private fun prepareQuery(wd: String): PreparedQuery? {
        val normalized = normalizeTitle(wd)
        if (normalized.isEmpty()) return null
        val tokens = wd.trim().split(Regex("\\s+")).map { normalizeTitle(it) }.filter { it.isNotEmpty() }
        return PreparedQuery(normalized, parseSeasonSuffix(wd, false, false), tokens)
    }

    private fun matchesPrepared(nName: String, query: PreparedQuery): Boolean {
        if (includesKeyword(nName, query.normalized)) return true
        return query.tokens.size > 1 && query.tokens.all { includesKeyword(nName, it) }
    }

    private fun isRelevantPrepared(name: String, query: PreparedQuery): Boolean {
        val nName = normalizeTitle(name)
        if (nName.isEmpty()) return false
        val titleSeason = parseSeasonSuffix(name, true)
        val qSeason = query.season
        if (qSeason != null && titleSeason != null) {
            if (qSeason.season != titleSeason.season) return false
            if (qSeason.explicit || titleSeason.explicit) {
                val baseQuery = prepareQuery(qSeason.base) ?: return true
                return matchesPrepared(normalizeTitle(titleSeason.base), baseQuery)
            }
        }
        return matchesPrepared(nName, query)
    }

    fun isRelevant(name: String, wd: String): Boolean {
        val query = prepareQuery(wd) ?: return true
        return isRelevantPrepared(name, query)
    }

    fun filterRelevantResults(items: List<SearchItem>, wd: String): List<SearchItem> {
        val query = prepareQuery(wd) ?: return items
        return items.filter { isRelevantPrepared(it.name, query) }
    }
}
