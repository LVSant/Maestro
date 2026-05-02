package maestro.cli.mcp.visualizer

import java.util.concurrent.atomic.AtomicReference

internal data class VisualizerEvent(
    val type: String? = null,
    val payload: Any? = null,
)

internal object McpVisualizerEvents {
    private val publisher = AtomicReference<((VisualizerEvent) -> Unit)?>(null)

    fun register(publish: (VisualizerEvent) -> Unit): AutoCloseable {
        publisher.set(publish)
        return AutoCloseable { publisher.compareAndSet(publish, null) }
    }

    fun publish(event: VisualizerEvent) {
        publisher.get()?.invoke(event)
    }
}
