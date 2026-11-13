package org.qtv.app.player.hls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** m3u8 广告过滤真值表（语义对齐 src/lib/m3u8.test.ts） */
class AdFilterTest {

    private fun seg(url: String, dur: Double = 10.0) = "#EXTINF:$dur,\n$url"
    private fun disc() = "#EXT-X-DISCONTINUITY"
    private val header = "#EXTM3U\n#EXT-X-TARGETDURATION:10\n"

    @Test
    fun `URL 特征组整段剔除但保留段前 DISCONTINUITY`() {
        val m3u8 = listOf(
            header.trim(),
            seg("https://a.com/1.ts"),
            disc(),
            seg("https://a.com/video/adjump/time/2.ts"),
            seg("https://a.com/video/adjump/time/3.ts"),
            disc(),
            seg("https://a.com/4.ts"),
        ).joinToString("\n")
        val out = AdFilter.stripMarkedAdGroups(m3u8)
        assertFalse(out.contains("adjump"))
        assertTrue(out.contains("https://a.com/1.ts"))
        assertTrue(out.contains("https://a.com/4.ts"))
        // 广告组前的 DISCONTINUITY 保留作正片分段边界
        assertEquals(1, out.lines().count { it.trim() == "#EXT-X-DISCONTINUITY" })
    }

    @Test
    fun `URL 特征组混入正片分片则整组放过`() {
        val m3u8 = listOf(
            header.trim(),
            seg("https://a.com/1.ts"),
            disc(),
            seg("https://a.com/video/adjump/2.ts"),
            seg("https://a.com/real3.ts"),
        ).joinToString("\n")
        val out = AdFilter.stripMarkedAdGroups(m3u8)
        assertTrue(out.contains("adjump"))
        assertTrue(out.contains("real3.ts"))
    }

    @Test
    fun `段内 KEY MAP 保留`() {
        val m3u8 = listOf(
            header.trim(),
            seg("https://a.com/1.ts"),
            disc(),
            "#EXT-X-KEY:METHOD=AES-128,URI=\"https://a.com/k.key\"",
            seg("https://a.com/video/adjump/2.ts"),
            disc(),
            seg("https://a.com/3.ts"),
        ).joinToString("\n")
        val out = AdFilter.stripMarkedAdGroups(m3u8)
        assertTrue(out.contains("EXT-X-KEY"))
        assertFalse(out.contains("adjump"))
    }

    @Test
    fun `两长夹一短剔除中插`() {
        val m3u8 = listOf(
            header.trim(),
            seg("https://a.com/1.ts", 300.0),
            disc(),
            seg("https://a.com/ad2.ts", 15.0),
            disc(),
            seg("https://a.com/3.ts", 300.0),
        ).joinToString("\n")
        val out = AdFilter.stripInterstitialAdGroups(m3u8)
        assertFalse(out.contains("ad2.ts"))
        assertTrue(out.contains("1.ts"))
        assertTrue(out.contains("3.ts"))
    }

    @Test
    fun `短邻段不触发中插判定`() {
        // dytt 式：全片短段（40s/15s/40s），邻段 <120s，绝不能触发
        val m3u8 = listOf(
            header.trim(),
            seg("https://a.com/1.ts", 40.0),
            disc(),
            seg("https://a.com/2.ts", 15.0),
            disc(),
            seg("https://a.com/3.ts", 40.0),
        ).joinToString("\n")
        val out = AdFilter.stripInterstitialAdGroups(m3u8)
        assertTrue(out.contains("2.ts"))
    }

    @Test
    fun `片头插入段整组剔除`() {
        val m3u8 = listOf(
            header.trim(),
            disc(),
            seg("https://a.com/ad1.ts", 5.0),
            seg("https://a.com/ad2.ts", 5.0),
            disc(),
            seg("https://a.com/real.ts", 300.0),
        ).joinToString("\n")
        val out = AdFilter.stripLeadAdGroup(m3u8)
        assertFalse(out.contains("ad1.ts"))
        assertFalse(out.contains("ad2.ts"))
        assertTrue(out.contains("real.ts"))
        // 新开头的 DISCONTINUITY 一并清掉
        assertFalse(out.lines().first().contains("DISCONTINUITY"))
    }

    @Test
    fun `首分片之前有内容则不动`() {
        val m3u8 = listOf(
            header.trim(),
            seg("https://a.com/1.ts", 5.0),
            disc(),
            seg("https://a.com/2.ts", 5.0),
            disc(),
            seg("https://a.com/3.ts", 300.0),
        ).joinToString("\n")
        assertEquals(m3u8, AdFilter.stripLeadAdGroup(m3u8))
    }

    @Test
    fun `多分组封装同构跳过片头剔除`() {
        // 4 组各 5 片：片头组与其余组同构 ⇒ 封装边界，不剔除
        val lines = ArrayList<String>()
        lines.add(header.trim())
        for (g in 0 until 4) {
            if (g > 0) lines.add(disc())
            for (s in 0 until 5) lines.add(seg("https://a.com/g${g}_$s.ts", 20.0))
        }
        val m3u8 = lines.joinToString("\n")
        assertEquals(m3u8, AdFilter.stripLeadAdGroup(m3u8))
    }

    @Test
    fun `stripLeadingDisc 清首分片前孤立标记`() {
        val m3u8 = listOf(header.trim(), disc(), seg("https://a.com/1.ts")).joinToString("\n")
        val out = AdFilter.stripLeadingDisc(m3u8)
        assertFalse(out.contains("DISCONTINUITY"))
        assertTrue(out.contains("1.ts"))
    }

    @Test
    fun `总入口串联四级管线`() {
        val m3u8 = listOf(
            header.trim(),
            disc(),
            seg("https://a.com/video/adjump/x1.ts", 5.0),
            disc(),
            seg("https://a.com/real.ts", 300.0),
        ).joinToString("\n")
        val out = AdFilter.stripAdGroups(m3u8)
        assertFalse(out.contains("adjump"))
        assertTrue(out.contains("real.ts"))
    }
}
