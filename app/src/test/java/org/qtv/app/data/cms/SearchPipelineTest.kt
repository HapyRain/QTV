package org.qtv.app.data.cms

import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.qtv.app.core.network.NetClient

/**
 * 搜索管线端到端（JVM 层，裸 ServerSocket 模拟采集站）。
 * 把「卡住/闪退」类根因（无上限整读、慢滴源拖死、解析崩溃）在 JVM 上锁死。
 */
class SearchPipelineTest {

    /** 极简 HTTP 服务：每连接一线程，按 responder 写响应 */
    private fun startServer(responder: (Socket) -> Unit): ServerSocket {
        val ss = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        Thread {
            try {
                while (true) {
                    val sock = ss.accept()
                    Thread {
                        try { responder(sock) } catch (_: Exception) {}
                        try { sock.close() } catch (_: Exception) {}
                    }.start()
                }
            } catch (_: Exception) { /* 服务关闭 */ }
        }.start()
        return ss
    }

    private fun respondFull(sock: Socket, bytes: ByteArray) {
        val head = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n"
        sock.getOutputStream().apply { write(head.toByteArray()); write(bytes); flush() }
    }

    @Test
    fun `正常 CMS 响应端到端结算`() {
        val payload = """{"code":1,"pagecount":1,"list":[
            {"vod_id":1,"vod_name":"庆余年 第二季","vod_year":"2024","type_name":"国产剧","vod_remarks":"全36集"},
            {"vod_id":2,"vod_name":"无关影片","vod_year":"2023","type_name":"电影"}
        ]}""".toByteArray()
        val ss = startServer { respondFull(it, payload) }
        try {
            val src = SourceConfig("t1", "测试源", "http://127.0.0.1:${ss.localPort}/api.php/provide/vod")
            val outcomes = ArrayList<SourceOutcome>()
            val final = runBlocking {
                SearchRepository.search("庆余年", listOf(src), true) { outcomes.add(it) }
            }
            assertEquals(1, outcomes.size)
            assertTrue(outcomes[0].ok)
            assertEquals(listOf("庆余年 第二季"), final.list.map { it.name }) // 无关影片被相关性过滤
        } finally { ss.close() }
    }

    @Test
    fun `慢滴响应被总死线截断且不挂死`() {
        val ss = startServer { sock ->
            val out = sock.getOutputStream()
            out.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n".toByteArray())
            repeat(200) { out.write("x".toByteArray()); out.flush(); Thread.sleep(50) }
        }
        try {
            val t0 = System.currentTimeMillis()
            val r = NetClient.getText("http://127.0.0.1:${ss.localPort}/slow", deadlineMs = 600, maxBytes = 1024)
            val elapsed = System.currentTimeMillis() - t0
            assertTrue("应在 3s 内截断返回，实测 ${elapsed}ms", elapsed < 3000)
            assertNotNull(r)
        } finally { ss.close() }
    }

    @Test
    fun `超大响应被体积上限截断`() {
        val big = ByteArray(2_000_000) { 'A'.code.toByte() }
        val ss = startServer { respondFull(it, big) }
        try {
            val r = NetClient.getText("http://127.0.0.1:${ss.localPort}/big", maxBytes = 100 * 1024, deadlineMs = 5000)
            assertNotNull(r)
            assertTrue("截断后不应超过上限+缓冲块，实测 ${r!!.first.length}", r.first.length <= 100 * 1024 + 8192)
        } finally { ss.close() }
    }
}
