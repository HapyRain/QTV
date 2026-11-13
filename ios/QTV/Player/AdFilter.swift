import Foundation

/// M3U8 广告分片过滤与相对路径重写（1:1 移植 Android `AdFilter.kt` 与 `src/lib/m3u8.ts` 四级管线）
enum AdFilter {

    private static let leadAdMaxSeconds = 90.0
    private static let leadAdMaxSegments = 20
    private static let interstitialMaxSeconds = 30.0
    private static let interstitialNeighborMinSeconds = 120.0
    private static let adUrlRegex = try! NSRegularExpression(pattern: "adjump|advert|/ads?/", options: [.caseInsensitive])
    private static let extInfRegex = try! NSRegularExpression(pattern: "^#EXTINF:([\\d.]+)")
    private static let uriAttrRegex = try! NSRegularExpression(pattern: "URI=\"([^\"]+)\"")

    static func stripAdGroups(_ m3u8: String) -> String {
        if m3u8.isEmpty { return "" }
        return stripLeadingDisc(
            stripLeadAdGroup(
                stripInterstitialAdGroups(
                    stripMarkedAdGroups(m3u8)
                )
            )
        )
    }

    private static func isDisc(_ line: String) -> Bool {
        line.trimmingCharacters(in: .whitespacesAndNewlines) == "#EXT-X-DISCONTINUITY"
    }

    private static func isSegment(_ line: String) -> Bool {
        let t = line.trimmingCharacters(in: .whitespacesAndNewlines)
        return !t.isEmpty && !t.hasPrefix("#")
    }

    private static func matchesAdUrl(_ line: String) -> Bool {
        let t = line.trimmingCharacters(in: .whitespacesAndNewlines)
        let range = NSRange(t.startIndex..<t.endIndex, in: t)
        return adUrlRegex.firstMatch(in: t, options: [], range: range) != nil
    }

    private static func parseExtInfSeconds(_ line: String) -> Double? {
        let t = line.trimmingCharacters(in: .whitespacesAndNewlines)
        let range = NSRange(t.startIndex..<t.endIndex, in: t)
        guard let m = extInfRegex.firstMatch(in: t, options: [], range: range),
              let r1 = Range(m.range(at: 1), in: t) else { return nil }
        return Double(t[r1])
    }

    static func stripMarkedAdGroups(_ m3u8: String) -> String {
        if m3u8.isEmpty { return "" }
        let lines = m3u8.components(separatedBy: "\n")
        var drop = Array(repeating: false, count: lines.count)
        var i = 0
        while i < lines.count {
            if !isDisc(lines[i]) { i += 1; continue }
            var j = i + 1
            var count = 0
            var allAd = true
            while j < lines.count && !isDisc(lines[j]) {
                if isSegment(lines[j]) {
                    count += 1
                    if !matchesAdUrl(lines[j]) { allAd = false }
                }
                j += 1
            }
            if count > 0 && allAd {
                drop[i] = true
                for k in (i + 1)..<j {
                    let t = lines[k].trimmingCharacters(in: .whitespacesAndNewlines)
                    if t.hasPrefix("#EXT-X-KEY") || t.hasPrefix("#EXT-X-MAP") { continue }
                    drop[k] = true
                }
            }
            i = j
        }
        if !drop.contains(true) { return m3u8 }
        return lines.enumerated().compactMap { idx, l in drop[idx] ? nil : l }.joined(separator: "\n")
    }

    private struct Group {
        let start: Int
        let end: Int
        let discLine: Int
        let seconds: Double
        let count: Int
    }

    private static func scanGroups(_ lines: [String]) -> [Group] {
        var discIdx: [Int] = []
        for (i, l) in lines.enumerated() where isDisc(l) {
            discIdx.append(i)
        }
        let bounds = [0] + discIdx + [lines.count]
        var groups: [Group] = []
        for k in 0..<(bounds.count - 1) {
            let start = (k == 0) ? 0 : bounds[k] + 1
            let end = bounds[k + 1]
            var seconds = 0.0
            var count = 0
            if start < end {
                for i in start..<end {
                    if let sec = parseExtInfSeconds(lines[i]) {
                        seconds += sec
                    } else if isSegment(lines[i]) {
                        count += 1
                    }
                }
            }
            groups.append(Group(start: start, end: end, discLine: (k == 0) ? -1 : bounds[k], seconds: seconds, count: count))
        }
        return groups
    }

