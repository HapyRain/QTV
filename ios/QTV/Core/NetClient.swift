import Foundation

/// 全局 HTTP 客户端（1:1 对齐 Android `NetClient.kt`）：
/// - 统一桌面级 User-Agent 与同源 Referer 防盗链；
/// - 响应体受单次读取体积上限 (`DEFAULT_MAX_BYTES = 8MB`) 与总死线 (`DEFAULT_DEADLINE_MS = 12s`) 保护；
/// - 字符集嗅探：Content-Type charset → UTF-8 → GB18030/GBK 兜底（兼容老旧采集站详情页）。
enum NetClient {

    static let userAgent =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"

    static let defaultMaxBytes = 8 * 1024 * 1024
    static let defaultDeadlineMs: Int = 12_000

    static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 8
        config.timeoutIntervalForResource = 12
        config.httpAdditionalHeaders = ["User-Agent": userAgent]
        return URLSession(configuration: config)
    }()

    /// 提取 URL 的 origin (`scheme://host[:port]/`) 供防盗链 Referer 使用
    static func originOf(_ rawUrl: String) -> String {
        guard let u = URL(string: rawUrl),
              let scheme = u.scheme?.lowercased(),
              let host = u.host else { return "" }
        let defaultPort = (scheme == "https") ? 443 : 80
        let portPart: String
        if let p = u.port, p != defaultPort {
            portPart = ":\(p)"
        } else {
            portPart = ""
        }
        return "\(scheme)://\(host)\(portPart)/"
    }

    /// 同步/异步兼容的带限额二进制拉取
    static func getBytes(
        _ rawUrl: String,
        referer: String? = nil,
        maxBytes: Int = defaultMaxBytes,
        deadlineMs: Int = defaultDeadlineMs
    ) -> (data: Data, contentType: String?, finalUrl: String, statusCode: Int)? {
        guard let url = URL(string: rawUrl) else { return nil }
        var req = URLRequest(url: url)
        req.timeoutInterval = Double(deadlineMs) / 1000.0
        req.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        req.setValue(referer ?? originOf(rawUrl), forHTTPHeaderField: "Referer")
        req.setValue("*/*", forHTTPHeaderField: "Accept")

        let sem = DispatchSemaphore(value: 0)
        var result: (Data, String?, String, Int)?
        let task = session.dataTask(with: req) { data, response, error in
            defer { sem.signal() }
            guard error == nil,
                  let http = response as? HTTPURLResponse,
                  let d = data else { return }
            let capped = d.count > maxBytes ? d.prefix(maxBytes) : d
            let ct = http.value(forHTTPHeaderField: "Content-Type")
            let finalUrl = http.url?.absoluteString ?? rawUrl
            result = (Data(capped), ct, finalUrl, http.statusCode)
        }
        task.resume()
        let waitResult = sem.wait(timeout: .now() + .milliseconds(deadlineMs + 500))
        if waitResult == .timedOut {
            task.cancel()
            return nil
        }
        guard let res = result, (200..<300).contains(res.3), !res.0.isEmpty else {
            return nil
        }
        return res
    }

    /// GET 文本并自动解码（UTF-8 -> GB18030 兜底）
    static func getText(
        _ rawUrl: String,
        referer: String? = nil,
        maxBytes: Int = defaultMaxBytes,
        deadlineMs: Int = defaultDeadlineMs
    ) -> (text: String, finalUrl: String)? {
        guard let res = getBytes(rawUrl, referer: referer, maxBytes: maxBytes, deadlineMs: deadlineMs) else {
            return nil
        }
        let decoded = decodeBytes(res.data, contentType: res.contentType)
        return (decoded, res.finalUrl)
    }

    static func decodeBytes(_ data: Data, contentType: String? = nil) -> String {
        if let ct = contentType?.lowercased(),
           ct.contains("gbk") || ct.contains("gb2312") || ct.contains("gb18030") {
            let gbEnc = CFStringConvertEncodingToNSStringEncoding(CFStringEncoding(CFStringEncodings.GB_18030_2000.rawValue))
            if let s = String(data: data, encoding: String.Encoding(rawValue: gbEnc)) {
                return s
            }
        }
        if let utf8 = String(data: data, encoding: .utf8) {
            let badCount = utf8.unicodeScalars.filter { $0.value == 0xFFFD }.count
            if badCount > 0 && badCount * 50 > utf8.count {
                let gbEnc = CFStringConvertEncodingToNSStringEncoding(CFStringEncoding(CFStringEncodings.GB_18030_2000.rawValue))
                if let gb = String(data: data, encoding: String.Encoding(rawValue: gbEnc)) {
                    return gb
                }
            }
            return utf8
        }
        let gbEnc = CFStringConvertEncodingToNSStringEncoding(CFStringEncoding(CFStringEncodings.GB_18030_2000.rawValue))
        if let gb = String(data: data, encoding: String.Encoding(rawValue: gbEnc)) {
            return gb
        }
        return String(decoding: data, as: UTF8.self)
    }
}
