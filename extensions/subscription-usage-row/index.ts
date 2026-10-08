import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

// UI adapter only: all authentication and queries remain in pi-subscription-usage.
export const ROW_KEY = Symbol.for("pi.extensions.quota-row.v1");
export const STATUS_EVENT = "subscription-usage/status/v1";
const WIDGET_KEY = "subscription-usage-row";
type Window = { label: string; displayPercent: number; resetCountdown?: string };
type Status = { v: 1; status: "ready"; windows: Window[] } | { v: 1; status: "unavailable" };

export function spacedCountdown(value: string): string {
  return value.replace(/(\d+[dhm])(?=\d)/g, "$1 ");
}

function safeText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, "").replace(/\s+/g, " ").trim();
}

export function renderUsage(event: Status | undefined, theme: Theme, fallback?: string): string | undefined {
  if (event?.status !== "ready") return fallback ? theme.fg("dim", fallback) : undefined;
  const windows = event.windows.filter(w => Number.isFinite(w.displayPercent) && w.displayPercent >= 0 && w.displayPercent <= 100);
  if (!windows.length) return undefined;
  return windows.map(w => {
    const percent = `${Math.round(w.displayPercent * 10) / 10}%`;
    const countdown = w.resetCountdown ? safeText(spacedCountdown(w.resetCountdown)) : "";
    const head = `${safeText(w.label)}  ${percent}`;
    return theme.fg("text", head) + (countdown ? theme.fg("muted", `  ↻ ${countdown}`) : "");
  }).join(theme.fg("dim", "  │  "));
}

function readStatus(value: unknown): Status | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.v !== 1) return undefined;
  if (raw.status === "unavailable") return { v: 1, status: "unavailable" };
  if (raw.status !== "ready" || !Array.isArray(raw.windows)) return undefined;
  const windows: Window[] = [];
  for (const item of raw.windows) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.label !== "string" || typeof item.displayPercent !== "number") continue;
    windows.push({ label: item.label, displayPercent: item.displayPercent,
      ...(typeof item.resetCountdown === "string" ? { resetCountdown: item.resetCountdown } : {}) });
  }
  return { v: 1, status: "ready", windows };
}

export default function subscriptionUsageRow(pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let event: Status | undefined;
  let fallback: string | undefined;
  let requestRender: (() => void) | undefined;
  let widgetInstalled = false;
  let unsubscribe: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const claims = new Set<symbol>();
  const global = globalThis as Record<symbol, unknown>;
  const active = () => Boolean(ctx?.hasUI && ctx.mode === "tui");

  const syncWidget = () => {
    if (!active() || !ctx) return;
    const show = claims.size === 0 && Boolean(event?.status === "ready" || fallback);
    if (show && !widgetInstalled) {
      widgetInstalled = true;
      ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
        requestRender = () => tui.requestRender();
        return { render: (width: number) => {
          const text = renderUsage(event, theme, fallback);
          return text && width > 0 ? [truncateToWidth(text, width)] : [];
        }, invalidate() {}, dispose() { requestRender = undefined; } };
      }, { placement: "belowEditor" });
    } else if (!show && widgetInstalled) {
      widgetInstalled = false;
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    }
    requestRender?.();
  };
  const changed = () => { syncWidget(); for (const listener of listeners) listener(); };

  const host = {
    source: "subscription-usage",
    render(theme: Theme) { return active() ? renderUsage(event, theme, fallback) : undefined; },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    claim() {
      const token = Symbol(); claims.add(token); changed();
      return () => { if (claims.delete(token)) changed(); };
    },
    // Invoked by the small presentation-only patch in the upstream plugin.
    // Return false outside TUI so its normal status output remains available.
    setFallback(value: string | undefined): boolean {
      if (!active()) return false;
      fallback = event?.status === "ready" ? undefined
        : value === "usage auth ?" ? "额度不可用 · /usage 检查授权"
        : value === "usage error" ? "额度查询失败 · /usage 查看详情" : undefined;
      changed();
      return true;
    },
  };
  global[ROW_KEY] = host; // Published during factory load, before timer session_start.

  const listen = () => {
    if (!unsubscribe) unsubscribe = pi.events.on(STATUS_EVENT, (data: unknown) => {
      const nextEvent = readStatus(data);
      if (!nextEvent) return;
      event = nextEvent;
      fallback = undefined;
      changed();
    });
  };
  listen(); // Capture even a fast upstream response before our session_start.
  const attach = (next: ExtensionContext) => {
    ctx = next;
    if (!active()) return;
    global[ROW_KEY] = host;
    listen();
    // A fast response before attach may already have installed the default footer.
    ctx.ui.setStatus("subscription-usage", undefined);
    syncWidget();
  };
  pi.on("session_start", (_e, next) => {
    if (ctx) { event = undefined; fallback = undefined; }
    attach(next);
  });
  pi.on("session_tree", (_e, next) => attach(next));
  pi.on("model_select", () => { event = undefined; fallback = undefined; changed(); });
  pi.on("session_shutdown", () => {
    unsubscribe?.(); unsubscribe = undefined;
    if (active() && ctx) ctx.ui.setWidget(WIDGET_KEY, undefined);
    widgetInstalled = false; requestRender = undefined;
    event = undefined; fallback = undefined; ctx = undefined;
    if (global[ROW_KEY] === host) delete global[ROW_KEY];
    listeners.clear();
  });
}
