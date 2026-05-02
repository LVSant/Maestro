package maestro.cli.mcp

import io.modelcontextprotocol.kotlin.sdk.server.Server
import io.modelcontextprotocol.kotlin.sdk.server.ServerOptions
import io.modelcontextprotocol.kotlin.sdk.server.StdioServerTransport
import io.modelcontextprotocol.kotlin.sdk.types.Implementation
import io.modelcontextprotocol.kotlin.sdk.types.ServerCapabilities
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.io.asSink
import kotlinx.io.asSource
import kotlinx.io.buffered
import maestro.debuglog.LogConfig
import maestro.cli.mcp.tools.ListDevicesTool
import maestro.cli.mcp.tools.TakeScreenshotTool
import maestro.cli.mcp.tools.RunTool
import maestro.cli.mcp.tools.InspectScreenTool
import maestro.cli.mcp.tools.CheatSheetTool
import maestro.cli.mcp.tools.RunOnCloudTool
import maestro.cli.mcp.tools.GetCloudRunStatusTool
import maestro.cli.mcp.tools.ListCloudDevicesTool
import maestro.cli.mcp.tools.withVisualizerHint
import maestro.cli.util.WorkingDirectory
import java.io.PrintStream

private val BASE_INSTRUCTIONS = """
    Authors, edits, and runs UI tests via declarative YAML flows on Android emulators, iOS simulators, Chromium browsers (`chromium`), or Maestro Cloud.

    Every local tool needs a `device_id` from `list_devices`. Docs: https://docs.maestro.dev/llms.txt. Call `cheat_sheet` before unfamiliar commands.

    ## Local workflow

    `list_devices` -> `inspect_screen` -> `run`. `list_devices` returns connected IDs (ask user to boot one if empty). `inspect_screen` fetches the view hierarchy; re-inspect after any UI change. `run` takes exactly one of `{yaml}` (inline, preferred), `{files}`, or `{dir, include_tags, exclude_tags}`, plus `device_id` and optional `env`. Syntax is validated as part of the call.

    Mobile flows declare `appId` + start with `launchApp`; web flows declare `url` + start with `openLink`. Tags are bare (no `@`). Prefer one full flow over single-command calls.

    ## Cloud workflow

    `list_cloud_devices` -> `run_on_cloud` -> `get_cloud_run_status` (poll every 60s until SUCCESS/ERROR/CANCELED/WARNING).

    `list_cloud_devices` returns `{device_model, device_os}` pairs — pass verbatim. `run_on_cloud` returns `upload_id`, `project_id`, dashboard URL. Tags only apply with a folder. No tool lists past runs.

    Auth: `maestro login` or `MAESTRO_CLOUD_API_KEY`. Never echo the API key.
""".trimIndent()

private fun buildInstructions(visualizerUrl: String?): String {
    if (visualizerUrl == null) return BASE_INSTRUCTIONS
    return BASE_INSTRUCTIONS + "\n\n" + """
        ## Live visualizer

        $visualizerUrl shows the device and command status live. Open in an embedded-browser/page-navigation tool if available; otherwise share as a clickable link.
    """.trimIndent()
}

// Captures the real stdout so the MCP protocol channel stays pristine even after
// `claimMcpStdout()` routes `System.out` to stderr. Defaults to `System.out` for
// test/dev paths that invoke `runMaestroMcpServer()` without going through main().
private var mcpProtocolOut: PrintStream = System.out

/**
 * Must run before any MCP-adjacent class loads: static init (kotlin-logging banner,
 * first-run analytics notice, third-party println-on-load) writes to whatever stdout
 * is at that moment and corrupts the JSON-RPC handshake for strict clients like
 * Claude Desktop.
 */
internal fun claimMcpStdout() {
    mcpProtocolOut = System.out
    System.setOut(System.err)
}

fun runMaestroMcpServer(visualizerUrl: String? = null) {
    // LogConfig silences log4j; the stdout redirect in `claimMcpStdout` catches
    // everything else. Keep both; they cover different noise sources.
    LogConfig.configure(logFileName = null, printToConsole = false)

    val sessionManager = McpMaestroSessionManager()

    val server = Server(
        serverInfo = Implementation(
            name = "maestro",
            version = "1.0.0"
        ),
        options = ServerOptions(
            capabilities = ServerCapabilities(
                tools = ServerCapabilities.Tools(listChanged = true)
            )
        ),
        instructions = buildInstructions(visualizerUrl)
    )

    server.addTools(listOf(
        ListDevicesTool.create().withVisualizerHint(visualizerUrl),
        TakeScreenshotTool.create(sessionManager).withVisualizerHint(visualizerUrl),
        RunTool.create(sessionManager).withVisualizerHint(visualizerUrl),
        InspectScreenTool.create(sessionManager).withVisualizerHint(visualizerUrl),
        CheatSheetTool.create().withVisualizerHint(visualizerUrl),
        ListCloudDevicesTool.create(),
        RunOnCloudTool.create(),
        GetCloudRunStatusTool.create()
    ))

    val transport = StdioServerTransport(
        System.`in`.asSource().buffered(),
        mcpProtocolOut.asSink().buffered()
    )

    System.err.println("MCP Server: Started. Waiting for messages. Working directory: ${WorkingDirectory.baseDir}")

    try {
        runBlocking {
            val session = server.createSession(transport)
            val done = Job()
            session.onClose { done.complete() }
            done.join()
        }
    } finally {
        sessionManager.close()
    }
}
