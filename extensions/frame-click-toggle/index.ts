import {
  AssistantMessageComponent, BashExecutionComponent, BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent, CustomMessageComponent, SkillInvocationMessageComponent,
  ToolExecutionComponent, VERSION, type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  Box, Container, getOsc8LinkAtColumn, stripTerminalSequences, visibleWidth, wrapTextWithAnsi,
  type TuiMouseEvent, type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

// Keep this exact-version allowlist: internal mouse/component APIs need regression testing.
const VERIFIED_PI_VERSIONS = new Set(["1.0.4", "1.1.0"]);
// Read-only adaptation of the installed ALPS v18 renderer. No core/package writes.
const ALPS_RENDER = Symbol.for("alps.pi.wrappedRender.v2");
const ALPS_CACHE = Symbol.for("alps.pi.renderCache.v9");
const ALPS_STATE = Symbol.for("alps.pi.patch.v1");
const OWNER = Symbol.for("pi.frame-click-toggle.owner.v1");
type Kind = "tool" | "thinking" | "expandable";
type MouseHandler = (this: RuntimeComponent, event: TuiMouseEvent) => TuiMouseEventResult | undefined;
type RendererComponent = { handleMouse?: unknown; children?: RendererComponent[] };
type RuntimeComponent = {
  render: (width: number) => string[];
  handleMouse?: MouseHandler;
  expanded?: boolean;
  result?: unknown;
  toolName?: string;
  hideThinkingBlock?: boolean;
  hideComponent?: boolean;
  lastMessage?: { content?: Array<{ type: string; thinking?: string; text?: string }> };
  thinkingVisibilityOverrides?: Map<number, boolean>;
  setExpanded?: (expanded: boolean) => void;
  setHideThinkingBlock?: (hidden: boolean) => void;
  callRendererComponent?: RendererComponent;
  resultRendererComponent?: RendererComponent;
  imageComponents?: unknown[];
  [key: symbol]: unknown;
};
type Cache = { width: number; innerKey: string; lines: string[] };
export type Geometry = {
  width: number; height: number; lines: string[];
  innerWidth: number; innerHeight: number;
  rows: Array<{ sourceY: number; sourceX: number }> | undefined;
};

function config(): { toolCompactMode?: string; compactEditTool?: boolean } | undefined {
  const state = (globalThis as unknown as Record<symbol, unknown>)[ALPS_STATE] as
    { enabled?: boolean; config?: { settings?: { chromeFrame?: { toolCompactMode?: string; compactEditTool?: boolean } } } } | undefined;
  return state?.enabled ? state.config?.settings?.chromeFrame : undefined;
}

/** Use the LAST displayed frame, never rerender a component during hit testing. */
export function frameGeometry(instance: RuntimeComponent, event: TuiMouseEvent, kind: Kind): Geometry | undefined {
  const metadata = (instance.render as unknown as Record<symbol, { version?: number }>)[ALPS_RENDER];
  if (metadata?.version !== 18 || instance.hideComponent) return;
  const cache = instance[ALPS_CACHE] as Cache | undefined;
  if (!cache || cache.width !== event.width || cache.lines.length !== event.height || event.width < 8) return;
  if (event.x < 0 || event.x >= event.width || event.y < 0 || event.y >= event.height) return;
  const text = cache.lines.map(stripTerminalSequences);
  if (!text[0]?.startsWith("╭─ ") || !text[0].endsWith("╮") || !text.at(-1)?.startsWith("╰") || !text.at(-1)?.endsWith("╯")) return;
  // Aggregated Tools ×N frames have different ownership, not one expandable item.
  if (/^╭─ Tools ×/.test(text[0])) return;
  const settings = config();
  const compact = kind === "tool" && !instance.expanded && settings?.toolCompactMode === "compact"
    && (instance.toolName !== "edit" || settings.compactEditTool === true);
  const raw = cache.innerKey.split("\n");
  const geometry: Geometry = { width: event.width, height: event.height, lines: cache.lines,
    innerWidth: event.width - 4, innerHeight: raw.length, rows: undefined };
  // Compact summary rows are a lossy projection: NEVER send their coordinates
  // to the hidden native result. The whole-frame fallback can still expand them.
  if (compact || (instance.imageComponents?.length ?? 0) > 0
    || text[0].startsWith("╭─ THINK") && instance.hideThinkingBlock) return geometry;
  let first = 0, last = raw.length;
  while (first < last && !stripTerminalSequences(raw[first]).trim()) first++;
  while (last > first && !stripTerminalSequences(raw[last - 1]).trim()) last--;
  const rows: NonNullable<Geometry["rows"]> = [];
  const rendered: string[] = [];
  for (let row = first; row < last; row++) {
    const segments = wrapTextWithAnsi(raw[row], geometry.innerWidth);
    let sourceX = 0;
    for (const segment of segments.length ? segments : [""]) {
      rows.push({ sourceY: row, sourceX });
      rendered.push(stripTerminalSequences(segment));
      sourceX += visibleWidth(segment);
    }
  }
  // Guard sanitizer/image/future layout changes. Only forward child events when
  // the visible projection is exact; do not guess at y+1 or recompute heights.
  if (rendered.length === text.length - 2 && rendered.every((line, i) =>
    text[i + 1].startsWith("│ ") && text[i + 1].endsWith(" │")
      && text[i + 1].slice(2, -2).trimEnd() === line.trimEnd())) geometry.rows = rows;
  return geometry;
}

function mappedEvent(geometry: Geometry, event: TuiMouseEvent): TuiMouseEvent | undefined {
  if (event.x < 2 || event.x >= geometry.width - 2 || event.y < 1 || event.y >= geometry.height - 1) return;
  const row = geometry.rows?.[event.y - 1];
  if (!row) return;
  return { ...event, x: event.x - 2 + row.sourceX, y: row.sourceY,
    width: geometry.innerWidth, height: geometry.innerHeight };
}

function onlyThinking(instance: RuntimeComponent): boolean {
  const content = instance.lastMessage?.content;
  return !!content?.some(block => block.type === "thinking" && block.thinking?.trim())
    && !content.some(block => block.type === "text" && block.text?.trim());
}

/** Container/Box routing is not a control; only unknown handlers or interactive descendants are. */
function hasInteractiveRenderer(component: RendererComponent | undefined, seen = new Set<RendererComponent>()): boolean {
  if (!component) return false;
  if (seen.has(component)) return true; // Cyclic/custom trees fail closed.
  seen.add(component);
  const handler = component.handleMouse;
  const passiveRouter = component instanceof Container && handler === Container.prototype.handleMouse
    || component instanceof Box && handler === Box.prototype.handleMouse;
  if (handler && !passiveRouter) return true;
  return component.children?.some(child => hasInteractiveRenderer(child, seen)) ?? false;
}

/** Called only after Pi recognized a click (press/release without a drag). */
export function handleFrameMouse(
  instance: RuntimeComponent, event: TuiMouseEvent, kind: Kind, original?: MouseHandler,
): TuiMouseEventResult | undefined {
  if (event.type === "click" && (event.x < 0 || event.x >= event.width || event.y < 0 || event.y >= event.height)) return;
  const geometry = frameGeometry(instance, event, kind);
  if (!geometry) return original?.call(instance, event);
  // Preserve hyperlink routing, selection modifiers and multi-click selection.
  if (event.type === "click" && (event.button !== "left" || event.ctrl || event.alt || event.shift || (event.clickCount ?? 1) !== 1)) return;
  if (event.type === "click" && getOsc8LinkAtColumn(geometry.lines[event.y], event.x)) return;
  const mapped = mappedEvent(geometry, event);
  if (mapped) {
    const result = original?.call(instance, mapped);
    if (result?.handled || result?.capture || result?.focus) return result;
  } else if (!geometry.rows && event.x >= 2 && event.x < geometry.width - 2
    && event.y >= 1 && event.y < geometry.height - 1
    && (hasInteractiveRenderer(instance.callRendererComponent) || hasInteractiveRenderer(instance.resultRendererComponent))) {
    // A lossy projection cannot address hidden controls. Never forward framed
    // coordinates to the native tree (that can rerender it at the wrong width).
    // Leave the body alone; header/borders still expand to reveal the controls.
    return;
  }
  if (event.type !== "click" || event.button !== "left") return;
  if (kind === "thinking") {
    // Mixed text/thinking messages retain native thinking-region dispatch above;
    // never invent collapsing of ordinary assistant text.
    if (!onlyThinking(instance) || !instance.setHideThinkingBlock) return;
    const hidden = instance.thinkingVisibilityOverrides?.get(0) ?? !!instance.hideThinkingBlock;
    instance.setHideThinkingBlock(!hidden);
    return { handled: true, render: true };
  }
  if (kind === "tool" && !instance.result) return;
  if (typeof instance.expanded !== "boolean" || !instance.setExpanded) return;
  instance.setExpanded(!instance.expanded);
  return { handled: true, render: true };
}

export default function frameClickToggle(pi: ExtensionAPI) {
  const owner = {};
  const patches: Array<{ prototype: RuntimeComponent; original?: PropertyDescriptor; wrapped: MouseHandler }> = [];
  let active = false;
  let enabled = true;
  const targets: Array<[unknown, Kind]> = [
    [ToolExecutionComponent, "tool"], [AssistantMessageComponent, "thinking"],
    [BashExecutionComponent, "expandable"], [BranchSummaryMessageComponent, "expandable"],
    [CompactionSummaryMessageComponent, "expandable"], [SkillInvocationMessageComponent, "expandable"],
    [CustomMessageComponent, "expandable"],
  ];
  function install() {
    for (const [ctor, kind] of targets) {
      const prototype = (ctor as { prototype?: RuntimeComponent })?.prototype;
      if (!prototype || typeof prototype.render !== "function") continue;
      const current = prototype.handleMouse;
      if ((current as unknown as Record<symbol, object> | undefined)?.[OWNER] === owner) continue;
      // Do not wrap an unknown replacement after losing ownership.
      if (patches.some(patch => patch.prototype === prototype)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "handleMouse");
      const wrapped: MouseHandler = function (event) {
        return active && enabled ? handleFrameMouse(this, event, kind, current) : current?.call(this, event);
      };
      Object.defineProperty(wrapped, OWNER, { value: owner });
      Object.defineProperty(prototype, "handleMouse", { configurable: true, writable: true, value: wrapped });
      patches.push({ prototype, original: descriptor, wrapped });
    }
  }
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    if (!VERIFIED_PI_VERSIONS.has(VERSION)) {
      ctx.ui.notify(`整框单击适配尚未验证 Pi ${VERSION}，保留原行为。`, "warning");
      return;
    }
    active = true;
    install();
  });
  pi.on("resources_discover", (_event, ctx) => {
    if (ctx.mode === "tui" && ctx.hasUI && active) install();
  });
  pi.registerCommand("frame-clicks", {
    description: "整框单击展开/收缩：on、off、status（只影响本次扩展运行）",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (!["", "on", "off", "status"].includes(action)) {
        ctx.ui.notify("用法：/frame-clicks on | off | status", "warning"); return;
      }
      if (action === "on") enabled = true;
      if (action === "off") enabled = false;
      ctx.ui.notify(`整框单击：${active && enabled ? "开启" : "关闭"}；适配 ALPS renderer v18 / cache v9；未知框布局保留原行为。`, "info");
    },
  });
  pi.on("session_shutdown", () => {
    active = false;
    for (const patch of patches.reverse()) {
      if (patch.prototype.handleMouse !== patch.wrapped) continue;
      if (patch.original) Object.defineProperty(patch.prototype, "handleMouse", patch.original);
      else delete patch.prototype.handleMouse;
    }
    patches.length = 0;
  });
}
