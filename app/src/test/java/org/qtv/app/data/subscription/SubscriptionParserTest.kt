package org.qtv.app.data.subscription

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** 订阅解析真值表（语义对齐 source-list.test / tvbox-parser.test） */
class SubscriptionParserTest {

    @Test
    fun `宽容解析注释尾随逗号与裸控制字符`() {
        val json = SubscriptionParser.parseSubscriptionJson(
            """
            {
              // 行注释
              "name": "测试",
              "sources": [
                { "name": "源1", "url": "https://a.com/api.php/provide/vod", },
                /* 块注释 */ { "name": "带
                换行", "url": "https://b.com/api.php/provide/vod" },
              ],
            }
            """.trimIndent()
        )
        val p = SubscriptionParser.parseSubscriptionPayload(json)
        assertEquals("测试", p.name)
        assertEquals(2, p.sources.size)
    }

    @Test
    fun `SourceList 裸数组归一化与去重`() {
        val json = SubscriptionParser.parseSubscriptionJson(
            """[{"name":"A","url":"https://a.com/vod/"},{"url":"https://a.com/vod"},{"url":"https://b.com/vod??"}]"""
        )
        val p = SubscriptionParser.parseSubscriptionPayload(json)
        assertEquals(2, p.sources.size)          // 尾斜杠与无斜杠同源去重；空 ?/# 剥掉
        assertEquals("https://a.com/vod", p.sources[0].url)
        assertEquals("https://b.com/vod", p.sources[1].url)
    }

    @Test
    fun `缺少 sources 与 liveSources 报格式错误`() {
        try {
            SubscriptionParser.parseSubscriptionPayload(SubscriptionParser.parseSubscriptionJson("""{"name":"x"}"""))
            fail("应当抛出格式错误")
        } catch (e: SubscriptionParser.SubscriptionFormatException) {
            assertTrue(e.message!!.contains("格式不正确"))
        }
    }

    @Test
    fun `TVBOX 跳过 Spider 与 XML 并计数`() {
        val json = SubscriptionParser.parseSubscriptionJson(
            """
            {"sites":[
              {"name":"Spider站","api":"csp_Example","type":3},
              {"name":"jar站","api":"https://x.com/spider.jar","type":3},
              {"name":"XML站","api":"https://x.com/api.php/provide/vod/at/xml"},
              {"name":"JSON站","api":"https://x.com/api.php/provide/vod","type":1}
            ]}
            """.trimIndent()
        )
        val p = SubscriptionParser.parseSubscriptionPayload(json)
        assertEquals(1, p.sources.size)
        assertEquals("JSON站", p.sources[0].name)
        val stats = p.stats!!
        assertEquals("tvbox", stats.format)
        assertEquals(3, stats.skipped)
        assertEquals(2, stats.skippedByReason["spider"])
        assertEquals(1, stats.skippedByReason["xml"])
    }

    @Test
    fun `TVBOX 缺省 type 但命中 CMS 特征时宽容导入`() {
        val json = SubscriptionParser.parseSubscriptionJson(
            """{"sites":[{"name":"无类型","api":"https://x.com/api.php/provide/vod"}]}"""
        )
        val p = SubscriptionParser.parseSubscriptionPayload(json)
        assertEquals(1, p.sources.size)
    }

    @Test
    fun `TVBOX 直播仅收 M3U 且可带 EPG`() {
        val json = SubscriptionParser.parseSubscriptionJson(
            """{"lives":[{"name":"央视","url":"https://x.com/tv.m3u8","epg":"https://x.com/epg.xml"},{"name":"txt台","url":"https://x.com/tv.txt"}]}"""
        )
        val p = SubscriptionParser.parseSubscriptionPayload(json)
        assertEquals(1, p.liveSources.size)
        assertEquals("https://x.com/epg.xml", p.liveSources[0].epg)
        assertEquals(1, p.stats!!.skippedByReason["nonM3uLive"])
    }

    @Test
    fun `接口目录按 baseUrl 导入且混用报错`() {
        val ok = SubscriptionParser.parseSubscriptionPayload(
            SubscriptionParser.parseSubscriptionJson(
                """[{"name":"目录源","baseUrl":"https://x.com/api.php/provide/vod"},{"baseUrl":"https://y.com/api.php/provide/vod","enabled":false}]"""
            )
        )
        assertEquals(1, ok.sources.size)
        assertEquals("source-catalog", ok.stats!!.format)
        assertEquals(1, ok.stats!!.skippedByReason["disabled"])

        try {
            SubscriptionParser.parseSubscriptionPayload(
                SubscriptionParser.parseSubscriptionJson(
                    """[{"baseUrl":"https://x.com/vod"},{"url":"https://y.com/vod"}]"""
                )
            )
            fail("混用应报错")
        } catch (e: SubscriptionParser.SubscriptionFormatException) {
            assertTrue(e.message!!.contains("混用"))
        }
    }

    @Test
    fun `describeParseStats 文案`() {
        val text = SubscriptionParser.describeParseStats(
            SubscriptionParser.SubStats("tvbox", 2, mapOf("spider" to 2), listOf("甲"), 3)
        )
        assertTrue(text.contains("跳过 2 个"))
        assertTrue(text.contains("Spider 引擎 2"))
        assertTrue(text.contains("「甲」"))
        assertTrue(text.contains("截断 3 条"))
    }
}
