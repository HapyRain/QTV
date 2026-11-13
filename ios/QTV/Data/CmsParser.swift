import Foundation

struct SourceConfig: Codable, Hashable {
    let key: String
    let name: String
    let url: String
    let detail: String?
    let isAdult: Bool
}

struct SearchItem: Codable, Hashable {
    let vodId: String
    let name: String
    let pic: String?
    let typeName: String?
    let year: String?
    let area: String?
    let remarks: String?
}

struct PlayLine {
    let name: String
    let episodes: [String]
}

struct VideoDetailResult {
    let lines: [PlayLine]
    let title: String?
    let cover: String?
    let desc: String?
    let typeName: String?
    let year: String?
    let area: String?
    let director: String?
    let actor: String?
    let remarks: String?

    var defaultLine: PlayLine? {
        lines.first(where: { line in line.episodes.contains(where: { $0.contains(".m3u8") }) }) ?? lines.first
    }
}

/// Apple CMS 响应解析（1:1 移植 `CmsParser.kt`）
enum CmsParser {

    static let adultKeywords: [String] = [
        "伦理片", "福利", "倫理片", "福利片", "日本伦理", "日本福利", "日本福利片", "日本伦理片",
        "擦边短剧", "擦边", "韩国伦理", "里番动漫", "门事件", "萝莉少女", "制服诱惑", "国产传媒",
        "cosplay", "黑丝诱惑", "无码", "日本无码", "有码", "日本有码", "SWAG",
        "网红主播", "色情片", "同性片", "福利视频", "无码高清", "有码高清", "91视频", "自拍偷拍",
        "mini传媒", "福利片",
    ]

    private static let m3u8Regex = try! NSRegularExpression(pattern: "\\$https?://[^\"'\\s]+?\\.m3u8", options: [.caseInsensitive])
    private static let htmlM3u8Regex1 = try! NSRegularExpression(pattern: "\\$(https?://[^\"'\\s]+?\\.m3u8)", options: [.caseInsensitive])
    private static let htmlM3u8Regex2 = try! NSRegularExpression(pattern: "\\$(https?://[^\"'\\s]+?/\\d{8}/\\d+_[a-f0-9]+/index\\.m3u8)", options: [.caseInsensitive])
    private static let h1Regex = try! NSRegularExpression(pattern: "<h1[^>]*>([^<]+)</h1>", options: [.caseInsensitive])
    private static let sketchRegex = try! NSRegularExpression(pattern: "<div[^>]*class=[\"']sketch[\"'][^>]*>([\\s\\S]*?)</div>", options: [.caseInsensitive])
    private static let htmlTagRegex = try! NSRegularExpression(pattern: "<[^>]+>")

    private static func stringVal(_ dict: [String: Any], _ key: String) -> String? {
        guard let v = dict[key], !(v is NSNull) else { return nil }
        let s = String(describing: v).trimmingCharacters(in: .whitespacesAndNewlines)
        return s.isEmpty ? nil : s
    }

    static func parseSearchList(_ jsonText: String) -> [SearchItem] {
        guard let data = jsonText.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = root["list"] as? [[String: Any]] else {
            return []
        }
        return list.map { v in
            SearchItem(
                vodId: stringVal(v, "vod_id") ?? "",
                name: stringVal(v, "vod_name") ?? "",
                pic: stringVal(v, "vod_pic"),
                typeName: stringVal(v, "type_name"),
                year: stringVal(v, "vod_year"),
                area: stringVal(v, "vod_area"),
                remarks: stringVal(v, "vod_remarks")
            )
        }
    }

