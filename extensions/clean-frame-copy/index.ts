import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Container, TuiAltScreen, sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

// Keep this exact-version allowlist: internal selection/layout APIs need regression testing.
const VERIFIED_PI_VERSIONS = new Set(["1.0.4", "1.1.0"]);
const ALPS_RENDER = Symbol.for("alps.pi.wrappedRender.v2");
const ALPS_CACHE = Symbol.for("alps.pi.renderCache.v9");
const OWNER = Symbol.for("pi.clean-frame-copy.owner.v1");
type Rect = { x: number; y: number; width: number; height: number };
type Component = {
  render?: unknown;
  mouseLayout?: { width: number; children: Array<{ component: Component; height: number }> };
  paddingX?: number; paddingY?: number;
  [key: symbol]: unknown;
};
type LayoutBox = { component: Component; rect: Rect; clip: Rect; children: LayoutBox[]; scrollView?: { scrollTop: number }; scrollContentLines?: string[] };
type Layout = { root: LayoutBox };
type Point = { row: number; col: number; boundary?: boolean; scrollView?: object };
type Selection = { start: Point; end: Point };
type Screen = {
  previousScreen: string[];
  implicitDocument?: Component;
  currentLayout?: Layout;
  hasOverlay?: () => boolean;
  getSelectionBounds: () => Selection | undefined;
  terminal: { columns: number };
  requestRender?: () => void;
  getSelectionColumns: (line: string, row: number, selection: Selection, minColumn?: number, maxColumn?: number) => { start: number; end: number };
  applySelectionHighlight: (text: string) => string;
  applySelection: (lines: string[], layout?: Layout) => string[];
  getActiveSelectionText: () => string | undefined;
};
type Interval = { start: number; end: number };
type RowMask = { frameStart: number; frameEnd: number; keep: Interval[] };
type CopyMethod = (this: Screen) => string | undefined;
type HighlightMethod = (this: Screen, lines: string[], layout?: Layout) => string[];
type SelectionPlan = { selection: Selection; source: string[]; masks: Map<number, RowMask[]>; scrollBox?: LayoutBox };

function findScrollBox(box: LayoutBox, scrollView: object): LayoutBox | undefined {
  if (box.scrollView === scrollView) return box;
  for (const child of box.children) {
    const found = findScrollBox(child, scrollView);
    if (found) return found;
  }
}

/** Only verified ALPS caches establish provenance; never recognize arbitrary text as a frame. */
function frameMasks(component: Component, x: number, y: number, width: number, height: number, source: string[]): RowMask[] | undefined {
  const metadata = (component.render as Record<symbol, { version?: number }> | undefined)?.[ALPS_RENDER];
  const cache = component[ALPS_CACHE] as { width?: number; lines?: string[] } | undefined;
  if (metadata?.version !== 18 || width < 8 || cache?.width !== width || cache.lines?.length !== height || height < 2) return;
  const cached = cache.lines.map(stripTerminalSequences);
  const actual: string[] = [];
  for (let i = 0; i < height; i++) {
    if (source[y + i] === undefined) return;
    actual.push(stripTerminalSequences(sliceByColumn(source[y + i], x, width, true)));
  }
  if (!cached[0]?.startsWith("╭─ ") || !cached[0].endsWith("╮") || !cached.at(-1)?.startsWith("╰") || !cached.at(-1)?.endsWith("╯")) return;
  // Timestamp decoration may alter the header only. Body and footer must match exactly.
  if (!actual[0].startsWith("╭─ ") || !actual[0].endsWith("╮") || visibleWidth(actual[0]) !== width
    || actual.slice(1).some((line, i) => line !== cached[i + 1])) return;
  const topSuffix = / ─*╮$/.exec(actual[0]);
  const bottom = /^╰─*(?: (.*) )?╯$/.exec(actual[height - 1]);
  if (!topSuffix || !bottom) return;
  const result: RowMask[] = [{ frameStart: x, frameEnd: x + width,
    keep: [{ start: x + 3, end: x + visibleWidth(actual[0].slice(0, topSuffix.index)) }] }];
  for (let i = 1; i < height - 1; i++) {
    const line = actual[i];
    if (visibleWidth(line) !== width || !line.startsWith("│ ") || !line.endsWith(" │")) return;
    result.push({ frameStart: x, frameEnd: x + width, keep: [{ start: x + 2, end: x + width - 2 }] });
  }
  const bottomKeep: Interval[] = [];
  if (bottom[1]) {
    const prefix = /^╰─* /.exec(actual[height - 1])![0];
    const start = x + visibleWidth(prefix);
    bottomKeep.push({ start, end: start + visibleWidth(bottom[1]) });
  }
  result.push({ frameStart: x, frameEnd: x + width, keep: bottomKeep });
  return result;
}

