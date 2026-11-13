package org.qtv.app.data.live

import java.io.ByteArrayInputStream
import java.util.zip.GZIPInputStream

/**
 * XMLTV 节目单解析（1:1 移植 `src/lib/xmltv.ts`）。
 * 单趟正则扫描 `<programme>`，按时间窗裁剪；Buffer 自动识别 gzip（1f 8b 魔数）。
 */
data class EpgProgram(
    val channelId: String,
    val start: Long,
    val stop: Long,
    val title: String,
    val desc: String?,
)

object XmltvParser {

    private val PROGRAMME_RE = Regex(
        "<programme\\s+([^>]*?)\\s*/>|<programme\\s+([^>]*?)>([\\s\\S]*?)</programme>"
    )
    private val ATTR_RE = Regex("([a-zA-Z0-9_-]+)=\"([^\"]*)\"")
    private val TITLE_RE = Regex("<title(?:\\s[^>]*)?>([\\s\\S]*?)</title>", RegexOption.IGNORE_CASE)
    private val DESC_RE = Regex("<desc(?:\\s[^>]*)?>([\\s\\S]*?)</desc>", RegexOption.IGNORE_CASE)

    const val DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000L

    private fun safeCodePoint(n: Int): String =
        if (n in 0..0x10FFFF && n !in 0xD800..0xDFFF) String(Character.toChars(n)) else ""

    /** 解析 XMLTV 实体（含 CDATA 与数字实体） */
    fun decodeXmlText(raw: String): String {
        var text = raw.trim()
        val cdata = Regex("^<!\\[CDATA\\[([\\s\\S]*)\\]\\]>$").find(text)
        if (cdata != null) text = cdata.groupValues[1]
        text = Regex("&#x([0-9a-fA-F]+);").replace(text) { safeCodePoint(it.groupValues[1].toInt(16)) }
        text = Regex("&#(\\d+);").replace(text) { safeCodePoint(it.groupValues[1].toInt()) }
        return text
            .replace("&quot;", "\"").replace("&apos;", "'")
            .replace("&lt;", "<").replace("&gt;", ">")
            .replace("&amp;", "&")
    }

    /** `YYYYMMDDHHmmss(.fff)?( +hhmm | Z)?` → epoch ms；无法解析返回 null */
    fun parseXmltvTime(raw: String): Long? {
        val m = Regex(
            "^(\\d{4})(\\d{2})(\\d{2})(\\d{2})?(\\d{2})?(\\d{2})?(?:\\.(\\d{1,3}))?(?:\\s*([+-])(\\d{2})(\\d{2})|\\s*Z)?$"
        ).find(raw.trim()) ?: return null
        val g = m.groupValues
        val utcMs = java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("UTC")).apply {
            set(g[1].toInt(), g[2].toInt() - 1, g[3].toInt(), (g[4].ifEmpty { "0" }).toInt(),
                (g[5].ifEmpty { "0" }).toInt(), (g[6].ifEmpty { "0" }).toInt())
            set(java.util.Calendar.MILLISECOND, if (g[7].isNotEmpty()) g[7].padEnd(3, '0').toInt() else 0)
        }.timeInMillis
        if (g[8].isEmpty()) return utcMs // 无时区按 UTC
        val offsetMin = g[9].toInt() * 60 + g[10].toInt()
        val offsetMs = offsetMin * 60_000L * (if (g[8] == "-") -1 else 1)
        return utcMs - offsetMs
    }

    /** 解析 XMLTV（string 或 gzip 字节），只保留 [now, now+windowMs] 的节目 */
    fun parseXmltv(
        content: String,
        windowMs: Long = DEFAULT_WINDOW_MS,
        now: Long = System.currentTimeMillis(),
    ): Map<String, List<EpgProgram>> {
        val result = LinkedHashMap<String, ArrayList<EpgProgram>>()
        val windowEnd = now + windowMs

        for (m in PROGRAMME_RE.findAll(content)) {
            val attrText = if (m.groupValues[1].isNotEmpty()) m.groupValues[1] else m.groupValues[2]
            val inner = m.groupValues[3]
            val attrs = LinkedHashMap<String, String>()
            for (a in ATTR_RE.findAll(attrText)) attrs[a.groupValues[1].lowercase()] = a.groupValues[2]
            val channelId = attrs["channel"]?.trim()?.ifEmpty { null } ?: continue
            val start = parseXmltvTime(attrs["start"] ?: "") ?: continue
            val stop = parseXmltvTime(attrs["stop"] ?: "") ?: continue
            if (stop <= now || start >= windowEnd) continue

            val titleMatch = TITLE_RE.find(inner)
            val descMatch = DESC_RE.find(inner)
            val title = titleMatch?.let { decodeXmlText(it.groupValues[1]) } ?: ""
            if (title.isEmpty()) continue
            val program = EpgProgram(
                channelId = channelId, start = start, stop = stop, title = title,
                desc = descMatch?.let { decodeXmlText(it.groupValues[1]) },
            )
            result.getOrPut(channelId) { ArrayList() }.add(program)
        }

        for (list in result.values) list.sortBy { it.start }
        return result
    }

    /** gzip 自动识别：1f 8b 魔数 */
    fun decodeMaybeGzip(bytes: ByteArray): String {
        val text = if (bytes.size >= 2 && bytes[0] == 0x1f.toByte() && bytes[1] == 0x8b.toByte()) {
            GZIPInputStream(ByteArrayInputStream(bytes)).use { it.readBytes() }
        } else bytes
        return String(text, Charsets.UTF_8)
    }

    /** 取某频道当前正在播出的节目与下一个节目 */
    fun currentAndNext(programs: List<EpgProgram>, at: Long = System.currentTimeMillis()): Pair<EpgProgram?, EpgProgram?> {
        var current: EpgProgram? = null
        var next: EpgProgram? = null
        for (p in programs) {
            if (p.start <= at && p.stop > at) {
                current = p
                continue
            }
            if (p.start > at) {
                next = p
                break
            }
        }
        return Pair(current, next)
    }
}
