import { HStack } from "@earendil-works/pi-tui";
import { TimelineGutter, type GutterTheme, type MarkerPoint } from "./gutter.ts";
import { currentPrompt, PromptIndexer, type PromptAnchor, type PromptIndex } from "./timeline.ts";

const NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const OWNER = Symbol.for("pi.conversation-timeline.owner.v1");
const MIN_WIDTH = 24;
type Runtime = any; // Non-public Pi 1.0 layout fields are intentionally isolated here.

function node(component: Runtime): Runtime {
  try { return component?.[NODE]?.(); } catch { return undefined; }
}

/** Scoped instance adapter. Never changes a prototype or a Pi/alps installation file. */
export class TimelineAdapter {
  index: PromptIndex = { prompts: [], totalLines: 0 };
  height = 0;
  private alive = true;
  private queued = false;
  private indexer = new PromptIndexer();
  private root: Runtime;
  private entry: Runtime;
  private slot: number;
  private scroll: Runtime;
  private document: Runtime;
  private wrapper: HStack;
  private renderHook: Runtime;
  private layoutHook: Runtime;
  private measureHook: Runtime;
  private renderDescriptor?: PropertyDescriptor;
  private layoutDescriptor?: PropertyDescriptor;
  private measureDescriptor?: PropertyDescriptor;
  private measuring = false;
  private prepared?: { width: number; lines: string[]; layout: Runtime };
  private selected?: { id: string; scrollTop: number };
  private indexWidth = 0;
  private layoutReady = false;

  static attach(tui: Runtime, theme: () => GutterTheme, activate: (group: PromptAnchor[], point?: MarkerPoint) => void): TimelineAdapter | undefined {
    const root = tui.layoutRoot;
    const layout = node(root);
    if (layout?.type !== "vstack" || !Array.isArray(root?.entries) || !Array.isArray(root?.children)) return;
    const slot = root.entries.findIndex((entry: Runtime) => {
      const n = node(entry.component);
      return n?.type === "scroll" && n.state?.primary === true;
    });
    if (slot < 0) return;
    const entry = root.entries[slot], scroll = entry.component, n = node(scroll);
    const document = n?.component;
    if (n?.state !== scroll || !document || document[OWNER] ||
        typeof document.render !== "function" || typeof scroll.render !== "function" || typeof scroll.updateLayout !== "function" ||
        typeof scroll.scrollTo !== "function" || typeof scroll.getContentWidth !== "function" ||
        typeof tui.requestRender !== "function" ||
        root.children[slot] !== scroll) return;
    return new TimelineAdapter(tui, root, entry, slot, scroll, document, theme, activate);
  }

  private constructor(
    private tui: Runtime, root: Runtime, entry: Runtime, slot: number,
    scroll: Runtime, document: Runtime, theme: () => GutterTheme, activate: (group: PromptAnchor[], point?: MarkerPoint) => void,
  ) {
    this.root = root; this.entry = entry; this.slot = slot; this.scroll = scroll; this.document = document;
    this.height = scroll.viewportHeight ?? 0;
    const gutter = new TimelineGutter(() => ({ index: this.index, height: this.height, activeId: this.activeId() }), theme, activate);
    this.wrapper = new HStack([
      { component: scroll, basis: 0, grow: 1, minSize: 1 },
      { component: gutter, basis: 4, minSize: 4, maxSize: 4, shrink: 0,
        visible: viewport => this.alive && viewport.width >= MIN_WIDTH },
    ], { align: "stretch" });
    const originalRender = document.render;
    const originalUpdate = scroll.updateLayout;
    const originalMeasure = scroll.render;
    this.renderDescriptor = Object.getOwnPropertyDescriptor(document, "render");
    this.layoutDescriptor = Object.getOwnPropertyDescriptor(scroll, "updateLayout");
    this.measureDescriptor = Object.getOwnPropertyDescriptor(scroll, "render");
    const adapter = this;
    this.renderHook = function (this: Runtime, width: number) {
      // HStack measures ScrollView.render(), then lays out its document again.
      // Reuse ONLY the synchronous measurement result once, never across frames.
      const prepared = adapter.prepared;
      adapter.prepared = undefined;
      if (!adapter.measuring && prepared?.width === width && prepared.layout === this.mouseLayout &&
          adapter.tui.layoutRoot === adapter.root && adapter.ownsCurrentRoot()) return prepared.lines;
      const lines = originalRender.call(this, width);
      if (adapter.alive && adapter.tui.layoutRoot === adapter.root && adapter.ownsCurrentRoot()) {
        // Failure to index must not break the original transcript renderer.
        try { adapter.index = adapter.indexer.build(lines, this); adapter.indexWidth = width; }
        catch { adapter.index = { prompts: [], totalLines: lines.length }; adapter.indexWidth = 0; }
      } else adapter.layoutReady = false;
      if (adapter.measuring) adapter.prepared = { width, lines, layout: this.mouseLayout };
      return lines;
    };
    this.measureHook = function (this: Runtime, width: number) {
      adapter.prepared = undefined;
      if (!adapter.ownsCurrentRoot() || adapter.tui.layoutRoot !== adapter.root) return originalMeasure.call(this, width);
      adapter.measuring = true;
      try { return originalMeasure.call(this, width); }
      finally {
        adapter.measuring = false;
        const pending = adapter.prepared;
        // A standalone measure may not be followed by a layout. Expire it this turn.
        if (pending) queueMicrotask(() => { if (adapter.prepared === pending) adapter.prepared = undefined; });
      }
    };
    this.layoutHook = function (this: Runtime, content: number, height: number, requestRender: () => void) {
      const previousActive = adapter.activeId();
      originalUpdate.call(this, content, height, requestRender);
      adapter.layoutReady = adapter.alive && adapter.tui.layoutRoot === adapter.root && adapter.ownsCurrentRoot();
      adapter.prepared = undefined;
      if (adapter.alive) {
        const heightChanged = adapter.height !== this.viewportHeight;
        adapter.height = this.viewportHeight;
        // Following the growing SAME reply changes scrollTop, not the visible marker.
        if (heightChanged || previousActive !== adapter.activeId()) adapter.requestCorrection();
      }
    };
    // Assign only after all capability checks; store original descriptors for exact restoration.
    document.render = this.renderHook;
    scroll.render = this.measureHook;
    scroll.updateLayout = this.layoutHook;
    document[OWNER] = this;
    root.entries[slot] = { ...entry, component: this.wrapper };
    root.children[slot] = this.wrapper;
    this.tui.requestRender();
  }

