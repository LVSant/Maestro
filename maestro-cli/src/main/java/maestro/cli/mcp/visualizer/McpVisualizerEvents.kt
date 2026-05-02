package maestro.cli.mcp.visualizer

import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

internal data class VisualizerEvent(
    val id: String? = null,
    val type: String? = null,
    val source: String? = null,
    val title: String? = null,
    val status: String? = null,
    val timestamp: String? = null,
    val detail: String? = null,
    val payload: Any? = null,
)

internal object McpVisualizerEvents {
    private val publisher = AtomicReference<((VisualizerEvent) -> Unit)?>(null)

    fun register(publish: (VisualizerEvent) -> Unit): AutoCloseable {
        publisher.set(publish)
        return AutoCloseable { publisher.compareAndSet(publish, null) }
    }

    fun publish(event: VisualizerEvent): VisualizerEvent {
        val normalized = event.withDefaults()
        publisher.get()?.invoke(normalized)
        return normalized
    }

    private fun VisualizerEvent.withDefaults(): VisualizerEvent = copy(
        id = id ?: UUID.randomUUID().toString(),
        type = type ?: "event",
        status = status ?: "info",
        timestamp = timestamp ?: Instant.now().toString(),
    )
}
