import Foundation
import Network

/// iOS 本机回环 HTTP 微服务 (`http://127.0.0.1:18688`)：
/// 为什么在 iOS 上使用 `127.0.0.1` 回环服务配合 `WKWebView`：
/// 1. 固定 Origin (`http://127.0.0.1:18688`) 跨启动持久保留 `localStorage` 与 `IndexedDB`（观看历史、播放进度、源配置）；
/// 2. WebKit 将 `http://127.0.0.1` 视为安全上下文 (`isSecureContext = true`)，完整开放 `CacheStorage`（视频分片本地缓存）；
/// 3. iOS `<video>` 原生 HLS 解码器 (`AVPlayer` / `mediaserverd`) 运行在独立系统守护进程，无法读取 `WKURLSchemeHandler`，
///    但可直接通过 `http://127.0.0.1:18688/api/proxy` 硬件解码去广告后的 M3U8 与直播流；
/// 4. 原生支持 `/api/search?stream=1` NDJSON 实时流式分块推送。
final class LocalHttpServer {

    static let shared = LocalHttpServer()
    weak var playerHost: PlayerHost?

    private(set) var port: UInt16 = 18688
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "org.qtv.ios.httpserver", qos: .userInitiated, attributes: .concurrent)

    func start(preferredPort: UInt16 = 18688) {
        if listener != nil { return }
        let portsToTry: [UInt16] = [preferredPort, 18689, 18690, 18691, 0]
        for candidate in portsToTry {
            do {
                let params = NWParameters.tcp
                params.allowLocalEndpointReuse = true
                params.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: candidate) ?? .any)
                let nwListener = try NWListener(using: params)
                nwListener.newConnectionHandler = { [weak self] conn in
                    self?.handleConnection(conn)
                }
                nwListener.stateUpdateHandler = { [weak self] state in
                    if case .ready = state, let actualPort = nwListener.port?.rawValue {
                        self?.port = actualPort
                    }
                }
                nwListener.start(queue: queue)
                self.listener = nwListener
                if candidate != 0 { self.port = candidate }
                break
            } catch {
                continue
            }
        }
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    private func handleConnection(_ conn: NWConnection) {
        conn.start(queue: queue)
        receiveRequest(on: conn, buffer: Data())
    }

    private func receiveRequest(on conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self = self else {
                conn.cancel()
                return
            }
            var accumulated = buffer
            if let d = data, !d.isEmpty {
                accumulated.append(d)
            }
            if let headerEnd = accumulated.range(of: Data("\r\n\r\n".utf8)) {
                let headerData = accumulated.subdata(in: 0..<headerEnd.lowerBound)
                let headerStr = String(decoding: headerData, as: UTF8.self)
                let lines = headerStr.components(separatedBy: "\r\n")
                guard let requestLine = lines.first else {
                    conn.cancel()
                    return
                }
                let parts = requestLine.components(separatedBy: " ")
                guard parts.count >= 2 else {
                    conn.cancel()
                    return
                }
                let method = parts[0].uppercased()
                let rawTarget = parts[1]

                var contentLength = 0
                for line in lines.dropFirst() {
                    let lower = line.lowercased()
                    if lower.hasPrefix("content-length:") {
                        let val = line.dropFirst("content-length:".count).trimmingCharacters(in: .whitespaces)
                        contentLength = Int(val) ?? 0
                    }
                }

                let bodyStart = headerEnd.upperBound
                let currentBodyBytes = accumulated.count - bodyStart
                if currentBodyBytes < contentLength && !isComplete && error == nil {
                    self.receiveRequest(on: conn, buffer: accumulated)
                    return
                }
                let bodyData = contentLength > 0 && accumulated.count >= bodyStart + contentLength
                    ? accumulated.subdata(in: bodyStart..<(bodyStart + contentLength))
                    : Data()

                self.dispatchRequest(method: method, rawTarget: rawTarget, bodyData: bodyData, conn: conn)
            } else if isComplete || error != nil || accumulated.count > 262_144 {
                conn.cancel()
            } else {
                self.receiveRequest(on: conn, buffer: accumulated)
            }
        }
    }

    private func dispatchRequest(method: String, rawTarget: String, bodyData: Data, conn: NWConnection) {
        if method == "OPTIONS" {
            sendResponse(conn: conn, status: "204 No Content", contentType: "text/plain", body: Data())
            return
        }
        guard let url = URL(string: "http://127.0.0.1:\(port)\(rawTarget)") else {
            sendJsonError(conn: conn, code: 400, message: "Invalid URI")
            return
        }
        let path = url.path.isEmpty ? "/" : url.path
        if path.hasPrefix("/api/") {
            handleApiRequest(method: method, url: url, bodyData: bodyData, conn: conn)
        } else {
            serveStaticFile(path: path, conn: conn)
        }
    }

    // MARK: - 静态文件服务 (`Resources/www/`)

    private func serveStaticFile(path: String, conn: NWConnection) {
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
            sendJsonError(conn: conn, code: 404, message: "Bundle missing")
            return
        }

        let candidates = [rel, "\(rel).html", "\(rel)/index.html", "www/index.html"]
        var foundUrl: URL?
        for c in candidates {
            let u = bundleBase.appendingPathComponent(c)
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: u.path, isDirectory: &isDir), !isDir.boolValue {
                foundUrl = u
                break
            }
        }

        guard let fileUrl = foundUrl, let data = try? Data(contentsOf: fileUrl) else {
            sendJsonError(conn: conn, code: 404, message: "Not found")
            return
        }

        let mime = mimeType(for: fileUrl.pathExtension)
        let cacheHeader = fileUrl.path.contains("/_next/static/") ? "public, max-age=31536000, immutable" : "no-cache"
        sendResponse(conn: conn, status: "200 OK", contentType: mime, body: data, cacheControl: cacheHeader)
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

    // MARK: - API 处理

    private func handleApiRequest(method: String, url: URL, bodyData: Data, conn: NWConnection) {
        let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let query = comps?.queryItems ?? []
        func qParam(_ name: String) -> String? {
            query.first(where: { $0.name == name })?.value
        }
        func qBool(_ name: String) -> Bool {
            guard let v = qParam(name)?.lowercased() else { return false }
            return v == "1" || v == "true"
        }

        let bodyObj: [String: Any] = {
            if !bodyData.isEmpty,
               let obj = try? JSONSerialization.jsonObject(with: bodyData) as? [String: Any] {
                return obj
            }
            guard let raw = qParam("__body"), !raw.isEmpty else { return [:] }
            let jsonStr: String
            if qParam("__bodyEnc") == "1",
               let decoded = Data(base64Encoded: raw),
               let s = String(data: decoded, encoding: .utf8) {
                jsonStr = s
            } else {
                jsonStr = raw
            }
            guard let d = jsonStr.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else {
                return [:]
            }
            return obj
        }()

        switch url.path {
        case "/api/status":
            let version = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "1.0"
            sendJson(conn: conn, obj: [
                "passwordRequired": false,
                "verified": true,
                "version": version,
                "instanceId": "local-ios",
                "defaultSources": [],
                "defaultLiveSources": [],
                "defaultSubscriptions": [],
                "defaultRecommendSource": NSNull(),
                "defaultImageMode": NSNull()
            ])

        case "/api/auth":
            sendJson(conn: conn, obj: ["success": true])

        case "/api/player-state":
            if qParam("read") == "1" {
                let b = playerHost?.currentBrightness() ?? -1.0
                let v = playerHost?.currentVolume() ?? -1.0
                sendJson(conn: conn, obj: ["brightness": b, "volume": v])
                return
            }
            DispatchQueue.main.async { [weak self] in
                if let p = qParam("paused") {
                    self?.playerHost?.onPlaybackPaused(p == "1" || p.lowercased() == "true")
                }
                if let f = qParam("fullscreen") {
                    self?.playerHost?.onFullscreenChanged(f == "1" || f.lowercased() == "true")
                }
                if let bStr = qParam("brightness"), let b = Float(bStr) {
                    self?.playerHost?.setBrightness(b)
                }
                if let vStr = qParam("volume"), let v = Float(vStr) {
                    self?.playerHost?.setVolume(v)
                }
            }
            sendJson(conn: conn, obj: ["ok": true])

        case "/api/search":
            handleSearch(bodyObj: bodyObj, stream: qBool("stream"), conn: conn)

        case "/api/detail":
            handleDetail(qParam: qParam, conn: conn)

        case "/api/source/test":
            guard let targetUrl = (bodyObj["url"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !targetUrl.isEmpty else {
                sendJsonError(conn: conn, code: 400, message: "缺少 url")
                return
            }
            let t0 = Int64(Date().timeIntervalSince1970 * 1000)
            let src = SourceConfig(key: "test", name: "test", url: targetUrl, detail: nil, isAdult: false)
            let res = CmsApi.search(src, wd: "test", page: 1)
            let ms = Int64(Date().timeIntervalSince1970 * 1000) - t0
            if let r = res {
                sendJson(conn: conn, obj: ["ok": true, "ms": ms, "count": r.items.count])
            } else {
                sendJson(conn: conn, obj: ["ok": false, "ms": ms, "error": "请求失败或格式错误"])
            }

        case "/api/source-list":
            let target = SubscriptionParser.normalizeSubscriptionUrl(qParam("url") ?? "")
            guard target.lowercased().hasPrefix("http://") || target.lowercased().hasPrefix("https://") else {
                sendJsonError(conn: conn, code: 400, message: "无效的订阅地址")
                return
            }
            guard let (text, _) = NetClient.getText(target) else {
                sendJsonError(conn: conn, code: 502, message: "订阅拉取失败")
                return
            }
            do {
                let payload = try SubscriptionParser.parseSubscriptionText(text)
                var root: [String: Any] = [
                    "name": payload.name ?? NSNull(),
                    "sources": payload.sources.map { (s) -> [String: Any] in
                        ["name": s.name, "url": s.url, "detail": s.detail ?? NSNull(), "isAdult": s.isAdult]
                    },
                    "liveSources": payload.liveSources.map { (l) -> [String: Any] in
                        ["name": l.name, "url": l.url, "epg": l.epg ?? NSNull()]
                    }
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
                sendJson(conn: conn, obj: root)
            } catch {
                sendJsonError(conn: conn, code: 400, message: error.localizedDescription)
            }

        case "/api/quality":
            handleQuality(bodyObj: bodyObj, stream: qBool("stream"), conn: conn)

        case "/api/live/playlist":
            handleLivePlaylist(qParam: qParam, conn: conn)

        case "/api/live/epg":
            handleLiveEpg(qParam: qParam, conn: conn)

        case "/api/live/probe":
            handleLiveProbe(bodyObj: bodyObj, stream: qBool("stream"), conn: conn)

        case "/api/proxy", "/api/live/stream":
            handleProxy(targetUrl: qParam("url"), adFilter: qBool("adFilter"), conn: conn)

        case "/api/douban", "/api/hot-list":
            sendJson(conn: conn, obj: ["items": []])

        case "/api/bangumi/calendar":
            sendJson(conn: conn, obj: ["days": []])

        default:
            sendJsonError(conn: conn, code: 404, message: "未知接口 \(url.path)")
        }
    }

    private func parseSources(_ arr: Any?) -> [SourceConfig] {
        guard let list = arr as? [[String: Any]] else { return [] }
        return list.enumerated().compactMap { i, o in
            guard let u = (o["url"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !u.isEmpty else { return nil }
            let key = (o["key"] as? String) ?? "src_\(i)"
            let name = (o["name"] as? String) ?? u
            let detail = (o["detail"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let isAdult = (o["isAdult"] as? Bool) ?? false
            return SourceConfig(key: key, name: name, url: u, detail: detail?.isEmpty == true ? nil : detail, isAdult: isAdult)
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

    private func handleSearch(bodyObj: [String: Any], stream: Bool, conn: NWConnection) {
        let wd = (bodyObj["wd"] as? String) ?? ""
        let filterAdult = (bodyObj["filterAdult"] as? Bool) ?? true
        let sources = parseSources(bodyObj["sources"])
        if sources.isEmpty {
            let doneObj: [String: Any] = ["type": "done", "list": [], "failures": []]
            if stream {
                let s = ((try? String(data: JSONSerialization.data(withJSONObject: doneObj), encoding: .utf8)) ?? "{}") + "\n"
                sendResponse(conn: conn, status: "200 OK", contentType: "application/x-ndjson; charset=utf-8", body: Data(s.utf8))
            } else {
                sendJson(conn: conn, obj: doneObj)
            }
            return
        }

        if stream {
            let header = "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson; charset=utf-8\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
            conn.send(content: Data(header.utf8), completion: .idempotent)
            let sendLock = NSLock()
            let outcomes = CmsApi.searchAll(wd: wd, sources: sources, filterAdult: filterAdult) { [weak self] o in
                guard let self = self else { return }
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
                   var line = String(data: d, encoding: .utf8) {
                    line.append("\n")
                    sendLock.lock()
                    conn.send(content: Data(line.utf8), completion: .idempotent)
                    sendLock.unlock()
                }
            }
            let doneObj = buildSearchDone(outcomes: outcomes)
            if let d = try? JSONSerialization.data(withJSONObject: doneObj),
               var line = String(data: d, encoding: .utf8) {
                line.append("\n")
                sendLock.lock()
                conn.send(content: Data(line.utf8), isComplete: true, completion: .contentProcessed { _ in
                    conn.cancel()
                })
                sendLock.unlock()
            } else {
                conn.cancel()
            }
            return
        }

        let outcomes = CmsApi.searchAll(wd: wd, sources: sources, filterAdult: filterAdult)
        sendJson(conn: conn, obj: buildSearchDone(outcomes: outcomes))
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
            ["sourceKey": $0.source.key, "error": $0.error ?? "请求失败", "timedOut": $0.timedOut] as [String: Any]
        }
        return ["type": "done", "list": list, "failures": failures]
    }

    private func handleDetail(qParam: (String) -> String?, conn: NWConnection) {
        guard let id = qParam("id"), !id.isEmpty else {
            sendJsonError(conn: conn, code: 400, message: "缺少 id")
            return
        }
        let rawSrc = qParam("source") ?? "{}"
        let srcObj = (try? JSONSerialization.jsonObject(with: Data(rawSrc.utf8)) as? [String: Any]) ?? [:]
        guard let srcUrl = (srcObj["url"] as? String), !srcUrl.isEmpty else {
            sendJsonError(conn: conn, code: 400, message: "缺少源地址")
            return
        }
        let src = SourceConfig(
            key: (srcObj["key"] as? String) ?? "src",
            name: (srcObj["name"] as? String) ?? "",
            url: srcUrl,
            detail: srcObj["detail"] as? String,
            isAdult: false
        )
        var d = CmsApi.detail(src, id: id)
        if d == nil || (d?.defaultLine?.episodes.isEmpty ?? true) {
            d = CmsApi.detailPage(src, id: id) ?? d
        }
        guard let detail = d else {
            sendJsonError(conn: conn, code: 404, message: "获取到的详情内容无效")
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
        sendJson(conn: conn, obj: ["episodes": episodes, "videoInfo": info])
    }

    private func handleQuality(bodyObj: [String: Any], stream: Bool, conn: NWConnection) {
        guard let rawItems = bodyObj["items"] as? [[String: Any]], !rawItems.isEmpty else {
            sendJsonError(conn: conn, code: 400, message: "请提供待探测的条目")
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
                defer { sem.signal(); group.leave() }
                let r = QualityProbe.probeQuality(source: src, id: id)
                lock.lock()
                results.append([
                    "sourceKey": r.sourceKey,
                    "vodId": r.vodId,
                    "height": r.height ?? NSNull(),
                    "error": r.error ?? NSNull()
                ])
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
            sendResponse(conn: conn, status: "200 OK", contentType: "application/x-ndjson; charset=utf-8", body: body)
        } else {
            sendJson(conn: conn, obj: ["results": results])
        }
    }

    private func handleLivePlaylist(qParam: (String) -> String?, conn: NWConnection) {
        guard let target = qParam("url")?.trimmingCharacters(in: .whitespacesAndNewlines), !target.isEmpty else {
            sendJsonError(conn: conn, code: 400, message: "缺少 url 参数")
            return
        }
        let format = qParam("format") ?? "json"
        guard let (text, _) = NetClient.getText(target) else {
            sendJsonError(conn: conn, code: 502, message: "订阅地址请求失败")
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
            sendResponse(conn: conn, status: "200 OK", contentType: "audio/x-mpegurl; charset=utf-8", body: Data(lines.joined(separator: "\n").utf8))
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
        sendJson(conn: conn, obj: ["name": NSNull(), "channels": chArr, "groups": groups])
    }

    private func handleLiveEpg(qParam: (String) -> String?, conn: NWConnection) {
        guard let target = qParam("url")?.trimmingCharacters(in: .whitespacesAndNewlines), !target.isEmpty else {
            sendJsonError(conn: conn, code: 400, message: "缺少 url 参数")
            return
        }
        let channelId = qParam("channel") ?? ""
        guard let res = NetClient.getBytes(target, maxBytes: 32 * 1024 * 1024, deadlineMs: 15_000) else {
            sendJsonError(conn: conn, code: 502, message: "EPG 地址请求失败")
            return
        }
        let xmlText = M3uAndXmltvParser.decodeMaybeGzip(res.data)
        let all = M3uAndXmltvParser.parseXmltv(xmlText)
        let programs = all[channelId] ?? []
        let (current, next) = M3uAndXmltvParser.currentAndNext(programs)
        func pgDict(_ p: EpgProgram?) -> Any {
            guard let p = p else { return NSNull() }
            return ["channelId": p.channelId, "start": p.start, "stop": p.stop, "title": p.title, "desc": p.desc ?? NSNull()]
        }
        sendJson(conn: conn, obj: [
            "channelId": channelId,
            "current": pgDict(current),
            "next": pgDict(next),
            "programs": programs.map { pgDict($0) }
        ])
    }

    private func handleLiveProbe(bodyObj: [String: Any], stream: Bool, conn: NWConnection) {
        let urls = ((bodyObj["urls"] as? [String]) ?? []).prefix(50).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        var results: [[String: Any]] = []
        for u in urls {
            let t0 = Int64(Date().timeIntervalSince1970 * 1000)
            let isM3u8 = u.components(separatedBy: "?").first?.lowercased().hasSuffix(".m3u8") == true
            let level = isM3u8 ? "manifest" : "head"
            if let res = NetClient.getBytes(u, maxBytes: 4096, deadlineMs: 4_000) {
                let ms = Int64(Date().timeIntervalSince1970 * 1000) - t0
                results.append(["url": u, "ok": true, "status": res.statusCode, "ms": ms, "level": level])
            } else {
                let ms = Int64(Date().timeIntervalSince1970 * 1000) - t0
                results.append(["url": u, "ok": false, "ms": ms, "level": level, "error": "连接超时或不可达"])
            }
        }
        if stream {
            let lines = results.compactMap { r -> String? in
                guard let d = try? JSONSerialization.data(withJSONObject: r) else { return nil }
                return String(data: d, encoding: .utf8)
            }
            let body = Data((lines.joined(separator: "\n") + "\n").utf8)
            sendResponse(conn: conn, status: "200 OK", contentType: "application/x-ndjson; charset=utf-8", body: body)
        } else {
            sendJson(conn: conn, obj: ["results": results])
        }
    }

    private func handleProxy(targetUrl: String?, adFilter: Bool, conn: NWConnection) {
        guard let target = targetUrl?.trimmingCharacters(in: .whitespacesAndNewlines), !target.isEmpty else {
            sendJsonError(conn: conn, code: 400, message: "缺少 url")
            return
        }
        guard let res = NetClient.getBytes(target, maxBytes: 32 * 1024 * 1024, deadlineMs: 20_000) else {
            sendJsonError(conn: conn, code: 502, message: "上游源请求失败")
            return
        }
        let ct = res.contentType ?? guessContentType(res.finalUrl)
        let isM3u8 = res.finalUrl.components(separatedBy: "?").first?.lowercased().hasSuffix(".m3u8") == true
            || ct.lowercased().contains("mpegurl")
        if isM3u8 {
            let text = NetClient.decodeBytes(res.data, contentType: ct)
            let rewritten = AdFilter.rewriteM3u8Playlist(text, baseUrl: res.finalUrl, adFilter: adFilter)
            sendResponse(conn: conn, status: "200 OK", contentType: "application/vnd.apple.mpegurl; charset=utf-8", body: Data(rewritten.utf8))
            return
        }
        sendResponse(conn: conn, status: "200 OK", contentType: ct, body: res.data)
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

    // MARK: - HTTP 响应发送

    private func sendJson(conn: NWConnection, obj: Any, status: String = "200 OK") {
        let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
        sendResponse(conn: conn, status: status, contentType: "application/json; charset=utf-8", body: data)
    }

    private func sendJsonError(conn: NWConnection, code: Int, message: String) {
        let status = "\(code) Error"
        sendJson(conn: conn, obj: ["error": message], status: status)
    }

    private func sendResponse(conn: NWConnection, status: String, contentType: String, body: Data, cacheControl: String = "no-store") {
        let header = [
            "HTTP/1.1 \(status)",
            "Content-Type: \(contentType)",
            "Content-Length: \(body.count)",
            "Access-Control-Allow-Origin: *",
            "Access-Control-Allow-Methods: GET, POST, OPTIONS",
            "Access-Control-Allow-Headers: *",
            "Cache-Control: \(cacheControl)",
            "Connection: close",
            "",
            ""
        ].joined(separator: "\r\n")
        var payload = Data(header.utf8)
        payload.append(body)
        conn.send(content: payload, isComplete: true, completion: .contentProcessed { _ in
            conn.cancel()
        })
    }
}
