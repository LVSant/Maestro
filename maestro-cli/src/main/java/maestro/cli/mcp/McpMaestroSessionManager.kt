package maestro.cli.mcp

import dadb.Dadb
import device.SimctlIOSDevice
import ios.xctest.XCTestIOSDevice
import maestro.Maestro
import maestro.cli.CliError
import maestro.cli.mcp.visualizer.McpDeviceContext
import maestro.cli.mcp.visualizer.McpVisualizerDriver
import maestro.cli.mcp.visualizer.McpVisualizerEvents
import maestro.cli.mcp.visualizer.VisualizerEvent
import maestro.device.DeviceService
import maestro.device.Device
import maestro.device.Platform
import maestro.drivers.AndroidDriver
import maestro.drivers.CdpWebDriver
import maestro.drivers.IOSDriver
import maestro.utils.CliInsights
import maestro.utils.TempFileHandler
import util.IOSDeviceType
import util.XCRunnerCLIUtils
import xcuitest.XCTestClient
import xcuitest.XCTestDriverClient
import xcuitest.installer.Context
import xcuitest.installer.LocalXCTestInstaller
import xcuitest.installer.LocalXCTestInstaller.IOSDriverConfig
import java.util.concurrent.ConcurrentHashMap

internal class McpMaestroSessionManager : AutoCloseable {
    private val sessions = ConcurrentHashMap<String, McpMaestroSession>()

    fun <T> withSession(
        deviceId: String,
        block: (McpMaestroSession) -> T,
    ): T {
        val session = sessions.computeIfAbsent(deviceId) {
            createSession(deviceId).also { publishConnected(it.context) }
        }
        return block(session)
    }

    override fun close() {
        sessions.values.forEach { session ->
            runCatching { session.close() }
        }
        sessions.clear()
    }

    private fun createSession(deviceId: String): McpMaestroSession {
        if (deviceId == WEB_DEVICE_ID) {
            return createWebSession()
        }

        val device = DeviceService.listConnectedDevices()
            .find { it.instanceId.equals(deviceId, ignoreCase = true) }
            ?: throw CliError("Device with id $deviceId is not connected")
        if (device.platform == Platform.IOS && device.deviceType == Device.DeviceType.REAL) {
            throw UnsupportedOperationException("Real iOS devices are not yet supported by the MCP server")
        }

        return when (device.platform) {
            Platform.ANDROID -> createAndroidSession(device)
            Platform.IOS -> createIosSession(device)
            Platform.WEB -> createWebSession()
        }
    }

    private fun createAndroidSession(device: Device.Connected): McpMaestroSession {
        val context = device.context()
        val dadb = Dadb.list().find { it.toString() == device.instanceId }
            ?: error("Unable to find device with id ${device.instanceId}")
        val androidDriver = AndroidDriver(dadb, null, device.instanceId, true)
        val driver = McpVisualizerDriver(androidDriver, context)
        return McpMaestroSession(
            maestro = Maestro.android(driver),
            context = context,
        )
    }

    private fun createIosSession(device: Device.Connected): McpMaestroSession {
        val context = device.context()
        val iosDriver = createIOSDriver(device.instanceId, device.deviceType)
        val driver = McpVisualizerDriver(iosDriver, context)
        return McpMaestroSession(
            maestro = Maestro.ios(driver, openDriver = true),
            context = context,
        )
    }

    private fun createWebSession(): McpMaestroSession {
        val context = McpDeviceContext("web", WEB_DEVICE_ID, "browser")
        val webDriver = CdpWebDriver(isStudio = false, isHeadless = false, screenSize = null)
        val driver = McpVisualizerDriver(webDriver, context)
        driver.open()
        return McpMaestroSession(
            maestro = Maestro(driver),
            context = context,
        )
    }

    private fun createIOSDriver(
        deviceId: String,
        deviceType: Device.DeviceType,
    ): IOSDriver {
        require(deviceType == Device.DeviceType.SIMULATOR) {
            "Unsupported device type $deviceType for iOS platform"
        }

        val iOSDriverConfig = IOSDriverConfig(
            prebuiltRunner = false,
            sourceDirectory = "driver-iPhoneSimulator",
            context = Context.CLI,
            snapshotKeyHonorModalViews = null,
        )

        val tempFileHandler = TempFileHandler()
        val deviceController = SimctlIOSDevice(
            deviceId = deviceId,
            tempFileHandler = tempFileHandler,
        )

        val xcTestInstaller = LocalXCTestInstaller(
            deviceId = deviceId,
            host = DEFAULT_XCTEST_HOST,
            defaultPort = DEFAULT_XCTEST_PORT,
            reinstallDriver = true,
            deviceType = IOSDeviceType.SIMULATOR,
            iOSDriverConfig = iOSDriverConfig,
            deviceController = deviceController,
            tempFileHandler = tempFileHandler,
        )

        val xcTestDevice = XCTestIOSDevice(
            deviceId = deviceId,
            client = XCTestDriverClient(
                installer = xcTestInstaller,
                client = XCTestClient(DEFAULT_XCTEST_HOST, DEFAULT_XCTEST_PORT),
                reinstallDriver = true,
            ),
            getInstalledApps = { XCRunnerCLIUtils(tempFileHandler).listApps(deviceId) },
        )

        return IOSDriver(
            iosDevice = ios.LocalIOSDevice(
                deviceId = deviceId,
                xcTestDevice = xcTestDevice,
                deviceController = deviceController,
                insights = CliInsights,
            ),
            insights = CliInsights,
        )
    }

    private fun publishConnected(context: McpDeviceContext) {
        McpVisualizerEvents.publish(
            VisualizerEvent(
                type = "maestro.connected",
                source = "mcp",
                title = "Connected to Maestro",
                status = "info",
                detail = listOfNotNull(context.platform, context.deviceId).joinToString(" "),
                payload = context.payload(),
            )
        )
    }

    private fun Device.Connected.context(): McpDeviceContext {
        return McpDeviceContext(
            platform = platform.name.lowercase(),
            deviceId = instanceId,
            deviceType = deviceType.name.lowercase(),
        )
    }

    data class McpMaestroSession(
        val maestro: Maestro,
        val context: McpDeviceContext,
    ) {
        fun close() {
            maestro.close()
        }
    }

    private companion object {
        private const val DEFAULT_XCTEST_HOST = "127.0.0.1"
        private const val DEFAULT_XCTEST_PORT = 22087
        private const val WEB_DEVICE_ID = "chromium"
    }
}
