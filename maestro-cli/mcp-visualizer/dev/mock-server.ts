// Vite plugin: simulate the Maestro visualizer backend so the React app can run
// against `bun dev` with no Kotlin/MCP server in the loop. Mocks every endpoint
// the frontend hits, broadcasts a scripted scenario over SSE, and serves a
// placeholder SVG for the device stream.

import type { Plugin, Connect } from "vite";
import type { ServerResponse } from "node:http";
import { scenario, ScenarioStep } from "./fixture";

type Channel = "events" | "deviceState";

class Broadcaster {
  private clients = new Map<Channel, Set<ServerResponse>>([
    ["events", new Set()],
    ["deviceState", new Set()],
  ]);

  add(channel: Channel, res: ServerResponse) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    this.clients.get(channel)!.add(res);
    res.on("close", () => this.clients.get(channel)!.delete(res));
  }

  send(channel: Channel, payload: unknown) {
    const message = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.clients.get(channel)!) client.write(message);
  }
}

function placeholderDeviceFrame(): string {
  // Fake iPhone-ish render so the app has something to point its overlay canvas at.
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 414 896" width="414" height="896">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fafafa"/>
      <stop offset="1" stop-color="#e5e7eb"/>
    </linearGradient>
  </defs>
  <rect width="414" height="896" fill="url(#bg)"/>
  <rect x="20" y="60" width="374" height="56" rx="14" fill="#ffffff" stroke="#d4d4d8"/>
  <text x="40" y="94" font-family="-apple-system, sans-serif" font-size="18" fill="#52525b">Mock Device — fixture mode</text>
  <rect x="20" y="140" width="374" height="120" rx="14" fill="#ffffff" stroke="#d4d4d8"/>
  <text x="40" y="180" font-family="-apple-system, sans-serif" font-size="14" fill="#71717a">No live stream.</text>
  <text x="40" y="206" font-family="-apple-system, sans-serif" font-size="14" fill="#71717a">Bun dev mode is replaying the fixture scenario.</text>
  <text x="40" y="232" font-family="-apple-system, sans-serif" font-size="14" fill="#71717a">Edit dev/fixture.ts to change events.</text>
  <g font-family="-apple-system, sans-serif" font-size="14" fill="#3f3f46">
    <rect x="20" y="280"  width="374" height="56" rx="12" fill="#ffffff" stroke="#e4e4e7"/><text x="40" y="312">Username</text>
    <rect x="20" y="346"  width="374" height="56" rx="12" fill="#ffffff" stroke="#e4e4e7"/><text x="40" y="378">Password</text>
    <rect x="20" y="420"  width="374" height="56" rx="12" fill="#0ea5e9"/><text x="170" y="452" fill="#ffffff" font-weight="600">Sign in</text>
  </g>
</svg>`;
}

function readJsonBody<T>(req: Connect.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : ({} as T)); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

export function mockBackendPlugin(): Plugin {
  let scenarioTimer: NodeJS.Timeout | null = null;
  let stopRequested = false;
  const broadcaster = new Broadcaster();

  let deviceState = {
    status: "streaming",
    platform: "ios",
    deviceId: "MOCK-DEVICE",
    streamUrl: "/api/device/stream",
  };

  async function runScenarioLoop() {
    while (!stopRequested) {
      for (const step of scenario as ScenarioStep[]) {
        await new Promise<void>((r) => { scenarioTimer = setTimeout(r, step.delayMs); });
        if (stopRequested) return;
        if (step.kind === "device.state") {
          deviceState = { ...deviceState, ...step.payload } as typeof deviceState;
          broadcaster.send("deviceState", deviceState);
        } else if (step.kind === "event") {
          broadcaster.send("events", step.payload);
        } else if (step.kind === "clear") {
          // Tell the UI to drop its log. Implemented by re-broadcasting maestro.connected
          // (which the current UI does not act on) so for the fixture we expose a
          // synthetic "fixture.clear" event the frontend ignores in production but
          // we can listen for in dev. For now, just no-op — operators reload the page.
        }
      }
    }
  }

  return {
    name: "maestro-visualizer-mock-backend",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api/device/targets", (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ devices: [{ platform: "ios", deviceId: "MOCK-DEVICE" }] }));
      });

      server.middlewares.use("/api/device/state", (req, res) => {
        broadcaster.add("deviceState", res);
        broadcaster.send("deviceState", deviceState);
      });

      server.middlewares.use("/api/events/stream", (req, res) => {
        broadcaster.add("events", res);
        broadcaster.send("events", { type: "visualizer.connected" });
      });

      server.middlewares.use("/api/device/stream", (_req, res) => {
        res.setHeader("Content-Type", "image/svg+xml");
        res.setHeader("Cache-Control", "no-store");
        res.end(placeholderDeviceFrame());
      });

      server.middlewares.use("/api/device/start", async (req, res) => {
        if (req.method !== "POST") { res.statusCode = 405; res.end(); return; }
        await readJsonBody(req).catch(() => ({}));
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(deviceState));
      });

      server.middlewares.use("/api/device/input", async (req, res) => {
        if (req.method !== "POST") { res.statusCode = 405; res.end(); return; }
        const body = await readJsonBody<any>(req).catch(() => ({}));
        // Echo input as a synthetic driver event so taps/swipes from the UI light up
        // the overlay layer just like in production.
        if (body?.kind === "touch") {
          if (body.action === "Down") {
            broadcaster.send("events", { type: "driver.tap", status: "started", point: { x: parseFloat(body.x), y: parseFloat(body.y) } });
          } else if (body.action === "Up") {
            broadcaster.send("events", { type: "driver.tap", status: "completed", point: { x: parseFloat(body.x), y: parseFloat(body.y) } });
          }
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      });

      runScenarioLoop().catch((e) => server.config.logger.error(`fixture loop error: ${e}`));
      server.httpServer?.on("close", () => {
        stopRequested = true;
        if (scenarioTimer) clearTimeout(scenarioTimer);
      });
    },
  };
}
