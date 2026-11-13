package org.qtv.app.data.live

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class M3uParserTest {

    @Test
    fun `标准 EXTINF 属性解析`() {
        val m3u = """
            #EXTM3U
            #EXTINF:-1 tvg-id="cctv1" tvg-logo="http://x/logo.png" group-title="央视",CCTV-1
            http://x/cctv1.m3u8
        """.trimIndent()
        val chs = M3uParser.parseM3u(m3u)
        assertEquals(1, chs.size)
        assertEquals("CCTV-1", chs[0].name)
        assertEquals("cctv1", chs[0].id)
        assertEquals("央视", chs[0].group)
        assertEquals("http://x/logo.png", chs[0].logo)
    }

    @Test
    fun `非标准 EXTINF 与 EXTGRP 兜底`() {
        val m3u = """
            #EXTINF:-1,湖南卫视 tvg-id="hunan"
            #EXTGRP:卫视
            http://x/hunan.m3u8
        """.trimIndent()
        val chs = M3uParser.parseM3u(m3u)
        assertEquals(1, chs.size)
        assertEquals("卫视", chs[0].group)
    }

    @Test
    fun `去重与非 http 丢弃与相对地址`() {
        val m3u = """
            #EXTINF:-1,A
            http://x/a.m3u8
            #EXTINF:-1,A重复
            http://x/a.m3u8
            #EXTINF:-1,组播
            rtp://239.0.0.1:1234
            #EXTINF:-1,相对
            /rel.m3u8
        """.trimIndent()
        val chs = M3uParser.parseM3u(m3u, "http://x/sub/list.m3u")
        assertEquals(2, chs.size)
        assertEquals("http://x/rel.m3u8", chs[1].url)
    }

    @Test
    fun `stableId 稳定且非空`() {
        assertEquals(M3uParser.stableId("http://x/a"), M3uParser.stableId("http://x/a"))
        assertTrue(M3uParser.stableId("http://x/a").isNotEmpty())
    }
}

class XmltvParserTest {

    @Test
    fun `parseXmltvTime 多种时区`() {
        assertEquals(1704081600000L, XmltvParser.parseXmltvTime("20240101120000 +0800"))
        assertEquals(1704081600000L, XmltvParser.parseXmltvTime("20240101040000 Z"))
        assertNull(XmltvParser.parseXmltvTime("not-a-time"))
    }

    @Test
    fun `解析 programme 并按窗口裁剪`() {
        val now = 1704081600000L // 2024-01-01 04:00:00Z
        val xml = """
            <tv>
              <programme start="20240101030000 Z" stop="20240101050000 Z" channel="c1">
                <title>跨窗口节目</title><desc>简介</desc>
              </programme>
              <programme start="20240101060000 Z" stop="20240101070000 Z" channel="c1">
                <title><![CDATA[未来的]]></title>
              </programme>
              <programme start="20230101060000 Z" stop="20230101070000 Z" channel="c1">
                <title>过期的</title>
              </programme>
            </tv>
        """.trimIndent()
        val map = XmltvParser.parseXmltv(xml, 24 * 3600 * 1000L, now)
        val list = map["c1"]!!
        assertEquals(2, list.size) // 过期的被窗口裁掉
        assertEquals("跨窗口节目", list[0].title)
        assertEquals("简介", list[0].desc)
        assertEquals("未来的", list[1].title)

        val (current, next) = XmltvParser.currentAndNext(list, now)
        assertNotNull(current)
        assertEquals("跨窗口节目", current!!.title)
        assertNotNull(next)
        assertEquals("未来的", next!!.title)
    }

    @Test
    fun `decodeXmlText 实体与 CDATA`() {
        assertEquals("a<b>&", XmltvParser.decodeXmlText("<![CDATA[a<b>&]]>"))
        assertEquals("甲\"乙", XmltvParser.decodeXmlText("甲&quot;乙"))
    }
}
