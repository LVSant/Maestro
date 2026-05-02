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

    private val screen: Screen? by lazy { runCatching { Screen(screenDimensions.first, screenDimensions.second) }.getOrNull() }

    override fun tap(point: Point) = emit({ status ->
        VisualizerEvent.Tap(status = status, point = point.toPoint2D(), screen = screen)
    }) {
        delegate.tap(point)
    }

    override fun swipe(start: Point, end: Point, durationMs: Long) = emit({ status ->
        VisualizerEvent.Swipe(
            status = status,
            start = start.toPoint2D(),
            end = end.toPoint2D(),
            durationMs = durationMs,
            screen = screen,
        )
    }) {
        delegate.swipe(start, end, durationMs)
    }

    override fun swipe(swipeDirection: SwipeDirection, durationMs: Long) {
        val (start, end) = swipePoints(swipeDirection)
        swipe(start, end, durationMs)
    }

    override fun swipe(elementPoint: Point, direction: SwipeDirection, durationMs: Long) {
        swipe(elementPoint, swipeEndPoint(elementPoint, direction), durationMs)
    }

    override fun inputText(text: String) = emit({ status ->
        VisualizerEvent.InputText(status = status, textLength = text.length)
    }) {
        delegate.inputText(text)
    }

    private fun <T> emit(buildEvent: (DriverStatus) -> VisualizerEvent, call: () -> T): T {
        McpVisualizerEvents.publish(buildEvent(DriverStatus.STARTED))
        return try {
            val result = call()
            McpVisualizerEvents.publish(buildEvent(DriverStatus.COMPLETED))
            result
        } catch (error: Throwable) {
            McpVisualizerEvents.publish(buildEvent(DriverStatus.FAILED))
            throw error
        }
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

    private fun Point.toPoint2D(): Point2D = Point2D(x, y)
}