    static func extractPlayLines(playFrom: String?, playUrl: String) -> [PlayLine] {
        if playUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return [] }
        let names = (playFrom ?? "").components(separatedBy: "$$$")
        let groups = playUrl.components(separatedBy: "$$$")
        var lines: [PlayLine] = []
        for (i, group) in groups.enumerated() {
            let eps = group.components(separatedBy: "#").compactMap { ep -> String? in
                let parts = ep.components(separatedBy: "$")
                let u = parts.count > 1 ? parts[1].trimmingCharacters(in: .whitespacesAndNewlines) : ""
                return (u.hasPrefix("http://") || u.hasPrefix("https://")) ? u : nil
            }
            if !eps.isEmpty {
                let name = (i < names.count ? names[i].trimmingCharacters(in: .whitespacesAndNewlines) : "").isEmpty
                    ? "线路\(i + 1)"
                    : names[i].trimmingCharacters(in: .whitespacesAndNewlines)
                lines.append(PlayLine(name: name, episodes: eps))
            }
        }
        return lines
    }

    static func extractM3u8FromText(_ text: String) -> [String] {
        if text.isEmpty { return [] }
        let nsRange = NSRange(text.startIndex..<text.endIndex, in: text)
        return m3u8Regex.matches(in: text, options: [], range: nsRange).compactMap { m in
            guard let r = Range(m.range, in: text) else { return nil }
            let val = String(text[r])
            return val.hasPrefix("$") ? String(val.dropFirst()) : val
        }
    }

    static func parseDetail(_ jsonText: String) -> VideoDetailResult? {
        guard let data = jsonText.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = root["list"] as? [[String: Any]],
              let vod = list.first else {
            return nil
        }
        var lines = extractPlayLines(
            playFrom: stringVal(vod, "vod_play_from"),
            playUrl: stringVal(vod, "vod_play_url") ?? ""
        )
        if lines.isEmpty {
            let eps = extractM3u8FromText(stringVal(vod, "vod_content") ?? "")
            if !eps.isEmpty {
                lines = [PlayLine(name: "默认", episodes: eps)]
            }
        }
        return VideoDetailResult(
            lines: lines,
            title: stringVal(vod, "vod_name"),
            cover: stringVal(vod, "vod_pic"),
            desc: stringVal(vod, "vod_content"),
            typeName: stringVal(vod, "type_name"),
            year: stringVal(vod, "vod_year"),
            area: stringVal(vod, "vod_area"),
            director: stringVal(vod, "vod_director"),
            actor: stringVal(vod, "vod_actor"),
            remarks: stringVal(vod, "vod_remarks")
        )
    }

    static func parseDetailPageHtml(_ html: String, fallbackTitle: String?) -> VideoDetailResult? {
        let nsRange = NSRange(html.startIndex..<html.endIndex, in: html)
        var matches = htmlM3u8Regex1.matches(in: html, options: [], range: nsRange).compactMap { m -> String? in
            guard let r = Range(m.range(at: 1), in: html) else { return nil }
            return String(html[r])
        }
        if matches.isEmpty {
            matches = htmlM3u8Regex2.matches(in: html, options: [], range: nsRange).compactMap { m -> String? in
                guard let r = Range(m.range(at: 1), in: html) else { return nil }
                return String(html[r])
            }
        }
        var seen = Set<String>()
        var episodes: [String] = []
        for u in matches {
            let cleaned: String
            if let parenIdx = u.firstIndex(of: "("), parenIdx > u.startIndex {
                cleaned = String(u[..<parenIdx])
            } else {
                cleaned = u
            }
            if seen.insert(cleaned).inserted {
                episodes.append(cleaned)
            }
        }
        var title = fallbackTitle
        if let m = h1Regex.firstMatch(in: html, options: [], range: nsRange),
           let r = Range(m.range(at: 1), in: html) {
            let t = String(html[r]).trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty { title = t }
        }
        var desc: String?
        if let m = sketchRegex.firstMatch(in: html, options: [], range: nsRange),
           let r = Range(m.range(at: 1), in: html) {
            let rawDesc = String(html[r])
            let stripped = htmlTagRegex.stringByReplacingMatches(
                in: rawDesc,
                options: [],
                range: NSRange(rawDesc.startIndex..<rawDesc.endIndex, in: rawDesc),
                withTemplate: " "
            ).trimmingCharacters(in: .whitespacesAndNewlines)
            if !stripped.isEmpty { desc = stripped }
        }
        let lines = episodes.isEmpty ? [] : [PlayLine(name: "默认", episodes: episodes)]
        return VideoDetailResult(
            lines: lines,
            title: title,
            cover: nil,
            desc: desc,
            typeName: nil,
            year: nil,
            area: nil,
            director: nil,
            actor: nil,
            remarks: nil
        )
    }

    static func isAdultContent(_ typeName: String?) -> Bool {
        guard let t = typeName, !t.isEmpty else { return false }
        return adultKeywords.contains(where: { t.contains($0) })
    }

    static func filterAdultResults(_ items: [SearchItem]) -> [SearchItem] {
        items.filter { !isAdultContent($0.typeName) }
    }

    static func normalizeTitle(_ s: String) -> String {
        let lower = s.lowercased()
        return String(lower.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) })
    }

    static func filterRelevantResults(_ items: [SearchItem], wd: String) -> [SearchItem] {
        let queryNorm = normalizeTitle(wd)
        if queryNorm.isEmpty { return items }
        let tokens = wd.trimmingCharacters(in: .whitespacesAndNewlines)
            .components(separatedBy: .whitespacesAndNewlines)
            .map { normalizeTitle($0) }
            .filter { !$0.isEmpty }
        return items.filter { item in
            let nName = normalizeTitle(item.name)
            if nName.isEmpty { return false }
            if nName.contains(queryNorm) { return true }
            return tokens.count > 1 && tokens.allSatisfy { nName.contains($0) }
        }
    }
}
