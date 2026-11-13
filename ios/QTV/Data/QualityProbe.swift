import Foundation

/// 画质探测（对齐 Android `QualityProbe.kt`）：
/// 优先解析 HLS master playlist 的 `RESOLUTION` 与 `BANDWIDTH`，并带进程内 TTL 缓存（成功 30 分钟 / 失败 2 分钟）。
enum QualityProbe {

    struct ProbeResult {
        let sourceKey: String
        let vodId: String
        let height: Int?
        let error: String?
    }

    private struct CachedEntry {
        let height: Int?
        let error: String?
        let at: Int64
    }

    private static var cache: [String: CachedEntry] = [:]
    private static let cacheLock = NSLock()
    private static let okTtlMs: Int64 = 30 * 60 * 1000
    private static let failTtlMs: Int64 = 2 * 60 * 1000

    private static let bwRegex = try! NSRegularExpression(pattern: "BANDWIDTH=(\\d+)")
    private static let resRegex = try! NSRegularExpression(pattern: "RESOLUTION=(\\d+)x(\\d+)")

    static func inferHeightFromBitrate(_ bandwidth: Int) -> Int? {
        let tiers: [(Int, Int)] = [
            (20_000_000, 4320), (10_000_000, 2160), (5_000_000, 1080),
            (3_000_000, 720), (1_500_000, 540), (800_000, 480), (400_000, 360)
        ]
        return tiers.first(where: { bandwidth >= $0.0 })?.1
    }

    static func parseBestHeight(_ text: String) -> Int? {
        guard text.contains("#EXT-X-STREAM-INF") else { return nil }
        var best: Int?
        var pendingBw = 0
        var pendingHeight: Int?
        var hasPending = false

        for raw in text.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.hasPrefix("#EXT-X-STREAM-INF") {
                let nsRange = NSRange(line.startIndex..<line.endIndex, in: line)
                if let m = bwRegex.firstMatch(in: line, options: [], range: nsRange),
                   let r1 = Range(m.range(at: 1), in: line) {
                    pendingBw = Int(line[r1]) ?? 0
                } else {
                    pendingBw = 0
                }
                if let m = resRegex.firstMatch(in: line, options: [], range: nsRange),
                   let r1 = Range(m.range(at: 1), in: line),
                   let r2 = Range(m.range(at: 2), in: line),
                   let w = Int(line[r1]),
                   let h = Int(line[r2]) {
                    pendingHeight = min(w, h)
                } else {
                    pendingHeight = nil
                }
                hasPending = true
                continue
            }
            if line.isEmpty || line.hasPrefix("#") || !hasPending { continue }
            let h = pendingHeight ?? (pendingBw > 0 ? inferHeightFromBitrate(pendingBw) : nil)
            if let validH = h, (best == nil || validH > best!) {
                best = validH
            }
            hasPending = false
        }
        return best
    }

    static func probeEpisodeOrder(_ episodes: [String]) -> [String] {
        if episodes.count < 2 { return Array(episodes.prefix(1)) }
        let mid = episodes[episodes.count / 2]
        let last = episodes[episodes.count - 1]
        return (mid == last) ? [mid] : [mid, last]
    }

    static func probeQuality(source: SourceConfig, id: String) -> ProbeResult {
        let base = ProbeResult(sourceKey: source.key, vodId: id, height: nil, error: nil)
        let cacheKey = "\(source.url)|\(source.detail ?? "")|\(id)"
        let now = Int64(Date().timeIntervalSince1970 * 1000)

        cacheLock.lock()
        if let hit = cache[cacheKey] {
            let ttl = (hit.error != nil) ? failTtlMs : okTtlMs
            if now - hit.at < ttl {
                cacheLock.unlock()
                return ProbeResult(sourceKey: source.key, vodId: id, height: hit.height, error: hit.error)
            }
        }
        cacheLock.unlock()

        let detailRes = CmsApi.detail(source, id: id, deadlineMs: 6_000)
            ?? CmsApi.detailPage(source, id: id, deadlineMs: 6_000)
        let episodes = detailRes?.defaultLine?.episodes ?? []
        if episodes.isEmpty {
            saveCache(cacheKey, height: nil, error: "未找到播放资源")
            return ProbeResult(sourceKey: source.key, vodId: id, height: nil, error: "未找到播放资源")
        }

        var foundHeight: Int?
        var lastError: String?
        let referer = NetClient.originOf(source.url)

        for epUrl in probeEpisodeOrder(episodes) {
            guard epUrl.lowercased().contains(".m3u8") else { continue }
            guard let (m3u8Text, _) = NetClient.getText(epUrl, referer: referer, maxBytes: 64 * 1024, deadlineMs: 5_000) else {
                lastError = "HTTP 请求失败"
                continue
            }
            if let h = parseBestHeight(m3u8Text) {
                foundHeight = h
                break
            }
        }

        saveCache(cacheKey, height: foundHeight, error: foundHeight != nil ? nil : lastError)
        return ProbeResult(sourceKey: source.key, vodId: id, height: foundHeight, error: foundHeight != nil ? nil : lastError)
    }

    private static func saveCache(_ key: String, height: Int?, error: String?) {
        cacheLock.lock()
        cache[key] = CachedEntry(height: height, error: error, at: Int64(Date().timeIntervalSince1970 * 1000))
        cacheLock.unlock()
    }
}
