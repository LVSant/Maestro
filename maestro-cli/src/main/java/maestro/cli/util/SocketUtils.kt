package maestro.cli.util

import java.net.InetSocketAddress
import java.net.ServerSocket

/**
 * Picks a free TCP port. The probe binds to [host] so the discovered port is actually free for
 * the family/interface the caller will bind to — matters because IPv4-only listeners can hide
 * from an IPv6-or-dual-stack probe (and vice versa).
 *
 * Prefers the 9999..11000 range so users see stable URLs across restarts when possible, and falls
 * back to an OS-picked ephemeral port if every port in the range is taken.
 */
fun getFreePort(host: String? = null): Int {
    (9999..11000).forEach { probe(host, it)?.let { port -> return port } }
    return probe(host, 0) ?: error("Could not find a free port")
}

private fun probe(host: String?, port: Int): Int? = try {
    if (host == null) ServerSocket(port).use { it.localPort }
    else ServerSocket().use { socket ->
        socket.bind(InetSocketAddress(host, port))
        socket.localPort
    }
} catch (_: Exception) {
    null
}
