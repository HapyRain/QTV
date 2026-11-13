package org.qtv.app.data.quality

import java.util.concurrent.ConcurrentHashMap
import org.qtv.app.core.network.NetClient
import org.qtv.app.data.cms.CmsApi
import org.qtv.app.data.cms.SourceConfig

/**
 * 服务端画质探测（1:1 移植 `src/lib/quality-probe.ts` 的两级策略）。
 *
 * 1. 多码率源：master playlist 的 RESOLUTION 文本解析（最快）；
 * 2. 单码率源：下沉到分片本身，从 H.264 SPS / MP4 VisualSampleEntry 挖分辨率。
 * 剩余盲区（HEVC TS、防盗链拒绝）按「未知」展示，播放后由实测补上。
 */
object QualityProbe {

    const val QUALITY_PROBE_TIMEOUT_MS = 12_000L
    private const val SEGMENT_BUDGET_MS = 4_000L
    private const val M3U8_MAX_BYTES = 64 * 1024
    private const val SEGMENT_PREFIX_BYTES = 96 * 1024
    private const val INIT_PREFIX_BYTES = 64 * 1024

    data class ProbeResult(val sourceKey: String, val vodId: String, val height: Int?, val error: String?)

    /** 码率 → 高度档位（与播放器档位命名口径一致，1:1 移植 inferHeightFromBitrate） */
    fun inferHeightFromBitrate(bandwidth: Int): Int? {
        val tiers = listOf(
            20_000_000 to 4320, 10_000_000 to 2160, 5_000_000 to 1080, 3_000_000 to 720,
            1_500_000 to 540, 800_000 to 480, 400_000 to 360,
        )
        return tiers.firstOrNull { bandwidth >= it.first }?.second
    }

    /** 从 master playlist 解析最高档短边高度（取短边防宽高写反） */
    fun parseBestHeight(text: String): Int? {
        if (!text.contains("#EXT-X-STREAM-INF")) return null
        var best: Int? = null
        var pendingBandwidth = 0
        var pendingHeight: Int? = null
        var hasPending = false
        for (raw in text.split("\n")) {
            val line = raw.trim()
            if (line.startsWith("#EXT-X-STREAM-INF")) {
                pendingBandwidth = Regex("BANDWIDTH=(\\d+)").find(line)?.groupValues?.get(1)?.toIntOrNull() ?: 0
                val res = Regex("RESOLUTION=(\\d+)x(\\d+)").find(line)
                pendingHeight = res?.let {
                    minOf(it.groupValues[1].toInt(), it.groupValues[2].toInt())
                }
                hasPending = true
                continue
            }
            if (line.isEmpty() || line.startsWith("#") || !hasPending) continue
            val height = pendingHeight ?: (if (pendingBandwidth > 0) inferHeightFromBitrate(pendingBandwidth) else null)
            if (height != null && (best == null || height > best)) best = height
            hasPending = false
        }
        return best
    }

    data class MediaPlaylistInfo(
        val initUri: String? = null,
        val firstSegment: String? = null,
        val keyMethod: String? = null,
        val keyUri: String? = null,
        val keyIv: ByteArray? = null,
        val mediaSequence: Int = 0,
    )