  private requestCorrection() {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (this.alive) this.tui.requestRender();
    });
  }
  activeId(): string | undefined {
    if (this.selected && this.selected.scrollTop === this.scroll.scrollTop && !this.scroll.isFollowingEnd &&
        this.index.prompts.some(p => p.id === this.selected!.id)) return this.selected.id;
    this.selected = undefined;
    return currentPrompt(this.index, this.scroll.scrollTop)?.id;
  }
  jump(id: string): boolean {
    if (!this.canNavigate()) return false;
    const prompt = this.index.prompts.find(p => p.id === id);
    if (!prompt) return false;
    this.scroll.scrollTo(prompt.line, { disableFollow: true });
    this.selected = { id, scrollTop: this.scroll.scrollTop };
    this.tui.requestRender();
    return true;
  }
  status(): string {
    if (!this.alive) return "已关闭";
    if (!this.tui.layoutRoot) return "普通终端模式：时间轴不绘制，也不支持跳转；请切换 fullscreen";
    if (this.tui.layoutRoot !== this.root || !this.ownsCurrentRoot()) return "布局已更换：等待重新绑定";
    if ((this.tui.terminal?.columns ?? 80) < MIN_WIDTH) return "窗口不足 24 列：保留正文宽度，使用 /timeline list";
    return `已开启 · ${this.index.prompts.length} 个可导航提问 · ${this.height} 行时间轴`;
  }
  canNavigate(): boolean {
    if (!this.alive || !this.layoutReady || this.tui.layoutRoot !== this.root || !this.ownsCurrentRoot()) return false;
    const columns = this.tui.terminal?.columns;
    if (!Number.isFinite(columns)) return false;
    const contentWidth = this.scroll.getContentWidth(columns >= MIN_WIDTH ? columns - 4 : columns);
    return this.indexWidth === contentWidth;
  }
  ownsCurrentRoot(): boolean {
    if (!this.tui.layoutRoot) this.layoutReady = false; // Suspend, retaining safe hooks for fullscreen restoration.
    return this.alive && (!this.tui.layoutRoot || this.tui.layoutRoot === this.root) &&
      this.root.entries?.[this.slot]?.component === this.wrapper &&
      this.root.children?.[this.slot] === this.wrapper &&
      this.document[OWNER] === this && this.document.render === this.renderHook &&
      this.scroll.updateLayout === this.layoutHook && this.scroll.render === this.measureHook;
  }
  dispose() {
    if (!this.alive) return;
    this.alive = false;
    if (this.root.entries[this.slot]?.component === this.wrapper) this.root.entries[this.slot] = this.entry;
    if (this.root.children[this.slot] === this.wrapper) this.root.children[this.slot] = this.entry.component;
    if (this.document.render === this.renderHook) {
      if (this.renderDescriptor) Object.defineProperty(this.document, "render", this.renderDescriptor);
      else delete this.document.render;
    }
    if (this.scroll.updateLayout === this.layoutHook) {
      if (this.layoutDescriptor) Object.defineProperty(this.scroll, "updateLayout", this.layoutDescriptor);
      else delete this.scroll.updateLayout;
    }
    if (this.scroll.render === this.measureHook) {
      if (this.measureDescriptor) Object.defineProperty(this.scroll, "render", this.measureDescriptor);
      else delete this.scroll.render;
    }
    if (this.document[OWNER] === this) delete this.document[OWNER];
    this.prepared = undefined;
    this.index = { prompts: [], totalLines: 0 };
    this.tui.requestRender();
  }
}
