import {
  AssistantMessageComponent,
  InteractiveMode,
  ToolExecutionComponent,
  UserMessageComponent,
  parseSkillBlock,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

const TIMESTAMP = Symbol.for("pi.message-timestamps.timestamp.v1");
const WRAPPER = Symbol.for("pi.message-timestamps.wrapper.v1");
const ALPS_WRAPPER = Symbol.for("alps.pi.wrappedRender.v2");
const RENDERER_WIDGET = "pi.message-timestamps.renderer-capture";
// Pi does not expose these component/session fields in its public types.
// Keep the runtime adaptation here, rather than changing installed Pi/alps files.
type Runtime = any;

export function formatMessageTimestamp(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function plain(text: string): string {
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;:]*m/g, "");
}

/** Decorate only alps USER/ASSISTANT/TOOL headers; never change message content. */
export function addHeaderTimestamp(
  lines: string[], width: number, stamp: string,
  color: (text: string) => string = text => text,
): string[] {
  const index = lines.findIndex(line => plain(line).trim().length > 0);
  const header = lines[index];
  if (!header || !/^[╭┌]?─ (?:USER|ASSISTANT|TOOL)(?: ─| )/.test(plain(header))) return lines;
  if (/ ─ \d{2}\/\d{2} \d{2}:\d{2}:\d{2}(?: |$)/.test(plain(header))) return lines;
  // Also support straight separator titles without rounded frame corners.
  // Anchor to the trailing border, not the dash between label and token count.
  const border = / (?:─+[╮┐]?|[╮┐])(?=(?:\x1b\[[0-9;:]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)| )*$)/.exec(header);
  if (!border) return lines;
  const prefix = header.slice(0, border.index);
  const right = /[╮┐]$/.exec(border[0])?.[0] ?? "";
  const time = ` ─ ${stamp}`;
  const dashes = Math.floor(width) - visibleWidth(prefix + time + " " + right);
  // Keep the original title/closed frame on terminals too narrow for a full timestamp.
  if (!Number.isFinite(dashes) || dashes < 0) return lines;
  const borderStyle = /(?:\x1b\[[0-9;:]*m)+$/.exec(prefix)?.[0] ?? "";
  const title = borderStyle ? prefix.slice(0, -borderStyle.length) : prefix;
  const suffix = header.slice(border.index + border[0].length);
  const result = [...lines];
  result[index] = title + color(time) + borderStyle + " " + "─".repeat(dashes) + right + suffix;
  return result;
}

function userText(message: Runtime): string {
  const content = message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.filter((block: Runtime) => block?.type === "text").map((block: Runtime) => block.text).join("") : "";
  return parseSkillBlock(text)?.userMessage ?? text;
}

export default function messageTimestamps(pi: ExtensionAPI) {
  const owner = {};
  const patches: Array<{ target: Runtime; key: string; original: Function; wrapped: Function }> = [];
  let sessionManager: Runtime;
  let ui: Runtime;
  let active = false;
  let visible = true;
  let renderer: Runtime;
  let assigned = new WeakMap<object, number>();
  let claimed = new Set<Runtime>();

  function patch(target: Runtime, key: string, create: (original: Function) => Function) {
    if (!target || typeof target[key] !== "function") return;
    if (target[key][WRAPPER]?.owner === owner) return;
    const original = target[key];
    const wrapped = create(original);
    // Preserve alps' ownership marker so its enable/disable/reload logic does
    // not mistake this transparent decorator for a conflicting frame renderer.
    const metadata = Object.getOwnPropertyDescriptor(original, ALPS_WRAPPER);
    if (metadata) Object.defineProperty(wrapped, ALPS_WRAPPER, metadata);
    Object.defineProperty(wrapped, WRAPPER, { value: { owner } });
    target[key] = wrapped;
    patches.push({ target, key, original, wrapped });
  }

  function timestamp(instance: Runtime, kind: "user" | "assistant" | "tool"): number | undefined {
    const native = kind === "assistant" ? instance.lastMessage?.timestamp : instance[TIMESTAMP];
    if (formatMessageTimestamp(native)) return native;
    if (kind === "assistant") return;
    const previous = assigned.get(instance);
    if (previous !== undefined) return previous;
    if (kind === "tool") {
      // Pi does not persist the exact execution-start time. Restored tool rows
      // use the originating assistant tool-call timestamp, not the reload clock.
      const branch = sessionManager?.getBranch?.();
      const messages = branch?.map((entry: Runtime) => entry.message).filter(Boolean)
        ?? sessionManager?.buildSessionContext?.().messages ?? [];
      let resultTime = instance.result?.timestamp;
      for (const message of messages) {
        if (message.role === "assistant" && Array.isArray(message.content)
          && message.content.some((block: Runtime) => block.type === "toolCall" && block.id === instance.toolCallId)
          && formatMessageTimestamp(message.timestamp)) {
          assigned.set(instance, message.timestamp);
          return message.timestamp;
        }
        if (message.role === "toolResult" && message.toolCallId === instance.toolCallId) resultTime = message.timestamp;
      }
      // Imported sessions can contain results without their original call message.
      if (formatMessageTimestamp(resultTime)) {
        assigned.set(instance, resultTime);
        return resultTime;
      }
      return;
    }
    // Already-rendered user components have no timestamp in Pi 1.0.
    // Match persisted messages in branch order; duplicate prompts consume distinct entries.
    const messages = sessionManager?.buildSessionContext?.().messages ?? [];
    for (const message of messages) {
      if (message?.role !== "user" || claimed.has(message)) continue;
      if (userText(message) !== instance.text || !formatMessageTimestamp(message.timestamp)) continue;
      claimed.add(message);
      assigned.set(instance, message.timestamp);
      instance[TIMESTAMP] = message.timestamp;
      return message.timestamp;
    }
  }

  function install() {
    // session_start handlers run in extension order. Alps may install its
    // renderers AFTER our handler. Reconcile at Pi's post-startup rebuild and
    // event/message boundaries, before any message component gets rendered.
    // No timer/polling or manual /timestamps activation is needed.
    for (const key of ["renderSessionItems", "handleEvent"]) {
      patch(InteractiveMode.prototype, key, original => function (this: Runtime, ...args: unknown[]) {
        if (active) {
          renderer = this.ui ?? renderer;
          install();
        }
        return original.apply(this, args);
      });
    }
    // Capture the actual timestamp as Pi creates/rebuilds user components.
    // This avoids guessing from render time, prompt text, or message numbering.
    patch(InteractiveMode.prototype, "addMessageToChat", original => function (this: Runtime, message: Runtime, ...args: unknown[]) {
      if (active) {
        renderer = this.ui ?? renderer;
        install();
      }
      const children = this.chatContainer?.children;
      const start = Array.isArray(children) ? children.length : 0;
      const result = original.call(this, message, ...args);
      if (active && message?.role === "user" && formatMessageTimestamp(message.timestamp)) {
        for (const child of this.chatContainer?.children?.slice(start) ?? []) {
          if (child instanceof UserMessageComponent) child[TIMESTAMP] = message.timestamp;
        }
      }
      return result;
    });
    patch(ToolExecutionComponent.prototype, "markExecutionStarted", original => function (this: Runtime, ...args: unknown[]) {
      if (active && !formatMessageTimestamp(this[TIMESTAMP])) this[TIMESTAMP] = Date.now();
      return original.apply(this, args);
    });
    for (const [component, kind] of [
      [UserMessageComponent, "user"], [AssistantMessageComponent, "assistant"], [ToolExecutionComponent, "tool"],
    ] as const) {
      // Never place our decorator underneath Alps: raw SDK output has no
      // frame title to decorate, and Alps would save our wrapper as its base
      // renderer. Wait for its actual frame renderer, then wrap on the outside.
      if (!Object.getOwnPropertyDescriptor(component.prototype.render, ALPS_WRAPPER)) continue;
      patch(component.prototype, "render", original => function (this: Runtime, width: number) {
        const lines = original.call(this, width);
        if (!active) return lines;
        if (kind === "tool") renderer = this.ui ?? renderer;
        if (!visible) return lines;
        const stamp = formatMessageTimestamp(timestamp(this, kind));
        return stamp && Array.isArray(lines)
          ? addHeaderTimestamp(lines, width, stamp, text => ui?.theme?.fg("dim", text) ?? text) : lines;
      });
    }
  }

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    active = true;
    sessionManager = ctx.sessionManager;
    ui = ctx.ui;
    assigned = new WeakMap();
    claimed = new Set();
    install();
  });
  pi.on("resources_discover", (_event, ctx) => {
    if (!active || !ctx.hasUI || ctx.mode !== "tui") return;
    // Resume/reload uses renderBeforeBind: history may already be built/painted
    // before any session_start handler. AgentSession.bindExtensions emits this
    // event AFTER every session_start handler, so Alps is ready regardless of
    // load order. Reconnect now; do not wait for the next user/model event.
    install();
    // The public widget factory exposes Pi's stable TUI reference. Capture it
    // synchronously, then remove our zero-height widget before a frame is drawn.
    // This does not replace the user's header/footer/editor or leave UI spacing.
    try {
      ctx.ui.setWidget(RENDERER_WIDGET, tui => {
        renderer = tui;
        return { render: () => [], invalidate() {} };
      });
    } finally {
      ctx.ui.setWidget(RENDERER_WIDGET, undefined);
    }
    // Fullscreen transcript/layout caches can contain the pre-bind rows.
    // requestRender alone does not clear them after render prototypes change.
    renderer?.invalidate?.();
    renderer?.requestRender?.(true);
  });
  pi.registerCommand("timestamps", {
    description: "标题时间戳：hide 隐藏，show 显示，toggle 切换；无参数检查状态",
    handler: async (args, ctx) => {
      if (!ctx.hasUI || ctx.mode !== "tui") {
        ctx.ui.notify("消息时间戳仅在 Pi 交互界面中显示。", "info");
        return;
      }
      const action = args.trim().toLowerCase();
      if (action && !["hide", "show", "toggle", "status", "隐藏", "显示"].includes(action)) {
        ctx.ui.notify("用法：/timestamps hide | show | toggle | status", "warning");
        return;
      }
      if (action === "hide" || action === "隐藏") visible = false;
      if (action === "show" || action === "显示") visible = true;
      if (action === "toggle") visible = !visible;
      if (active) install();
      const user = (UserMessageComponent.prototype.render as Runtime)[WRAPPER]?.owner === owner;
      const assistant = (AssistantMessageComponent.prototype.render as Runtime)[WRAPPER]?.owner === owner;
      const tool = (ToolExecutionComponent.prototype.render as Runtime)[WRAPPER]?.owner === owner;
      ctx.ui.notify(`消息时间戳：${active ? "已启用" : "未启用"}；USER 挂钩：${user ? "正常" : "未接入"}；ASSISTANT 挂钩：${assistant ? "正常" : "未接入"}；TOOL 挂钩：${tool ? "正常" : "未接入"}；时间戳${visible ? "显示" : "隐藏"}。`, "info");
      renderer?.invalidate?.();
      renderer?.requestRender?.(true);
    },
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    active = false;
    // Restore only hooks we still own; never overwrite another extension's replacement.
    for (const { target, key, original, wrapped } of patches.reverse()) {
      if (target[key] === wrapped) target[key] = original;
    }
    patches.length = 0;
    sessionManager = undefined;
    ui = undefined;
    renderer = undefined;
    assigned = new WeakMap();
    claimed.clear();
  });
}
