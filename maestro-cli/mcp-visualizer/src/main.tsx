import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type CommandStatus = "started" | "completed" | "failed" | "warned" | "skipped";
type DriverStatus = "started" | "completed" | "failed";
/** Normalized [0, 1] coordinates within the device's screen. */
type Point2D = { x: number; y: number };

type VisualizerEvent =
  | { type: "maestro.connected"; platform: string; deviceId: string }
  | {
      type: "maestro.command";
      status: CommandStatus;
      flowId: string;
      index: number;
      callId: string;
      commandType: string | null;
      yaml: string | null;
      errorMessage?: string | null;
    }
  | { type: "driver.tap"; status: DriverStatus; point: Point2D }
  | {
      type: "driver.swipe";
      status: DriverStatus;
      start: Point2D;
      end: Point2D;
      durationMs: number;
    }
  | { type: "driver.input_text"; status: DriverStatus; textLength: number }
  | { type: "visualizer.connected" };

type DeviceState = {
  status: "idle" | "starting" | "streaming" | "error";
  platform?: string;
  deviceId?: string;
  streamUrl?: string;
  message?: string;
};

type DeviceTarget = {
  platform: string;
  deviceId: string;
};

type OverlayPoint = {
  x: number;
  y: number;
};

type DeviceOverlayBase = {
  id: string;
  timestampMs: number;
  durationMs: number;
  expiresAt: number;
};

type DeviceOverlay =
  | DeviceOverlayBase & {
    kind: "tap";
    point: OverlayPoint;
  }
  | DeviceOverlayBase & {
    kind: "swipe";
    start: OverlayPoint;
    end: OverlayPoint;
  }
  | DeviceOverlayBase & {
    kind: "input_text";
    text: string;
  };

const TAP_ANIMATION_DURATION_MS = 200;
const TAP_RADIUS_START = 15;
const TAP_RADIUS_END = 30;
const SWIPE_FINGER_RADIUS = 20;

function clampPoint(point: Point2D): OverlayPoint {
  return {
    x: Math.max(0, Math.min(1, point.x)),
    y: Math.max(0, Math.min(1, point.y)),
  };
}
type TrackedMaestroCommand = {
  callId: string;
  flowId: string;
  index: number;
  /** Monotonic insert order so multiple flows stay chronological in the log. */
  sequence: number;
  yaml: string;
  status: CommandStatus;
  errorMessage?: string;
};

function upsertMaestroCommand(rows: TrackedMaestroCommand[], event: VisualizerEvent): TrackedMaestroCommand[] {
  if (event.type !== "maestro.command") return rows;
  // Synthetic commands (applyConfiguration, defineVariables) have no source yaml; skip them.
  if (!event.yaml) return rows;

  const i = rows.findIndex((r) => r.callId === event.callId);
  const maxSeq = rows.reduce((m, r) => Math.max(m, r.sequence), 0);
  const sequence = i === -1 ? maxSeq + 1 : rows[i].sequence;

  const nextRow: TrackedMaestroCommand = {
    callId: event.callId,
    flowId: event.flowId,
    index: event.index,
    sequence,
    yaml: event.yaml,
    status: event.status,
    errorMessage: event.errorMessage ?? undefined,
  };

  if (i === -1) {
    return [...rows, nextRow].sort((a, b) => a.sequence - b.sequence);
  }

  const copy = [...rows];
  copy[i] = nextRow;
  return copy.sort((a, b) => a.sequence - b.sequence);
}