    fun parseMediaPlaylist(text: String): MediaPlaylistInfo {
        var initUri: String? = null
        var firstSegment: String? = null
        var keyMethod: String? = null
        var keyUri: String? = null
        var keyIv: ByteArray? = null
        var mediaSequence = 0
        for (raw in text.split("\n")) {
            val line = raw.trim()
            if (line.isEmpty()) continue
            if (line.startsWith("#EXT-X-MAP:")) {
                initUri = Regex("URI=\"([^\"]+)\"").find(line)?.groupValues?.get(1)
                continue
            }
            if (line.startsWith("#EXT-X-KEY:")) {
                keyMethod = Regex("METHOD=([^,]+)").find(line)?.groupValues?.get(1)?.trim()
                keyUri = Regex("URI=\"([^\"]+)\"").find(line)?.groupValues?.get(1)
                val iv = Regex("IV=0x([0-9a-fA-F]+)").find(line)?.groupValues?.get(1)
                keyIv = iv?.let { hexToBytes(it) }
                continue
            }
            if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
                mediaSequence = line.substringAfter(':').trim().toIntOrNull() ?: 0
                continue
            }
            if (!line.startsWith("#") && firstSegment == null) firstSegment = line
        }
        return MediaPlaylistInfo(initUri, firstSegment, keyMethod, keyUri, keyIv, mediaSequence)
    }

    private fun hexToBytes(hex: String): ByteArray? {
        if (hex.length % 2 != 0) return null
        return try {
            ByteArray(hex.length / 2) { i -> hex.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
        } catch (_: Exception) {
            null
        }
    }

    /** HLS 规定未显式给 IV 时用媒体序列号作大端 128 位 IV */
    fun defaultIv(sequence: Int): ByteArray {
        val iv = ByteArray(16)
        val seq = sequence.toLong() and 0xFFFFFFFFL
        iv[12] = ((seq shr 24) and 0xff).toByte()
        iv[13] = ((seq shr 16) and 0xff).toByte()
        iv[14] = ((seq shr 8) and 0xff).toByte()
        iv[15] = (seq and 0xff).toByte()
        return iv
    }

    private fun resolveUrl(base: String, ref: String): String? =
        try { java.net.URI(base).resolve(ref).toString() } catch (_: Exception) { null }

    private fun probeHeaders(source: SourceConfig) = NetClient.originOf(source.url)

    /** 只拉一段字节前缀（分片动辄几十 MB） */
    private fun fetchPrefix(url: String, maxBytes: Int, source: SourceConfig, deadlineMs: Long = 6_000): ByteArray? {
        val text = NetClient.getBytes(url, referer = probeHeaders(source), maxBytes = maxBytes, deadlineMs = deadlineMs)
        return text
    }

    /** 从分片本身解析分辨率（单码率兜底）；fMP4 优先 init segment */
    private fun probeSegmentResolution(text: String, playlistUrl: String, source: SourceConfig, budgetMs: Long): Int? {
        val list = parseMediaPlaylist(text)
        val firstSegment = list.firstSegment ?: return null

        list.initUri?.let { initUri ->
            val initUrl = resolveUrl(playlistUrl, initUri)
            if (initUrl != null) {
                val buf = fetchPrefix(initUrl, INIT_PREFIX_BYTES, source, minOf(SEGMENT_BUDGET_MS, budgetMs))
                buf?.let { CodecParse.parseMp4VideoResolution(it)?.height }?.let { return it }
            }
        }

        val segmentUrl = resolveUrl(playlistUrl, firstSegment) ?: return null
        var buf = fetchPrefix(segmentUrl, SEGMENT_PREFIX_BYTES, source, minOf(SEGMENT_BUDGET_MS, budgetMs))
        if (buf == null || buf.isEmpty()) return null

        if (list.keyMethod != null && list.keyMethod != "NONE") {
            if (list.keyMethod != "AES-128" || list.keyUri == null) return null
            val keyUrl = resolveUrl(playlistUrl, list.keyUri) ?: return null
            val key = fetchPrefix(keyUrl, 32, source, minOf(SEGMENT_BUDGET_MS, budgetMs)) ?: return null
            if (key.size < 16) return null
            buf = CodecParse.decryptAes128CbcPrefix(buf, key, list.keyIv ?: defaultIv(list.mediaSequence))
        }

        return if (CodecParse.looksLikeMp4(buf)) CodecParse.parseMp4VideoResolution(buf)?.height
        else CodecParse.parseTsVideoResolution(buf)?.height
    }

    /** 探测顺序：中间集优先，探不出再退最后一集（防预告片/坏集，1:1 移植） */
    fun probeEpisodeOrder(episodes: List<String>): List<String> {
        if (episodes.size < 2) return episodes.take(1)
        val mid = episodes[episodes.size / 2] ?: episodes[0]
        val last = episodes[episodes.size - 1]
        return if (mid == last) listOf(mid) else listOf(mid, last)
    }

    private fun probeEpisode(target: String, source: SourceConfig, budgetMs: Long): Pair<Int?, String?> {
        val isM3u8 = Regex("""\.m3u8([?#]|$)""", RegexOption.IGNORE_CASE).containsMatchIn(target)
        if (!isM3u8) {
            if (!Regex("""\.mp4([?#]|$)""", RegexOption.IGNORE_CASE).containsMatchIn(target)) return Pair(null, null)
            val buf = fetchPrefix(target, SEGMENT_PREFIX_BYTES, source, minOf(6_000L, budgetMs))
            return Pair(buf?.let { CodecParse.parseMp4VideoResolution(it)?.height }, null)
        }

        val text = NetClient.getText(target, referer = probeHeaders(source), maxBytes = M3U8_MAX_BYTES, deadlineMs = minOf(6_000L, budgetMs))
            ?: return Pair(null, "HTTP 请求失败")
        val height = parseBestHeight(text.first)
        if (height != null) return Pair(height, null)
        return Pair(
            try { probeSegmentResolution(text.first, target, source, budgetMs) } catch (_: Exception) { null },
            null,
        )
    }

    /** 取影片播放地址（与 /api/detail 同逻辑：列表接口优先，详情页降级） */
    private fun fetchEpisodes(source: SourceConfig, id: String, budgetMs: Long): List<String> {
        val api = CmsApi.detail(source, id, deadlineMs = budgetMs)?.defaultLine?.episodes
        if (!api.isNullOrEmpty()) return api
        return CmsApi.detailPage(source, id, deadlineMs = budgetMs)?.defaultLine?.episodes ?: emptyList()
    }

    // —— 进程内短缓存（成功 30 分钟 / 失败 2 分钟，对齐服务端策略） ——
    private data class Cached(val height: Int?, val error: String?, val at: Long)
    private val cache = ConcurrentHashMap<String, Cached>()
    private const val OK_TTL = 30 * 60 * 1000L
    private const val FAIL_TTL = 2 * 60 * 1000L

    fun probeQuality(source: SourceConfig, id: String): ProbeResult {
        val base = ProbeResult(source.key, id, null, null)
        if (!Regex("^https?://").containsMatchIn(source.url) || !Regex("^[\\w-]+$").matches(id)) {
            return base.copy(error = "无效的源或影片 ID")
        }
        val key = "${source.url.trimEnd('/')}|${source.detail ?: ""}|$id"
        cache[key]?.let {
            if (System.currentTimeMillis() - it.at < if (it.error != null) FAIL_TTL else OK_TTL) {
                return base.copy(height = it.height, error = it.error)
            }
        }

        val deadlineAt = System.currentTimeMillis() + QUALITY_PROBE_TIMEOUT_MS
        fun budget(): Long = (deadlineAt - System.currentTimeMillis()).coerceAtLeast(300)
        var lastError: String? = null
        var height: Int? = null
        try {
            val episodes = fetchEpisodes(source, id, budget())
            if (episodes.isEmpty()) {
                lastError = "未找到播放资源"
            } else {
                for (target in probeEpisodeOrder(episodes)) {
                    if (System.currentTimeMillis() >= deadlineAt - 1_000) break
                    val (h, err) = probeEpisode(target, source, budget())
                    if (h != null) { height = h; break }
                    if (err != null) lastError = err
                    if (lastError != null && Regex("^HTTP (401|403)").containsMatchIn(lastError)) break
                }
            }
        } catch (e: Throwable) {
            lastError = e.message ?: "探测失败"
        }
        cache[key] = Cached(height, lastError, System.currentTimeMillis())
        return base.copy(height = height, error = lastError)
    }
}
