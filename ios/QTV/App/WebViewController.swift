import UIKit
import WebKit
import AVFoundation
import MediaPlayer

/// iOS 原生 WebView 容器（1:1 对齐 Android `MainActivity.kt`）：
/// - 启动本机回环服务 `http://127.0.0.1:18688` + `qtv://`（兼容 `ljjtv://`）双重协议兜底，确保 `IndexedDB`、`CacheStorage` 与 `AVPlayer` 原生 HLS 硬件解码 100% 满血工作；
/// - 注入 `window.QTV` 原生分片流式下载桥（保留 `window.LJJTV` 别名），将离线缓存的 MP4 视频实时写入 iOS「文件 (Files) → 我的 iPhone → QTV → Downloads」目录；
/// - 实现 `PlayerHost`：全屏横竖屏自动旋转、状态栏与 Home 指示条自动隐藏、屏幕防息屏常亮、屏幕亮度与系统媒体音量无级调节。
final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, PlayerHost {

    private var webView: WKWebView!
    private let apiHandler = LocalApiHandler()
    private var isPlayerFullscreen = false
    private var isPlaybackPaused = true

    // 系统音量滑块控制（iOS 调节系统媒体音量的标准方式）
    private var volumeView: MPVolumeView?
    private weak var volumeSlider: UISlider?

    // 原生文件流式保存状态（对齐 Android SaveBridge）
    private let saveLock = NSLock()
    private var saveFileHandle: FileHandle?
    private var saveFileURL: URL?

    override var prefersStatusBarHidden: Bool {
        return isPlayerFullscreen && !isPlaybackPaused
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        return .lightContent
    }

    override var prefersHomeIndicatorAutoHidden: Bool {
        return isPlayerFullscreen
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 6.0 / 255.0, green: 8.0 / 255.0, blue: 12.0 / 255.0, alpha: 1.0)

        LocalHttpServer.shared.playerHost = self
        LocalHttpServer.shared.start(preferredPort: 18688)

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(onWillEnterForeground),
            name: UIApplication.willEnterForegroundNotification,
            object: nil
        )

        setupHiddenVolumeView()
        setupWebView()
        loadInitialPage()
    }

    @objc private func onWillEnterForeground() {
        LocalHttpServer.shared.start(preferredPort: LocalHttpServer.shared.port)
    }

    private func setupHiddenVolumeView() {
        let vv = MPVolumeView(frame: CGRect(x: -1000, y: -1000, width: 10, height: 10))
        vv.isHidden = false
        vv.alpha = 0.001
        view.addSubview(vv)
        self.volumeView = vv
        for subview in vv.subviews {
            if let slider = subview as? UISlider {
                self.volumeSlider = slider
                break
            }
        }
    }

    private func setupWebView() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsAirPlayForMediaPlayback = true
        config.allowsPictureInPictureMediaPlayback = true

        apiHandler.playerHost = self
        config.setURLSchemeHandler(apiHandler, forURLScheme: "qtv")
        // 兼容旧版深链：qtv:// 与 ljjtv:// 两个 scheme 都指向同一处理器
        config.setURLSchemeHandler(apiHandler, forURLScheme: "ljjtv")

        let contentController = WKUserContentController()
        contentController.add(self, name: "qtvSave")
        // 兼容旧前端：两个通道都接，处理函数里按名字判断
        contentController.add(self, name: "ljjtvSave")

        // 注入 window.QTV 原生保存桥与 iOS 平台标识（与 Android SaveBridge 接口完全一致），并保留 LJJTV 别名
        let bridgeJs = """
        (function() {
          window.__QTV_IOS__ = true;
          window.__LJJTV_IOS__ = true; // 兼容旧前端
          var saveFailed = false;
          window.QTV = {
            saveBegin: function(name) {
              saveFailed = false;
              try {
                window.webkit.messageHandlers.qtvSave.postMessage({ action: 'begin', name: String(name || 'video.mp4') });
              } catch (e) { saveFailed = true; }
            },
            saveChunk: function(base64) {
              if (saveFailed) return;
              try {
                window.webkit.messageHandlers.qtvSave.postMessage({ action: 'chunk', data: String(base64 || '') });
              } catch (e) { saveFailed = true; }
            },
            saveEnd: function() {
              if (saveFailed) return false;
              try {
                window.webkit.messageHandlers.qtvSave.postMessage({ action: 'end' });
                return true;
              } catch (e) { return false; }
            },
            saveAbort: function() {
              try {
                window.webkit.messageHandlers.qtvSave.postMessage({ action: 'abort' });
              } catch (e) {}
            }
          };
          window.LJJTV = window.QTV; // 兼容旧前端
        })();
        """
        let userScript = WKUserScript(source: bridgeJs, injectionTime: .atDocumentStart, forMainFrameOnly: false)
        contentController.addUserScript(userScript)
        config.userContentController = contentController

        let wv = WKWebView(frame: view.bounds, configuration: config)
        wv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        wv.isOpaque = false
        wv.backgroundColor = view.backgroundColor
        wv.scrollView.backgroundColor = view.backgroundColor
        wv.scrollView.showsVerticalScrollIndicator = false
        wv.scrollView.showsHorizontalScrollIndicator = false
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        wv.allowsBackForwardNavigationGestures = true
        wv.customUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 QTVApp/1.0"
        wv.navigationDelegate = self
        wv.uiDelegate = self

        view.addSubview(wv)
        self.webView = wv
    }

    private func loadInitialPage() {
        let port = LocalHttpServer.shared.port
        if let startUrl = URL(string: "http://127.0.0.1:\(port)/") {
            webView.load(URLRequest(url: startUrl))
        } else if let fallbackUrl = URL(string: "qtv://appassets.androidplatform.net/index.html") {
            webView.load(URLRequest(url: fallbackUrl))
        }
    }

    // MARK: - WKNavigationDelegate & 进程崩溃自愈

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        let host = url.host?.lowercased() ?? ""
        let isLocal = url.scheme == "qtv" || url.scheme == "ljjtv" || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data"
            || host == "127.0.0.1" || host == "localhost" || host == "appassets.androidplatform.net"
        if isLocal {
            decisionHandler(.allow)
        } else if (url.scheme == "http" || url.scheme == "https") && navigationAction.navigationType == .linkActivated {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
            decisionHandler(.cancel)
        } else {
            decisionHandler(.allow)
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        LocalHttpServer.shared.start(preferredPort: LocalHttpServer.shared.port)
        webView.reload()
    }

    // MARK: - WKUIDelegate (`window.confirm` / `window.alert`)

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "确认", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }

    // MARK: - PlayerHost 实现（全屏横竖屏旋转、防息屏、亮度与音量）

    func onPlaybackPaused(_ paused: Bool) {
        isPlaybackPaused = paused
        UIApplication.shared.isIdleTimerDisabled = !paused
        setNeedsStatusBarAppearanceUpdate()
    }

    func onFullscreenChanged(_ fullscreen: Bool) {
        guard isPlayerFullscreen != fullscreen else { return }
        isPlayerFullscreen = fullscreen
        AppDelegate.orientationLock = fullscreen ? .landscape : .portrait
        if fullscreen {
            UIApplication.shared.isIdleTimerDisabled = true
        }
        rotateDevice(to: fullscreen ? .landscapeRight : .portrait)
        setNeedsStatusBarAppearanceUpdate()
        if #available(iOS 11.0, *) {
            setNeedsUpdateOfHomeIndicatorAutoHidden()
        }
    }

    private func rotateDevice(to orientation: UIInterfaceOrientation) {
        if #available(iOS 16.0, *) {
            guard let windowScene = view.window?.windowScene else { return }
            let mask: UIInterfaceOrientationMask = (orientation.isLandscape) ? .landscape : .portrait
            windowScene.requestGeometryUpdate(.iOS(interfaceOrientations: mask))
            setNeedsUpdateOfSupportedInterfaceOrientations()
        } else {
            UIDevice.current.setValue(orientation.rawValue, forKey: "orientation")
            UIViewController.attemptRotationToDeviceOrientation()
        }
    }

    func setBrightness(_ value: Float) {
        if value < 0 { return }
        let clamped = CGFloat(min(max(value, 0.01), 1.0))
        UIScreen.main.brightness = clamped
    }

    func setVolume(_ value: Float) {
        let clamped = min(max(value, 0.0), 1.0)
        volumeSlider?.setValue(clamped, animated: false)
        volumeSlider?.sendActions(for: .touchUpInside)
    }

    func currentBrightness() -> Float {
        var b: Float = -1.0
        if Thread.isMainThread {
            b = Float(UIScreen.main.brightness)
        } else {
            DispatchQueue.main.sync {
                b = Float(UIScreen.main.brightness)
            }
        }
        return b
    }

    func currentVolume() -> Float {
        return AVAudioSession.sharedInstance().outputVolume
    }

    // MARK: - 原生文件流式保存桥 (`window.QTV` / 兼容 `window.LJJTV`)

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard (message.name == "qtvSave" || message.name == "ljjtvSave"),
              let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }

        saveLock.lock()
        defer { saveLock.unlock() }

        switch action {
        case "begin":
            abortSaveLocked()
            let rawName = (body["name"] as? String) ?? "video.mp4"
            let safeName = rawName.replacingOccurrences(of: "[\\\\/:*?\"<>|]", with: "_", options: .regularExpression)
            let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
            let downloadsDir = docs.appendingPathComponent("Downloads", isDirectory: true)
            try? FileManager.default.createDirectory(at: downloadsDir, withIntermediateDirectories: true)
            let targetURL = downloadsDir.appendingPathComponent(safeName.isEmpty ? "video.mp4" : safeName)
            FileManager.default.createFile(atPath: targetURL.path, contents: nil)
            saveFileURL = targetURL
            saveFileHandle = try? FileHandle(forWritingTo: targetURL)

        case "chunk":
            if let b64 = body["data"] as? String,
               let data = Data(base64Encoded: b64) {
                try? saveFileHandle?.write(contentsOf: data)
            }

        case "end":
            try? saveFileHandle?.synchronize()
            try? saveFileHandle?.close()
            saveFileHandle = nil
            saveFileURL = nil

        case "abort":
            abortSaveLocked()

        default:
            break
        }
    }

    private func abortSaveLocked() {
        try? saveFileHandle?.close()
        saveFileHandle = nil
        if let url = saveFileURL {
            try? FileManager.default.removeItem(at: url)
        }
        saveFileURL = nil
    }
}
