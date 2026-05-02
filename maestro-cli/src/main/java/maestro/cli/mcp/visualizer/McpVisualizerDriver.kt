package maestro.cli.mcp.visualizer

import maestro.DeviceInfo
import maestro.Driver
import maestro.KeyCode
import maestro.OnDeviceElementQuery
import maestro.Point
import maestro.ScreenRecording
import maestro.SwipeDirection
import maestro.TreeNode
import maestro.ViewHierarchy
import maestro.device.DeviceOrientation
import okio.Sink
import java.io.File
import java.util.UUID

internal data class McpDeviceContext(
    val platform: String,
    val deviceId: String?,
    val deviceType: String,
) {
    fun payload() = mapOf(
        "platform" to platform,
        "deviceId" to deviceId,
        "deviceType" to deviceType,
    )
}

internal class McpVisualizerDriver(
    private val delegate: Driver,
    private val context: McpDeviceContext,
) : Driver by delegate {

    override fun open() = emitDriverCall("driver.open") {
        delegate.open()
    }

    override fun close() = emitDriverCall("driver.close") {
        delegate.close()
    }

    override fun launchApp(appId: String, launchArguments: Map<String, Any>) =
        emitDriverCall("driver.launch_app", mapOf("appId" to appId)) {
            delegate.launchApp(appId, launchArguments)
        }

    override fun stopApp(appId: String) =
        emitDriverCall("driver.stop_app", mapOf("appId" to appId)) {
            delegate.stopApp(appId)
        }

    override fun killApp(appId: String) =
        emitDriverCall("driver.kill_app", mapOf("appId" to appId)) {
            delegate.killApp(appId)
        }

    override fun tap(point: Point) =
        emitDriverCall("driver.tap", mapOf(
            "point" to point.payload(),
            "screen" to screenPayload(),
        )) {
            delegate.tap(point)
        }

    override fun longPress(point: Point) =
        emitDriverCall("driver.long_press", mapOf("point" to point.toString())) {
            delegate.longPress(point)
        }

    override fun pressKey(code: KeyCode) =
        emitDriverCall("driver.press_key", mapOf("code" to code.toString())) {
            delegate.pressKey(code)
        }

    override fun contentDescriptor(excludeKeyboardElements: Boolean): TreeNode =
        emitDriverCall("driver.content_descriptor", mapOf("excludeKeyboardElements" to excludeKeyboardElements)) {
            delegate.contentDescriptor(excludeKeyboardElements)
        }

    override fun swipe(start: Point, end: Point, durationMs: Long) =
        emitDriverCall("driver.swipe", mapOf(
            "start" to start.payload(),
            "end" to end.payload(),
            "durationMs" to durationMs,
            "screen" to screenPayload(),
        )) {
            delegate.swipe(start, end, durationMs)
        }

    override fun swipe(swipeDirection: SwipeDirection, durationMs: Long) {
        val (start, end) = swipePoints(swipeDirection)
        swipe(start, end, durationMs)
    }

    override fun swipe(elementPoint: Point, direction: SwipeDirection, durationMs: Long) {
        swipe(elementPoint, swipeEndPoint(elementPoint, direction), durationMs)
    }

    override fun backPress() = emitDriverCall("driver.back_press") {
        delegate.backPress()
    }

    override fun inputText(text: String) =
        emitDriverCall("driver.input_text", mapOf("textLength" to text.length)) {
            delegate.inputText(text)
        }

    override fun openLink(link: String, appId: String?, autoVerify: Boolean, browser: Boolean) =
        emitDriverCall("driver.open_link", mapOf(
            "link" to link,
            "appId" to appId,
            "autoVerify" to autoVerify,
            "browser" to browser,
        )) {
            delegate.openLink(link, appId, autoVerify, browser)
        }

    override fun hideKeyboard() = emitDriverCall("driver.hide_keyboard") {
        delegate.hideKeyboard()
    }

    override fun takeScreenshot(out: Sink, compressed: Boolean) =
        emitDriverCall("driver.take_screenshot", mapOf("compressed" to compressed)) {
            delegate.takeScreenshot(out, compressed)
        }

    override fun startScreenRecording(out: Sink): ScreenRecording =
        emitDriverCall("driver.start_screen_recording") {
            delegate.startScreenRecording(out)
        }

    override fun setLocation(latitude: Double, longitude: Double) =
        emitDriverCall("driver.set_location", mapOf("latitude" to latitude, "longitude" to longitude)) {
            delegate.setLocation(latitude, longitude)
        }

    override fun setOrientation(orientation: DeviceOrientation) =
        emitDriverCall("driver.set_orientation", mapOf("orientation" to orientation.toString())) {
            delegate.setOrientation(orientation)
        }

    override fun eraseText(charactersToErase: Int) =
        emitDriverCall("driver.erase_text", mapOf("charactersToErase" to charactersToErase)) {
            delegate.eraseText(charactersToErase)
        }

    override fun waitUntilScreenIsStatic(timeoutMs: Long): Boolean =
        emitDriverCall("driver.wait_until_screen_is_static", mapOf("timeoutMs" to timeoutMs)) {
            delegate.waitUntilScreenIsStatic(timeoutMs)
        }

    override fun waitForAppToSettle(initialHierarchy: ViewHierarchy?, appId: String?, timeoutMs: Int?): ViewHierarchy? =
        emitDriverCall("driver.wait_for_app_to_settle", mapOf("appId" to appId, "timeoutMs" to timeoutMs)) {
            delegate.waitForAppToSettle(initialHierarchy, appId, timeoutMs)
        }

    override fun setPermissions(appId: String, permissions: Map<String, String>) =
        emitDriverCall("driver.set_permissions", mapOf("appId" to appId, "permissions" to permissions.keys.toList())) {
            delegate.setPermissions(appId, permissions)
        }

    override fun addMedia(mediaFiles: List<File>) =
        emitDriverCall("driver.add_media", mapOf("count" to mediaFiles.size)) {
            delegate.addMedia(mediaFiles)
        }

    override fun setAirplaneMode(enabled: Boolean) =
        emitDriverCall("driver.set_airplane_mode", mapOf("enabled" to enabled)) {
            delegate.setAirplaneMode(enabled)
        }

    override fun setAndroidChromeDevToolsEnabled(enabled: Boolean) =
        emitDriverCall("driver.set_android_chrome_devtools_enabled", mapOf("enabled" to enabled)) {
            delegate.setAndroidChromeDevToolsEnabled(enabled)
        }

    override fun queryOnDeviceElements(query: OnDeviceElementQuery): List<TreeNode> =
        emitDriverCall("driver.query_on_device_elements", mapOf("query" to query.toString())) {
            delegate.queryOnDeviceElements(query)
        }

    override fun deviceInfo(): DeviceInfo =
        emitDriverCall("driver.device_info") {
            delegate.deviceInfo()
        }

    private fun <T> emitDriverCall(
        name: String,
        payload: Map<String, Any?> = emptyMap(),
        call: () -> T,
    ): T {
        val callId = UUID.randomUUID().toString()
        publishDriverEvent(callId, name, "started", payload)
        return try {
            val result = call()
            publishDriverEvent(callId, name, "completed", payload)
            result
        } catch (error: Throwable) {
            publishDriverEvent(callId, name, "failed", payload + ("message" to (error.message ?: error.toString())))
            throw error
        }
    }

    private fun publishDriverEvent(
        callId: String,
        name: String,
        status: String,
        payload: Map<String, Any?>,
    ) {
        McpVisualizerEvents.publish(
            VisualizerEvent(
                type = name,
                source = "driver",
                title = name.removePrefix("driver.").replace('_', ' '),
                status = status,
                payload = payload + context.payload() + mapOf(
                    "callId" to callId,
                ),
            )
        )
    }

    private fun swipePoints(direction: SwipeDirection): Pair<Point, Point> {
        val deviceInfo = delegate.deviceInfo()
        val width = deviceInfo.widthGrid
        val height = deviceInfo.heightGrid
        val upStartY = if (context.platform == "android") 0.5.asPercentOf(height) else 0.9.asPercentOf(height)

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
        val deviceInfo = delegate.deviceInfo()
        val width = deviceInfo.widthGrid
        val height = deviceInfo.heightGrid

        return when (direction) {
            SwipeDirection.UP -> Point(start.x, 0.1.asPercentOf(height))
            SwipeDirection.DOWN -> Point(start.x, 0.9.asPercentOf(height))
            SwipeDirection.RIGHT -> Point(0.9.asPercentOf(width), start.y)
            SwipeDirection.LEFT -> Point(0.1.asPercentOf(width), start.y)
        }
    }

    private fun Double.asPercentOf(total: Int): Int {
        return (this * total).toInt()
    }

    private fun Point.payload(): Map<String, Int> {
        return mapOf("x" to x, "y" to y)
    }

    private fun screenPayload(): Map<String, Int>? {
        return runCatching {
            val deviceInfo = delegate.deviceInfo()
            mapOf(
                "width" to deviceInfo.widthGrid,
                "height" to deviceInfo.heightGrid,
            )
        }.getOrNull()
    }
}
