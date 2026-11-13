package org.qtv.app.player.hls

/**
 * m3u8 广告分片过滤（1:1 移植 `src/lib/m3u8.ts` 的四级管线，语义以 TS 真值表为准）。
 *
 * 关键教训（源码注释实测）：**不能只删 `#EXT-X-DISCONTINUITY`**——dytt 源每段 PTS
 * 基准独立跳变，删标记会音画错位；必须整组移除广告分片并保留段前 DISCONTINUITY
 * 作正片分段边界。段内 EXT-X-KEY / EXT-X-MAP 保留（正片可能复用同一解密配置）。
 *
 * 管线：stripMarkedAdGroups（URL 特征）→ stripInterstitialAdGroups（两长夹一短）
 * → stripLeadAdGroup（片头启发式）→ stripLeadingDisc（清首分片前的孤立标记）。
 */
object AdFilter {

    private val LEAD_AD_MAX_SECONDS = 90.0
    private val LEAD_AD_MAX_SEGMENTS = 20
    private val INTERSTITIAL_MAX_SECONDS = 30.0
    private val INTERSTITIAL_NEIGHBOR_MIN_SECONDS = 120.0

    /** 广告分片 URL 特征（adjump/advert/ads 路径），比时长/位置可靠得多 */
    private val AD_URL_PATTERN = Regex("adjump|advert|/ads?/", RegexOption.IGNORE_CASE)

    fun stripAdGroups(m3u8: String): String {
        if (m3u8.isEmpty()) return ""
        return stripLeadingDisc(stripLeadAdGroup(stripInterstitialAdGroups(stripMarkedAdGroups(m3u8))))
    }

    private fun isDisc(l: String) = l.trim() == "#EXT-X-DISCONTINUITY"
    private fun isSegment(l: String): Boolean {
        val t = l.trim()
        return t.isNotEmpty() && !t.startsWith("#")
    }

    /** 按 URL 特征剔除任意位置的 DISCONTINUITY 广告段：段内全部分片命中才整段剔除 */
    fun stripMarkedAdGroups(m3u8: String): String {
        if (m3u8.isEmpty()) return ""
        val lines = m3u8.split("\n")
        val drop = BooleanArray(lines.size)
        var i = 0
        while (i < lines.size) {
            if (!isDisc(lines[i])) { i += 1; continue }
            var j = i + 1
            var count = 0
            var allAd = true
            while (j < lines.size && !isDisc(lines[j])) {
                if (isSegment(lines[j])) {
                    count += 1
                    if (!AD_URL_PATTERN.containsMatchIn(lines[j].trim())) allAd = false
                }
                j += 1
            }
            if (count > 0 && allAd) {
                drop[i] = true
                for (k in (i + 1) until j) {
                    val t = lines[k].trim()
                    if (t.startsWith("#EXT-X-KEY") || t.startsWith("#EXT-X-MAP")) continue
                    drop[k] = true
                }
            }
            i = j
        }
        if (drop.none { it }) return m3u8
        return lines.filterIndexed { idx, _ -> !drop[idx] }.joinToString("\n")
    }

    private data class Group(val start: Int, val end: Int, val discLine: Int, val seconds: Double, val count: Int)

    /** 按 DISCONTINUITY 切组：组 k（k≥1）前的边界行是 discIdx[k-1]；组 0 从文件头开始 */
    private fun scanGroups(lines: List<String>): List<Group> {
        val discIdx = ArrayList<Int>()
        lines.forEachIndexed { i, l -> if (isDisc(l)) discIdx.add(i) }
        val bounds = listOf(0) + discIdx + listOf(lines.size)
        val groups = ArrayList<Group>()
        for (k in 0 until bounds.size - 1) {
            val start = if (k == 0) 0 else bounds[k] + 1
            val end = bounds[k + 1]
            var seconds = 0.0
            var count = 0
            for (i in start until end) {
                val m = Regex("^#EXTINF:([\\d.]+)").find(lines[i].trim())
                if (m != null) seconds += m.groupValues[1].toDoubleOrNull() ?: 0.0
                else if (isSegment(lines[i])) count += 1
            }
            groups.add(Group(start, end, if (k == 0) -1 else bounds[k], seconds, count))
        }
        return groups
    }

