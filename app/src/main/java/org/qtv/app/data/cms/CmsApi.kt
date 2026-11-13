package org.qtv.app.data.cms

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.qtv.app.core.network.NetClient

/** 用户配置的采集站（Apple CMS） */
data class SourceConfig(
    val key: String,
    val name: String,
    val url: String,
    val detail: String? = null,
    val isAdult: Boolean = false,
)

/** 单源搜索结算结果 */
data class SourceOutcome(
    val source: SourceConfig,
    val ok: Boolean,
    val list: List<SearchItem>,
    val error: String? = null,
    val timedOut: Boolean = false,
    val ms: Long = 0,
)

/** Apple CMS HTTP 接口（PLAN §3.3） */
object CmsApi {

    private val jsonLenient = Json { ignoreUnknownKeys = true; isLenient = true }

    /** GET {url}?ac=videolist&wd={wd}&pg={page} */
    fun search(source: SourceConfig, wd: String, page: Int): Pair<List<SearchItem>, Int>? {
        val sep = if (source.url.contains("?")) "&" else "?"
        val url = source.url + sep + "ac=videolist&wd=" + java.net.URLEncoder.encode(wd, "UTF-8") + "&pg=" + page
        val (text, _) = NetClient.getText(url) ?: return null
        val items = CmsParser.parseSearchList(text)
        val pagecount = parsePageCount(text) ?: 1
        return Pair(items, pagecount)
    }

    /** GET {url}?ac=videolist&ids={id} */
    fun detail(source: SourceConfig, id: String, deadlineMs: Long = NetClient.DEFAULT_DEADLINE_MS): VideoDetailResult? {
        val sep = if (source.url.contains("?")) "&" else "?"
        val url = source.url + sep + "ac=videolist&ids=" + java.net.URLEncoder.encode(id, "UTF-8")
        val (text, _) = NetClient.getText(url, deadlineMs = deadlineMs) ?: return null
        return CmsParser.parseDetail(text)
    }

    /** 详情页 HTML 降级：{detailRoot}/index.php/vod/detail/id/{id}.html */
    fun detailPage(source: SourceConfig, id: String, deadlineMs: Long = NetClient.DEFAULT_DEADLINE_MS): VideoDetailResult? {
        val root = detailRoot(source)
        val url = root.trimEnd('/') + "/index.php/vod/detail/id/" + id + ".html"
        val (text, _) = NetClient.getText(url, deadlineMs = deadlineMs) ?: return null
        return CmsParser.parseDetailPageHtml(text, null)
    }

    /** detail 根地址推导（PLAN §1-3）：source.detail → 接口 origin */
    fun detailRoot(source: SourceConfig): String {
        source.detail?.let { if (it.isNotBlank()) return it }
        return NetClient.originOf(source.url).trimEnd('/')
    }

    private fun parsePageCount(text: String): Int? {
        return try {
            val el = jsonLenient.parseToJsonElement(text)
            val obj = el as? JsonObject ?: return null
            val list = obj["list"]
            // pagecount 在 list 节点上（Apple CMS 惯例），个别站放外层
            val fromList = (list as? JsonObject)?.get("pagecount")?.jsonPrimitive?.content
            val fromRoot = obj["pagecount"]?.jsonPrimitive?.content
            (fromList ?: fromRoot)?.toIntOrNull()
        } catch (_: Exception) {
            null
        }
    }
}
