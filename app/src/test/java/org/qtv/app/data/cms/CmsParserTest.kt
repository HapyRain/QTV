package org.qtv.app.data.cms

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CmsParserTest {

    // —— parseSearchList ——
    @Test
    fun `list null 返回空而非错误`() {
        assertTrue(CmsParser.parseSearchList("""{"code":1,"msg":"ok","list":null}""").isEmpty())
        assertTrue(CmsParser.parseSearchList("""{"code":1}""").isEmpty())
        assertTrue(CmsParser.parseSearchList("not json").isEmpty())
    }

    @Test
    fun `搜索列表字段映射与混型容错`() {
        val items = CmsParser.parseSearchList(
            """{"list":[{"vod_id":123,"vod_name":"肖申克的救赎","vod_year":"1994","type_name":"剧情片","vod_remarks":"高清"}]}"""
        )
        assertEquals(1, items.size)
        assertEquals("123", items[0].vodId)
        assertEquals("肖申克的救赎", items[0].name)
        assertEquals("1994", items[0].year)
    }

    // —— 播放地址 ——
    @Test
    fun `优先取含 m3u8 的线路组`() {
        // 第一组无 ep；第二组只有网页中转页 → 不含 m3u8 → 回退
        assertEquals(emptyList<String>(), CmsParser.extractEpisodesFromPlayUrl("\$\$\$/share/abc1"))
        // 组1 全是网页中转页（无 m3u8）；组2 含 m3u8 → 选组2
        val eps = CmsParser.extractEpisodesFromPlayUrl("线路1\$https://x.com/share/p1\$\$\$线路2\$https://x.com/a/index.m3u8")
        assertEquals(listOf("https://x.com/a/index.m3u8"), eps)
    }

    @Test
    fun `多线路保留全部`() {
        val lines = CmsParser.extractPlayLines(
            "量子\$\$\$非凡",
            "第1集\$https://q.com/1.m3u8#第2集\$https://q.com/2.m3u8\$\$\$第1集\$https://f.com/1.m3u8"
        )
        assertEquals(2, lines.size)
        assertEquals("量子", lines[0].name)
        assertEquals(2, lines[0].episodes.size)
        assertEquals("非凡", lines[1].name)
        assertEquals(1, lines[1].episodes.size)
    }

    @Test
    fun `extractM3u8FromText 从简介兜底`() {
        val eps = CmsParser.extractM3u8FromText("简介 \$https://cdn.com/x/index.m3u8 其他")
        assertEquals(listOf("https://cdn.com/x/index.m3u8"), eps)
    }

    @Test
    fun `详情页 HTML 通用模式与标题简介`() {
        val html = """
            <h1>测试影片</h1>
            <div class="sketch">简介 <b>加粗</b></div>
            var url = '${'$'}https://cdn.com/a/index.m3u8';
        """.trimIndent()
        val d = CmsParser.parseDetailPageHtml(html, null)!!
        assertEquals(listOf("https://cdn.com/a/index.m3u8"), d.lines[0].episodes)
        assertEquals("测试影片", d.title)
        assertTrue(d.desc!!.contains("加粗"))
    }

    @Test
    fun `详情页 HTML 非凡日期哈希特征`() {
        val html = "\$https://cdn.com/20240101/12345_abcdef0123/index.m3u8"
        val d = CmsParser.parseDetailPageHtml(html, "兜底标题")!!
        assertEquals("https://cdn.com/20240101/12345_abcdef0123/index.m3u8", d.lines[0].episodes[0])
    }

    // —— 成人过滤 ——
    @Test
    fun `成人关键词命中`() {
        assertTrue(CmsParser.isAdultContent("伦理片"))
        assertTrue(CmsParser.isAdultContent("日本 有码"))
        assertFalse(CmsParser.isAdultContent("剧情片"))
        assertFalse(CmsParser.isAdultContent(null))
    }

    // —— 归一化与季数 ——
    @Test
    fun `归一化忽略标点空白大小写`() {
        assertEquals("摔跤吧爸爸", CmsParser.normalizeTitle("摔跤吧!爸爸"))
        assertEquals("abc", CmsParser.normalizeTitle(" A_b.c "))
    }

    @Test
    fun `季数匹配查询侧无空格`() {
        // 查询「庆余年2」= 第二季；标题侧必须有空格才认季数
        assertTrue(CmsParser.isRelevant("庆余年 第二季", "庆余年2"))
        assertFalse(CmsParser.isRelevant("庆余年 第三季", "庆余年2"))
    }

    @Test
    fun `标题自带数字不误判为季数`() {
        // 「电影2」是片名自带数字，不是第二季
        assertTrue(CmsParser.isRelevant("电影2", "电影2"))
        assertFalse(CmsParser.isRelevant("电影12", "电影2"))
    }

    @Test
    fun `中文季数`() {
        assertTrue(CmsParser.isRelevant("权力的游戏 第八季", "权力的游戏8"))
    }

    @Test
    fun `filterRelevantResults 丢弃无关结果`() {
        val items = listOf(
            SearchItem("1", "庆余年 第二季", null, null, null, null, null),
            SearchItem("2", "无关电影", null, null, null, null, null),
        )
        val out = CmsParser.filterRelevantResults(items, "庆余年")
        assertEquals(1, out.size)
        assertEquals("庆余年 第二季", out[0].name)
    }
}
