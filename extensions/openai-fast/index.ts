import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const STATUS_KEY = "openai-fast";
export const ENTRY_TYPE = "openai-fast/state/v1";
export const ICON = "⚡";

type FastState = { v: 1; enabled: boolean };
type Payload = Record<string, unknown>;

function isRecord(value: unknown): value is Payload {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFastState(value: unknown): value is FastState {
  return isRecord(value) && value.v === 1 && typeof value.enabled === "boolean";
}

/** Pure payload transform: no auth access, hidden retries, or in-place mutation. */
export function applyFastMode(payload: unknown, enabled: boolean): unknown {
  if (!isRecord(payload)) return undefined;
  if (enabled) return { ...payload, service_tier: "priority" };
  // Also make /fast no effective if models.json supplies a fast/priority override.
  if (payload.service_tier === "priority" || payload.service_tier === "fast") {
    return { ...payload, service_tier: "default" };
  }
  return undefined;
}

export default function openaiFast(pi: ExtensionAPI) {
  let enabled = false;

  const syncStatus = (ctx: ExtensionContext, provider = ctx.model?.provider) => {
    if (!ctx.hasUI) return;
    // ALPS docks this reserved status immediately before its workspace folder.
    // Other footers can use Pi's ordinary status display; never replace a footer.
    ctx.ui.setStatus(STATUS_KEY, enabled && provider === "openai" ? ICON : undefined);
  };
  const restore = (ctx: ExtensionContext) => {
    enabled = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === ENTRY_TYPE && isFastState(entry.data)) {
        enabled = entry.data.enabled;
      }
    }
    syncStatus(ctx);
  };

  pi.registerCommand("fast", {
    description: "OpenAI 加速请求：/fast ok 开启，/fast no 关闭；/fast 查看状态",
    getArgumentCompletions: prefix => {
      const items = ["ok", "no"].filter(value => value.startsWith(prefix));
      return items.length ? items.map(value => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();
      if (value && value !== "ok" && value !== "no") {
        ctx.ui.notify("用法：/fast ok 开启，/fast no 关闭，/fast 查看状态。", "warning");
        return;
      }
      if (value) {
        const next = value === "ok";
        if (enabled !== next) {
          pi.appendEntry<FastState>(ENTRY_TYPE, { v: 1, enabled: next });
          enabled = next;
        }
      }
      syncStatus(ctx);
      if (ctx.model?.provider !== "openai") {
        ctx.ui.notify(`Fast ${enabled ? "已开启" : "已关闭"}；当前不是 openai 模型，不修改当前请求，也不显示闪电。`, "info");
      } else if (enabled) {
        ctx.ui.notify("⚡ Fast 已开启：请求 service_tier=priority。图标表示请求开关，不保证服务端 Fast 档位；可能增加额度消耗。", "info");
      } else {
        ctx.ui.notify("Fast 已关闭：不请求 priority/fast 加速。", "info");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("model_select", (event, ctx) => syncStatus(ctx, event.model.provider));
  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    if (model?.provider !== "openai" || !isRecord(event.payload)) return;
    // The hook's context describes the selected model, not necessarily a helper
    // request. Do not alter background/summary requests for a different model.
    if (event.payload.model !== model.id) return;
    return applyFastMode(event.payload, enabled);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
