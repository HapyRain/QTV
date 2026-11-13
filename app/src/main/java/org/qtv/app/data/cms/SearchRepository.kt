package org.qtv.app.data.cms

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * 聚合搜索（PLAN §1-2 / §3.3）：并行搜所有源、每源总死线、逐源结算回调、
 * 最终聚合（去重 → 成人过滤 → 相关性过滤 → 精确命中置顶 + 名称排序）。
 */
object SearchRepository {

    /** 单源总死线（对齐 SEARCH_SOURCE_TIMEOUT_MS=10s） */
    const val SOURCE_TIMEOUT_MS = 10_000L
    /** 每源最多页数（对齐 SEARCH_MAX_PAGES=5） */
    const val MAX_PAGES = 5

    data class FinalResult(
        val list: List<SearchItem>,
        val failures: List<SourceOutcome>,
    )

    /**
     * @param onOutcome 每源结算即回调（线程不保证，主线程外）。
     * @return 聚合后的最终结果（顺序：精确命中 → 名称 → 源名）。
     */
    suspend fun search(
        wd: String,
        sources: List<SourceConfig>,
        filterAdult: Boolean,
        onOutcome: (SourceOutcome) -> Unit,
    ): FinalResult = coroutineScope {
        val deferred = sources.map { src ->
            async {
                val outcome = searchOne(src, wd, filterAdult)
                onOutcome(outcome)
                outcome
            }
        }
        val outcomes = deferred.map { it.await() }
        aggregate(outcomes, wd, filterAdult)
    }

    private suspend fun searchOne(
        source: SourceConfig,
        wd: String,
        filterAdult: Boolean,
    ): SourceOutcome = withTimeoutOrNull(SOURCE_TIMEOUT_MS) {
        val t0 = System.currentTimeMillis()
        val first = withContext(Dispatchers.IO) { CmsApi.search(source, wd, 1) }
            ?: return@withTimeoutOrNull SourceOutcome(source, false, emptyList(), error = "请求失败或格式错误")
        val (page1, pageCount) = first
        val restPages: List<SearchItem> = if (pageCount > 1) {
            val pages = (2..minOf(pageCount, MAX_PAGES)).toList()
            coroutineScope {
                pages.map { p -> async { withContext(Dispatchers.IO) { CmsApi.search(source, wd, p)?.first ?: emptyList<SearchItem>() } } }
                    .awaitAll()
                    .flatten()
            }
        } else {
            emptyList()
        }
        val raw = (page1 + restPages).distinctBy { it.vodId }
        val filtered = (if (filterAdult) CmsParser.filterAdultResults(raw) else raw)
            .let { CmsParser.filterRelevantResults(it, wd) }
        SourceOutcome(source, true, filtered, ms = System.currentTimeMillis() - t0)
    } ?: SourceOutcome(source, false, emptyList(), timedOut = true, error = "超时")

    /** 与 aggregateOutcomes 同构：去重 → 排序（精确命中 0/1 → 名称 → 源名） */
    fun aggregate(outcomes: List<SourceOutcome>, wd: String, filterAdult: Boolean): FinalResult {
        val failures = outcomes.filter { !it.ok }
        val seen = HashSet<String>()
        val merged = ArrayList<SearchItem>()
        for (o in outcomes) {
            for (item in o.list) {
                if (filterAdult && CmsParser.isAdultContent(item.typeName)) continue
                val key = "${o.source.key}_${item.vodId}"
                if (!seen.add(key)) continue
                merged.add(item)
            }
        }
        val exact = CmsParser.normalizeTitle(wd)
        val sorted = merged.sortedWith(
            compareBy<SearchItem> { if (CmsParser.normalizeTitle(it.name) == exact) 0 else 1 }
                .thenBy { it.name }
        )
        return FinalResult(sorted, failures)
    }
}