/** Shared provenance/masks for BOTH copy and highlight; never render inside this pass. */
function selectionPlan(screen: Screen, layout = screen.currentLayout): SelectionPlan | undefined {
  const selection = screen.getSelectionBounds();
  if (!selection || !layout || screen.hasOverlay?.()) return;
  let source = screen.previousScreen;
  let root = layout.root;
  let offsetX = 0, offsetY = 0;
  let scrollBox: LayoutBox | undefined;
  if (selection.start.scrollView) {
    const box = findScrollBox(root, selection.start.scrollView);
    if (!box?.scrollContentLines || !box.children[0] || !box.scrollView) return;
    scrollBox = box;
    source = box.scrollContentLines;
    root = box.children[0];
    offsetX = -box.rect.x;
    offsetY = box.scrollView.scrollTop - box.rect.y;
  }
  const masks = new Map<number, RowMask[]>();
  const visited = new Set<Component>();
  function visitComponent(component: Component, x: number, y: number, width: number, height: number) {
    if (y > selection!.end.row || y + height <= selection!.start.row || visited.has(component)) return;
    visited.add(component);
    const frame = frameMasks(component, x, y, width, height, source);
    if (frame) {
      for (let i = 0; i < frame.length; i++) {
        const row = y + i;
        const list = masks.get(row) ?? [];
        // Ambiguous overlap is not safe to alter. Leave the entire row untouched.
        list.push(frame[i]); masks.set(row, list);
      }
      return;
    }
    // A framed/unknown replacement has a hidden native layout: do not descend into it.
    if ((component.render as Record<symbol, unknown> | undefined)?.[ALPS_RENDER]) return;
    const mouse = component.mouseLayout;
    const isBox = component instanceof Box;
    if (!isBox && !(component instanceof Container)) return;
    const padX = isBox ? component.paddingX ?? 0 : 0;
    const padY = isBox ? component.paddingY ?? 0 : 0;
    const innerWidth = Math.max(1, width - 2 * padX);
    if (!mouse || mouse.width !== innerWidth || mouse.children.reduce((sum, child) => sum + child.height, 0) + 2 * padY !== height) return;
    let childY = y + padY;
    for (const child of mouse.children) {
      visitComponent(child.component, x + padX, childY, innerWidth, child.height);
      childY += child.height;
    }
  }
  function visitBox(box: LayoutBox) {
    if (box.children.length) {
      for (const child of box.children) visitBox(child);
    } else {
      const component = box.component === screen.implicitDocument ? screen as unknown as Component : box.component;
      visitComponent(component, box.rect.x + offsetX, box.rect.y + offsetY, box.rect.width, box.rect.height);
    }
  }
  visitBox(root);
  if (!masks.size) return;
  return { selection, source, masks, scrollBox };
}
function keptIntervals(mask: RowMask, width: number, start: number, end: number): Interval[] {
  return [{ start: 0, end: mask.frameStart }, ...mask.keep, { start: mask.frameEnd, end: width }]
    .map(range => ({ start: Math.max(range.start, start), end: Math.min(range.end, end) }))
    .filter(range => range.end > range.start);
}
/** Use the last layout/mouseLayout only: extraction MUST NOT rerender components. */
export function cleanSelectionText(screen: Screen, originalText: string): string {
  const plan = selectionPlan(screen);
  if (!plan) return originalText;
  const { selection, source, masks } = plan;
  const lines: string[] = [];
  for (let row = selection.start.row; row <= selection.end.row; row++) {
    const line = source[row] ?? "";
    const columns = screen.getSelectionColumns(line, row, selection);
    const rowMasks = masks.get(row);
    if (!rowMasks || rowMasks.length !== 1) {
      lines.push(stripTerminalSequences(sliceByColumn(line, columns.start, Math.max(0, columns.end - columns.start), true)).trimEnd());
      continue;
    }
    const mask = rowMasks[0];
    const intervals = keptIntervals(mask, visibleWidth(line), columns.start, columns.end);
    // Skip decorative-only rows, but preserve genuine empty body rows.
    if (!intervals.length) continue;
    lines.push(intervals.map(range => stripTerminalSequences(sliceByColumn(line, range.start, range.end - range.start, true))).join("").trimEnd());
  }
  // Empty string means "a real selection with only decorations", not "no selection".
  // This preserves hasActiveSelection() and prevents copying the last answer as a fallback.
  return lines.join("\n");
}

