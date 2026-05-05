// Scripted scenario for the mock dev server. Each step has a delay before it
// fires (relative to the previous step). A `clear` step resets the loop.
// Coordinates are normalized [0, 1] within the device's screen.

export type ScenarioStep =
  | { delayMs: number; kind: "device.state"; payload: { status: string; platform?: string; deviceId?: string; streamUrl?: string; message?: string } }
  | { delayMs: number; kind: "event"; payload: any }
  | { delayMs: number; kind: "clear" };

const cmd = (status: string, callId: string, yaml: string, errorMessage?: string) => ({
  type: "maestro.command",
  status,
  flowId: "fixture-flow",
  index: parseInt(callId.replace(/\D/g, ""), 10) || 0,
  callId,
  commandType: yaml.split(":")[0],
  yaml,
  errorMessage,
});

const tap = (status: string, x: number, y: number) => ({ type: "driver.tap", status, point: { x, y } });
const swipe = (status: string, sx: number, sy: number, ex: number, ey: number, durationMs = 300) => ({
  type: "driver.swipe", status, start: { x: sx, y: sy }, end: { x: ex, y: ey }, durationMs,
});
const inputText = (status: string, len: number) => ({ type: "driver.input_text", status, textLength: len });

export const scenario: ScenarioStep[] = [
  { delayMs: 0,    kind: "device.state", payload: { status: "streaming", platform: "ios", deviceId: "MOCK-DEVICE", streamUrl: "/api/device/stream" } },
  { delayMs: 600,  kind: "event", payload: { type: "maestro.connected", platform: "ios", deviceId: "MOCK-DEVICE" } },

  { delayMs: 400,  kind: "event", payload: cmd("started", "c0", "launchApp: com.example.shop") },
  { delayMs: 700,  kind: "event", payload: cmd("completed", "c0", "launchApp: com.example.shop") },

  { delayMs: 250,  kind: "event", payload: cmd("started", "c1", "assertVisible: Sign in") },
  { delayMs: 350,  kind: "event", payload: cmd("completed", "c1", "assertVisible: Sign in") },

  { delayMs: 200,  kind: "event", payload: cmd("started", "c2", "tapOn:\n    text: Sign in\n    index: 0") },
  { delayMs: 100,  kind: "event", payload: tap("started", 0.5, 0.62) },
  { delayMs: 250,  kind: "event", payload: tap("completed", 0.5, 0.62) },
  { delayMs: 150,  kind: "event", payload: cmd("completed", "c2", "tapOn:\n    text: Sign in\n    index: 0") },

  { delayMs: 250,  kind: "event", payload: cmd("started", "c3", "tapOn: Username") },
  { delayMs: 200,  kind: "event", payload: tap("started", 0.5, 0.4) },
  { delayMs: 200,  kind: "event", payload: tap("completed", 0.5, 0.4) },
  { delayMs: 100,  kind: "event", payload: cmd("completed", "c3", "tapOn: Username") },

  { delayMs: 200,  kind: "event", payload: cmd("started", "c4", "inputText: explorer") },
  { delayMs: 200,  kind: "event", payload: inputText("started", 8) },
  { delayMs: 600,  kind: "event", payload: inputText("completed", 8) },
  { delayMs: 100,  kind: "event", payload: cmd("completed", "c4", "inputText: explorer") },

  { delayMs: 250,  kind: "event", payload: cmd("started", "c5", "tapOn: Password") },
  { delayMs: 200,  kind: "event", payload: tap("completed", 0.5, 0.48) },
  { delayMs: 100,  kind: "event", payload: cmd("completed", "c5", "tapOn: Password") },

  { delayMs: 200,  kind: "event", payload: cmd("started", "c6", "inputText: hunter2") },
  { delayMs: 600,  kind: "event", payload: cmd("completed", "c6", "inputText: hunter2") },

  { delayMs: 250,  kind: "event", payload: cmd("started", "c7", "swipe:\n    start: \"50%,80%\"\n    end: \"50%,20%\"\n    duration: 350") },
  { delayMs: 100,  kind: "event", payload: swipe("started", 0.5, 0.8, 0.5, 0.2, 350) },
  { delayMs: 400,  kind: "event", payload: swipe("completed", 0.5, 0.8, 0.5, 0.2, 350) },
  { delayMs: 100,  kind: "event", payload: cmd("completed", "c7", "swipe:\n    start: \"50%,80%\"\n    end: \"50%,20%\"\n    duration: 350") },

  { delayMs: 300,  kind: "event", payload: cmd("warned", "c8", "assertVisible:\n    text: Promo banner\n    optional: true") },

  { delayMs: 250,  kind: "event", payload: cmd("skipped", "c9", "runFlow:\n    when:\n        visible: Logout\n    commands:\n      - tapOn: Logout") },

  { delayMs: 350,  kind: "event", payload: cmd("started", "c10", "assertVisible: Top") },
  { delayMs: 1200, kind: "event", payload: cmd("failed", "c10", "assertVisible: Top", "Assertion is false: \"Top\" is visible") },

  { delayMs: 4000, kind: "clear" },
];
