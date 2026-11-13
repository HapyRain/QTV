package org.qtv.app.player.hls

import androidx.media3.common.C
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener

/**
 * playlist 文本改写数据源（PLAN §2.3 保底方案）：
 * 对 .m3u8 响应体整体读入 → AdFilter.stripAdGroups → 再交给上层解析。
 * 不赌 DefaultHlsPlaylistParser 的可见性；playlist 体量小（KB 级）整读无压力。
 * 分片/密钥请求原样透传；改写失败时退回原文播放（宁可带广告，不能黑屏）。
 */
class AdStripDataSource(private val upstream: DataSource) : DataSource {

    private var stripped: ByteArray? = null
    private var pos = 0
    private var uri: android.net.Uri? = null

    override fun addTransferListener(transferListener: TransferListener) =
        upstream.addTransferListener(transferListener)

    override fun open(dataSpec: DataSpec): Long {
        uri = dataSpec.uri
        val path = dataSpec.uri.toString().substringBefore('?').substringBefore('#')
        val isPlaylist = path.endsWith(".m3u8", ignoreCase = true)
        if (!isPlaylist) return upstream.open(dataSpec)

        val openedLen = upstream.open(dataSpec)
        val raw = java.io.ByteArrayOutputStream().use { out ->
            val buf = ByteArray(8 * 1024)
            while (true) {
                val n = upstream.read(buf, 0, buf.size)
                if (n == C.RESULT_END_OF_INPUT) break
                if (n > 0) out.write(buf, 0, n)
            }
            out.toByteArray()
        }
        val text = raw.toString(Charsets.UTF_8)
        val bytes = try {
            AdFilter.stripAdGroups(text).toByteArray(Charsets.UTF_8)
        } catch (_: Exception) {
            raw
        }
        stripped = bytes
        pos = 0
        return if (openedLen > 0) openedLen else bytes.size.toLong()
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        val bytes = stripped ?: return upstream.read(buffer, offset, length)
        if (pos >= bytes.size) return C.RESULT_END_OF_INPUT
        val n = minOf(length, bytes.size - pos)
        System.arraycopy(bytes, pos, buffer, offset, n)
        pos += n
        return n
    }

    override fun getUri(): android.net.Uri? = uri ?: upstream.uri

    override fun getResponseHeaders(): Map<String, List<String>> = upstream.responseHeaders

    override fun close() {
        stripped = null
        pos = 0
        upstream.close()
    }

    class Factory(private val base: DataSource.Factory) : DataSource.Factory {
        override fun createDataSource(): DataSource = AdStripDataSource(base.createDataSource())
    }
}
