package org.qtv.app.data.quality

import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * 从媒体分片本身解析分辨率（1:1 移植 `src/lib/codec-parse.ts`）。
 *
 * 单码率 m3u8 里没有 RESOLUTION，只能下沉到分片：H.264 SPS NAL / MP4 VisualSampleEntry。
 * 只读前缀、只解头部，不做完整 demux。HEVC SPS 不解析（跳错会静默给错分辨率，
 * 比「未知」更糟）。
 */
data class MediaResolution(val width: Int, val height: Int)

object CodecParse {

    /** H.264 里带 chroma_format_idc 等扩展字段的 profile */
    private val H264_HIGH_PROFILES = setOf(100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135)

    private class BitReader(private val data: ByteArray) {
        var pos = 0
            private set

        fun readBits(n: Int): Int {
            var value = 0
            for (i in 0 until n) {
                val byte = data.getOrElse(pos shr 3) { throw IllegalStateException("位流已耗尽") }
                value = (value shl 1) or ((byte.toInt() shr (7 - (pos and 7))) and 1)
                pos += 1
            }
            return value
        }

        /** 无符号 exp-golomb */
        fun readUE(): Int {
            var zeros = 0
            while (readBits(1) == 0) {
                zeros += 1
                if (zeros > 32) throw IllegalStateException("非法的 exp-golomb 编码")
            }
            if (zeros == 0) return 0
            return (1 shl zeros) - 1 + readBits(zeros)
        }

        /** 有符号 exp-golomb */
        fun readSE(): Int {
            val k = readUE()
            return if (k % 2 == 1) (k + 1) / 2 else -k / 2
        }
    }

    private fun chromaSubsampling(chromaFormatIdc: Int): Pair<Int, Int> = when (chromaFormatIdc) {
        1 -> Pair(2, 2)   // 4:2:0
        2 -> Pair(2, 1)   // 4:2:2
        else -> Pair(1, 1) // 单色 / 4:4:4
    }

