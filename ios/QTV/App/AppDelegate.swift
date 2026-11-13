import UIKit
import AVFoundation

@main
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?
    /// 动态屏幕方向锁：默认允许竖屏，进入播放器全屏时切换为横屏 (.landscape)
    static var orientationLock: UIInterfaceOrientationMask = .portrait

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        installCrashRecorder()
        configureAudioSession()

        let window = UIWindow(frame: UIScreen.main.bounds)
        window.backgroundColor = UIColor(red: 6.0 / 255.0, green: 8.0 / 255.0, blue: 12.0 / 255.0, alpha: 1.0)
        let rootVC = WebViewController()
        window.rootViewController = rootVC
        window.makeKeyAndVisible()
        self.window = window

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            self.maybeShowLastCrash(on: rootVC)
        }
        return true
    }

    func application(
        _ application: UIApplication,
        supportedInterfaceOrientationsFor window: UIWindow?
    ) -> UIInterfaceOrientationMask {
        return AppDelegate.orientationLock
    }

    /// 配置电影播放音频会话：即使 iPhone 侧边静音键开启，视频依然正常发声，且支持后台/画中画音频
    private func configureAudioSession() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .moviePlayback, options: [.allowAirPlay, .allowBluetooth])
            try session.setActive(true)
        } catch {
            // 忽略音频会话初始化非致命异常
        }
    }

    private static func crashFileURL() -> URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        return docs.appendingPathComponent("crash.log")
    }

    private func installCrashRecorder() {
        NSSetUncaughtExceptionHandler { exception in
            let info = """
            Date: \(Date())
            Name: \(exception.name.rawValue)
            Reason: \(exception.reason ?? "unknown")
            Stack:
            \(exception.callStackSymbols.joined(separator: "\n"))
            """
            try? info.write(to: AppDelegate.crashFileURL(), atomically: true, encoding: .utf8)
        }
    }

    private func maybeShowLastCrash(on presenter: UIViewController) {
        let url = AppDelegate.crashFileURL()
        guard FileManager.default.fileExists(atPath: url.path),
              let text = try? String(contentsOf: url, encoding: .utf8),
              !text.isEmpty else { return }
        let shown = text.count > 3000 ? String(text.prefix(3000)) + "\n…（已截断）" : text
        let alert = UIAlertController(
            title: "检测到上次异常退出",
            message: "以下是崩溃诊断日志，点击「复制」可发送给开发者排查：\n\n\(shown)",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "复制", style: .default) { _ in
            UIPasteboard.general.string = text
            try? FileManager.default.removeItem(at: url)
        })
        alert.addAction(UIAlertAction(title: "关闭", style: .cancel) { _ in
            try? FileManager.default.removeItem(at: url)
        })
        presenter.present(alert, animated: true)
    }
}