function StatusIcon({ status }: { status: string }) {
  const common = "mt-[3px] h-4 w-4 shrink-0 stroke-current";
  switch (status) {
    case "started":
      return (
        <svg className={`${common} text-sky-500`} viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="3" fill="currentColor" />
        </svg>
      );
    case "completed":
      return (
        <svg className={`${common} text-emerald-500`} fill="none" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3.75 8.25 6.75 11.25 12.25 5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "failed":
      return (
        <svg className={`${common} text-red-500`} fill="none" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M5 11 11 5M11 11 5 5" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "warned":
      return (
        <svg className={`${common} text-amber-500`} fill="none" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 4.5v5M8 11.5h.01" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "skipped":
      return (
        <svg className={`${common} text-neutral-400`} fill="none" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 8h8" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    default:
      return (
        <svg className={`${common} text-neutral-400`} fill="none" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="1.25" fill="currentColor" stroke="none" />
        </svg>
      );
  }
}

// Each command's source yaml is the inner body (e.g. `tapOn:\n    text: Login`).
// Render it as a YAML list item — `- ` on the first line, two-space indent on the rest —
// so the panel reads like a runnable flow.
function asYamlListItem(yaml: string): string {
  const lines = yaml.split("\n");
  return lines.map((line, i) => (i === 0 ? `- ${line}` : `  ${line}`)).join("\n");
}

function CommandsPanel({
  rows,
  collapsed,
  onToggle,
}: {
  rows: TrackedMaestroCommand[];
  collapsed: boolean;
  onToggle: () => void;
}) {
  const listRef = React.useRef<HTMLOListElement | null>(null);
  const started = [...rows].reverse().find((r) => r.status === "started");
  const failed = [...rows].reverse().find((r) => r.status === "failed");
  const lastActive = started ?? failed ?? (rows.length ? rows[rows.length - 1] : undefined);

  React.useEffect(() => {
    if (!lastActive || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-call-id="${CSS.escape(lastActive.callId)}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [lastActive?.callId, rows.length]);

  if (collapsed) {
    return (
      <aside className="flex h-full shrink-0 flex-col items-center gap-2 border-r border-neutral-200 bg-neutral-50 py-2">
        <button
          type="button"
          onClick={onToggle}
          aria-label="Expand Maestro Commands"
          title="Expand Maestro Commands"
          className="grid h-7 w-7 place-items-center rounded text-neutral-500 transition hover:bg-neutral-200 hover:text-neutral-800"
        >
          <ChevronIcon direction="right" />
        </button>
        <span
          className="rotate-180 select-none text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-500"
          style={{ writingMode: "vertical-rl" }}
        >
          Maestro Commands
        </span>
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50">
      <header className="flex h-8 shrink-0 items-center justify-between border-b border-neutral-200 px-2">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-700">Maestro Commands</h2>
        <button
          type="button"
          onClick={onToggle}
          aria-label="Collapse Maestro Commands"
          title="Collapse Maestro Commands"
          className="grid h-6 w-6 place-items-center rounded text-neutral-500 transition hover:bg-neutral-200 hover:text-neutral-800"
        >
          <ChevronIcon direction="left" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden font-mono text-sm leading-5 text-neutral-600">
        {rows.length === 0 ? (
          <p className="px-3 pt-2 text-neutral-500">Run a flow to see steps here.</p>
        ) : (
          <ol ref={listRef} className="m-0 h-full list-none overflow-y-auto px-2 py-1.5 [&>li]:mt-0">
            {rows.map((row) => (
              <li
                key={row.callId}
                data-call-id={row.callId}
                className={`flex gap-2 py-0 leading-5 ${lastActive?.callId === row.callId ? "text-neutral-900" : ""}`}
              >
                <span className="sr-only">{row.status}</span>
                <StatusIcon status={row.status} />
                <div className="min-w-0 flex-1 leading-5">
                  <pre className="m-0 whitespace-pre-wrap break-words leading-[inherit]">{asYamlListItem(row.yaml)}</pre>
                  {row.errorMessage && row.status === "failed" ? (
                    <p className="mt-0 text-xs leading-4 text-red-600">{row.errorMessage}</p>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </aside>
  );
}

function ChevronIcon({ direction }: { direction: "left" | "right" }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
      {direction === "left" ? <path d="M10 4 6 8l4 4" /> : <path d="M6 4l4 4-4 4" />}
    </svg>
  );
}

function overlayFromEvent(event: VisualizerEvent): DeviceOverlay | undefined {
  const timestampMs = Date.now();
  const id = `${event.type}-${timestampMs}`;

  if (event.type === "driver.tap" && event.status === "started") {
    return {
      id,
      kind: "tap",
      point: clampPoint(event.point),
      timestampMs,
      durationMs: TAP_ANIMATION_DURATION_MS,
      expiresAt: timestampMs + TAP_ANIMATION_DURATION_MS,
    };
  }

  if (event.type === "driver.swipe" && event.status === "started") {
    return {
      id,
      kind: "swipe",
      start: clampPoint(event.start),
      end: clampPoint(event.end),
      timestampMs,
      durationMs: event.durationMs,
      expiresAt: timestampMs + event.durationMs,
    };
  }

  if (event.type === "driver.input_text" && event.status === "started") {
    return {
      id,
      kind: "input_text",
      text: `input text · ${event.textLength} chars`,
      timestampMs,
      durationMs: 1_200,
      expiresAt: timestampMs + 1_200,
    };
  }

  return undefined;
}

function pink(opacity: number) {
  return `oklch(71.8% 0.202 349.761 / ${opacity})`;
}

function drawTap(ctx: CanvasRenderingContext2D, tap: Extract<DeviceOverlay, { kind: "tap" }>, currentTimeMs: number) {
  const progress = (currentTimeMs - tap.timestampMs) / TAP_ANIMATION_DURATION_MS;
  if (progress < 0 || progress > 1) return;

  const x = tap.point.x * ctx.canvas.width;
  const y = tap.point.y * ctx.canvas.height;
  const radius = TAP_RADIUS_START + progress * (TAP_RADIUS_END - TAP_RADIUS_START);

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = pink(1);
  ctx.fill();
  ctx.strokeStyle = pink(1);
  ctx.lineWidth = 5;
  ctx.stroke();
}

function drawSwipe(ctx: CanvasRenderingContext2D, swipe: Extract<DeviceOverlay, { kind: "swipe" }>, currentTimeMs: number) {
  const progress = (currentTimeMs - swipe.timestampMs) / swipe.durationMs;
  if (progress < 0 || progress > 1) return;

  const startX = swipe.start.x * ctx.canvas.width;
  const startY = swipe.start.y * ctx.canvas.height;
  const endX = swipe.end.x * ctx.canvas.width;
  const endY = swipe.end.y * ctx.canvas.height;
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const fingerHeight = SWIPE_FINGER_RADIUS * 2;
  const swipeDistance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
  const stretchAmount = progress * swipeDistance;
  const fingerWidth = fingerHeight + stretchAmount;
  const angle = Math.atan2(deltaY, deltaX);

  ctx.save();
  ctx.translate(startX, startY);
  ctx.rotate(angle);

  ctx.beginPath();
  ctx.roundRect(-fingerHeight / 2, -fingerHeight / 2, fingerWidth, fingerHeight, fingerHeight / 2);
  ctx.fillStyle = pink(0.7);
  ctx.fill();
  ctx.strokeStyle = pink(1);
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.restore();
}

function DeviceOverlayCanvas({ overlays }: { overlays: DeviceOverlay[] }) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    let animationFrame = 0;

    function draw() {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const now = Date.now();
      for (const overlay of overlays) {
        if (overlay.kind === "tap") drawTap(ctx, overlay, now);
        if (overlay.kind === "swipe") drawSwipe(ctx, overlay, now);
      }

      if (overlays.some((overlay) => overlay.kind !== "input_text" && overlay.expiresAt > now)) {
        animationFrame = window.requestAnimationFrame(draw);
      }
    }

    draw();
    return () => window.cancelAnimationFrame(animationFrame);
  }, [overlays]);

  return <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />;
}

function InputTextOverlay({ overlay }: { overlay: Extract<DeviceOverlay, { kind: "input_text" }> }) {
  return (
    <div
      className="absolute bottom-8 left-1/2 -translate-x-1/2 rounded-full px-3 py-1 text-xs font-semibold text-white shadow"
      style={{ backgroundColor: pink(0.95) }}
    >
      {overlay.text}
    </div>
  );
}

// Forwards user input to simulator-server's stdin protocol via /api/device/input.
// We send raw touch Down/Move/Up events (matching the device-preview branch) rather
// than synthesizing tap/swipe — the simulator interprets short presses as taps and
// drags as swipes natively, which feels more responsive than driver-mediated gestures.
type InputCommand =
  | { kind: "touch"; action: "Down" | "Move" | "Up"; x: string; y: string }
  | { kind: "key"; action: "Down" | "Up"; code: number }
  | { kind: "button"; action: "Down" | "Up"; name: string };

let pendingMove: InputCommand | null = null;

function dispatchInput(cmd: InputCommand) {
  fetch("/api/device/input", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  }).catch(() => {});
}

function flushInput() {
  if (!pendingMove) return;
  const cmd = pendingMove;
  pendingMove = null;
  dispatchInput(cmd);
}

// Coalesce rapid Move events to one per animation frame so we don't flood the server
// and starve the MJPEG stream — matches the device-preview frontend's approach.
function sendInput(cmd: InputCommand) {
  if (cmd.kind === "touch" && cmd.action === "Move") {
    pendingMove = cmd;
    return;
  }
  if (pendingMove) flushInput();
  dispatchInput(cmd);
}

function useInputFlushLoop() {
  React.useEffect(() => {
    let raf = 0;
    const tick = () => {
      flushInput();
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, []);
}

// USB HID Usage IDs (HID Usage Tables §10), as expected by simulator-server.
const HID: Record<string, number> = {
  KeyA: 4, KeyB: 5, KeyC: 6, KeyD: 7, KeyE: 8, KeyF: 9, KeyG: 10, KeyH: 11,
  KeyI: 12, KeyJ: 13, KeyK: 14, KeyL: 15, KeyM: 16, KeyN: 17, KeyO: 18, KeyP: 19,
  KeyQ: 20, KeyR: 21, KeyS: 22, KeyT: 23, KeyU: 24, KeyV: 25, KeyW: 26, KeyX: 27,
  KeyY: 28, KeyZ: 29,
  Digit1: 30, Digit2: 31, Digit3: 32, Digit4: 33, Digit5: 34,
  Digit6: 35, Digit7: 36, Digit8: 37, Digit9: 38, Digit0: 39,
  Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44,
  Minus: 45, Equal: 46, BracketLeft: 47, BracketRight: 48, Backslash: 49,
  Semicolon: 51, Quote: 52, Backquote: 53, Comma: 54, Period: 55, Slash: 56,
  ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82,
};

function useKeyboardInput() {
  React.useEffect(() => {
    function handle(action: "Down" | "Up", e: KeyboardEvent): boolean {
      if (e.metaKey || e.ctrlKey) return false; // leave browser shortcuts alone
      const tag = (e.target as Element | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return false;
      const code = HID[e.code];
      if (code == null) return false;
      sendInput({ kind: "key", action, code });
      return true;
    }
    const onDown = (e: KeyboardEvent) => { if (handle("Down", e)) e.preventDefault(); };
    const onUp = (e: KeyboardEvent) => { if (handle("Up", e)) e.preventDefault(); };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, []);
}

function GestureLayer() {
  const draggingRef = React.useRef(false);

  function devicePoint(e: React.PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    const y = Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1);
    return { x: x.toFixed(5), y: y.toFixed(5) };
  }

  return (
    <div
      className="absolute inset-0 cursor-crosshair touch-none select-none"
      onPointerDown={(e) => {
        draggingRef.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        const p = devicePoint(e);
        sendInput({ kind: "touch", action: "Down", x: p.x, y: p.y });
      }}
      onPointerMove={(e) => {
        if (!draggingRef.current) return;
        const p = devicePoint(e);
        sendInput({ kind: "touch", action: "Move", x: p.x, y: p.y });
      }}
      onPointerUp={(e) => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
        const p = devicePoint(e);
        sendInput({ kind: "touch", action: "Up", x: p.x, y: p.y });
      }}
      onPointerCancel={(e) => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        const p = devicePoint(e);
        sendInput({ kind: "touch", action: "Up", x: p.x, y: p.y });
      }}
    />
  );
}

function HardwareButton({ name, label, hideForPlatform, platform, children }: {
  name: string;
  label: string;
  hideForPlatform?: string;
  platform?: string;
  children: React.ReactNode;
}) {
  if (hideForPlatform && platform === hideForPlatform) return null;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={() => {
        sendInput({ kind: "button", action: "Down", name });
        window.setTimeout(() => sendInput({ kind: "button", action: "Up", name }), 80);
      }}
      className="grid h-10 w-10 place-items-center rounded-md border border-neutral-200 bg-white text-neutral-700 shadow-sm transition hover:bg-neutral-50 active:bg-neutral-100"
    >
      {children}
    </button>
  );
}

function HardwareRail({ platform }: { platform?: string }) {
  if (platform !== "android" && platform !== "ios") return null;
  return (
    <div className="flex shrink-0 flex-col gap-1.5 self-start rounded-lg border border-neutral-200 bg-neutral-50 p-1.5">
      <HardwareButton name="power" label="Power">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
          <path d="M12 3v9" /><path d="M7 7a7 7 0 1 0 10 0" />
        </svg>
      </HardwareButton>
      <HardwareButton name="volumeUp" label="Volume up">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-4 w-4">
          <path d="M12 5v14" /><path d="M5 12h14" />
        </svg>
      </HardwareButton>
      <HardwareButton name="volumeDown" label="Volume down">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-4 w-4">
          <path d="M5 12h14" />
        </svg>
      </HardwareButton>
      <div className="my-1 h-px bg-neutral-200" />
      <HardwareButton name="back" label="Back" hideForPlatform="ios" platform={platform}>
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4"><path d="M15 5 L7 12 L15 19 Z" /></svg>
      </HardwareButton>
      <HardwareButton name="home" label="Home">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
          <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1z" />
        </svg>
      </HardwareButton>
      <HardwareButton name="appSwitch" label="Recents">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
          <rect x="6" y="6" width="12" height="12" rx="1.2" />
        </svg>
      </HardwareButton>
    </div>
  );
}

function App() {
  const [overlays, setOverlays] = React.useState<DeviceOverlay[]>([]);
  const [commandRows, setCommandRows] = React.useState<TrackedMaestroCommand[]>([]);
  const [deviceState, setDeviceState] = React.useState<DeviceState>({ status: "idle" });
  const [commandsCollapsed, setCommandsCollapsed] = React.useState(false);
  const didAutoStartDeviceStream = React.useRef(false);

  useInputFlushLoop();
  useKeyboardInput();

  React.useEffect(() => {
    const stream = new EventSource("/api/events/stream");

    stream.onopen = () => console.log("[mcp-visualizer] event stream connected");
    stream.onerror = (event) => console.error("[mcp-visualizer] event stream error", event);
    stream.onmessage = (message) => {
      const event = JSON.parse(message.data) as VisualizerEvent;
      console.log("[mcp-visualizer] event", event);

      setCommandRows((rows) => upsertMaestroCommand(rows, event));

      const overlay = overlayFromEvent(event);
      if (overlay) {
        setOverlays((current) => [overlay, ...current].slice(0, 8));
      }
    };

    return () => stream.close();
  }, []);

  React.useEffect(() => {
    if (overlays.length === 0) return;

    const timeout = window.setTimeout(() => {
      const now = Date.now();
      setOverlays((current) => current.filter((overlay) => overlay.expiresAt > now));
    }, 100);
    return () => window.clearTimeout(timeout);
  }, [overlays]);

  React.useEffect(() => {
    const stream = new EventSource("/api/device/state");

    stream.onmessage = (message) => {
      setDeviceState(JSON.parse(message.data));
    };

    return () => stream.close();
  }, []);

  React.useEffect(() => {
    if (didAutoStartDeviceStream.current) return;
    didAutoStartDeviceStream.current = true;

    async function startOnlyConnectedDevice() {
      const response = await fetch("/api/device/targets");
      const body = await response.json() as { devices?: DeviceTarget[] };
      const devices = body.devices || [];
      if (devices.length !== 1) return;

      const [device] = devices;
      await startDeviceStream(device);
    }

    startOnlyConnectedDevice().catch((error) => {
      setDeviceState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, []);

  async function startDeviceStream(target: DeviceTarget) {
    const response = await fetch("/api/device/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: target.platform,
        deviceId: target.deviceId,
      }),
    });
    setDeviceState(await response.json());
  }

  return (
    <main className="flex h-screen items-stretch overflow-hidden bg-neutral-100 font-mono text-neutral-700">
      <CommandsPanel
        rows={commandRows}
        collapsed={commandsCollapsed}
        onToggle={() => setCommandsCollapsed((c) => !c)}
      />
      <div className="flex min-w-0 flex-1 items-start gap-4 p-4">
        {deviceState.status === "streaming" ? (
          <>
            <div className="relative shrink-0 overflow-hidden rounded-[2rem] bg-neutral-900 shadow-xl shadow-neutral-300/60 ring-1 ring-neutral-200">
              <img className="block max-h-[calc(100vh-2rem)] w-auto" src="/api/device/stream" draggable={false} />
              <div className="pointer-events-none absolute inset-0">
                <DeviceOverlayCanvas overlays={overlays} />
                {overlays
                  .filter((overlay): overlay is Extract<DeviceOverlay, { kind: "input_text" }> => overlay.kind === "input_text")
                  .map((overlay) => <InputTextOverlay key={overlay.id} overlay={overlay} />)}
              </div>
              <GestureLayer />
            </div>
            <HardwareRail platform={deviceState.platform} />
          </>
        ) : (
          <div className="grid h-[70vh] w-full max-w-sm shrink-0 place-items-center rounded-[2rem] border border-neutral-200 bg-white text-xs text-neutral-500 shadow-xl shadow-neutral-300/60">
            <div className="text-center">
              <div>no device stream</div>
              {deviceState.message && (
                <div className="mt-2 max-w-xs whitespace-pre-wrap text-neutral-400">{deviceState.message}</div>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
