import { performance } from "node:perf_hooks";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { rgbColor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type Outcome = "completed" | "failed" | "cancelled";
export interface RoundResult {
  outcome: Outcome;
  elapsedMs: number;
}
export const ENTRY_TYPE = "working-timer:round:v1";
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function formatDuration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return seconds >= 3600
    ? `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`
    : `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

export function isRoundResult(value: unknown): value is RoundResult {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<RoundResult>;
  return ["completed", "failed", "cancelled"].includes(item.outcome ?? "") &&
    typeof item.elapsedMs === "number" && Number.isFinite(item.elapsedMs) && item.elapsedMs >= 0;
}

/** One user-facing run, including tools, automatic retries and continuations. */
export class RoundTimer {
  active = false;
  activity = "等待响应";
  outcome: Outcome = "completed";
  last?: RoundResult;
  previous?: RoundResult;
  private startedAt = 0;
  private tools = new Map<string, string>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  start(): void {
    if (this.active) return; // A retry emits agent_start again: keep the original clock.
    this.active = true;
    this.startedAt = this.now();
    this.activity = "等待响应";
    this.outcome = "completed";
    this.tools.clear();
  }

  elapsed(): number {
    return this.active ? Math.max(0, this.now() - this.startedAt) : (this.last?.elapsedMs ?? 0);
  }

  generating(): void {
    if (this.active) this.activity = "生成回复";
  }

  waiting(): void {
    if (!this.active) return;
    this.activity = "等待响应";
  }

  toolStart(id: string, name: string): void {
    if (this.active) this.tools.set(id, name.replace(/[\x00-\x1f\x7f]/g, ""));
  }

  toolEnd(id: string): void {
    this.tools.delete(id);
    if (this.active && !this.tools.size) this.activity = "等待响应";
  }

  get phase(): string {
    if (!this.tools.size) return this.activity;
    const first = this.tools.values().next().value;
    return `工具执行 · ${first}${this.tools.size > 1 ? ` +${this.tools.size - 1}` : ""}`;
  }

  observeStop(reason: string): void {
    if (!this.active) return;
    this.outcome = reason === "error" ? "failed" : reason === "aborted" ? "cancelled" : "completed";
    if (this.outcome === "failed") this.activity = "请求失败，等待重试/结束";
  }

  finish(): RoundResult | undefined {
    if (!this.active) return undefined;
    const result: RoundResult = { outcome: this.outcome, elapsedMs: this.elapsed() };
    this.previous = this.last;
    this.last = result;
    this.active = false;
    this.tools.clear();
    return result;
  }

  restore(results: RoundResult[]): void {
    this.active = false;
    this.tools.clear();
    // Older entries may include TPS fields; retain only timing/outcome without
    // modifying historical session files or reviving removed speed UI.
    const timingOnly = (result: RoundResult | undefined) => result
      ? { outcome: result.outcome, elapsedMs: result.elapsedMs } : undefined;
    this.last = timingOnly(results.at(-1));
    this.previous = timingOnly(results.at(-2));
  }

  render(width: number, theme: Theme): string[] {
    if (width <= 0 || (!this.active && !this.last)) return [];
    const blue = theme.appearance === "light" ? rgbColor(40, 120, 185) : rgbColor(124, 189, 245);
    // Concrete red, rather than an arbitrary custom theme's error color.
    const red = theme.appearance === "light" ? rgbColor(192, 57, 43) : rgbColor(255, 107, 107);
    const outcome = this.active ? undefined : this.last!.outcome;
    const icon = this.active ? FRAMES[Math.floor(this.elapsed() / 120) % FRAMES.length]
      : outcome === "failed" ? "✗" : outcome === "cancelled" ? "⊘" : "✓";
    const label = this.active ? "Working" : outcome === "failed" ? "Failed"
      : outcome === "cancelled" ? "Cancelled" : "Completed";
    const color = this.active ? blue : outcome === "failed" ? red
      : outcome === "cancelled" ? "warning" : "success";
    let line = theme.style(`${icon} ${label}`, { fg: color, bold: true }) + "  " +
      theme.style(formatDuration(this.elapsed()), { fg: outcome === "failed" ? red : "text", bold: true });
    const previous = this.active ? this.last : this.previous;
    const tail = previous && width >= 76
      ? theme.fg("dim", `  ·  上轮 ${formatDuration(previous.elapsedMs)}`) : "";
    if (width >= 42) {
      const phase = this.active ? this.phase : outcome === "failed" ? "请求失败"
        : outcome === "cancelled" ? "已取消" : undefined;
      if (phase) {
        const separator = theme.fg("dim", "  ·  ");
        const available = Math.max(0, width - 1 - visibleWidth(line) - visibleWidth(separator) - visibleWidth(tail));
        const detail = outcome === "failed" ? theme.style(phase, { fg: red }) : theme.fg("muted", phase);
        if (available > 0) line += separator + truncateToWidth(detail, available);
      }
    }
    return [truncateToWidth(" " + line + tail, width)];
  }
}
