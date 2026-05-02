package maestro.cli.mcp.visualizer

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.request.prepareGet
import io.ktor.client.statement.bodyAsChannel
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.call
import io.ktor.server.engine.ApplicationEngine
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.request.receiveText
import io.ktor.server.response.respondBytesWriter
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import io.ktor.utils.io.ByteWriteChannel
import io.ktor.utils.io.copyAndClose
import io.ktor.utils.io.writeStringUtf8
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import maestro.cli.Dependencies
import maestro.cli.util.getFreePort
import maestro.device.DeviceService
import maestro.device.Platform
import java.io.BufferedReader
import java.io.InputStreamReader
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

internal data class DeviceStreamState(
    val status: String,
    val platform: String? = null,
    val deviceId: String? = null,
    val streamUrl: String? = null,
    val message: String? = null,
)

private data class DeviceStreamTarget(val platform: String, val deviceId: String)

internal class McpVisualizerServer private constructor(
    val port: Int,
    private val server: ApplicationEngine,
    private val scope: CoroutineScope,
    private val deviceStream: DeviceStream,
    private val httpClient: HttpClient,
    private val eventRegistration: AutoCloseable,
) : AutoCloseable {

    override fun close() {
        eventRegistration.close()
        scope.cancel()
        deviceStream.close()
        httpClient.close()
        server.stop(0, 0)
    }

    companion object {
        private fun readVisualizerHtml(): String =
            McpVisualizerServer::class.java.getResource("/mcp-visualizer/index.html")?.readText()
                ?: "<!doctype html><p>Visualizer resource missing — build the CLI first.</p>"

        fun start(port: Int? = null): McpVisualizerServer {
            val resolvedPort = port ?: getFreePort(host = "127.0.0.1")
            val mapper = jacksonObjectMapper()
            val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
            val events = SseBroadcaster(mapper)
            val deviceStates = SseBroadcaster(mapper)
            val deviceStream = DeviceStream(onStateChange = { deviceStates.publish(it) })
            val httpClient = HttpClient(CIO) {
                install(HttpTimeout) {
                    requestTimeoutMillis = HttpTimeout.INFINITE_TIMEOUT_MS
                    socketTimeoutMillis = HttpTimeout.INFINITE_TIMEOUT_MS
                    connectTimeoutMillis = 10_000
                }
            }

            suspend fun ApplicationCall.respondJson(value: Any, status: HttpStatusCode = HttpStatusCode.OK) {
                respondText(mapper.writeValueAsString(value), ContentType.Application.Json, status)
            }

            fun deviceStreamTargets(): List<DeviceStreamTarget> =
                DeviceService.listConnectedDevices()
                    .filter { it.platform != Platform.WEB }
                    .map { DeviceStreamTarget(it.platform.name.lowercase(), it.instanceId) }

            val eventRegistration = McpVisualizerEvents.register { event ->
                scope.launch {
                    events.publish(event)
                    if (event is VisualizerEvent.MaestroConnected && event.platform != "web") {
                        deviceStream.start(event.platform, event.deviceId)
                    }
                }
            }

            val server = embeddedServer(
                port = resolvedPort,
                factory = Netty,
                configure = { shutdownTimeout = 0; shutdownGracePeriod = 0 },
                host = "127.0.0.1",
            ) {
                routing {
                    get("/") { call.respondText(readVisualizerHtml(), ContentType.Text.Html) }
                    get("/api/events/stream") { events.stream(call, VisualizerEvent.VisualizerConnected) }
                    get("/api/device/state") { deviceStates.stream(call, deviceStream.state) }
                    get("/api/device/targets") { call.respondJson(mapOf("devices" to deviceStreamTargets())) }
                    post("/api/device/start") {
                        data class Request(val platform: String? = null, val deviceId: String? = null)
                        val request = runCatching { mapper.readValue<Request>(call.receiveText()) }.getOrNull()
                        val platform = request?.platform
                        val deviceId = request?.deviceId
                        if (platform.isNullOrBlank() || deviceId.isNullOrBlank()) {
                            call.respondJson(mapOf("error" to "platform and deviceId are required"), HttpStatusCode.BadRequest)
                            return@post
                        }
                        call.respondJson(deviceStream.start(platform, deviceId))
                    }
                    get("/api/device/stream") {
                        val state = deviceStream.state
                        val streamUrl = state.streamUrl
                        if (state.status != "streaming" || streamUrl == null) {
                            call.respondJson(state, HttpStatusCode.Conflict)
                            return@get
                        }
                        httpClient.prepareGet(streamUrl).execute { response ->
                            val contentType = response.headers["Content-Type"]?.let { ContentType.parse(it) }
                                ?: ContentType.Application.OctetStream
                            call.respondBytesWriter(contentType = contentType, status = HttpStatusCode.OK) {
                                response.bodyAsChannel().copyAndClose(this)
                            }
                        }
                    }
                }
            }.start(wait = false)

            System.err.println("mcp_visualizer_ready http://127.0.0.1:$resolvedPort")

            return McpVisualizerServer(
                port = resolvedPort,
                server = server,
                scope = scope,
                deviceStream = deviceStream,
                httpClient = httpClient,
                eventRegistration = eventRegistration,
            )
        }
    }
}

