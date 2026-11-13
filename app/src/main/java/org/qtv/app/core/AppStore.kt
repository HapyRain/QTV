package org.qtv.app.core

import android.content.Context
import android.content.SharedPreferences
import org.qtv.app.data.cms.SourceConfig
import org.json.JSONArray
import org.json.JSONObject

/**
 * v0.1 持久化：SharedPreferences（PLAN §6.0：Room 留到后续里程碑）。
 * 存：点播源列表、成人过滤开关、播放进度。
 */
object AppStore {

    private lateinit var prefs: SharedPreferences

    fun init(context: Context) {
        prefs = context.applicationContext.getSharedPreferences("libretv", Context.MODE_PRIVATE)
    }

    // —— 源管理 ——
    fun loadSources(): List<SourceConfig> {
        val raw = prefs.getString("sources", null) ?: return emptyList()
        return try {
            val arr = JSONArray(raw)
            buildList {
                for (i in 0 until arr.length()) {
                    val o = arr.getJSONObject(i)
                    add(
                        SourceConfig(
                            key = o.optString("key", "src_$i"),
                            name = o.optString("name", ""),
                            url = o.optString("url", ""),
                            detail = o.optString("detail", "").ifBlank { null },
                            isAdult = o.optBoolean("isAdult", false),
                        )
                    )
                }
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun saveSources(sources: List<SourceConfig>) {
        val arr = JSONArray()
        sources.forEachIndexed { i, s ->
            arr.put(
                JSONObject()
                    .put("key", s.key.ifBlank { "src_$i" })
                    .put("name", s.name)
                    .put("url", s.url)
                    .put("detail", s.detail ?: "")
                    .put("isAdult", s.isAdult)
            )
        }
        prefs.edit().putString("sources", arr.toString()).apply()
    }

    // —— 设置 ——
    var adultFilter: Boolean
        get() = prefs.getBoolean("adultFilter", true)
        set(value) = prefs.edit().putBoolean("adultFilter", value).apply()

    // —— 播放进度："key" -> "positionMs|durationMs" ——
    fun saveProgress(key: String, positionMs: Long, durationMs: Long) {
        prefs.edit().putString("progress:$key", "$positionMs|$durationMs").apply()
    }

    fun loadProgress(key: String): Pair<Long, Long>? {
        val raw = prefs.getString("progress:$key", null) ?: return null
        val parts = raw.split("|")
        if (parts.size != 2) return null
        return Pair(parts[0].toLongOrNull() ?: 0L, parts[1].toLongOrNull() ?: 0L)
    }
}
