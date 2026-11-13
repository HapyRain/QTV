package org.qtv.app.api

import java.io.ByteArrayOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 回归：结束哨兵曾用 null（LinkedBlockingQueue 禁止）→ 每次 finish() 必 NPE 杀进程 */
class QueueInputStreamTest {

    private fun readAll(q: QueueInputStream): String {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(64)
        while (true) {
            val n = q.read(buf, 0, buf.size)
            if (n < 0) break
            out.write(buf, 0, n)
        }
        return out.toString(Charsets.UTF_8)
    }

    @Test
    fun `finish 不抛 NPE 并正常读到 EOF`() {
        val q = QueueInputStream()
        q.offer("hello ".toByteArray())
        q.offer("world".toByteArray())
        q.finish()
        q.finish() // 幂等
        assertEquals("hello world", readAll(q))
    }

    @Test
    fun `close 唤醒并结束流`() {
        val q = QueueInputStream()
        q.offer("ab".toByteArray())
        q.close()
        val b = ByteArray(4)
        assertEquals(2, q.read(b, 0, 4))   // 先读出 'ab'
        assertEquals(-1, q.read(b, 0, 4))  // close 后 EOF
    }

    @Test
    fun `close 后 offer 被忽略`() {
        val q = QueueInputStream()
        q.finish()
        q.offer("late".toByteArray())
        assertEquals(-1, q.read(ByteArray(4), 0, 4))
    }

    @Test
    fun `单字节与分块读取一致`() {
        val q = QueueInputStream()
        q.offer("xyz".toByteArray())
        q.finish()
        assertEquals('x'.code, q.read())
        val b = ByteArray(4)
        val n = q.read(b, 0, 4)
        assertEquals(2, n)
        assertEquals('y', b[0].toInt().toChar())
        assertEquals('z', b[1].toInt().toChar())
        assertEquals(-1, q.read(b, 0, 4))
    }

    @Test
    fun `EOF 后再次 read 立即返回而不是永久阻塞`() {
        val q = QueueInputStream()
        q.offer("a".toByteArray())
        q.finish()
        val b = ByteArray(4)
        assertEquals(1, q.read(b, 0, 4))
        assertEquals(-1, q.read(b, 0, 4))
        // 关键回归：二次/三次 read 不许再进阻塞等待（曾导致「检索中永不结束」）
        assertEquals(-1, q.read(b, 0, 4))
        assertEquals(-1, q.read())
    }
    @Test
    fun `空块不会死循环`() {
        val q = QueueInputStream()
        q.offer(ByteArray(0))
        q.offer("ok".toByteArray())
        q.finish()
        assertEquals("ok", readAll(q))
    }
}