private class DeviceStream(
    private val onStateChange: suspend (DeviceStreamState) -> Unit,
) : AutoCloseable {
    private var process: Process? = null

    @Volatile
    var state: DeviceStreamState = DeviceStreamState(status = "idle")
        private set

    suspend fun start(platform: String, deviceId: String): DeviceStreamState {
        val current = state
        if (current.platform == platform && current.deviceId == deviceId &&
            (current.status == "starting" || current.status == "streaming")) {
            return current
        }

        close()
        setState(DeviceStreamState(status = "starting", platform = platform, deviceId = deviceId))

        runCatching {
            Dependencies.installSimulatorServer()
            val p = ProcessBuilder(
                Dependencies.simulatorServerBinary().absolutePath,
                platform, "--id", deviceId,
            ).redirectErrorStream(true).start()
            process = p
            val streamUrl = awaitStreamReady(p)
            setState(DeviceStreamState(
                status = "streaming",
                platform = platform,
                deviceId = deviceId,
                streamUrl = streamUrl,
            ))
        }.onFailure { error ->
            close()
            setState(DeviceStreamState(
                status = "error",
                platform = platform,
                deviceId = deviceId,
                message = error.message ?: error.toString(),
            ))
        }

        return state
    }

    override fun close() {
        val p = process ?: return
        p.destroy()
        if (!p.waitFor(2, TimeUnit.SECONDS)) p.destroyForcibly()
        process = null
    }

    private suspend fun setState(next: DeviceStreamState) {
        state = next
        onStateChange(next)
    }

    private fun awaitStreamReady(process: Process): String {
        val reader = BufferedReader(InputStreamReader(process.inputStream))
        val deadline = System.currentTimeMillis() + 30_000
        while (System.currentTimeMillis() < deadline) {
            val line = reader.readLine() ?: error("simulator-server exited before announcing stream_ready")
            System.err.println("[simulator-server] $line")
            if (line.startsWith("stream_ready ")) {
                // Drain the rest in the background so the child's stdout pipe doesn't block.
                Thread { runCatching { reader.forEachLine { System.err.println("[simulator-server] $it") } } }
                    .apply { isDaemon = true }.start()
                return line.removePrefix("stream_ready ").trim()
            }
        }
        error("simulator-server did not announce stream_ready within 30s")
    }
}

private class SseBroadcaster(private val mapper: ObjectMapper) {
    private val clients = CopyOnWriteArrayList<SseClient>()

    suspend fun publish(value: Any) {
        val message = "data: ${mapper.writeValueAsString(value)}\n\n"
        clients.toList().forEach { client ->
            try {
                client.write(message)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                RuntimeException("Error writing SSE message", e).also { e.printStackTrace() }
                clients.remove(client)
            }
        }
    }

    suspend fun stream(call: ApplicationCall, initialValue: Any) {
        call.respondBytesWriter(contentType = ContentType.Text.EventStream) {
            val client = SseClient(this)
            clients.add(client)
            try {
                client.write("data: ${mapper.writeValueAsString(initialValue)}\n\n")
                awaitCancellation()
            } finally {
                clients.remove(client)
            }
        }
    }
}

private class SseClient(private val channel: ByteWriteChannel) {
    private val mutex = Mutex()

    suspend fun write(message: String) {
        mutex.withLock {
            channel.writeStringUtf8(message)
            channel.flush()
        }
    }
}