    /** 长正片段之间的超短插入段（两长夹一短）：≤30s 且前后邻段 ≥120s */
    fun stripInterstitialAdGroups(m3u8: String): String {
        if (m3u8.isEmpty()) return ""
        val lines = m3u8.split("\n")
        val groups = scanGroups(lines)
        val drop = BooleanArray(lines.size)
        for (k in 1 until groups.size) {
            val g = groups[k]
            val prev = groups[k - 1]
            val next = groups.getOrNull(k + 1)
            if (g.count == 0 || g.discLine < 0) continue
            if (g.seconds <= 0 || g.seconds > INTERSTITIAL_MAX_SECONDS) continue
            if (prev.seconds < INTERSTITIAL_NEIGHBOR_MIN_SECONDS) continue
            if (next == null || next.seconds < INTERSTITIAL_NEIGHBOR_MIN_SECONDS) continue
            drop[g.discLine] = true
            for (i in g.start until g.end) {
                val t = lines[i].trim()
                if (t.startsWith("#EXT-X-KEY") || t.startsWith("#EXT-X-MAP")) continue
                drop[i] = true
            }
        }
        if (drop.none { it }) return m3u8
        return lines.filterIndexed { idx, _ -> !drop[idx] }.joinToString("\n")
    }

    /**
     * 剔除片头插入广告段（整组移除分片）。保守判定（全部满足才剔除）：
     * 0. 多分组封装同构（片头组大小 ≈ 其余组中位数）→ 跳过（封装边界，防误杀）；
     * 1. 首个分片之前存在 DISCONTINUITY；2. 该段以下一个 DISCONTINUITY 结束且其后仍有分段；
     * 3. 段时长 ≤ 90s 且分片数 ≤ 20。
     */
    fun stripLeadAdGroup(m3u8: String): String {
        if (m3u8.isEmpty()) return ""
        val lines = m3u8.split("\n")
        val discIdx = ArrayList<Int>()
        lines.forEachIndexed { i, l -> if (isDisc(l)) discIdx.add(i) }

        fun groupSize(from: Int, to: Int): Int =
            (from until to).count { isSegment(lines[it]) }

        if (discIdx.size >= 4) {
            val leadSize = groupSize(discIdx[0] + 1, discIdx[1])
            val others = (1 until discIdx.size).map { g ->
                groupSize(discIdx[g] + 1, if (g + 1 < discIdx.size) discIdx[g + 1] else lines.size)
            }
            val sorted = others.sorted()
            val median = sorted[sorted.size / 2]
            val typical = Math.abs(leadSize - median) <= maxOf(3, (median * 0.5).toInt())
            if (typical) return m3u8 // 片头组与其余组同构 ⇒ 封装边界，跳过
        }

        val firstDisc = discIdx.firstOrNull() ?: return m3u8
        if ((0 until firstDisc).any { isSegment(lines[it]) }) return m3u8
        val nextDisc = discIdx.drop(1).firstOrNull { it > firstDisc } ?: return m3u8

        var seconds = 0.0
        var count = 0
        for (i in (firstDisc + 1) until nextDisc) {
            val m = Regex("^#EXTINF:([\\d.]+)").find(lines[i].trim())
            if (m != null) seconds += m.groupValues[1].toDoubleOrNull() ?: 0.0
            else if (isSegment(lines[i])) count += 1
        }
        if (count == 0 || count > LEAD_AD_MAX_SEGMENTS) return m3u8
        if (seconds <= 0 || seconds > LEAD_AD_MAX_SECONDS) return m3u8

        val kept = lines.filterIndexed { i, l ->
            if (i < firstDisc || i >= nextDisc) true
            else {
                val t = l.trim()
                t.startsWith("#EXT-X-KEY") || t.startsWith("#EXT-X-MAP")
            }
        }
        // 新开头的 DISCONTINUITY（首分片前无「前文」）一并清掉
        val out = ArrayList<String>()
        var seenSegment = false
        for (l in kept) {
            if (!seenSegment && isDisc(l)) continue
            if (isSegment(l)) seenSegment = true
            out.add(l)
        }
        return out.joinToString("\n")
    }

    /** 清除首个分片之前的 DISCONTINUITY：其前没有媒体内容，标记无语义 */
    fun stripLeadingDisc(content: String): String {
        val lines = content.split("\n")
        val firstSeg = lines.indexOfFirst { isSegment(it) }
        if (firstSeg <= 0) return content
        val kept = lines.filterIndexed { i, l -> !(i < firstSeg && l.trim() == "#EXT-X-DISCONTINUITY") }
        return if (kept.size == lines.size) content else kept.joinToString("\n")
    }
}