/** Paint only the same content cells used by copy; use the INCOMING layout, not the previous frame. */
export function cleanSelectionHighlight(screen: Screen, lines: string[], layout: Layout | undefined, native: string[]): string[] {
  const plan = selectionPlan(screen, layout);
  if (!plan) return native;
  const { selection, source, masks, scrollBox } = plan;
  let dx = 0, dy = 0, minRow = 0, maxRow = lines.length - 1, minColumn = 0, maxColumn = screen.terminal.columns;
  if (scrollBox) {
    if (!scrollBox.scrollView) return native;
    dx = scrollBox.rect.x; dy = scrollBox.rect.y - scrollBox.scrollView.scrollTop;
    minRow = Math.max(0, scrollBox.rect.y, scrollBox.clip.y);
    maxRow = Math.min(maxRow, scrollBox.rect.y + scrollBox.rect.height - 1, scrollBox.clip.y + scrollBox.clip.height - 1);
    minColumn = Math.max(0, dx, scrollBox.clip.x);
    maxColumn = Math.min(maxColumn, dx + scrollBox.rect.width, scrollBox.clip.x + scrollBox.clip.width);
  }
  const projected: Selection = {
    start: { ...selection.start, row: selection.start.row + dy, col: selection.start.col + dx },
    end: { ...selection.end, row: selection.end.row + dy, col: selection.end.col + dx },
  };
  return native.map((nativeLine, row) => {
    if (row < minRow || row > maxRow || row < projected.start.row || row > projected.end.row) return nativeLine;
    const line = lines[row];
    const rowMasks = masks.get(row - dy);
    if (line === undefined || rowMasks?.length !== 1) return nativeLine;
    const mask = rowMasks[0];
    const localSource = source[row - dy];
    // Indicators/overlays/clipped frames may change cells after layout rendering.
    // Do not alter an unverified visible frame or draw across its clip boundary.
    if (localSource === undefined || mask.frameStart + dx < minColumn || mask.frameEnd + dx > maxColumn
      || stripTerminalSequences(sliceByColumn(line, mask.frameStart + dx, mask.frameEnd - mask.frameStart, true))
        !== stripTerminalSequences(sliceByColumn(localSource, mask.frameStart, mask.frameEnd - mask.frameStart, true))) return nativeLine;
    const columns = screen.getSelectionColumns(line, row, projected, minColumn, maxColumn);
    if (columns.end <= columns.start) return nativeLine;
    const projectedMask: RowMask = { frameStart: mask.frameStart + dx, frameEnd: mask.frameEnd + dx,
      keep: mask.keep.map(range => ({ start: range.start + dx, end: range.end + dx })) };
    const intervals = keptIntervals(projectedMask, visibleWidth(line), columns.start, columns.end);
    if (!intervals.length) return line;
    let cursor = 0, result = "";
    for (const interval of intervals) {
      result += sliceByColumn(line, cursor, interval.start - cursor, true);
      result += screen.applySelectionHighlight(sliceByColumn(line, interval.start, interval.end - interval.start, true));
      cursor = interval.end;
    }
    return result + sliceByColumn(line, cursor, Math.max(0, visibleWidth(line) - cursor), true);
  });
}

