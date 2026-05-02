package maestro.cli.mcp.visualizer

import maestro.Driver
import maestro.Point
import maestro.SwipeDirection

// Wraps a Driver to publish the spatial events the visualizer overlays consume:
// tap (dot), swipe (arrow), inputText (text length pill). Every other Driver
// method passes through untouched — they are not visualized.
internal class McpVisualizerDriver(
    private val delegate: Driver,
    private val platform: String,
) : Driver by delegate {

    private val screenDimensions: Pair<Int, Int> by lazy {
        val info = delegate.deviceInfo()
        info.widthGrid to info.heightGrid
    }

    private val screenPayload: Map<String, Int> by lazy {
        mapOf("width" to screenDimensions.first, "height" to screenDimensions.second)
    }

    override fun tap(point: Point) =
        emit("driver.tap", mapOf("point" to point.payload(), "screen" to screenPayload)) {
            delegate.tap(point)
        }

    override fun swipe(start: Point, end: Point, durationMs: Long) =
        emit(
            "driver.swipe",
            mapOf(
                "start" to start.payload(),
                "end" to end.payload(),
                "durationMs" to durationMs,
                "screen" to screenPayload,
            ),
        ) {
            delegate.swipe(start, end, durationMs)
        }

    override fun swipe(swipeDirection: SwipeDirection, durationMs: Long) {
        val (start, end) = swipePoints(swipeDirection)
        swipe(start, end, durationMs)
    }

    override fun swipe(elementPoint: Point, direction: SwipeDirection, durationMs: Long) {
        swipe(elementPoint, swipeEndPoint(elementPoint, direction), durationMs)
    }

    override fun inputText(text: String) =
        emit("driver.input_text", mapOf("textLength" to text.length)) {
            delegate.inputText(text)
        }

    private fun <T> emit(type: String, payload: Map<String, Any?>, call: () -> T): T {
        publish(type, "started", payload)
        return try {
            val result = call()
            publish(type, "completed", payload)
            result
        } catch (error: Throwable) {
            publish(type, "failed", payload + ("message" to (error.message ?: error.toString())))
            throw error
        }
    }

    private fun publish(type: String, status: String, payload: Map<String, Any?>) {
        McpVisualizerEvents.publish(
            VisualizerEvent(type = type, payload = payload + ("status" to status))
        )
    }

    private fun swipePoints(direction: SwipeDirection): Pair<Point, Point> {
        val (width, height) = screenDimensions
        val upStartY = if (platform == "android") 0.5.asPercentOf(height) else 0.9.asPercentOf(height)
        return when (direction) {
            SwipeDirection.UP -> Point(0.5.asPercentOf(width), upStartY) to
                Point(0.5.asPercentOf(width), 0.1.asPercentOf(height))
            SwipeDirection.DOWN -> Point(0.5.asPercentOf(width), 0.2.asPercentOf(height)) to
                Point(0.5.asPercentOf(width), 0.9.asPercentOf(height))
            SwipeDirection.RIGHT -> Point(0.1.asPercentOf(width), 0.5.asPercentOf(height)) to
                Point(0.9.asPercentOf(width), 0.5.asPercentOf(height))
            SwipeDirection.LEFT -> Point(0.9.asPercentOf(width), 0.5.asPercentOf(height)) to
                Point(0.1.asPercentOf(width), 0.5.asPercentOf(height))
        }
    }

    private fun swipeEndPoint(start: Point, direction: SwipeDirection): Point {
        val (width, height) = screenDimensions
        return when (direction) {
            SwipeDirection.UP -> Point(start.x, 0.1.asPercentOf(height))
            SwipeDirection.DOWN -> Point(start.x, 0.9.asPercentOf(height))
            SwipeDirection.RIGHT -> Point(0.9.asPercentOf(width), start.y)
            SwipeDirection.LEFT -> Point(0.1.asPercentOf(width), start.y)
        }
    }

    private fun Double.asPercentOf(total: Int): Int = (this * total).toInt()

    private fun Point.payload(): Map<String, Int> = mapOf("x" to x, "y" to y)
}
