import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { ENTRY_TYPE, isRoundResult, RoundTimer, type RoundResult } from "./timer.ts";
import { createSoundPlayer, type SoundPlayer } from "./sound.ts";

const WIDGET_KEY = "working-timer";
/** Set by the openai-quota extension; absent when that extension is not installed. */
const QUOTA_ROW_KEY = Symbol.for("pi.extensions.quota-row.v1");
/** Below this many columns the timer keeps its own line and quota docks beneath. */
const MIN_TIMER_COLUMNS = 24;
type QuotaRowHost = {
  render(theme: unknown, now: number): string | undefined;
  subscribe(listener: () => void): () => void;
  claim(): () => void;
};

// Read the host lazily on every render: load order between extensions is not guaranteed.
function quotaRowHost(): QuotaRowHost | undefined {
  const host = (globalThis as Record<symbol, unknown>)[QUOTA_ROW_KEY] as Partial<QuotaRowHost> | undefined;
  return host && typeof host.render === "function" && typeof host.subscribe === "function" && typeof host.claim === "function"
    ? (host as QuotaRowHost) : undefined;
}

export default function workingTimer(pi: ExtensionAPI, options: { createPlayer?: () => SoundPlayer; now?: () => number } = {}) {
  const timer = new RoundTimer(options.now);
  let sound: SoundPlayer | undefined;
  let audioWarningShown = false;
  const stopSound = () => { sound?.dispose(); sound = undefined; };
  const playSound = (ctx: ExtensionContext) => {
    sound ??= (options.createPlayer ?? createSoundPlayer)();
    sound.play(() => {
      if (audioWarningShown) return;
      audioWarningShown = true;
      ctx.ui.notify("提示音播放失败，请检查插件内音频文件、系统音量和音频输出设备。", "warning");
    });
  };
  let ticker: ReturnType<typeof setInterval> | undefined;
  let render: (() => void) | undefined;
  let runSignal: AbortSignal | undefined;
  let unsubscribeInput: (() => void) | undefined;
  let unsubscribeQuota: (() => void) | undefined;
  let releaseQuotaRow: (() => void) | undefined;
  let interrupted = false;
  let promptDepth = 0;

  const stopTicker = () => {
    if (ticker) clearInterval(ticker);
    ticker = undefined;
  };
  const refresh = () => render?.();
  const interactive = (ctx: ExtensionContext) => ctx.hasUI && ctx.mode === "tui";

  /** One row: timer first, allowance right after it. Falls back to a second line when narrow. */
  const renderRow = (width: number, theme: Theme): string[] => {
    const lines = timer.render(width, theme);
    if (width <= 0) return lines;
    const segment = quotaRowHost()?.render(theme, Date.now());
    if (typeof segment !== "string") return lines;
    const segmentWidth = visibleWidth(segment);
    if (segmentWidth <= 0) return lines;
    const SEPARATOR = "  │  "; // 5 columns.
    const separatorWidth = visibleWidth(SEPARATOR);
    const rest = lines.slice(1);
    const join = (text: string) => [truncateToWidth(`${text}${SEPARATOR}${segment}`, width), ...rest];
    const head = lines[0];
    // Before the first round the timer draws nothing: the allowance then owns the row alone.
    if (head === undefined) return [truncateToWidth(segment, width)];
    // Prefer the timer's natural text: only narrow it when the joined line would overflow.
    if (visibleWidth(head) + separatorWidth + segmentWidth <= width) return join(head);
    const leftWidth = width - separatorWidth - segmentWidth;
    if (leftWidth >= MIN_TIMER_COLUMNS) {
      const left = timer.render(leftWidth, theme)[0];
      if (left !== undefined) return join(left);
    }
    // Never squeeze the timer into an unreadable stub; dock the allowance beneath instead.
    return [...lines, truncateToWidth(segment, width)];
  };

  const attach = (ctx: ExtensionContext) => {
    stopSound();
    audioWarningShown = false;
    const results: RoundResult[] = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === ENTRY_TYPE && isRoundResult(entry.data)) {
        results.push(entry.data);
      }
    }
    stopTicker();
    timer.restore(results);
    runSignal = undefined;
    interrupted = false;
    promptDepth = 0;
    unsubscribeInput?.();
    unsubscribeInput = ctx.ui.onTerminalInput(data => {
      // Observe only: Pi still handles the configured interrupt key itself.
      // Retry/compaction have a separate abort controller, not ctx.signal.
      if (timer.active && promptDepth === 0 && getKeybindings().matches(data, "app.interrupt")) {
        interrupted = true;
      }
      return undefined;
    });
    // Share the working-timer row with the quota extension, if it is installed.
    unsubscribeQuota?.();
    releaseQuotaRow?.();
    releaseQuotaRow = undefined;
    const quotaHost = quotaRowHost();
    unsubscribeQuota = quotaHost?.subscribe(() => render?.());
    releaseQuotaRow = quotaHost?.claim();
    ctx.ui.setWorkingVisible(false); // Replace normal Working; retain native retry/compaction diagnostics.
    ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
      render = () => tui.requestRender();
      return {
        render: (width) => renderRow(width, theme),
        invalidate() {}, // Colors/layout are recomputed for every render.
        dispose() {
          stopTicker();
          stopSound();
          render = undefined;
        },
      };
    }, { placement: "belowEditor" });
  };

  pi.registerCommand("sound-test", {
    description: "播放回复结束提示音（不调用模型）",
    handler: async (_args, ctx) => { if (interactive(ctx)) playSound(ctx); },
  });

  pi.on("session_start", (_event, ctx) => {
    if (interactive(ctx)) attach(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    if (interactive(ctx)) attach(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!interactive(ctx)) return;
    timer.start();
    interrupted = false;
    runSignal = ctx.signal;
    timer.waiting();
    if (!ticker) {
      ticker = setInterval(refresh, 120);
      ticker.unref();
    }
    refresh();
  });

  pi.on("message_start", (event, ctx) => {
    if (!interactive(ctx) || !timer.active || event.message.role !== "assistant") return;
    runSignal = ctx.signal ?? runSignal;
    timer.waiting();
    refresh();
  });
  pi.on("message_update", (event, ctx) => {
    if (!interactive(ctx) || !timer.active) return;
    const streamEvent = event.assistantMessageEvent;
    if (streamEvent.type === "text_delta" || streamEvent.type === "thinking_delta" || streamEvent.type === "toolcall_delta") {
      interrupted = false; // If Pi continues generating, the key did not cancel this run.
      timer.generating();
      refresh();
    }
  });
  pi.on("message_end", (event, ctx) => {
    if (!interactive(ctx) || event.message.role !== "assistant") return;
    timer.observeStop(event.message.stopReason);
    refresh();
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (!interactive(ctx)) return;
    timer.toolStart(event.toolCallId, event.toolName);
    refresh();
  });
  pi.on("tool_execution_end", (event, ctx) => {
    if (!interactive(ctx)) return;
    // A failed tool can be recovered by the model; it is not a failed whole round.
    timer.toolEnd(event.toolCallId);
    refresh();
  });

  pi.on("ui_prompt_start", (_event, ctx) => {
    if (interactive(ctx)) promptDepth++;
  });
  pi.on("ui_prompt_end", (_event, ctx) => {
    if (interactive(ctx)) promptDepth = Math.max(0, promptDepth - 1);
  });

  pi.on("agent_before_settle", (event, ctx) => {
    if (interactive(ctx)) timer.observeStop(event.outcome === "completed" ? "stop"
      : event.outcome === "aborted" ? "aborted" : "error");
  });
  // agent_end is NOT final: retries, compression and queued work may follow it.
  pi.on("agent_settled", (_event, ctx) => {
    if (!interactive(ctx) || !timer.active) return;
    if (interrupted || runSignal?.aborted) timer.observeStop("aborted");
    stopTicker();
    const result = timer.finish();
    runSignal = undefined;
    if (result) pi.appendEntry(ENTRY_TYPE, result); // Session metadata, never sent to the model.
    refresh();
    // Only final settlement rings: never agent_end, restored history or retries.
    if (result) playSound(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopTicker();
    stopSound();
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    unsubscribeQuota?.();
    unsubscribeQuota = undefined;
    releaseQuotaRow?.(); // Hand the shared row back so the quota widget can own it again.
    releaseQuotaRow = undefined;
    interrupted = false;
    runSignal = undefined;
    if (interactive(ctx)) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      ctx.ui.setWorkingVisible(true);
    }
    render = undefined;
  });
}