export default function cleanFrameCopy(pi: ExtensionAPI) {
  const owner = {};
  const prototype = TuiAltScreen.prototype as unknown as Screen;
  let active = false, enabled = true, lastScreen: Screen | undefined;
  let patch: { copyOriginal: PropertyDescriptor; highlightOriginal: PropertyDescriptor; copy: CopyMethod; highlight: HighlightMethod } | undefined;
  const owned = () => !!patch && prototype.getActiveSelectionText === patch.copy && prototype.applySelection === patch.highlight;
  function install() {
    if (patch) return;
    const copyDescriptor = Object.getOwnPropertyDescriptor(prototype, "getActiveSelectionText");
    const highlightDescriptor = Object.getOwnPropertyDescriptor(prototype, "applySelection");
    if (typeof copyDescriptor?.value !== "function" || !copyDescriptor.configurable
      || typeof highlightDescriptor?.value !== "function" || !highlightDescriptor.configurable
      || typeof prototype.applySelectionHighlight !== "function") return;
    const copyOriginal = copyDescriptor.value as CopyMethod;
    const highlightOriginal = highlightDescriptor.value as HighlightMethod;
    const copy: CopyMethod = function () {
      lastScreen = this;
      const text = copyOriginal.call(this);
      if (!active || !enabled || !owned() || text === undefined) return text;
      try { return cleanSelectionText(this, text); } catch { return text; }
    };
    const highlight: HighlightMethod = function (lines, layout = this.currentLayout) {
      lastScreen = this;
      const native = highlightOriginal.call(this, lines, layout);
      if (!active || !enabled || !owned()) return native;
      try { return cleanSelectionHighlight(this, lines, layout, native); } catch { return native; }
    };
    Object.defineProperty(copy, OWNER, { value: owner });
    Object.defineProperty(highlight, OWNER, { value: owner });
    try {
      Object.defineProperty(prototype, "getActiveSelectionText", { ...copyDescriptor, value: copy });
      Object.defineProperty(prototype, "applySelection", { ...highlightDescriptor, value: highlight });
      patch = { copyOriginal: copyDescriptor, highlightOriginal: highlightDescriptor, copy, highlight };
    } catch {
      if (prototype.getActiveSelectionText === copy) Object.defineProperty(prototype, "getActiveSelectionText", copyDescriptor);
      if (prototype.applySelection === highlight) Object.defineProperty(prototype, "applySelection", highlightDescriptor);
    }
  }
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    if (!VERIFIED_PI_VERSIONS.has(VERSION)) { ctx.ui.notify(`选区去框尚未验证 Pi ${VERSION}，保留原行为。`, "warning"); return; }
    active = true; install();
    if (!owned()) ctx.ui.notify("选区去框未接入：接口不兼容或已有其他 hook，保留原行为。", "warning");
  });
  pi.registerCommand("clean-copy", {
    description: "ALPS 外框不参与选区高亮与复制：on、off、status（临时开关）",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (!["", "on", "off", "status"].includes(action)) { ctx.ui.notify("用法：/clean-copy on | off | status", "warning"); return; }
      if (action === "on") enabled = true;
      if (action === "off") enabled = false;
      if (action === "on" || action === "off") lastScreen?.requestRender?.();
      ctx.ui.notify(`高亮与复制去框：${active && enabled && owned() ? "开启" : "关闭"}；仅 Pi fullscreen 内部选区，保留选中的标题／时间文字。`, "info");
    },
  });
  pi.on("session_shutdown", () => {
    active = false;
    if (patch && prototype.getActiveSelectionText === patch.copy) Object.defineProperty(prototype, "getActiveSelectionText", patch.copyOriginal);
    if (patch && prototype.applySelection === patch.highlight) Object.defineProperty(prototype, "applySelection", patch.highlightOriginal);
    patch = undefined; lastScreen?.requestRender?.(); lastScreen = undefined;
  });
}
