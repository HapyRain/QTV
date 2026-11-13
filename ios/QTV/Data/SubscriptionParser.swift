import Foundation

/// 数据源订阅解析（1:1 移植 `SubscriptionParser.kt`）：
/// 自动识别 TVBOX 配置（`sites`/`lives`）→ 接口目录（裸数组带 `baseUrl`）→ LibreTV-SourceList，
/// 兼容 `//`、`/* */` 注释与尾随逗号。
enum SubscriptionParser {

    static let maxVodSources = 100
    static let maxLiveSources = 50

    struct SubSource {
        let name: String
        let url: String
        let detail: String?
        let isAdult: Bool
    }

    struct SubLiveSource {
        let name: String
        let url: String
        let epg: String?
    }

    struct SubStats {
        let format: String
        let skipped: Int
        let skippedByReason: [String: Int]
        let skippedSamples: [String]?
        let truncated: Int
    }

    struct SubPayload {
        let name: String?
        let sources: [SubSource]
        let liveSources: [SubLiveSource]
        let stats: SubStats?
    }

    enum FormatError: LocalizedError {
        case invalid(String)
        var errorDescription: String? {
            switch self {
            case .invalid(let msg): return msg
            }
        }
    }

    private static let spiderRegex = try! NSRegularExpression(pattern: "^csp_|\\.(?:jar|js|py)(?:[?#].*)?$", options: [.caseInsensitive])
    private static let cmsApiRegex = try! NSRegularExpression(pattern: "/api\\.php/provide/vod(?![^?#]*/at/xml)(?:[/?#]|$)", options: [.caseInsensitive])
    private static let m3uRegex = try! NSRegularExpression(pattern: "\\.m3u8?(?:[?#].*)?$", options: [.caseInsensitive])
    private static let txtRegex = try! NSRegularExpression(pattern: "\\.txt(?:[?#].*)?$", options: [.caseInsensitive])

    static func normalizeSubscriptionUrl(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("?") || s.hasSuffix("#") || s.hasSuffix("/") {
            s.removeLast()
        }
        return s
    }

    static func normalizeUrl(_ raw: Any?, trimTrailingSlash: Bool) -> String? {
        guard let str = (raw as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !str.isEmpty else {
            return nil
        }
        let lower = str.lowercased()
        guard lower.hasPrefix("http://") || lower.hasPrefix("https://") else { return nil }
        var cleaned = str
        while cleaned.hasSuffix("?") || cleaned.hasSuffix("#") { cleaned.removeLast() }
        if trimTrailingSlash {
            while cleaned.hasSuffix("/") { cleaned.removeLast() }
        }
        guard URL(string: cleaned) != nil else { return nil }
        return cleaned
    }

    static func hostnameOf(_ url: String) -> String {
        URL(string: url)?.host ?? url
    }

    static func stripCommentsAndTrailingCommas(_ text: String) -> String {
        let noBom = text.hasPrefix("\u{FEFF}") ? String(text.dropFirst()) : text
        let chars = Array(noBom.unicodeScalars)
        var step1 = String.UnicodeScalarView()
        var inString = false
        var inLine = false
        var inBlock = false
        var i = 0

        while i < chars.count {
            let ch = chars[i]
            let next = (i + 1 < chars.count) ? chars[i + 1] : nil
            if inLine {
                if ch == "\n" || ch == "\r" {
                    inLine = false
                    step1.append(ch)
                }
            } else if inBlock {
                if ch == "*" && next == "/" {
                    inBlock = false
                    i += 1
                }
            } else if inString {
                if ch.value < 0x20 {
                    // 转义裸控制字符
                    step1.append("\\")
                    step1.append("n")
                } else {
                    step1.append(ch)
                    if ch == "\\" {
                        if let n = next { step1.append(n) }
                        i += 1
                    } else if ch == "\"" {
                        inString = false
                    }
                }
            } else {
                if ch == "\"" {
                    inString = true
                    step1.append(ch)
                } else if ch == "/" && next == "/" {
                    inLine = true
                    i += 1
                } else if ch == "/" && next == "*" {
                    inBlock = true
                    i += 1
                } else {
                    step1.append(ch)
                }
            }
            i += 1
        }

        let arr2 = Array(step1)
        var out = String.UnicodeScalarView()
        inString = false
        i = 0
        while i < arr2.count {
            let ch = arr2[i]
            if inString {
                out.append(ch)
                if ch == "\\" {
                    if i + 1 < arr2.count { out.append(arr2[i + 1]) }
                    i += 1
                } else if ch == "\"" {
                    inString = false
                }
            } else if ch == "\"" {
                inString = true
                out.append(ch)
            } else if ch == "," {
                var j = i + 1
                while j < arr2.count && CharacterSet.whitespacesAndNewlines.contains(arr2[j]) {
                    j += 1
                }
                if j < arr2.count && (arr2[j] == "}" || arr2[j] == "]") {
                    // 丢弃尾随逗号
                } else {
                    out.append(ch)
                }
            } else {
                out.append(ch)
            }
            i += 1
        }
        return String(out)
    }

    static func parseSubscriptionText(_ text: String) throws -> SubPayload {
        let cleaned = stripCommentsAndTrailingCommas(text)
        guard let data = cleaned.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) else {
            throw FormatError.invalid("订阅内容不是合法的 JSON")
        }

        if let obj = json as? [String: Any], (obj["sites"] is [[String: Any]] || obj["lives"] is [[String: Any]]) {
            return try parseTvbox(obj)
        }

        if let arr = json as? [[String: Any]], !arr.isEmpty {
            let allBaseUrl = arr.allSatisfy { $0["baseUrl"] != nil }
            if allBaseUrl {
                return try parseCatalog(arr)
            }
        }

        return try parseSourceList(json)
    }

