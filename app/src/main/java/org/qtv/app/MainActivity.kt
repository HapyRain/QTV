package org.qtv.app

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.File
import java.io.OutputStream
import org.qtv.app.api.LocalApi
import org.qtv.app.api.PlayerHost

/**
 * 独立版宿主：WebView 加载**原封不动的 QTV 网页前端**（assets/www，静态导出）。
 *
 * - 无密码：/api/status 返回 passwordRequired=false；
 * - 无端口/地址：前端与 API 全部本地，打开即用；
 * - IndexedDB/历史/设置与网页版同一套存储（appassets 真实 origin）。
 *
 * 请求路由（shouldInterceptRequest）：
 *   /api/...          → LocalApi（本地实现，见 api/LocalApi.kt）
 *   appassets 任意路径 → assets/www/ 与子目录（根路径自动重写）
 *   其它主机（外链）   → 系统浏览器
 *
 * 稳定性（针对「搜索必现闪退」类问题的系统性加固）：
 *   - 渲染进程崩溃 → onRenderProcessGone 返回 true 并重建 WebView（默认行为是全 App 被杀）；
 *   - 未捕获异常 → 落盘 crash.log，下次启动弹窗展示（用户直接把弹窗内容反馈即可定位）；
 *   - 拦截层/流式响应全部 catch(Throwable) 兜底。
 */
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    /** 根页「再按一次退出」的时间窗起点（返回闭环，见 handleOnBackPressed） */
    private var lastBackPressedAt = 0L
    /** HTML5 全屏（onShowCustomView）：全屏视图与回调，进出时同步方向与常亮 */
    private var customView: android.view.View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null

    /** 全屏沉浸式状态栏控制（播放中隐藏、暂停露出） */
    private val insetsController: WindowInsetsControllerCompat
        get() = WindowInsetsControllerCompat(window, window.decorView)

    // —— 下载保存桥（WebView 的 blob 下载在 Android 上静默失败，必须走原生落盘） ——
    private var saveStream: OutputStream? = null
    private var saveUri: Uri? = null
    private var saveIsMediaStore = false
    private val saveLock = Any()

    /** 网页里 `<input type="file">`（配置导入）依赖这个回调桥接系统文件选择器 */
    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val data = result.data
        val uris: Array<Uri>? = if (result.resultCode == RESULT_OK) {
            data?.data?.let { arrayOf(it) }
                ?: data?.clipData?.let { clip -> Array(clip.itemCount) { i -> clip.getItemAt(i).uri } }
        } else {
            null
        }
        fileChooserCallback?.onReceiveValue(uris)
        fileChooserCallback = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        installCrashRecorder()
        maybeShowLastCrash()
        webView = WebView(this)
        setContentView(webView)
        configureWebView(webView)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val wv = if (::webView.isInitialized) webView else null
                if (wv == null) {
                    finish()
                    return
                }
                // 返回闭环：① 浮层（详情/抽屉/弹窗，前端派发 Escape 关闭）
                //            ② 页面历史后退（搜索词、/watch、/live、/about …）
                //            ③ 根页：2 秒内再按一次退出
                try {
                    wv.evaluateJavascript(
                        "(function(){try{var f=window.__qtvCloseOverlay||window.__ljjtvCloseOverlay;return !!(f && f());}catch(e){return false;}})();",
                    ) { result ->
                        if (result == "true") return@evaluateJavascript
                        if (wv.canGoBack()) {
                            wv.goBack()
                            return@evaluateJavascript
                        }
                        val now = System.currentTimeMillis()
                        if (now - lastBackPressedAt < 2000) {
                            finish()
                        } else {
                            lastBackPressedAt = now
                            Toast.makeText(this@MainActivity, "再按一次退出", Toast.LENGTH_SHORT).show()
                        }
                    }
                } catch (_: Throwable) {
                    finish()
                }
            }
        })

        webView.loadUrl("https://appassets.androidplatform.net/assets/www/index.html")
    }

    /** WebView 全量配置（首次创建与渲染崩溃重建共用） */
    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView(wv: WebView) {
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true          // localStorage + IndexedDB（历史/进度/设置）
            databaseEnabled = true
            allowFileAccess = false           // 全部资源走拦截器映射，无需文件访问
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = false   // 与网页版一致的自动播放
            cacheMode = WebSettings.LOAD_DEFAULT
            userAgentString = "$userAgentString QTVApp/1.0"
        }
        // 页面滚动条在 WebView 里像网页控件：CSS 已隐藏，这里再兜底关掉 View 自己的滚动条绘制
        wv.isVerticalScrollBarEnabled = false
        wv.isHorizontalScrollBarEnabled = false

        // 播放状态桥 + 文件保存桥（本地捆绑前端专用，不注入远程内容）
        LocalApi.playerHost = host
        try {
            // QTV 为主通道名；LJJTV 保留为兼容别名（旧前端/旧书签仍可用）
            wv.removeJavascriptInterface("QTV")
            wv.removeJavascriptInterface("LJJTV")
            val saveBridge = SaveBridge()
            wv.addJavascriptInterface(saveBridge, "QTV")
            wv.addJavascriptInterface(saveBridge, "LJJTV")
        } catch (_: Throwable) { /* 忽略 */ }

        wv.webChromeClient = object : WebChromeClient() {
            /**
             * HTML5 全屏（Element.requestFullscreen）在 Android WebView 里的唯一承接口。
             * 不实现它，页面全屏请求会直接失败——ArtPlayer 就会提示「不支持全屏」。
             * 全屏 = 传统横屏全屏：锁定横屏 + 屏幕常亮。
             */
            override fun onShowCustomView(view: android.view.View?, callback: CustomViewCallback?) {
                if (customView != null) {
                    callback?.onCustomViewHidden()
                    return
                }
                val v = view ?: run { callback?.onCustomViewHidden(); return }
                customView = v
                customViewCallback = callback
                val decor = window.decorView as android.view.ViewGroup
                webView.visibility = android.view.View.GONE
                decor.addView(
                    v,
                    android.view.ViewGroup.LayoutParams(
                        android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                        android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                    ),
                )
                try {
                    requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                } catch (_: Throwable) { /* 忽略 */ }
                window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                enterImmersive()
            }

            override fun onHideCustomView() {
                val v = customView ?: return
                (window.decorView as? android.view.ViewGroup)?.removeView(v)
                customView = null
                customViewCallback?.onCustomViewHidden()
                customViewCallback = null
                webView.visibility = android.view.View.VISIBLE
                try {
                    requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                } catch (_: Throwable) { /* 忽略 */ }
                window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                exitImmersive()
                // 退出全屏恢复系统亮度（手势改过的不带出去）
                setBrightnessInternal(-1f)
            }

            override fun onShowFileChooser(
                view: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = filePathCallback
                val intent = fileChooserParams?.createIntent()
                    ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                    }
                return try {
                    fileChooserLauncher.launch(intent)
                    true
                } catch (_: Exception) {
                    fileChooserCallback = null
                    false
                }
            }
        }

        wv.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?
            ): WebResourceResponse? {
                return try {
                    val uri = request?.url ?: return super.shouldInterceptRequest(view, request)
                    val path = uri.path ?: return super.shouldInterceptRequest(view, request)
                    if (path.startsWith("/api/")) return LocalApi.handle(request)
                    if (uri.host == "appassets.androidplatform.net") {
                        var rel = path.removePrefix("/")
                        rel = if (rel.startsWith("assets/")) rel.removePrefix("assets/") else "www/$rel"
                        return assetResponse(rel) ?: super.shouldInterceptRequest(view, request)
                    }
                    super.shouldInterceptRequest(view, request)
                } catch (_: Throwable) {
                    // 拦截器崩溃会带崩整个 App（WebView 在 binder 线程回调）：一律放行让请求走网络
                    super.shouldInterceptRequest(view, request)
                }
            }

            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val uri = request?.url ?: return false
                // 站内导航放行；外链（about 页的 GitHub 等）交系统浏览器
                return if (uri.host != "appassets.androidplatform.net") {
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, uri))
                    } catch (_: Exception) { /* 无浏览器可处理 */ }
                    true
                } else {
                    false
                }
            }

            /**
             * 渲染进程崩溃必须返回 true（已处理）：默认行为是整个 App 跟着死——
             * 这正是「搜索必现闪退」类问题最典型的放大器。这里销毁旧实例、换新 WebView 重载。
             */
            override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
                val wv2 = view ?: return true
                try {
                    val parent = wv2.parent as? android.view.ViewGroup
                    parent?.removeView(wv2)
                    wv2.destroy()
                } catch (_: Throwable) { /* 忽略 */ }
                runOnUiThread {
                    try {
                        webView = WebView(this@MainActivity).also { fresh ->
                            configureWebView(fresh)
                            setContentView(fresh)
                            fresh.loadUrl("https://appassets.androidplatform.net/assets/www/index.html")
                        }
                        Toast.makeText(this@MainActivity, "页面组件已重启", Toast.LENGTH_SHORT).show()
                    } catch (_: Throwable) { /* 忽略 */ }
                }
                return true
            }
        }
    }

    // —— 崩溃留档：下次启动弹窗展示，用户可直接复制给我 ——
    private fun crashFile(): File = File(filesDir, "crash.log")

    private fun installCrashRecorder() {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            try {
                crashFile().writeText(
                    "${java.util.Date()}\nthread=${t.name}\n" + android.util.Log.getStackTraceString(e)
                )
            } catch (_: Throwable) { /* 落盘失败也要继续走默认崩溃流程 */ }
            previous?.uncaughtException(t, e)
        }
    }

    private fun maybeShowLastCrash() {
        val f = crashFile()
        if (!f.exists()) return
        val text = try { f.readText() } catch (_: Throwable) { return }
        val shown = if (text.length > 3500) text.take(3500) + "\n…（截断）" else text
        AlertDialog.Builder(this)
            .setTitle("检测到上次异常退出")
            .setMessage("以下是崩溃记录，点「复制」后把内容发给开发者即可定位：\n\n$shown")
            .setPositiveButton("复制") { _, _ ->
                try {
                    val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    cm.setPrimaryClip(ClipData.newPlainText("crash", text))
                    Toast.makeText(this, "已复制", Toast.LENGTH_SHORT).show()
                } catch (_: Throwable) { /* 忽略 */ }
                f.delete()
            }
            .setNegativeButton("关闭") { _, _ -> f.delete() }
            .show()
    }

    // —— 全屏沉浸式：播放中藏系统栏，暂停时露出（PlayerHost.onPlaybackPaused） ——
    private fun enterImmersive() {
        try {
            WindowCompat.setDecorFitsSystemWindows(window, false)
            insetsController.hide(WindowInsetsCompat.Type.systemBars())
            insetsController.systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        } catch (_: Throwable) { /* 忽略 */ }
    }

    private fun exitImmersive() {
        try {
            insetsController.show(WindowInsetsCompat.Type.systemBars())
            WindowCompat.setDecorFitsSystemWindows(window, true)
        } catch (_: Throwable) { /* 忽略 */ }
    }

    /** 亮度（0..1；-1 = 恢复系统默认）。只影响本窗口，不动系统亮度 */
    private fun setBrightnessInternal(value: Float) {
        try {
            val lp = window.attributes
            lp.screenBrightness = if (value < 0f) android.view.WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE else value.coerceIn(0.01f, 1f)
            window.attributes = lp
            windowBrightness = lp.screenBrightness
        } catch (_: Throwable) { /* 忽略 */ }
    }

    /** 当前窗口亮度缓存：/api/player-state?read=1 在后台线程读取，不能在非 UI 线程碰 window */
    @Volatile
    private var windowBrightness: Float = -1f

    /** LocalApi 的宿主实现：播放状态 → 沉浸式；亮度/音量 → 系统 */
    private val host = object : PlayerHost {
        override fun onFullscreenChanged(fullscreen: Boolean) {
            try {
                if (fullscreen) {
                    requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                    window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    enterImmersive()
                } else if (customView == null) {
                    requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                    window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    exitImmersive()
                    setBrightnessInternal(-1f)
                }
            } catch (_: Throwable) { /* 忽略 */ }
        }

        override fun onPlaybackPaused(paused: Boolean) {
            if (customView == null) return // 只在全屏期间联动系统栏
            try {
                if (paused) insetsController.show(WindowInsetsCompat.Type.systemBars())
                else {
                    insetsController.hide(WindowInsetsCompat.Type.systemBars())
                    insetsController.systemBarsBehavior =
                        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                }
            } catch (_: Throwable) { /* 忽略 */ }
        }

        override fun setBrightness(value: Float) {
            setBrightnessInternal(value)
        }

        override fun setVolume(value: Float) {
            try {
                val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
                val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
                val target = Math.round(value.coerceIn(0f, 1f) * max).coerceIn(0, max)
                am.setStreamVolume(AudioManager.STREAM_MUSIC, target, 0)
            } catch (_: Throwable) { /* 忽略 */ }
        }

        override fun currentBrightness(): Float {
            if (windowBrightness >= 0f) return windowBrightness
            return try {
                val v = android.provider.Settings.System.getInt(
                    contentResolver,
                    android.provider.Settings.System.SCREEN_BRIGHTNESS,
                )
                v.coerceIn(0, 255) / 255f
            } catch (_: Throwable) {
                -1f
            }
        }

        override fun currentVolume(): Float = try {
            val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
            val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
            if (max <= 0) -1f else am.getStreamVolume(AudioManager.STREAM_MUSIC).toFloat() / max
        } catch (_: Throwable) {
            -1f
        }
    }

    /**
     * 文件保存桥：WebView 的 blob 下载在 Android 上静默失败（DownloadListener 收不到），
     * 前端把字节分块 base64 交给这里流式落盘（MediaStore Downloads，API<29 落应用外存目录）。
     * 调用方为本地捆绑前端（www），不注入远程页面。
     */
    inner class SaveBridge {
        @JavascriptInterface
        fun saveBegin(name: String) {
            synchronized(saveLock) {
                abortSaveLocked()
                val safe = name.replace(Regex("[\\\\/:*?\"<>|]"), "_").ifBlank { "video.mp4" }
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        val values = ContentValues().apply {
                            put(MediaStore.Downloads.DISPLAY_NAME, safe)
                            put(MediaStore.Downloads.MIME_TYPE, mimeFor(safe))
                            put(MediaStore.Downloads.IS_PENDING, 1)
                        }
                        saveIsMediaStore = true
                        saveUri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                        saveStream = saveUri?.let { contentResolver.openOutputStream(it) }
                    } else {
                        saveIsMediaStore = false
                        val dir = getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS)
                        val f = File(dir, safe)
                        saveStream = f.outputStream()
                        saveUri = Uri.fromFile(f)
                    }
                } catch (_: Throwable) {
                    saveStream = null
                    saveUri = null
                }
            }
        }

        @JavascriptInterface
        fun saveChunk(base64: String) {
            synchronized(saveLock) {
                try {
                    val bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
                    saveStream?.write(bytes)
                } catch (_: Throwable) { /* 丢块：saveEnd 会判失败 */ }
            }
        }

        @JavascriptInterface
        fun saveEnd(): Boolean {
            synchronized(saveLock) {
                return try {
                    saveStream?.flush()
                    saveStream?.close()
                    saveStream = null
                    if (saveIsMediaStore && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && saveUri != null) {
                        val values = ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }
                        contentResolver.update(saveUri!!, values, null, null)
                    } else {
                        saveUri?.lastPathSegment?.let {
                            android.media.MediaScannerConnection.scanFile(
                                this@MainActivity,
                                arrayOf(saveUri?.path),
                                null,
                                null,
                            )
                        }
                    }
                    val ok = saveUri != null
                    saveUri = null
                    ok
                } catch (_: Throwable) {
                    abortSaveLocked()
                    false
                }
            }
        }

        @JavascriptInterface
        fun saveAbort() {
            synchronized(saveLock) { abortSaveLocked() }
        }

        private fun abortSaveLocked() {
            try { saveStream?.close() } catch (_: Throwable) { /* 忽略 */ }
            saveStream = null
            try {
                if (saveIsMediaStore && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    saveUri?.let { contentResolver.delete(it, null, null) }
                } else {
                    saveUri?.path?.let { File(it).delete() }
                }
            } catch (_: Throwable) { /* 忽略 */ }
            saveUri = null
        }

        private fun mimeFor(name: String): String = when {
            name.endsWith(".ts", true) -> "video/mp2t"
            name.endsWith(".m3u8", true) -> "application/vnd.apple.mpegurl"
            name.endsWith(".mp4", true) -> "video/mp4"
            else -> "application/octet-stream"
        }
    }

    /** assets/www/ 与子目录 的 MIME 映射（静态导出产物） */
    private fun assetResponse(assetPath: String): WebResourceResponse? {
        val cleanPath = assetPath.substringBefore('?').trimEnd('/').ifEmpty { "www/index.html" }
        var resolvedPath = cleanPath
        val input = try {
            assets.open(resolvedPath)
        } catch (_: Exception) {
            try {
                resolvedPath = "$cleanPath.html"
                assets.open(resolvedPath)
            } catch (_: Exception) {
                try {
                    resolvedPath = "$cleanPath/index.html"
                    assets.open(resolvedPath)
                } catch (_: Exception) {
                    return null
                }
            }
        }
        val lower = resolvedPath.lowercase()
        val mime = when {
            lower.endsWith(".html") -> "text/html"
            lower.endsWith(".js") -> "application/javascript"
            lower.endsWith(".css") -> "text/css"
            lower.endsWith(".json") || lower.endsWith(".webmanifest") -> "application/json"
            lower.endsWith(".txt") -> "text/plain"
            lower.endsWith(".svg") -> "image/svg+xml"
            lower.endsWith(".png") -> "image/png"
            lower.endsWith(".jpg") || lower.endsWith(".jpeg") -> "image/jpeg"
            lower.endsWith(".webp") -> "image/webp"
            lower.endsWith(".gif") -> "image/gif"
            lower.endsWith(".ico") -> "image/x-icon"
            lower.endsWith(".woff2") -> "font/woff2"
            lower.endsWith(".woff") -> "font/woff"
            lower.endsWith(".m3u8") -> "application/vnd.apple.mpegurl"
            else -> "application/octet-stream"
        }
        val text = mime.startsWith("text/") || mime in setOf(
            "application/javascript", "application/json", "image/svg+xml", "application/vnd.apple.mpegurl"
        )
        return WebResourceResponse(
            mime,
            if (text) "utf-8" else null,
            200,
            "OK",
            mapOf("Access-Control-Allow-Origin" to "*"),
            input,
        )
    }
}