    static func stripInterstitialAdGroups(_ m3u8: String) -> String {
        if m3u8.isEmpty { return "" }
        let lines = m3u8.components(separatedBy: "\n")
        let groups = scanGroups(lines)
        var drop = Array(repeating: false, count: lines.count)
        if groups.count >= 3 {
            for k in 1..<(groups.count - 1) {
                let g = groups[k]
                let prev = groups[k - 1]
                let next = groups[k + 1]
                if g.count == 0 || g.discLine < 0 { continue }
                if g.seconds <= 0 || g.seconds > interstitialMaxSeconds { continue }
                if prev.seconds < interstitialNeighborMinSeconds || next.seconds < interstitialNeighborMinSeconds { continue }
                drop[g.discLine] = true
                for i in g.start..<g.end {
                    let t = lines[i].trimmingCharacters(in: .whitespacesAndNewlines)
                    if t.hasPrefix("#EXT-X-KEY") || t.hasPrefix("#EXT-X-MAP") { continue }
                    drop[i] = true
                }
            }
        }
        if !drop.contains(true) { return m3u8 }
        return lines.enumerated().compactMap { idx, l in drop[idx] ? nil : l }.joined(separator: "\n")
    }

    static func stripLeadAdGroup(_ m3u8: String) -> String {
        if m3u8.isEmpty { return "" }
        let lines = m3u8.components(separatedBy: "\n")
        var discIdx: [Int] = []
        for (i, l) in lines.enumerated() where isDisc(l) {
            discIdx.append(i)
        }
        func groupSize(_ from: Int, _ to: Int) -> Int {
            guard from < to else { return 0 }
            return (from..<to).filter { isSegment(lines[$0]) }.count
        }
        if discIdx.count >= 4 {
            let leadSize = groupSize(discIdx[0] + 1, discIdx[1])
            let others = (1..<discIdx.count).map { g in
                groupSize(discIdx[g] + 1, (g + 1 < discIdx.count) ? discIdx[g + 1] : lines.count)
            }.sorted()
            let median = others[others.count / 2]
            if abs(leadSize - median) <= max(3, Int(Double(median) * 0.5)) {
                return m3u8
            }
        }
        guard let firstDisc = discIdx.first else { return m3u8 }
        if (0..<firstDisc).contains(where: { isSegment(lines[$0]) }) { return m3u8 }
        guard let nextDisc = discIdx.dropFirst().first(where: { $0 > firstDisc }) else { return m3u8 }

        var seconds = 0.0
        var count = 0
        for i in (firstDisc + 1)..<nextDisc {
            if let sec = parseExtInfSeconds(lines[i]) {
                seconds += sec
            } else if isSegment(lines[i]) {
                count += 1
            }
        }
        if count == 0 || count > leadAdMaxSegments { return m3u8 }
        if seconds <= 0 || seconds > leadAdMaxSeconds { return m3u8 }

        let kept = lines.enumerated().compactMap { i, l -> String? in
            if i < firstDisc || i >= nextDisc { return l }
            let t = l.trimmingCharacters(in: .whitespacesAndNewlines)
            return (t.hasPrefix("#EXT-X-KEY") || t.hasPrefix("#EXT-X-MAP")) ? l : nil
        }
        var out: [String] = []
        var seenSegment = false
        for l in kept {
            if !seenSegment && isDisc(l) { continue }
            if isSegment(l) { seenSegment = true }
            out.append(l)
        }
        return out.joined(separator: "\n")
    }

    static func stripLeadingDisc(_ content: String) -> String {
        let lines = content.components(separatedBy: "\n")
        guard let firstSeg = lines.firstIndex(where: { isSegment($0) }), firstSeg > 0 else {
            return content
        }
        let kept = lines.enumerated().compactMap { i, l -> String? in
            (i < firstSeg && isDisc(l)) ? nil : l
        }
        return kept.count == lines.count ? content : kept.joined(separator: "\n")
    }

    /// 代理 M3U8 清单时：可选剥离广告分片，并将相对分片/子清单/密钥地址重写为本地 `/api/proxy?url=...`
    static func rewriteM3u8Playlist(_ content: String, baseUrl: String, adFilter: Bool) -> String {
        let filtered = adFilter ? stripAdGroups(content) : content
        guard let base = URL(string: baseUrl) else { return filtered }

        func wrapProxy(_ raw: String) -> String {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let resolved = URL(string: trimmed, relativeTo: base)?.absoluteURL.absoluteString,
                  resolved.lowercased().hasPrefix("http://") || resolved.lowercased().hasPrefix("https://") else {
                return raw
            }
            var allowed = CharacterSet.urlQueryAllowed
            allowed.remove(charactersIn: "&+=?")
            let encoded = resolved.addingPercentEncoding(withAllowedCharacters: allowed) ?? resolved
            return "/api/proxy?url=\(encoded)\(adFilter ? "&adFilter=1" : "")"
        }

        return filtered.components(separatedBy: "\n").map { line in
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { return line }
            if trimmed.hasPrefix("#") {
                let nsRange = NSRange(line.startIndex..<line.endIndex, in: line)
                guard let m = uriAttrRegex.firstMatch(in: line, options: [], range: nsRange),
                      let r1 = Range(m.range(at: 1), in: line),
                      let fullRange = Range(m.range(at: 0), in: line) else {
                    return line
                }
                let inner = String(line[r1])
                var copy = line
                copy.replaceSubrange(fullRange, with: "URI=\"\(wrapProxy(inner))\"")
                return copy
            }
            return wrapProxy(trimmed)
        }.joined(separator: "\n")
    }
}
