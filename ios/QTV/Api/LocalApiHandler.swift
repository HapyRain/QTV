import Foundation
import WebKit

/// 原生播放器状态与硬件桥协议（由 `WebViewController` 实现）
protocol PlayerHost: AnyObject {
    func onPlaybackPaused(_ paused: Bool)
    func onFullscreenChanged(_ fullscreen: Bool)
    func setBrightness(_ value: Float)
    func setVolume(_ value: Float)
    func currentBrightness() -> Float
    func currentVolume() -> Float
}

/// iOS `WKURLSchemeHandler`：同时承载本地静态资源 (`Resources/www/`) 与全套本地 `/api/*` 路由（1:1 对齐 Android `LocalApi.kt`）
final class LocalApiHandler: NSObject, WKURLSchemeHandler {

    weak var playerHost: PlayerHost?
    private let activeLock = NSLock()
    private var activeTasks = Set<ObjectIdentifier>()

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let id = ObjectIdentifier(urlSchemeTask)
        activeLock.lock()
        activeTasks.insert(id)
        activeLock.unlock()

        guard let url = urlSchemeTask.request.url else {
            finishWithError(urlSchemeTask, code: 400, message: "Invalid URL")
            return
        }

        let path = url.path.isEmpty ? "/" : url.path
        if path.hasPrefix("/api/") {
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                self?.handleApi(url: url, task: urlSchemeTask)
            }
        } else {
            serveStaticAsset(path: path, url: url, task: urlSchemeTask)
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        let id = ObjectIdentifier(urlSchemeTask)
        activeLock.lock()
        activeTasks.remove(id)
        activeLock.unlock()
    }

    private func isTaskActive(_ task: WKURLSchemeTask) -> Bool {
        let id = ObjectIdentifier(task)
        activeLock.lock()
        defer { activeLock.unlock() }
        return activeTasks.contains(id)
    }

    private func completeTask(_ task: WKURLSchemeTask, response: HTTPURLResponse, data: Data) {
        let id = ObjectIdentifier(task)
        activeLock.lock()
        guard activeTasks.contains(id) else {
            activeLock.unlock()
            return
        }
        activeTasks.remove(id)
        activeLock.unlock()
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    private func finishWithError(_ task: WKURLSchemeTask, code: Int, message: String) {
        let body = (try? JSONSerialization.data(withJSONObject: ["error": message])) ?? Data()
        let resp = makeHttpResponse(url: task.request.url ?? URL(string: "qtv://appassets.androidplatform.net/")!, statusCode: code, contentType: "application/json; charset=utf-8", contentLength: body.count)
        completeTask(task, response: resp, data: body)
    }

    private func makeHttpResponse(url: URL, statusCode: Int = 200, contentType: String, contentLength: Int? = nil) -> HTTPURLResponse {
        var headers: [String: String] = [
            "Content-Type": contentType,
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store"
        ]
        if let len = contentLength {
            headers["Content-Length"] = String(len)
        }
        return HTTPURLResponse(url: url, statusCode: statusCode, httpVersion: "HTTP/1.1", headerFields: headers)!
    }

    // MARK: - 静态资源映射 (`Resources/www/`)

    private func serveStaticAsset(path: String, url: URL, task: WKURLSchemeTask) {
        var rel = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if rel.hasPrefix("assets/") {
            rel = String(rel.dropFirst("assets/".count))
        } else if !rel.hasPrefix("www/") {
            rel = rel.isEmpty ? "www/index.html" : "www/\(rel)"
        }
        if rel == "www" || rel == "www/" {
            rel = "www/index.html"
        }

        guard let bundleBase = Bundle.main.resourceURL else {
            finishWithError(task, code: 404, message: "Bundle resource missing")
            return
        }

        let candidates = [
            rel,
            "\(rel).html",
            "\(rel)/index.html",
            "www/index.html"
        ]

        var foundUrl: URL?
        for c in candidates {
            let candidateUrl = bundleBase.appendingPathComponent(c)
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: candidateUrl.path, isDirectory: &isDir), !isDir.boolValue {
                foundUrl = candidateUrl
                break
            }
        }

        guard let fileUrl = foundUrl, let data = try? Data(contentsOf: fileUrl) else {
            finishWithError(task, code: 404, message: "Not found: \(path)")
            return
        }

        let mime = mimeType(for: fileUrl.pathExtension)
        let resp = makeHttpResponse(url: url, statusCode: 200, contentType: mime, contentLength: data.count)
        completeTask(task, response: resp, data: data)
    }

    private func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "application/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "webmanifest": return "application/json; charset=utf-8"
        case "txt": return "text/plain; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "gif": return "image/gif"
        case "ico": return "image/x-icon"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "m3u8": return "application/vnd.apple.mpegurl"
        default: return "application/octet-stream"
        }
    }

    // MARK: - 本地 `/api/*` 路由分发

    private func handleApi(url: URL, task: WKURLSchemeTask) {
        let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let query = comps?.queryItems ?? []
        func qParam(_ name: String) -> String? {
            query.first(where: { $0.name == name })?.value
        }
        func qBool(_ name: String) -> Bool {
            guard let v = qParam(name)?.lowercased() else { return false }
            return v == "1" || v == "true"
        }

        let bodyRaw = decodeBody(raw: qParam("__body"), isBase64: qParam("__bodyEnc") == "1")

        switch url.path {
        case "/api/status":
            let version = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "1.0"
            let payload: [String: Any] = [
                "passwordRequired": false,
                "verified": true,
                "version": version,
                "instanceId": "local-ios",
                "defaultSources": [],
                "defaultLiveSources": [],
                "defaultSubscriptions": [],
                "defaultRecommendSource": NSNull(),
                "defaultImageMode": NSNull()
            ]
            sendJson(task, url: url, obj: payload)

        case "/api/auth":
            sendJson(task, url: url, obj: ["success": true])

        case "/api/player-state":
            handlePlayerState(url: url, qParam: qParam, task: task)

        case "/api/search":
            handleSearch(url: url, bodyRaw: bodyRaw, stream: qBool("stream"), task: task)

        case "/api/detail":
            handleDetail(url: url, qParam: qParam, task: task)

        case "/api/source/test":
            handleSourceTest(url: url, bodyRaw: bodyRaw, task: task)

        case "/api/source-list":
            handleSourceList(url: url, rawUrl: qParam("url"), task: task)

        case "/api/quality":
            handleQuality(url: url, bodyRaw: bodyRaw, stream: qBool("stream"), task: task)

        case "/api/live/playlist":
            handleLivePlaylist(url: url, qParam: qParam, task: task)

        case "/api/live/epg":
            handleLiveEpg(url: url, qParam: qParam, task: task)

        case "/api/live/probe":
            handleLiveProbe(url: url, bodyRaw: bodyRaw, stream: qBool("stream"), task: task)

        case "/api/proxy", "/api/live/stream":
            handleProxy(url: url, targetUrl: qParam("url"), adFilter: qBool("adFilter"), task: task)

        case "/api/douban", "/api/hot-list":
            sendJson(task, url: url, obj: ["items": []])

        case "/api/bangumi/calendar":
            sendJson(task, url: url, obj: ["days": []])

        default:
            finishWithError(task, code: 404, message: "未知接口 \(url.path)")
        }
    }

    private func decodeBody(raw: String?, isBase64: Bool) -> [String: Any] {
        guard let r = raw, !r.isEmpty else { return [:] }
        let jsonStr: String
        if isBase64, let data = Data(base64Encoded: r), let s = String(data: data, encoding: .utf8) {
            jsonStr = s
        } else {
            jsonStr = r
        }
        guard let d = jsonStr.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else {
            return [:]
        }
        return obj
    }

    private func sendJson(_ task: WKURLSchemeTask, url: URL, obj: Any, statusCode: Int = 200) {
        let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
        let resp = makeHttpResponse(url: url, statusCode: statusCode, contentType: "application/json; charset=utf-8", contentLength: data.count)
        completeTask(task, response: resp, data: data)
    }

    // MARK: - /api/player-state

    private func handlePlayerState(url: URL, qParam: (String) -> String?, task: WKURLSchemeTask) {
        if qParam("read") == "1" {
            let b = playerHost?.currentBrightness() ?? -1.0
            let v = playerHost?.currentVolume() ?? -1.0
            sendJson(task, url: url, obj: ["brightness": b, "volume": v])
            return
        }
        // qParam 是非逃逸参数，不能直接进 main 队列的逃逸闭包：先把值取出来
        let pausedRaw = qParam("paused")
        let fullscreenRaw = qParam("fullscreen")
        let brightnessRaw = qParam("brightness")
        let volumeRaw = qParam("volume")
        DispatchQueue.main.async { [weak self] in
            if let p = pausedRaw {
                self?.playerHost?.onPlaybackPaused(p == "1" || p.lowercased() == "true")
            }
            if let f = fullscreenRaw {
                self?.playerHost?.onFullscreenChanged(f == "1" || f.lowercased() == "true")
            }
            if let bStr = brightnessRaw, let b = Float(bStr) {
                self?.playerHost?.setBrightness(b)
            }
            if let vStr = volumeRaw, let v = Float(vStr) {
                self?.playerHost?.setVolume(v)
            }
        }
        sendJson(task, url: url, obj: ["ok": true])
    }

    // MARK: - /api/search

    private func parseSources(_ arr: Any?) -> [SourceConfig] {
        guard let list = arr as? [[String: Any]] else { return [] }
        return list.enumerated().compactMap { i, o in
            guard let url = (o["url"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !url.isEmpty else {
                return nil
            }
            let key = (o["key"] as? String) ?? "src_\(i)"
            let name = (o["name"] as? String) ?? url
            let detail = (o["detail"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let isAdult = (o["isAdult"] as? Bool) ?? false
            return SourceConfig(key: key, name: name, url: url, detail: detail?.isEmpty == true ? nil : detail, isAdult: isAdult)
        }
    }

    private func stampItem(_ item: SearchItem, source: SourceConfig) -> [String: Any] {
        [
            "sourceKey": source.key,
            "sourceName": source.name,
            "vodId": item.vodId,
            "name": item.name,
            "pic": item.pic ?? NSNull(),
            "typeName": item.typeName ?? NSNull(),
            "year": item.year ?? NSNull(),
            "area": item.area ?? NSNull(),
            "remarks": item.remarks ?? NSNull(),
            "sourceUrl": source.url,
            "isAdult": source.isAdult
        ]
    }

    private func handleSearch(url: URL, bodyRaw: [String: Any], stream: Bool, task: WKURLSchemeTask) {
        let wd = (bodyRaw["wd"] as? String) ?? ""
        let filterAdult = (bodyRaw["filterAdult"] as? Bool) ?? true
        let sources = parseSources(bodyRaw["sources"])

        if sources.isEmpty {
            let doneObj: [String: Any] = ["type": "done", "list": [], "failures": []]
            if stream {
                let line = ((try? String(data: JSONSerialization.data(withJSONObject: doneObj), encoding: .utf8)) ?? "{}") + "\n"
                let d = Data(line.utf8)
                let resp = makeHttpResponse(url: url, contentType: "application/x-ndjson; charset=utf-8", contentLength: d.count)
                completeTask(task, response: resp, data: d)
            } else {
                sendJson(task, url: url, obj: doneObj)
            }
            return
        }

        if stream && isTaskActive(task) {
            // 流式 NDJSON：先发 HTTP 200 头，每源完成即实时推送一行 JSON，前端流式进度条丝滑更新
            let resp = makeHttpResponse(url: url, contentType: "application/x-ndjson; charset=utf-8")
            activeLock.lock()
            let stillActive = activeTasks.contains(ObjectIdentifier(task))
            activeLock.unlock()
            if stillActive {
                task.didReceive(resp)
            }
            let sendLock = NSLock()
            let outcomes = CmsApi.searchAll(wd: wd, sources: sources, filterAdult: filterAdult) { [weak self] o in
                guard let self = self, self.isTaskActive(task) else { return }
                let ev: [String: Any] = [
                    "type": "source",
                    "sourceKey": o.source.key,
                    "ok": o.ok,
                    "list": o.list.map { self.stampItem($0, source: o.source) },
                    "error": o.error ?? NSNull(),
                    "timedOut": o.timedOut,
                    "ms": o.ms
                ]
                if let d = try? JSONSerialization.data(withJSONObject: ev),
                   var s = String(data: d, encoding: .utf8) {
                    s.append("\n")
                    sendLock.lock()
                    if self.isTaskActive(task) {
                        task.didReceive(Data(s.utf8))
                    }
                    sendLock.unlock()
                }
            }
            let doneObj = buildSearchDone(outcomes: outcomes)
            if let d = try? JSONSerialization.data(withJSONObject: doneObj),
               var s = String(data: d, encoding: .utf8) {
                s.append("\n")
                sendLock.lock()
                let id = ObjectIdentifier(task)
                activeLock.lock()
                if activeTasks.contains(id) {
                    activeTasks.remove(id)
                    activeLock.unlock()
                    task.didReceive(Data(s.utf8))
                    task.didFinish()
                } else {
                    activeLock.unlock()
                }
                sendLock.unlock()
            }
            return
        }

        let outcomes = CmsApi.searchAll(wd: wd, sources: sources, filterAdult: filterAdult)
        sendJson(task, url: url, obj: buildSearchDone(outcomes: outcomes))
    }

    private func buildSearchDone(outcomes: [SourceOutcome]) -> [String: Any] {
        var seen = Set<String>()
        var merged: [(SourceConfig, SearchItem)] = []
        for o in outcomes {
            for item in o.list {
                let k = "\(o.source.key)_\(item.vodId)"
                if seen.insert(k).inserted {
                    merged.append((o.source, item))
                }
            }
        }
        merged.sort { $0.1.name < $1.1.name }
        let list = merged.map { stampItem($0.1, source: $0.0) }
        let failures = outcomes.filter { !$0.ok }.map {
            [
                "sourceKey": $0.source.key,
                "error": $0.error ?? "请求失败",
                "timedOut": $0.timedOut
            ] as [String: Any]
        }
        return ["type": "done", "list": list, "failures": failures]
    }

    // MARK: - /api/detail

    private func handleDetail(url: URL, qParam: (String) -> String?, task: WKURLSchemeTask) {
        guard let id = qParam("id"), !id.isEmpty else {
            finishWithError(task, code: 400, message: "缺少 id")
            return
        }
        let srcObj = decodeBody(raw: qParam("source"), isBase64: false)
        let srcUrl = (srcObj["url"] as? String) ?? ""
        if srcUrl.isEmpty {
            finishWithError(task, code: 400, message: "缺少源地址")
            return
        }
        let src = SourceConfig(
            key: (srcObj["key"] as? String) ?? "src",
            name: (srcObj["name"] as? String) ?? "",
            url: srcUrl,
            detail: (srcObj["detail"] as? String),
            isAdult: false
        )
        var d = CmsApi.detail(src, id: id)
        if d == nil || (d?.defaultLine?.episodes.isEmpty ?? true) {
            d = CmsApi.detailPage(src, id: id) ?? d
        }
        guard let detail = d else {
            finishWithError(task, code: 404, message: "获取到的详情内容无效")
            return
        }
        let episodes = detail.defaultLine?.episodes ?? []
        let info: [String: Any] = [
            "title": detail.title ?? NSNull(),
            "cover": detail.cover ?? NSNull(),
            "desc": detail.desc ?? NSNull(),
            "typeName": detail.typeName ?? NSNull(),
            "year": detail.year ?? NSNull(),
            "area": detail.area ?? NSNull(),
            "director": detail.director ?? NSNull(),
            "actor": detail.actor ?? NSNull(),
            "remarks": detail.remarks ?? NSNull(),
            "sourceKey": src.key,
            "sourceName": src.name,
            "sourceUrl": src.url
        ]
        sendJson(task, url: url, obj: ["episodes": episodes, "videoInfo": info])
    }

    // MARK: - /api/source/test & /api/source-list

    private func handleSourceTest(url: URL, bodyRaw: [String: Any], task: WKURLSchemeTask) {
        guard let targetUrl = (bodyRaw["url"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !targetUrl.isEmpty else {
            finishWithError(task, code: 400, message: "缺少 url")
            return
        }
        let t0 = Int64(Date().timeIntervalSince1970 * 1000)
        let src = SourceConfig(key: "test", name: "test", url: targetUrl, detail: nil, isAdult: false)
        let res = CmsApi.search(src, wd: "test", page: 1)
        let ms = Int64(Date().timeIntervalSince1970 * 1000) - t0
        if let r = res {
            sendJson(task, url: url, obj: ["ok": true, "ms": ms, "count": r.items.count])
        } else {
            sendJson(task, url: url, obj: ["ok": false, "ms": ms, "error": "请求失败或格式错误"])
        }
    }

    private func handleSourceList(url: URL, rawUrl: String?, task: WKURLSchemeTask) {
        let target = SubscriptionParser.normalizeSubscriptionUrl(rawUrl ?? "")
        guard target.lowercased().hasPrefix("http://") || target.lowercased().hasPrefix("https://") else {
            finishWithError(task, code: 400, message: "无效的订阅地址")
            return
        }
        guard let (text, _) = NetClient.getText(target) else {
            finishWithError(task, code: 502, message: "订阅拉取失败")
            return
        }
        do {
            let payload = try SubscriptionParser.parseSubscriptionText(text)
            let sourcesArr = payload.sources.map {
                [
                    "name": $0.name,
                    "url": $0.url,
                    "detail": $0.detail ?? NSNull(),
                    "isAdult": $0.isAdult
                ] as [String: Any]
            }
            let liveArr = payload.liveSources.map {
                [
                    "name": $0.name,
                    "url": $0.url,
                    "epg": $0.epg ?? NSNull()
                ] as [String: Any]
            }
            var root: [String: Any] = [
                "name": payload.name ?? NSNull(),
                "sources": sourcesArr,
                "liveSources": liveArr
            ]
            if let st = payload.stats {
                root["stats"] = [
                    "format": st.format,
                    "skipped": st.skipped,
                    "skippedByReason": st.skippedByReason,
                    "skippedSamples": st.skippedSamples ?? [],
                    "truncated": st.truncated
                ]
            }
            sendJson(task, url: url, obj: root)
        } catch {
            finishWithError(task, code: 400, message: error.localizedDescription)
        }
    }

    // MARK: - /api/quality

    private func handleQuality(url: URL, bodyRaw: [String: Any], stream: Bool, task: WKURLSchemeTask) {
        guard let rawItems = bodyRaw["items"] as? [[String: Any]], !rawItems.isEmpty else {
            finishWithError(task, code: 400, message: "请提供待探测的条目")
            return
        }
        var pairs: [(SourceConfig, String)] = []
        for o in rawItems.prefix(50) {
            guard let srcObj = o["source"] as? [String: Any],
                  let srcUrl = (srcObj["url"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  let id = (o["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !srcUrl.isEmpty, !id.isEmpty else { continue }
            let src = SourceConfig(
                key: (srcObj["key"] as? String) ?? "src",
                name: (srcObj["name"] as? String) ?? srcUrl,
                url: srcUrl,
                detail: srcObj["detail"] as? String,
                isAdult: false
            )
            pairs.append((src, id))
        }

        let lock = NSLock()
        var results: [[String: Any]] = []
        let group = DispatchGroup()
        let sem = DispatchSemaphore(value: 6)

        for (src, id) in pairs {
            group.enter()
            DispatchQueue.global(qos: .utility).async {
                sem.wait()
                defer {
                    sem.signal()
                    group.leave()
                }
                let r = QualityProbe.probeQuality(source: src, id: id)
                let entry: [String: Any] = [
                    "sourceKey": r.sourceKey,
                    "vodId": r.vodId,
                    "height": r.height ?? NSNull(),
                    "error": r.error ?? NSNull()
                ]
                lock.lock()
                results.append(entry)
                lock.unlock()
            }
        }
        group.wait()

        if stream {
            var lines = ["{\"ping\":true}"]
            for r in results {
                if let d = try? JSONSerialization.data(withJSONObject: r),
                   let s = String(data: d, encoding: .utf8) {
                    lines.append(s)
                }
            }
            let body = Data((lines.joined(separator: "\n") + "\n").utf8)
            let resp = makeHttpResponse(url: url, contentType: "application/x-ndjson; charset=utf-8", contentLength: body.count)
            completeTask(task, response: resp, data: body)
        } else {
            sendJson(task, url: url, obj: ["results": results])
        }
    }

    // MARK: - /api/live/playlist, /api/live/epg, /api/live/probe

    private func handleLivePlaylist(url: URL, qParam: (String) -> String?, task: WKURLSchemeTask) {
        guard let target = qParam("url")?.trimmingCharacters(in: .whitespacesAndNewlines), !target.isEmpty else {
            finishWithError(task, code: 400, message: "缺少 url 参数")
            return
        }
        let format = qParam("format") ?? "json"
        guard let (text, _) = NetClient.getText(target) else {
            finishWithError(task, code: 502, message: "订阅地址请求失败")
            return
        }
        let channels = M3uAndXmltvParser.parseM3u(text, baseUrl: target)
        var groupSet = Set<String>()
        var groups: [String] = []
        for c in channels {
            if let g = c.group, !g.isEmpty, groupSet.insert(g).inserted {
                groups.append(g)
            }
        }

        if format == "m3u" {
            var lines = ["#EXTM3U"]
            for c in channels {
                let g = (c.group ?? "").replacingOccurrences(of: "\"", with: "'")
                let tid = (c.tvgId ?? c.id).replacingOccurrences(of: "\"", with: "'")
                lines.append("#EXTINF:-1 tvg-id=\"\(tid)\" group-title=\"\(g)\",\(c.name)")
                lines.append(c.url)
            }
            let data = Data(lines.joined(separator: "\n").utf8)
            let resp = makeHttpResponse(url: url, contentType: "audio/x-mpegurl; charset=utf-8", contentLength: data.count)
            completeTask(task, response: resp, data: data)
            return
        }

        let chArr = channels.map { c in
            [
                "id": c.id,
                "name": c.name,
                "url": c.url,
                "logo": c.logo ?? NSNull(),
                "group": c.group ?? NSNull(),
                "tvgId": c.tvgId ?? NSNull(),
                "rawName": c.rawName ?? NSNull()
            ] as [String: Any]
        }
        sendJson(task, url: url, obj: [
            "name": NSNull(),
            "channels": chArr,
            "groups": groups
        ])
    }

    private func handleLiveEpg(url: URL, qParam: (String) -> String?, task: WKURLSchemeTask) {
        guard let target = qParam("url")?.trimmingCharacters(in: .whitespacesAndNewlines), !target.isEmpty else {
            finishWithError(task, code: 400, message: "缺少 url 参数")
            return
        }
        let channelId = qParam("channel") ?? ""
        guard let res = NetClient.getBytes(target, maxBytes: 32 * 1024 * 1024, deadlineMs: 15_000) else {
            finishWithError(task, code: 502, message: "EPG 地址请求失败")
            return
        }
        let xmlText = M3uAndXmltvParser.decodeMaybeGzip(res.data)
        let all = M3uAndXmltvParser.parseXmltv(xmlText)
        let programs = all[channelId] ?? []
        let (current, next) = M3uAndXmltvParser.currentAndNext(programs)

        func pgDict(_ p: EpgProgram?) -> Any {
            guard let p = p else { return NSNull() }
            return [
                "channelId": p.channelId,
                "start": p.start,
                "stop": p.stop,
                "title": p.title,
                "desc": p.desc ?? NSNull()
            ]
        }

        sendJson(task, url: url, obj: [
            "channelId": channelId,
            "current": pgDict(current),
            "next": pgDict(next),
            "programs": programs.map { pgDict($0) }
        ])
    }

    private func handleLiveProbe(url: URL, bodyRaw: [String: Any], stream: Bool, task: WKURLSchemeTask) {
        let urls = ((bodyRaw["urls"] as? [String]) ?? []).prefix(50).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        var results: [[String: Any]] = []
        for u in urls {
            results.append(probeOneLive(u))
        }
        if stream {
            let lines = results.compactMap { r -> String? in
                guard let d = try? JSONSerialization.data(withJSONObject: r) else { return nil }
                return String(data: d, encoding: .utf8)
            }
            let body = Data((lines.joined(separator: "\n") + "\n").utf8)
            let resp = makeHttpResponse(url: url, contentType: "application/x-ndjson; charset=utf-8", contentLength: body.count)
            completeTask(task, response: resp, data: body)
        } else {
            sendJson(task, url: url, obj: ["results": results])
        }
    }

    private func probeOneLive(_ rawUrl: String) -> [String: Any] {
        let t0 = Int64(Date().timeIntervalSince1970 * 1000)
        let isM3u8 = rawUrl.components(separatedBy: "?").first?.lowercased().hasSuffix(".m3u8") == true
        let level = isM3u8 ? "manifest" : "head"
        if let res = NetClient.getBytes(rawUrl, maxBytes: 4096, deadlineMs: 4_000) {
            let ms = Int64(Date().timeIntervalSince1970 * 1000) - t0
            return ["url": rawUrl, "ok": true, "status": res.statusCode, "ms": ms, "level": level]
        } else {
            let ms = Int64(Date().timeIntervalSince1970 * 1000) - t0
            return ["url": rawUrl, "ok": false, "ms": ms, "level": level, "error": "连接超时或不可达"]
        }
    }

    // MARK: - /api/proxy & /api/live/stream

    private func handleProxy(url: URL, targetUrl: String?, adFilter: Bool, task: WKURLSchemeTask) {
        guard let target = targetUrl?.trimmingCharacters(in: .whitespacesAndNewlines), !target.isEmpty else {
            finishWithError(task, code: 400, message: "缺少 url")
            return
        }
        guard let res = NetClient.getBytes(target, maxBytes: 32 * 1024 * 1024, deadlineMs: 20_000) else {
            finishWithError(task, code: 502, message: "上游源请求失败")
            return
        }
        let ct = res.contentType ?? guessContentType(res.finalUrl)
        let isM3u8 = res.finalUrl.components(separatedBy: "?").first?.lowercased().hasSuffix(".m3u8") == true
            || ct.lowercased().contains("mpegurl")

        if isM3u8 {
            let text = NetClient.decodeBytes(res.data, contentType: ct)
            let rewritten = AdFilter.rewriteM3u8Playlist(text, baseUrl: res.finalUrl, adFilter: adFilter)
            let outData = Data(rewritten.utf8)
            let resp = makeHttpResponse(url: url, statusCode: 200, contentType: "application/vnd.apple.mpegurl; charset=utf-8", contentLength: outData.count)
            completeTask(task, response: resp, data: outData)
            return
        }

        let resp = makeHttpResponse(url: url, statusCode: 200, contentType: ct, contentLength: res.data.count)
        completeTask(task, response: resp, data: res.data)
    }

    private func guessContentType(_ rawUrl: String) -> String {
        let p = (rawUrl.components(separatedBy: "?").first ?? "").lowercased()
        if p.hasSuffix(".m3u8") { return "application/vnd.apple.mpegurl" }
        if p.hasSuffix(".ts") { return "video/mp2t" }
        if p.hasSuffix(".mp4") { return "video/mp4" }
        if p.hasSuffix(".jpg") || p.hasSuffix(".jpeg") { return "image/jpeg" }
        if p.hasSuffix(".png") { return "image/png" }
        if p.hasSuffix(".webp") { return "image/webp" }
        if p.hasSuffix(".gif") { return "image/gif" }
        return "application/octet-stream"
    }
}
