import Foundation
import Compression

struct LiveChannel {
    let id: String
    let name: String
    let url: String
    let logo: String?
    let group: String?
    let tvgId: String?
    let rawName: String?
}

struct EpgProgram {
    let channelId: String
    let start: Int64
    let stop: Int64
    let title: String
    let desc: String?
}

/// M3U 播放列表与 XMLTV (含 Gzip) 节目单解析（1:1 移植 `M3uParser.kt` + `XmltvParser.kt`）
enum M3uAndXmltvParser {

    private static let attrRegex = try! NSRegularExpression(pattern: "([a-zA-Z0-9_-]+)=\"([^\"]*)\"")
    private static let extInfPrefixRegex = try! NSRegularExpression(pattern: "^#EXTINF\\s*:\\s*", options: [.caseInsensitive])
    private static let mediaExtRegex = try! NSRegularExpression(pattern: "\\.(m3u8?|flv|ts|mp4)$", options: [.caseInsensitive])

    static func stableId(_ input: String) -> String {
        var h: UInt64 = 5381
        for scalar in input.unicodeScalars {
            h = ((h << 5) &+ h &+ UInt64(scalar.value)) & 0xFFFFFFFF
        }
        return String(h, radix: 36)
    }

    static func normalizeStreamUrl(_ raw: String, baseUrl: String?) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        let resolved: URL?
        if let baseStr = baseUrl, !baseStr.isEmpty, let base = URL(string: baseStr) {
            resolved = URL(string: trimmed, relativeTo: base)?.absoluteURL
        } else {
            resolved = URL(string: trimmed)
        }
        guard let u = resolved,
              let scheme = u.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            return nil
        }
        return u.absoluteString
    }

    private static func nameFromUrl(_ url: String) -> String {
        guard let u = URL(string: url) else { return "未命名频道" }
        let last = u.lastPathComponent.removingPercentEncoding ?? u.lastPathComponent
        let range = NSRange(last.startIndex..<last.endIndex, in: last)
        let cleaned = mediaExtRegex.stringByReplacingMatches(in: last, options: [], range: range, withTemplate: "")
        return cleaned.isEmpty ? (u.host ?? "未命名频道") : cleaned
    }

    static func parseM3u(_ content: String, baseUrl: String? = nil) -> [LiveChannel] {
        if content.isEmpty { return [] }
        var channels: [LiveChannel] = []
        var seen = Set<String>()
        var attrs: [String: String]?
        var title: String?
        var extGroup = ""

        for rawLine in content.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty { continue }

            if line.uppercased().hasPrefix("#EXTINF") {
                var map: [String: String] = [:]
                let nsRange = NSRange(line.startIndex..<line.endIndex, in: line)
                for m in attrRegex.matches(in: line, options: [], range: nsRange) {
                    if let r1 = Range(m.range(at: 1), in: line),
                       let r2 = Range(m.range(at: 2), in: line) {
                        map[String(line[r1]).lowercased()] = String(line[r2]).trimmingCharacters(in: .whitespacesAndNewlines)
                    }
                }
                let noAttrs = attrRegex.stringByReplacingMatches(in: line, options: [], range: nsRange, withTemplate: "")
                let stripped = extInfPrefixRegex.stringByReplacingMatches(
                    in: noAttrs,
                    options: [],
                    range: NSRange(noAttrs.startIndex..<noAttrs.endIndex, in: noAttrs),
                    withTemplate: ""
                )
                if let commaIdx = stripped.firstIndex(of: ",") {
                    title = String(stripped[stripped.index(after: commaIdx)...]).trimmingCharacters(in: CharacterSet(charactersIn: " \""))
                } else {
                    title = stripped.trimmingCharacters(in: CharacterSet(charactersIn: " \""))
                }
                attrs = map
                extGroup = ""
                continue
            }

            if line.uppercased().hasPrefix("#EXTGRP:") {
                let g = String(line.dropFirst("#EXTGRP:".count)).trimmingCharacters(in: .whitespacesAndNewlines)
                if attrs != nil && !g.isEmpty && attrs?["group-title"] == nil {
                    extGroup = g
                }
                continue
            }

            if line.hasPrefix("#") { continue }

            let url = normalizeStreamUrl(line, baseUrl: baseUrl)
            let curAttrs = attrs
            let curTitle = title
            let curExtGroup = extGroup
            attrs = nil; title = nil; extGroup = ""

            guard let validUrl = url, seen.insert(validUrl).inserted else { continue }
            let tvgId = curAttrs?["tvg-id"]?.isEmpty == false ? curAttrs?["tvg-id"] : nil
            let logo = curAttrs?["tvg-logo"].flatMap { normalizeStreamUrl($0, baseUrl: baseUrl) }
            let group = (curAttrs?["group-title"]?.isEmpty == false ? curAttrs?["group-title"] : nil)
                ?? (curExtGroup.isEmpty ? nil : curExtGroup)
            let rawName = curAttrs?["tvg-name"]?.isEmpty == false ? curAttrs?["tvg-name"] : nil
            channels.append(LiveChannel(
                id: tvgId ?? stableId(validUrl),
                name: (curTitle?.isEmpty == false ? curTitle! : nameFromUrl(validUrl)),
                url: validUrl,
                logo: logo,
                group: group,
                tvgId: tvgId,
                rawName: rawName
            ))
        }
        return channels
    }

    // —— XMLTV & Gzip 解压 ——
    private static let programmeRegex = try! NSRegularExpression(
        pattern: "<programme\\s+([^>]*?)>([\\s\\S]*?)</programme>",
        options: [.caseInsensitive]
    )
    private static let titleRegex = try! NSRegularExpression(
        pattern: "<title(?:\\s[^>]*)?>([\\s\\S]*?)</title>",
        options: [.caseInsensitive]
    )
    private static let descRegex = try! NSRegularExpression(
        pattern: "<desc(?:\\s[^>]*)?>([\\s\\S]*?)</desc>",
        options: [.caseInsensitive]
    )
    private static let timeRegex = try! NSRegularExpression(
        pattern: "^(\\d{4})(\\d{2})(\\d{2})(\\d{2})?(\\d{2})?(\\d{2})?(?:\\.(\\d{1,3}))?(?:\\s*([+-])(\\d{2})(\\d{2})|\\s*Z)?$"
    )

    static func decodeMaybeGzip(_ data: Data) -> String {
        if data.count >= 2 && data[0] == 0x1F && data[1] == 0x8B {
            if let decompressed = gunzip(data) {
                return String(decoding: decompressed, as: UTF8.self)
            }
        }
        return String(decoding: data, as: UTF8.self)
    }

    /// 解析 Gzip 头部并用 Apple Compression 框架解压 DEFLATE 负载
    private static func gunzip(_ data: Data) -> Data? {
        guard data.count > 18, data[0] == 0x1F, data[1] == 0x8B, data[2] == 8 else { return nil }
        let flags = data[3]
        var offset = 10
        if (flags & 0x04) != 0 {
            guard offset + 2 <= data.count else { return nil }
            let xlen = Int(data[offset]) | (Int(data[offset + 1]) << 8)
            offset += 2 + xlen
        }
        if (flags & 0x08) != 0 {
            while offset < data.count && data[offset] != 0 { offset += 1 }
            offset += 1
        }
        if (flags & 0x10) != 0 {
            while offset < data.count && data[offset] != 0 { offset += 1 }
            offset += 1
        }
        if (flags & 0x02) != 0 { offset += 2 }
        guard offset < data.count - 8 else { return nil }
        let compressed = data.subdata(in: offset..<(data.count - 8))
        let dstCapacity = max(compressed.count * 6, 256 * 1024)
        var dstBuffer = Data(count: dstCapacity)
        let decodedBytes = dstBuffer.withUnsafeMutableBytes { dstPtr -> Int in
            compressed.withUnsafeBytes { srcPtr -> Int in
                guard let dstBase = dstPtr.bindMemory(to: UInt8.self).baseAddress,
                      let srcBase = srcPtr.bindMemory(to: UInt8.self).baseAddress else { return 0 }
                return compression_decode_buffer(dstBase, dstCapacity, srcBase, compressed.count, nil, COMPRESSION_ZLIB)
            }
        }
        guard decodedBytes > 0 else { return nil }
        dstBuffer.count = decodedBytes
        return dstBuffer
    }

    private static func decodeXmlText(_ raw: String) -> String {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("<![CDATA[") && text.hasSuffix("]]>") {
            text = String(text.dropFirst(9).dropLast(3))
        }
        return text
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&apos;", with: "'")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&amp;", with: "&")
    }

    static func parseXmltvTime(_ raw: String) -> Int64? {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let nsRange = NSRange(t.startIndex..<t.endIndex, in: t)
        guard let m = timeRegex.firstMatch(in: t, options: [], range: nsRange) else { return nil }
        func group(_ idx: Int) -> String {
            guard let r = Range(m.range(at: idx), in: t) else { return "" }
            return String(t[r])
        }
        var comps = DateComponents()
        comps.calendar = Calendar(identifier: .gregorian)
        comps.timeZone = TimeZone(secondsFromGMT: 0)
        comps.year = Int(group(1))
        comps.month = Int(group(2))
        comps.day = Int(group(3))
        comps.hour = Int(group(4)) ?? 0
        comps.minute = Int(group(5)) ?? 0
        comps.second = Int(group(6)) ?? 0
        guard let date = comps.date else { return nil }
        var utcMs = Int64(date.timeIntervalSince1970 * 1000)
        let sign = group(8)
        if !sign.isEmpty {
            let offsetMin = (Int(group(9)) ?? 0) * 60 + (Int(group(10)) ?? 0)
            let offsetMs = Int64(offsetMin) * 60_000 * (sign == "-" ? -1 : 1)
            utcMs -= offsetMs
        }
        return utcMs
    }

    static func parseXmltv(_ content: String, windowMs: Int64 = 24 * 60 * 60 * 1000) -> [String: [EpgProgram]] {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let windowEnd = now + windowMs
        var result: [String: [EpgProgram]] = [:]
        let nsRange = NSRange(content.startIndex..<content.endIndex, in: content)

        for m in programmeRegex.matches(in: content, options: [], range: nsRange) {
            guard let rAttr = Range(m.range(at: 1), in: content),
                  let rInner = Range(m.range(at: 2), in: content) else { continue }
            let attrText = String(content[rAttr])
            let inner = String(content[rInner])
            var attrs: [String: String] = [:]
            let attrRange = NSRange(attrText.startIndex..<attrText.endIndex, in: attrText)
            for a in attrRegex.matches(in: attrText, options: [], range: attrRange) {
                if let k = Range(a.range(at: 1), in: attrText),
                   let v = Range(a.range(at: 2), in: attrText) {
                    attrs[String(attrText[k]).lowercased()] = String(attrText[v])
                }
            }
            guard let chId = attrs["channel"]?.trimmingCharacters(in: .whitespacesAndNewlines), !chId.isEmpty,
                  let start = parseXmltvTime(attrs["start"] ?? ""),
                  let stop = parseXmltvTime(attrs["stop"] ?? ""),
                  stop > now && start < windowEnd else { continue }

            let innerRange = NSRange(inner.startIndex..<inner.endIndex, in: inner)
            guard let tm = titleRegex.firstMatch(in: inner, options: [], range: innerRange),
                  let tr = Range(tm.range(at: 1), in: inner) else { continue }
            let title = decodeXmlText(String(inner[tr]))
            if title.isEmpty { continue }

            var desc: String?
            if let dm = descRegex.firstMatch(in: inner, options: [], range: innerRange),
               let dr = Range(dm.range(at: 1), in: inner) {
                desc = decodeXmlText(String(inner[dr]))
            }
            result[chId, default: []].append(EpgProgram(channelId: chId, start: start, stop: stop, title: title, desc: desc))
        }
        for k in result.keys {
            result[k]?.sort(by: { $0.start < $1.start })
        }
        return result
    }

    static func currentAndNext(_ programs: [EpgProgram]) -> (current: EpgProgram?, next: EpgProgram?) {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        var current: EpgProgram?
        var next: EpgProgram?
        for p in programs {
            if p.start <= now && p.stop > now {
                current = p
            } else if p.start > now {
                next = p
                break
            }
        }
        return (current, next)
    }
}
