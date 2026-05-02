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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import maestro.cli.Dependencies
import maestro.cli.util.getFreePort
import maestro.device.DeviceService
import maestro.device.Platform
import java.io.BufferedReader
import java.io.InputStreamReader
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.collections.get

internal class McpVisualizerServerHandle(
    val server: ApplicationEngine,
    val port: Int,
    private val closeStream: () -> Unit,
) : AutoCloseable {
    override fun close() {
        closeStream()
        server.stop(0, 0)
    }
}

private data class DeviceStreamStartRequest(
    val platform: String? = null,
    val deviceId: String? = null,
)

private data class DeviceStreamState(
    val status: String,
    val platform: String? = null,
    val deviceId: String? = null,
    val streamUrl: String? = null,
    val message: String? = null,
)

private data class DeviceStreamTarget(
    val platform: String,
    val deviceId: String,
)

private const val SIMULATOR_OUTPUT_TAIL_CAPACITY = 4096

internal fun startMcpVisualizerServer(port: Int? = null): McpVisualizerServerHandle {
    val selectedPort = port ?: getFreePort()
    val mapper = jacksonObjectMapper()
    val visualizerScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    val events = SseBroadcaster(name = "events", mapper = mapper, scope = visualizerScope)
    val deviceStates = SseBroadcaster(name = "device-state", mapper = mapper, scope = visualizerScope)
    val httpClient = HttpClient(CIO) {
        install(HttpTimeout) {
            requestTimeoutMillis = HttpTimeout.INFINITE_TIMEOUT_MS
            socketTimeoutMillis = HttpTimeout.INFINITE_TIMEOUT_MS
            connectTimeoutMillis = 10_000
        }
    }

    var deviceState = DeviceStreamState(status = "idle")
    var deviceProcess: Process? = null

    suspend fun ApplicationCall.respondJson(value: Any, status: HttpStatusCode = HttpStatusCode.OK) {
        respondText(mapper.writeValueAsString(value), ContentType.Application.Json, status)
    }

    suspend fun setDeviceState(next: DeviceStreamState) {
        deviceState = next
        deviceStates.publish(next)
    }

    fun stopDeviceProcess() {
        val process = deviceProcess ?: return
        process.destroy()
        if (!process.waitFor(2, TimeUnit.SECONDS)) {
            process.destroyForcibly()
        }
        deviceProcess = null
    }

    suspend fun startDeviceStream(platform: String, deviceId: String): DeviceStreamState {
        val current = deviceState
        if (
            current.platform == platform &&
            current.deviceId == deviceId &&
            (current.status == "starting" || current.status == "streaming")
        ) {
            return current
        }

        stopDeviceProcess()
        setDeviceState(DeviceStreamState(status = "starting", platform = platform, deviceId = deviceId))

        runCatching {
            Dependencies.installSimulatorServer()
            val process = ProcessBuilder(
                Dependencies.simulatorServerBinary().absolutePath,
                platform,
                "--id",
                deviceId,
            )
                .redirectErrorStream(true)
                .start()
            deviceProcess = process
            val streamUrl = awaitStreamReady(process)
            setDeviceState(DeviceStreamState(
                status = "streaming",
                platform = platform,
                deviceId = deviceId,
                streamUrl = streamUrl,
            ))
        }.onFailure { error ->
            stopDeviceProcess()
            setDeviceState(DeviceStreamState(
                status = "error",
                platform = platform,
                deviceId = deviceId,
                message = error.message ?: error.toString(),
            ))
        }

        return deviceState
    }

    fun deviceStreamTargets(): List<DeviceStreamTarget> {
        return DeviceService.listConnectedDevices()
            .filter { it.platform != Platform.WEB }
            .map {
                DeviceStreamTarget(
                    platform = it.platform.name.lowercase(),
                    deviceId = it.instanceId,
                )
            }
    }

    val eventRegistration = McpVisualizerEvents.register { event ->
        visualizerScope.launch {
            events.publish(event)
            event.deviceStreamTarget()?.let { (platform, deviceId) ->
                startDeviceStream(platform, deviceId)
            }
        }
    }

    val server = embeddedServer(
        factory = Netty,
        configure = {
            shutdownTimeout = 0
            shutdownGracePeriod = 0
        },
        port = selectedPort,
        host = "127.0.0.1",
    ) {
        routing {
            get("/") {
                call.respondText(readVisualizerHtml(), ContentType.Text.Html)
            }
            get("/mcp-visualizer") {
                call.respondText(readVisualizerHtml(), ContentType.Text.Html)
            }
            get("/api/health") {
                call.respondJson(mapOf("ok" to true))
            }
            post("/api/events") {
                // Keep event ingestion narrow for now. Kotlin callers can use this
                // same local route until we know where driver-level events should hook in.
                val input = runCatching { mapper.readValue<VisualizerEvent>(call.receiveText()) }
                    .getOrDefault(VisualizerEvent())
                call.respondJson(McpVisualizerEvents.publish(input))
            }
            get("/api/events/stream") {
                events.stream(call, VisualizerEvent(type = "visualizer.connected"))
            }
            get("/api/device") {
                call.respondJson(deviceState)
            }
            get("/api/device/targets") {
                call.respondJson(mapOf("devices" to deviceStreamTargets()))
            }
            get("/api/device/state") {
                deviceStates.stream(call, deviceState)
            }
            post("/api/device/start") {
                val request = runCatching { mapper.readValue<DeviceStreamStartRequest>(call.receiveText()) }
                    .getOrDefault(DeviceStreamStartRequest())
                val platform = request.platform
                val deviceId = request.deviceId
                if (platform.isNullOrBlank() || deviceId.isNullOrBlank()) {
                    call.respondJson(mapOf("error" to "platform and deviceId are required"), HttpStatusCode.BadRequest)
                    return@post
                }

                call.respondJson(startDeviceStream(platform, deviceId))
            }
            post("/api/device/stop") {
                stopDeviceProcess()
                setDeviceState(DeviceStreamState(status = "idle"))
                call.respondJson(deviceState)
            }
            get("/api/device/stream") {
                val streamUrl = deviceState.streamUrl
                if (deviceState.status != "streaming" || streamUrl == null) {
                    call.respondJson(deviceState, HttpStatusCode.Conflict)
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

    println("mcp_visualizer_ready http://127.0.0.1:$selectedPort")

    return McpVisualizerServerHandle(server, selectedPort) {
        eventRegistration.close()
        visualizerScope.cancel()
        stopDeviceProcess()
        httpClient.close()
    }
}

private fun VisualizerEvent.deviceStreamTarget(): DeviceStreamTarget? {
    if (type != "maestro.connected") return null
    val payload = payload as? Map<*, *> ?: return null
    val platform = (payload["platform"] as? String)?.lowercase()?.takeIf { it.isNotBlank() } ?: return null
    val deviceId = (payload["deviceId"] as? String)?.takeIf { it.isNotBlank() } ?: return null
    if (platform == "web") return null
    return DeviceStreamTarget(platform = platform, deviceId = deviceId)
}

private fun readVisualizerHtml(): String {
    return McpVisualizerServerHandle::class.java
        .getResource("/mcp-visualizer/index.html")
        ?.readText()
        ?: """
            <!doctype html>
            <html>
              <body>
                <p>Maestro MCP visualizer resource was not found. Build the CLI resources first.</p>
              </body>
            </html>
        """.trimIndent()
}

private fun awaitStreamReady(process: Process): String {
    val reader = BufferedReader(InputStreamReader(process.inputStream))
    val outputTail = StringBuilder()
    val deadline = System.currentTimeMillis() + 30_000
    while (System.currentTimeMillis() < deadline) {
        val line = reader.readLine() ?: run {
            process.waitFor(500, TimeUnit.MILLISECONDS)
            error("simulator-server exited before announcing stream_ready${outputTail.suffix()}")
        }
        System.err.println("[simulator-server] $line")
        if (line.startsWith("stream_ready ")) {
            drainInBackground(reader, "mcp-visualizer-simulator-stdout") {
                System.err.println("[simulator-server] $it")
            }
            return line.removePrefix("stream_ready ").trim()
        }
        outputTail.appendTail(line)
    }
    error("simulator-server did not announce stream_ready within 30s${outputTail.suffix()}")
}

private fun drainInBackground(reader: BufferedReader, name: String, onLine: (String) -> Unit) {
    Thread({
        runCatching { reader.forEachLine(onLine) }
    }, name).apply { isDaemon = true }.start()
}

private fun StringBuilder.appendTail(line: String) {
    append(line).append('\n')
    if (length > SIMULATOR_OUTPUT_TAIL_CAPACITY) {
        delete(0, length - SIMULATOR_OUTPUT_TAIL_CAPACITY)
    }
}

private fun StringBuilder.suffix(): String {
    val tail = toString().trim()
    return if (tail.isEmpty()) "" else ". simulator-server output:\n$tail"
}

private class SseBroadcaster(
    private val name: String,
    private val mapper: ObjectMapper,
    private val scope: CoroutineScope,
) {
    private data class SseClient(
        val id: Int,
        val channel: ByteWriteChannel,
        val mutex: Mutex = Mutex(),
    )

    private val clients = CopyOnWriteArrayList<SseClient>()
    private val nextClientId = AtomicInteger(1)

    suspend fun publish(value: Any) {
        val message = "data: ${mapper.writeValueAsString(value)}\n\n"
        val snapshot = clients.toList()
        snapshot.forEach { client ->
            val failed = runCatching {
                client.write(message)
            }.onFailure { error ->
                System.err.println("[mcp-visualizer][$name] client=${client.id} write failed: ${error.message ?: error}")
            }.isFailure
            if (failed) clients.remove(client)
        }
    }

    suspend fun stream(call: ApplicationCall, initialValue: Any) {
        call.respondBytesWriter(contentType = ContentType.Text.EventStream) {
            val client = SseClient(nextClientId.getAndIncrement(), this)
            clients.add(client)
            System.err.println("[mcp-visualizer][$name] client=${client.id} connected clients=${clients.size}")
            val heartbeat = scope.launch {
                while (true) {
                    delay(5_000)
                    val failed = runCatching {
                        client.write(": heartbeat ${Instant.now()}\n\n")
                    }.onFailure { error ->
                        System.err.println("[mcp-visualizer][$name] client=${client.id} heartbeat failed: ${error.message ?: error}")
                    }.isFailure
                    if (failed) {
                        clients.remove(client)
                        break
                    }
                }
            }
            try {
                client.write("data: ${mapper.writeValueAsString(initialValue)}\n\n")
                awaitCancellation()
            } finally {
                heartbeat.cancel()
                clients.remove(client)
                System.err.println("[mcp-visualizer][$name] client=${client.id} disconnected clients=${clients.size}")
            }
        }
    }

    private suspend fun SseClient.write(message: String) {
        mutex.withLock {
            channel.writeStringUtf8(message)
            channel.flush()
        }
    }

}