    private static func parseSourceList(_ json: Any) throws -> SubPayload {
        let obj = json as? [String: Any]
        let rawVod = (json as? [[String: Any]]) ?? (obj?["sources"] as? [[String: Any]]) ?? []
        let rawLive = (obj?["liveSources"] as? [[String: Any]]) ?? []
        if rawVod.isEmpty && rawLive.isEmpty {
            throw FormatError.invalid("订阅内容格式不正确（缺少 sources / liveSources 数组）")
        }
        var sources: [SubSource] = []
        var seenVod = Set<String>()
        for item in rawVod {
            if sources.count >= maxVodSources { break }
            guard let url = normalizeUrl(item["url"], trimTrailingSlash: true),
                  seenVod.insert(url).inserted else { continue }
            let name = (item["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let detail = normalizeUrl(item["detail"], trimTrailingSlash: true)
            let isAdult = (item["isAdult"] as? Bool) ?? false
            sources.append(SubSource(
                name: (name?.isEmpty == false) ? name! : hostnameOf(url),
                url: url,
                detail: detail,
                isAdult: isAdult
            ))
        }

        var liveSources: [SubLiveSource] = []
        var seenLive = Set<String>()
        for item in rawLive {
            if liveSources.count >= maxLiveSources { break }
            guard let url = normalizeUrl(item["url"], trimTrailingSlash: false),
                  seenLive.insert(url).inserted else { continue }
            let name = (item["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let epg = normalizeUrl(item["epg"], trimTrailingSlash: false)
            liveSources.append(SubLiveSource(
                name: (name?.isEmpty == false) ? name! : hostnameOf(url),
                url: url,
                epg: epg
            ))
        }
        let subName = (obj?["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return SubPayload(
            name: (subName?.isEmpty == false) ? subName : nil,
            sources: sources,
            liveSources: liveSources,
            stats: SubStats(format: "libretv", skipped: 0, skippedByReason: [:], skippedSamples: nil, truncated: 0)
        )
    }

    private static func parseCatalog(_ entries: [[String: Any]]) throws -> SubPayload {
        var sources: [SubSource] = []
        var seen = Set<String>()
        var skipped = 0
        var byReason: [String: Int] = [:]
        var truncated = 0

        for entry in entries {
            if let enabled = entry["enabled"] as? Bool, !enabled {
                skipped += 1
                byReason["disabled", default: 0] += 1
                continue
            }
            guard let url = normalizeUrl(entry["baseUrl"], trimTrailingSlash: true) else {
                skipped += 1
                byReason["invalidUrl", default: 0] += 1
                continue
            }
            if seen.contains(url) { continue }
            if sources.count >= maxVodSources {
                truncated += 1
                continue
            }
            seen.insert(url)
            let name = (entry["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            sources.append(SubSource(name: (name?.isEmpty == false) ? name! : hostnameOf(url), url: url, detail: nil, isAdult: false))
        }

        if sources.isEmpty {
            throw FormatError.invalid("配置中没有可导入的接口源")
        }
        return SubPayload(
            name: nil,
            sources: sources,
            liveSources: [],
            stats: SubStats(format: "source-catalog", skipped: skipped, skippedByReason: byReason, skippedSamples: nil, truncated: truncated)
        )
    }

    private static func matches(_ regex: NSRegularExpression, _ s: String) -> Bool {
        let range = NSRange(s.startIndex..<s.endIndex, in: s)
        return regex.firstMatch(in: s, options: [], range: range) != nil
    }

    private static func parseTvbox(_ record: [String: Any]) throws -> SubPayload {
        let rawSites = (record["sites"] as? [[String: Any]]) ?? []
        let rawLives = (record["lives"] as? [[String: Any]]) ?? []
        var skipped = 0
        var byReason: [String: Int] = [:]
        var truncated = 0

        var vodSources: [SubSource] = []
        var seenVod = Set<String>()
        for site in rawSites {
            let name = (site["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let api = (site["api"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !api.isEmpty else {
                skipped += 1; byReason["invalidUrl", default: 0] += 1; continue
            }
            let typeVal: Int? = {
                if let n = site["type"] as? Int { return n }
                if let s = site["type"] as? String { return Int(s) }
                return nil
            }()
            if typeVal == 3 || matches(spiderRegex, api) {
                skipped += 1; byReason["spider", default: 0] += 1; continue
            }
            if let searchable = site["searchable"], (String(describing: searchable) == "0" || String(describing: searchable) == "false") {
                skipped += 1; byReason["unsearchable", default: 0] += 1; continue
            }
            let importable = typeVal == 1 || ((typeVal == nil || typeVal == 0 || typeVal == 4) && matches(cmsApiRegex, api))
            if !importable {
                skipped += 1; byReason[typeVal == 4 ? "spider" : "xml", default: 0] += 1; continue
            }
            guard let url = normalizeUrl(api, trimTrailingSlash: true) else {
                skipped += 1; byReason["invalidUrl", default: 0] += 1; continue
            }
            if seenVod.contains(url) { continue }
            if vodSources.count >= maxVodSources { truncated += 1; continue }
            seenVod.insert(url)
            vodSources.append(SubSource(
                name: (name?.isEmpty == false) ? name! : hostnameOf(url),
                url: url,
                detail: nil,
                isAdult: false
            ))
        }

        var liveSources: [SubLiveSource] = []
        var seenLive = Set<String>()
        for entry in rawLives {
            if let channels = entry["channels"] as? [[String: Any]] {
                for ch in channels {
                    if let urls = ch["urls"] as? [String], let first = urls.first,
                       let u = normalizeUrl(first, trimTrailingSlash: false), !matches(txtRegex, u) {
                        if seenLive.insert(u).inserted && liveSources.count < maxLiveSources {
                            let n = (ch["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                            liveSources.append(SubLiveSource(name: (n?.isEmpty == false) ? n! : hostnameOf(u), url: u, epg: nil))
                        }
                    }
                }
                continue
            }
            guard let u = normalizeUrl(entry["url"], trimTrailingSlash: false) else { continue }
            if matches(txtRegex, u) && !matches(m3uRegex, u) {
                skipped += 1; byReason["nonM3uLive", default: 0] += 1; continue
            }
            if seenLive.insert(u).inserted && liveSources.count < maxLiveSources {
                let n = (entry["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                let epg = normalizeUrl(entry["epg"], trimTrailingSlash: false)
                liveSources.append(SubLiveSource(name: (n?.isEmpty == false) ? n! : hostnameOf(u), url: u, epg: epg))
            }
        }

        if vodSources.isEmpty && liveSources.isEmpty {
            throw FormatError.invalid("配置中没有可直接导入的源（已跳过 \(skipped) 个 Spider/不兼容条目）")
        }
        let subName = (record["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return SubPayload(
            name: (subName?.isEmpty == false) ? subName : nil,
            sources: vodSources,
            liveSources: liveSources,
            stats: SubStats(format: "tvbox", skipped: skipped, skippedByReason: byReason, skippedSamples: nil, truncated: truncated)
        )
    }
}
