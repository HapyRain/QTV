package org.qtv.app.data.quality

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class QualityProbeTest {

    @Test
    fun `parseBestHeight 取短边防宽高写反`() {
        val master = """
            #EXTM3U
            #EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720
            a.m3u8
            #EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=720x1280
            b.m3u8
        """.trimIndent()
        assertEquals(720, QualityProbe.parseBestHeight(master))
    }

    @Test
    fun `无 STREAM-INF 的媒体列表不报高度`() {
        assertNull(QualityProbe.parseBestHeight("#EXTM3U\n#EXTINF:10,\nseg.ts"))
    }

    @Test
    fun `只有 BANDWIDTH 时按码率反推档位`() {
        val master = "#EXT-X-STREAM-INF:BANDWIDTH=5000000\na.m3u8"
        assertEquals(1080, QualityProbe.parseBestHeight(master))
    }

    @Test
    fun `parseMediaPlaylist 提取 init 分片与密钥`() {
        val text = """
            #EXTM3U
            #EXT-X-MEDIA-SEQUENCE:7
            #EXT-X-KEY:METHOD=AES-128,URI="k.key",IV=0x000102030405060708090a0b0c0d0e0f
            #EXT-X-MAP:URI="init.mp4"
            #EXTINF:4,
            seg1.ts
        """.trimIndent()
        val info = QualityProbe.parseMediaPlaylist(text)
        assertEquals("init.mp4", info.initUri)
        assertEquals("seg1.ts", info.firstSegment)
        assertEquals("AES-128", info.keyMethod)
        assertEquals("k.key", info.keyUri)
        assertEquals(7, info.mediaSequence)
        assertEquals(16, info.keyIv!!.size)
        assertEquals(1, info.keyIv!![1].toInt())
    }

    @Test
    fun `defaultIv 大端序列号`() {
        val iv = QualityProbe.defaultIv(0x0102)
        assertEquals(16, iv.size)
        assertEquals(1, iv[14].toInt())
        assertEquals(2, iv[15].toInt())
    }

    @Test
    fun `探测顺序中间集优先且补最后一集`() {
        val eps = listOf("e1", "e2", "e3", "e4")
        assertEquals(listOf("e3", "e4"), QualityProbe.probeEpisodeOrder(eps))
        assertEquals(listOf("only"), QualityProbe.probeEpisodeOrder(listOf("only")))
    }

    @Test
    fun `inferHeightFromBitrate 档位`() {
        assertEquals(1080, QualityProbe.inferHeightFromBitrate(5_000_000))
        assertEquals(720, QualityProbe.inferHeightFromBitrate(3_000_000))
        assertNull(QualityProbe.inferHeightFromBitrate(100))
    }
}

class CodecParseTest {

    @Test
    fun `unescapeRbsp 去防竞争字节`() {
        val src = byteArrayOf(0, 0, 3, 1, 5)
        val out = CodecParse.unescapeRbsp(src)
        assertEquals(4, out.size)
        assertEquals(1, out[2].toInt())
        assertEquals(5, out[3].toInt())
    }

    @Test
    fun `looksLikeMp4 识别 ftyp moov 与 TS 否定`() {
        val mp4 = ByteArray(16).also {
            "ftyp".forEachIndexed { i, c -> it[4 + i] = c.code.toByte() }
        }
        assertTrue(CodecParse.looksLikeMp4(mp4))
        val ts = ByteArray(188).also { it[0] = 0x47 }
        assertFalse(CodecParse.looksLikeMp4(ts))
    }

    @Test
    fun `解析被截断的 TS 不抛异常`() {
        val buf = ByteArray(200).also { it[0] = 0x47 }
        assertNull(CodecParse.parseTsVideoResolution(buf))
    }

    @Test
    fun `AES 前缀解密完整块`() {
        // key=00..0f iv=10..1f，加密 "0123456789abcdef" 得密文后前缀解密应回原文
        val key = ByteArray(16) { it.toByte() }
        val iv = ByteArray(16) { (it + 16).toByte() }
        val plain = "0123456789abcdef".toByteArray()
        val cipher = javax.crypto.Cipher.getInstance("AES/CBC/NoPadding")
        cipher.init(javax.crypto.Cipher.ENCRYPT_MODE, javax.crypto.spec.SecretKeySpec(key, "AES"), javax.crypto.spec.IvParameterSpec(iv))
        val enc = cipher.doFinal(plain)
        val dec = CodecParse.decryptAes128CbcPrefix(enc, key, iv)
        assertTrue(plain.contentEquals(dec))
    }
}