    /** 去掉防竞争字节（00 00 03 xx → 00 00 xx） */
    fun unescapeRbsp(src: ByteArray): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        var zeros = 0
        for (b in src) {
            if (zeros == 2 && b == 3.toByte()) {
                zeros = 0
                continue
            }
            out.write(b.toInt())
            zeros = if (b == 0.toByte()) zeros + 1 else 0
        }
        return out.toByteArray()
    }

    private fun skipScalingLists(reader: BitReader, chromaFormatIdc: Int) {
        val count = if (chromaFormatIdc != 3) 8 else 12
        for (i in 0 until count) {
            if (reader.readBits(1) == 0) continue
            val size = if (i < 6) 16 else 64
            for (j in 0 until size) reader.readSE()
        }
    }

    /** 解析 H.264 SPS（RBSP）得到画面尺寸 */
    fun parseH264Sps(rbsp: ByteArray): MediaResolution? {
        return try {
            val reader = BitReader(rbsp)
            val profileIdc = reader.readBits(8)
            reader.readBits(8) // constraint flags + reserved
            reader.readBits(8) // level_idc
            reader.readUE()    // seq_parameter_set_id

            var chromaFormatIdc = 1
            if (profileIdc in H264_HIGH_PROFILES) {
                chromaFormatIdc = reader.readUE()
                if (chromaFormatIdc == 3) reader.readBits(1)
                reader.readUE() // bit_depth_luma_minus8
                reader.readUE() // bit_depth_chroma_minus8
                reader.readBits(1)
                if (reader.readBits(1) == 1) skipScalingLists(reader, chromaFormatIdc)
            }

            reader.readUE() // log2_max_frame_num_minus4
            val picOrderCntType = reader.readUE()
            if (picOrderCntType == 0) {
                reader.readUE()
            } else if (picOrderCntType == 1) {
                reader.readBits(1)
                reader.readSE()
                reader.readSE()
                val cycles = reader.readUE()
                for (i in 0 until cycles) reader.readSE()
            }

            reader.readUE() // max_num_ref_frames
            reader.readBits(1)
            val widthInMbs = reader.readUE() + 1
            val heightInMapUnits = reader.readUE() + 1
            val frameMbsOnly = reader.readBits(1)
            if (frameMbsOnly == 0) reader.readBits(1)
            reader.readBits(1) // direct_8x8_inference_flag

            val cropped = reader.readBits(1) == 1
            var cropLeft = 0; var cropRight = 0; var cropTop = 0; var cropBottom = 0
            if (cropped) {
                cropLeft = reader.readUE(); cropRight = reader.readUE()
                cropTop = reader.readUE(); cropBottom = reader.readUE()
            }

            var width = widthInMbs * 16
            var height = (2 - frameMbsOnly) * heightInMapUnits * 16
            if (cropped) {
                val (subWidthC, subHeightC) = chromaSubsampling(chromaFormatIdc)
                width -= (cropLeft + cropRight) * subWidthC
                height -= (cropTop + cropBottom) * subHeightC * (2 - frameMbsOnly)
            }
            if (width <= 0 || height <= 0) null else MediaResolution(width, height)
        } catch (_: Exception) {
            null // 位流不规则/截断：宁可「未知」也不要错值
        }
    }

    private fun findStartCodes(es: ByteArray, limit: Int = 64): List<Int> {
        val positions = ArrayList<Int>()
        var i = 2
        while (i < es.size && positions.size < limit) {
            if (es[i] == 1.toByte() && es[i - 1] == 0.toByte() && es[i - 2] == 0.toByte()) positions.add(i + 1)
            i += 1
        }
        return positions
    }

    /** 在 Annex-B 基本流里找 SPS（NAL type 7）的 RBSP */
    fun findH264Sps(es: ByteArray): ByteArray? {
        val starts = findStartCodes(es)
        for ((i, from) in starts.withIndex()) {
            val to = if (i + 1 < starts.size) starts[i + 1] - 3 else es.size
            if (to <= from) continue
            val nal = es.copyOfRange(from, to)
            if ((nal[0].toInt() and 0x1f) == 7) return unescapeRbsp(nal.copyOfRange(1, nal.size))
        }
        return null
    }

    // —— MPEG-TS ——
    private const val TS_PACKET_SIZE = 188
    private const val MAX_ES_BYTES = 256 * 1024

    private data class TsPacket(val pid: Int, val payloadStart: Boolean, val payload: ByteArray)

    private fun findTsOffset(buf: ByteArray): Int {
        val max = minOf(buf.size, TS_PACKET_SIZE * 4)
        for (i in 0 until max) {
            if (buf[i] == 0x47.toByte() &&
                i + TS_PACKET_SIZE * 2 < buf.size &&
                buf[i + TS_PACKET_SIZE] == 0x47.toByte() &&
                buf[i + TS_PACKET_SIZE * 2] == 0x47.toByte()
            ) return i
        }
        return if (buf.isNotEmpty() && buf[0] == 0x47.toByte()) 0 else -1
    }

    private fun readTsPackets(buf: ByteArray, start: Int): Sequence<TsPacket> = sequence {
        var i = start
        while (i + TS_PACKET_SIZE <= buf.size) {
            if (buf[i] == 0x47.toByte()) {
                val pid = ((buf[i + 1].toInt() and 0x1f) shl 8) or buf[i + 2].toInt()
                val payloadStart = (buf[i + 1].toInt() and 0x40) != 0
                val hasAdaptation = (buf[i + 3].toInt() and 0x20) != 0
                val hasPayload = (buf[i + 3].toInt() and 0x10) != 0
                if (hasPayload) {
                    var payloadBegin = i + 4
                    if (hasAdaptation) payloadBegin += 1 + buf[i + 4].toInt()
                    if (payloadBegin < i + TS_PACKET_SIZE) {
                        yield(TsPacket(pid, payloadStart, buf.copyOfRange(payloadBegin, i + TS_PACKET_SIZE)))
                    }
                }
            }
            i += TS_PACKET_SIZE
        }
    }

    private fun parsePat(payload: ByteArray): Int {
        val begin = 1 + payload.getOrElse(0) { 0.toByte() }.toInt()
        if (begin + 8 > payload.size) return -1
        if (payload[begin] != 0x00.toByte()) return -1
        val sectionLength = ((payload[begin + 1].toInt() and 0x0f) shl 8) or payload[begin + 2].toInt()
        val end = begin + 3 + sectionLength - 4
        var p = begin + 8
        while (p + 4 <= end && p + 4 <= payload.size) {
            val programNumber = (payload[p].toInt() shl 8) or payload[p + 1].toInt()
            if (programNumber != 0) return ((payload[p + 2].toInt() and 0x1f) shl 8) or payload[p + 3].toInt()
            p += 4
        }
        return -1
    }

    private fun parsePmt(payload: ByteArray): Int {
        val begin = 1 + payload.getOrElse(0) { 0.toByte() }.toInt()
        if (begin + 12 > payload.size) return -1
        if (payload[begin] != 0x02.toByte()) return -1
        val sectionLength = ((payload[begin + 1].toInt() and 0x0f) shl 8) or payload[begin + 2].toInt()
        val end = begin + 3 + sectionLength - 4
        val programInfoLength = ((payload[begin + 10].toInt() and 0x0f) shl 8) or payload[begin + 11].toInt()
        var p = begin + 12 + programInfoLength
        while (p + 5 <= end && p + 5 <= payload.size) {
            val streamType = payload[p].toInt()
            val pid = ((payload[p + 1].toInt() and 0x1f) shl 8) or payload[p + 2].toInt()
            val esInfoLength = ((payload[p + 3].toInt() and 0x0f) shl 8) or payload[p + 4].toInt()
            if (streamType == 0x1b) return pid
            p += 5 + esInfoLength
        }
        return -1
    }

    private fun collectElementaryStream(buf: ByteArray, start: Int, videoPid: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        var total = 0
        for (packet in readTsPackets(buf, start)) {
            if (videoPid >= 0 && packet.pid != videoPid) continue
            var payload = packet.payload
            if (packet.payloadStart &&
                payload.size > 9 && payload[0] == 0.toByte() && payload[1] == 0.toByte() && payload[2] == 1.toByte()
            ) {
                val esBegin = 9 + payload[8].toInt()
                if (esBegin >= payload.size) continue
                payload = payload.copyOfRange(esBegin, payload.size)
            }
            out.write(payload, 0, payload.size)
            total += payload.size
            if (total >= MAX_ES_BYTES) break
        }
        return out.toByteArray()
    }

    /** 解析 TS 分片得到分辨率（H.264；HEVC 不支持） */
    fun parseTsVideoResolution(buf: ByteArray): MediaResolution? {
        val start = findTsOffset(buf)
        if (start < 0) return null

        var pmtPid = -1
        var videoPid = -1
        for (packet in readTsPackets(buf, start)) {
            if (!packet.payloadStart) continue
            if (pmtPid < 0 && packet.pid == 0x0000) {
                pmtPid = parsePat(packet.payload)
                continue
            }
            if (pmtPid >= 0 && packet.pid == pmtPid) {
                videoPid = parsePmt(packet.payload)
                break
            }
        }

        val es = collectElementaryStream(buf, start, videoPid)
        if (es.isEmpty()) return null
        val sps = findH264Sps(es) ?: return null
        return parseH264Sps(sps)
    }

    // —— MP4 / fMP4 ——
    private val VISUAL_BOXES = setOf("avc1", "avc3", "hvc1", "hev1", "mp4v", "encv", "dvh1", "dvhe")
    private val CONTAINER_BOXES = mapOf(
        "moov" to 8, "trak" to 8, "mdia" to 8, "minf" to 8, "stbl" to 8, "stsd" to 16,
    )

    private fun readU32(buf: ByteArray, offset: Int): Long =
        ((buf[offset].toLong() and 0xff) shl 24) or
            ((buf[offset + 1].toLong() and 0xff) shl 16) or
            ((buf[offset + 2].toLong() and 0xff) shl 8) or
            (buf[offset + 3].toLong() and 0xff)

    private fun boxType(buf: ByteArray, offset: Int): String = buildString {
        for (i in 0..3) append((buf[offset + i].toInt() and 0xff).toChar())
    }

    /** VisualSampleEntry：载荷偏移 24 处宽高各 16 位 */
    private fun readVisualSampleEntry(buf: ByteArray, boxStart: Int): MediaResolution? {
        val offset = boxStart + 8 + 24
        if (offset + 4 > buf.size) return null
        val width = ((buf[offset].toInt() and 0xff) shl 8) or (buf[offset + 1].toInt() and 0xff)
        val height = ((buf[offset + 2].toInt() and 0xff) shl 8) or (buf[offset + 3].toInt() and 0xff)
        return if (width <= 0 || height <= 0) null else MediaResolution(width, height)
    }

    private fun isPrintableType(type: String): Boolean = type.all { it.code in 0x20..0x7e }

    private fun scanBoxes(buf: ByteArray, from: Int, to: Int): MediaResolution? {
        var p = from
        while (p + 8 <= to) {
            val type = boxType(buf, p + 4)
            if (!isPrintableType(type)) return null
            var size = readU32(buf, p)
            var header = 8L
            if (size == 1L) {
                if (p + 16 > to) return null
                val high = readU32(buf, p + 8)
                val low = readU32(buf, p + 12)
                if (high != 0L) return null
                size = low
                header = 16
            }
            if (size == 0L) size = (to - p).toLong()
            if (size < header || p + size > to) return null
            if (type in VISUAL_BOXES) {
                readVisualSampleEntry(buf, p)?.let { return it }
            }
            val childHeader = CONTAINER_BOXES[type]
            if (childHeader != null) {
                scanBoxes(buf, p + childHeader, (p + size).toInt())?.let { return it }
            }
            p += size.toInt()
        }
        return null
    }

    fun parseMp4VideoResolution(buf: ByteArray): MediaResolution? = scanBoxes(buf, 0, buf.size)

    fun looksLikeMp4(buf: ByteArray): Boolean {
        if (buf.size < 12) return false
        val type = boxType(buf, 4)
        return type == "ftyp" || type == "styp" || type == "moov" || type == "moof"
    }

    /** AES-128-CBC 解密分片前缀（只处理完整 16 字节块，NoPadding） */
    fun decryptAes128CbcPrefix(buf: ByteArray, key: ByteArray, iv: ByteArray): ByteArray {
        val usable = (buf.size / 16) * 16
        if (usable == 0 || key.size < 16 || iv.size < 16) return ByteArray(0)
        return try {
            val cipher = Cipher.getInstance("AES/CBC/NoPadding")
            cipher.init(
                Cipher.DECRYPT_MODE,
                SecretKeySpec(key.copyOfRange(0, 16), "AES"),
                IvParameterSpec(iv.copyOfRange(0, 16)),
            )
            cipher.doFinal(buf, 0, usable)
        } catch (_: Exception) {
            ByteArray(0)
        }
    }
}
