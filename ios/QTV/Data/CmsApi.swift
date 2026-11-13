import Foundation

struct SourceOutcome {
    let source: SourceConfig
    let ok: Bool
    let list: [SearchItem]
    let error: String?
    let timedOut: Bool
    let ms: Int64
}

/// Apple CMS HTTP 接口与多源并发聚合搜索（1:1 移植 `CmsApi.kt` + `SearchRepository.kt`）
enum CmsApi {

    static let sourceTimeoutMs = 10_000
    static let maxPages = 5

    static func search(_ source: SourceConfig, wd: String, page: Int) -> (items: [SearchItem], pageCount: Int)? {
        let sep = source.url.contains("?") ? "&" : "?"
        let encodedWd = wd.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? wd
        let url = "\(source.url)\(sep)ac=videolist&wd=\(encodedWd)&pg=\(page)"
        guard let (text, _) = NetClient.getText(url, deadlineMs: sourceTimeoutMs) else { return nil }
        let items = CmsParser.parseSearchList(text)
        let pageCount = parsePageCount(text) ?? 1
        return (items, pageCount)
    }

    static func detail(_ source: SourceConfig, id: String, deadlineMs: Int = NetClient.defaultDeadlineMs) -> VideoDetailResult? {
        let sep = source.url.contains("?") ? "&" : "?"
        let encodedId = id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? id
        let url = "\(source.url)\(sep)ac=videolist&ids=\(encodedId)"
        guard let (text, _) = NetClient.getText(url, deadlineMs: deadlineMs) else { return nil }
        return CmsParser.parseDetail(text)
    }

    static func detailPage(_ source: SourceConfig, id: String, deadlineMs: Int = NetClient.defaultDeadlineMs) -> VideoDetailResult? {
        let root = detailRoot(source)
        let cleanRoot = root.hasSuffix("/") ? String(root.dropLast()) : root
        let url = "\(cleanRoot)/index.php/vod/detail/id/\(id).html"
        guard let (text, _) = NetClient.getText(url, deadlineMs: deadlineMs) else { return nil }
        return CmsParser.parseDetailPageHtml(text, fallbackTitle: nil)
    }

    static func detailRoot(_ source: SourceConfig) -> String {
        if let d = source.detail?.trimmingCharacters(in: .whitespacesAndNewlines), !d.isEmpty {
            return d
        }
        let orig = NetClient.originOf(source.url)
        return orig.hasSuffix("/") ? String(orig.dropLast()) : orig
    }

    private static func parsePageCount(_ text: String) -> Int? {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        if let listObj = obj["list"] as? [String: Any], let pc = listObj["pagecount"] {
            return Int(String(describing: pc))
        }
        if let pc = obj["pagecount"] {
            return Int(String(describing: pc))
        }
        return nil
    }

    /// 并发搜索全部启用源
    static func searchAll(
        wd: String,
        sources: [SourceConfig],
        filterAdult: Bool,
        onOutcome: ((SourceOutcome) -> Void)? = nil
    ) -> [SourceOutcome] {
        if sources.isEmpty { return [] }
        let lock = NSLock()
        var outcomes: [SourceOutcome] = []
        let group = DispatchGroup()

        for src in sources {
            group.enter()
            DispatchQueue.global(qos: .userInitiated).async {
                defer { group.leave() }
                let outcome = searchOne(source: src, wd: wd, filterAdult: filterAdult)
                lock.lock()
                outcomes.append(outcome)
                lock.unlock()
                onOutcome?(outcome)
            }
        }
        group.wait()
        return outcomes
    }

    private static func searchOne(source: SourceConfig, wd: String, filterAdult: Bool) -> SourceOutcome {
        let t0 = Int64(Date().timeIntervalSince1970 * 1000)
        guard let first = search(source, wd: wd, page: 1) else {
            let ms = Int64(Date().timeIntervalSince1970 * 1000) - t0
            let timedOut = ms >= Int64(sourceTimeoutMs - 500)
            return SourceOutcome(
                source: source,
                ok: false,
                list: [],
                error: timedOut ? "超时" : "请求失败或格式错误",
                timedOut: timedOut,
                ms: ms
            )
        }
        var allItems = first.items
        let totalPages = min(first.pageCount, maxPages)
        if totalPages > 1 {
            let pageLock = NSLock()
            let pageGroup = DispatchGroup()
            for p in 2...totalPages {
                pageGroup.enter()
                DispatchQueue.global(qos: .userInitiated).async {
                    defer { pageGroup.leave() }
                    if let res = search(source, wd: wd, page: p) {
                        pageLock.lock()
                        allItems.append(contentsOf: res.items)
                        pageLock.unlock()
                    }
                }
            }
            _ = pageGroup.wait(timeout: .now() + .milliseconds(sourceTimeoutMs))
        }

        var seenIds = Set<String>()
        let unique = allItems.filter { seenIds.insert($0.vodId).inserted }
        let adultFiltered = filterAdult ? CmsParser.filterAdultResults(unique) : unique
        let relevant = CmsParser.filterRelevantResults(adultFiltered, wd: wd)
        let ms = Int64(Date().timeIntervalSince1970 * 1000) - t0
        return SourceOutcome(source: source, ok: true, list: relevant, error: nil, timedOut: false, ms: ms)
    }
}
