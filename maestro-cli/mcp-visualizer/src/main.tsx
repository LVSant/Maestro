import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type VisualizerEvent = {
  type?: string;
  payload?: unknown;
};

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

type EventPayload = Record<string, unknown>;

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

function payloadRecord(payload: unknown): EventPayload {
  return payload && typeof payload === "object" ? payload as EventPayload : {};
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pointValue(value: unknown): OverlayPoint | undefined {
  if (value && typeof value === "object") {
    const point = value as Record<string, unknown>;
    const x = numberValue(point.x);
    const y = numberValue(point.y);
    if (x != null && y != null) return { x, y };
  }

  if (typeof value === "string") {
    const match = value.match(/x=(-?\d+),\s*y=(-?\d+)/);
    if (match) return { x: Number(match[1]), y: Number(match[2]) };
  }

  return undefined;
}

function screenSize(payload: EventPayload) {
  const screen = payload.screen;
  if (!screen || typeof screen !== "object") return undefined;

  const width = numberValue((screen as Record<string, unknown>).width);
  const height = numberValue((screen as Record<string, unknown>).height);
  return width && height ? { width, height } : undefined;
}

function normalizePoint(point: OverlayPoint, payload: EventPayload): OverlayPoint | undefined {
  const screen = screenSize(payload);
  if (!screen) {
    return point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1 ? point : undefined;
  }

  return {
    x: Math.max(0, Math.min(1, point.x / screen.width)),
    y: Math.max(0, Math.min(1, point.y / screen.height)),
  };
}
type TrackedMaestroCommand = {
  callId: string;
  flowId: string;
  index: number;
  /** Monotonic insert order so multiple flows stay chronological in the log. */
  sequence: number;
  yaml: string;
  status: string;
  errorMessage?: string;
};

function commandPayload(event: VisualizerEvent) {
  const p = payloadRecord(event.payload);
  const flowId = typeof p.flowId === "string" ? p.flowId : "";
  const callId = typeof p.callId === "string" ? p.callId : `cmd-${Date.now()}`;
  const index = typeof p.index === "number" ? p.index : Number(p.index);
  const yaml = typeof p.yaml === "string" ? p.yaml : undefined;
  const status = typeof p.status === "string" ? p.status : "";
  return { flowId, callId, index: Number.isFinite(index) ? index : 0, yaml, status };
}

function upsertMaestroCommand(rows: TrackedMaestroCommand[], event: VisualizerEvent): TrackedMaestroCommand[] {
  if (event.type !== "maestro.command") return rows;

  const { flowId, callId, index, yaml, status } = commandPayload(event);
  // Synthetic commands (applyConfiguration, defineVariables) have no source yaml; skip them.
  if (!yaml || !status) return rows;

  const errorMessage = stringValue(payloadRecord(event.payload).errorMessage);
  const i = rows.findIndex((r) => r.callId === callId);
  const maxSeq = rows.reduce((m, r) => Math.max(m, r.sequence), 0);
  const sequence = i === -1 ? maxSeq + 1 : rows[i].sequence;

  const nextRow: TrackedMaestroCommand = {
    callId,
    flowId,
    index,
    sequence,
    yaml,
    status,
    errorMessage,
  };

  if (i === -1) {
    return [...rows, nextRow].sort((a, b) => a.sequence - b.sequence);
  }

  const copy = [...rows];
  copy[i] = nextRow;
  return copy.sort((a, b) => a.sequence - b.sequence);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function StatusIcon({ status }: { status: string }) {
  const common = "mt-[3px] h-4 w-4 shrink-0 stroke-current";
  switch (status) {
    case "started":
      return (
        <svg className={`${common} text-sky-400`} viewBox="0 0 16 16" aria-hidden="true">
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
        <svg className={`${common} text-neutral-600`} fill="none" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 8h8" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    default:
      return (
        <svg className={`${common} text-neutral-600`} fill="none" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="1.25" fill="currentColor" stroke="none" />
        </svg>
      );
  }
}

function CommandsPanel({ rows }: { rows: TrackedMaestroCommand[] }) {
  const listRef = React.useRef<HTMLOListElement | null>(null);
  const started = [...rows].reverse().find((r) => r.status === "started");
  const failed = [...rows].reverse().find((r) => r.status === "failed");
  const lastActive = started ?? failed ?? (rows.length ? rows[rows.length - 1] : undefined);

  React.useEffect(() => {
    if (!lastActive || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-call-id="${CSS.escape(lastActive.callId)}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [lastActive?.callId, rows.length]);

  return (
    <aside className="flex max-h-[calc(100vh-2rem)] min-h-0 w-80 shrink-0 flex-col overflow-hidden py-1 pl-1 pr-2 font-mono text-sm leading-5 text-neutral-500">
      {rows.length === 0 ? (
        <p className="pr-1 text-neutral-600">Run a flow to see steps here.</p>
      ) : (
        <ol ref={listRef} className="min-h-0 flex-1 list-none gap-0 overflow-y-auto [&>li]:mt-0">
          {rows.map((row) => (
            <li
              key={row.callId}
              data-call-id={row.callId}
              className={`flex gap-2 py-0 leading-5 ${lastActive?.callId === row.callId ? "text-neutral-300" : ""}`}
            >
              <span className="sr-only">{row.status}</span>
              <StatusIcon status={row.status} />
              <div className="min-w-0 flex-1 leading-5">
                <pre className="m-0 whitespace-pre-wrap break-words leading-[inherit]">{row.yaml}</pre>
                {row.errorMessage && row.status === "failed" ? (
                  <p className="mt-0 text-xs leading-4 text-red-400/90">{row.errorMessage}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}

function overlayFromEvent(event: VisualizerEvent): DeviceOverlay | undefined {
  const payload = payloadRecord(event.payload);
  if (payload.status !== "started") return undefined;

  const id = `${event.type || "event"}-${Date.now()}`;
  const timestampMs = Date.now();

  if (event.type === "driver.tap") {
    const point = pointValue(payload.point);
    const normalized = point ? normalizePoint(point, payload) : undefined;
    return normalized
      ? {
        id,
        kind: "tap",
        point: normalized,
        timestampMs,
        durationMs: TAP_ANIMATION_DURATION_MS,
        expiresAt: timestampMs + TAP_ANIMATION_DURATION_MS,
      }
      : undefined;
  }

  if (event.type === "driver.swipe") {
    const start = pointValue(payload.start);
    const end = pointValue(payload.end);
    const normalizedStart = start ? normalizePoint(start, payload) : undefined;
    const normalizedEnd = end ? normalizePoint(end, payload) : undefined;
    const durationMs = numberValue(payload.durationMs) ?? 500;
    return normalizedStart && normalizedEnd
      ? {
        id,
        kind: "swipe",
        start: normalizedStart,
        end: normalizedEnd,
        timestampMs,
        durationMs,
        expiresAt: timestampMs + durationMs,
      }
      : undefined;
  }

  if (event.type === "driver.input_text") {
    const textLength = numberValue(payload.textLength);
    return {
      id,
      kind: "input_text",
      text: textLength == null ? "input text" : `input text · ${textLength} chars`,
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

function App() {
  const [overlays, setOverlays] = React.useState<DeviceOverlay[]>([]);
  const [commandRows, setCommandRows] = React.useState<TrackedMaestroCommand[]>([]);
  const [deviceState, setDeviceState] = React.useState<DeviceState>({ status: "idle" });
  const didAutoStartDeviceStream = React.useRef(false);

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
    <main className="flex min-h-screen items-center justify-start bg-neutral-950 p-4 font-mono">
      <div className="flex max-w-full items-start gap-4">
        {deviceState.status === "streaming" ? (
          <div className="relative shrink-0 overflow-hidden rounded-[2rem] bg-black shadow-2xl shadow-black/40">
            <img className="block max-h-[calc(100vh-2rem)] w-auto max-w-[calc(100vw-24rem)]" src="/api/device/stream" />
            <div className="pointer-events-none absolute inset-0">
              <DeviceOverlayCanvas overlays={overlays} />
              {overlays
                .filter((overlay): overlay is Extract<DeviceOverlay, { kind: "input_text" }> => overlay.kind === "input_text")
                .map((overlay) => <InputTextOverlay key={overlay.id} overlay={overlay} />)}
            </div>
          </div>
        ) : (
          <div className="grid h-[70vh] w-full max-w-sm shrink-0 place-items-center rounded-[2rem] bg-black text-xs text-neutral-500 shadow-2xl shadow-black/40">
            <div>
              <div>no device stream</div>
              {deviceState.message && (
                <div className="mt-2 max-w-xs whitespace-pre-wrap text-neutral-600">{deviceState.message}</div>
              )}
            </div>
          </div>
        )}
        <CommandsPanel rows={commandRows} />
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
