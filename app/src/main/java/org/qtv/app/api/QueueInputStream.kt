package org.qtv.app.api

import java.io.InputStream
import java.util.concurrent.LinkedBlockingQueue

/**
 * 可增量写入的响应流（NDJSON 逐源推送）。
 *
 * 历史教训（搜索必现闪退的根因）：`LinkedBlockingQueue.put(null)` 是 **NPE**
 * （java.util.concurrent 容器禁止 null），早先用 null 当结束哨兵导致每次
 * `finish()` 在 finally 里炸掉整个进程。现在用**唯一哨兵实例**结束流。
 *
 * WebView 在请求被中止（AbortSignal/切页）时会 close() 本流：close() 以哨兵唤醒
 * 阻塞中的 take()，否则读线程永远挂着（线程泄漏）。
 */
internal class QueueInputStream : InputStream() {

    private val queue = LinkedBlockingQueue<ByteArray>()
    private val closed = java.util.concurrent.atomic.AtomicBoolean(false)
    private var current: ByteArray? = null
    private var pos = 0

    fun offer(b: ByteArray) {
        if (!closed.get() && b !== EOF) queue.put(b)
    }

    /** 结束流：以哨兵唤醒读端；幂等，且绝不 put(null) */
    fun finish() {
        if (closed.compareAndSet(false, true)) {
            try {
                queue.put(EOF)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }
    }

    /** WebView 中止请求时调用：语义同 finish */
    override fun close() = finish()

    override fun read(): Int {
        val one = ByteArray(1)
        val n = read(one, 0, 1)
        return if (n <= 0) -1 else one[0].toInt() and 0xff
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
        // 已到流尾：后续 read 必须立刻 -1。曾经这里的循环条件把 EOF 又送回
        // take()，二次 read 会永久阻塞 —— 表现为「检索中永远不结束」。
        if (current === EOF) return -1
        while (current == null || pos >= (current?.size ?: 0)) {
            val next = try {
                // 30s 看门狗：生产者无论因何原因死亡，消费端也不会永久挂住
                queue.poll(30, java.util.concurrent.TimeUnit.SECONDS)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                return -1
            } ?: return -1
            if (next === EOF) {
                current = EOF
                return -1
            }
            current = next
            pos = 0
        }
        val cur = current!!
        val n = minOf(len, cur.size - pos)
        System.arraycopy(cur, pos, b, off, n)
        pos += n
        return n
    }

    private companion object {
        /** 结束哨兵：用唯一实例而不是 null（并发容器禁止 null） */
        val EOF: ByteArray = ByteArray(0)
    }
}
