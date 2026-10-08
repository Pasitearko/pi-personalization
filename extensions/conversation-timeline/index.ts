import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TimelineAdapter } from "./adapter.ts";
import { TimelinePicker } from "./picker.ts";
import { pickerPlacement } from "./placement.ts";
import type { MarkerPoint } from "./gutter.ts";
import type { PromptAnchor } from "./timeline.ts";

const WIDGET = "conversation-timeline-lifecycle";

export default function conversationTimeline(pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let adapter: TimelineAdapter | undefined;
  let enabled = true;
  let generation = 0;
  let dismiss: (() => void) | undefined;
  let selecting = false;
  let warned = false;

  function closePicker() {
    dismiss?.();
    dismiss = undefined;
    selecting = false;
  }
  function detach() {
    generation++;
    closePicker();
    adapter?.dispose();
    adapter = undefined;
  }
  async function choose(group: PromptAnchor[], point?: MarkerPoint) {
    if (selecting || !ctx || !adapter || !group.length) return;
    const currentCtx = ctx, owner = adapter, epoch = generation;
    if (group.length === 1) { owner.jump(group[0].id); return; }
    selecting = true;
    let terminal = () => ({ columns: 80, rows: 24 });
    let rightOffset: number | undefined;
    let positionedIndex = owner.index;
    let anchorPrompt = owner.index.prompts.find(p => p.id === group[0].id);
    const placement = () => {
      const size = terminal();
      if (positionedIndex !== owner.index) {
        positionedIndex = owner.index;
        anchorPrompt = owner.index.prompts.find(p => p.id === group[0].id);
      }
      const localRow = anchorPrompt ? Math.round(anchorPrompt.line / Math.max(1, owner.index.totalLines - 1) *
        Math.max(0, owner.height - 1)) : 0;
      const marker = point ? { top: point.top, x: size.columns - (rightOffset ?? 3),
        y: point.top + localRow } : undefined;
      return pickerPlacement(size.columns, size.rows, group.length, marker, owner.height);
    };
    try {
      const id = await currentCtx.ui.custom<string | null>((tui, theme, _keys, done) => {
        terminal = () => tui.terminal;
        if (point) rightOffset = tui.terminal.columns - point.x;
        dismiss = () => done(null);
        return new TimelinePicker(group, theme, () => tui.terminal.rows, done, () => placement().maxHeight);
      }, { overlay: true, overlayOptions: () => ({ anchor: "top-left", ...placement() }) });
      if (epoch === generation && owner === adapter && id && !owner.jump(id)) {
        currentCtx.ui.notify("该提问已不在当前聊天布局中，请重新选择。", "info");
      }
    } catch (error) {
      if (epoch === generation && owner === adapter) currentCtx.ui.notify(`时间轴选择失败：${String(error)}`, "warning");
    } finally {
      if (epoch === generation && owner === adapter) { dismiss = undefined; selecting = false; }
    }
  }
  function mount(current: ExtensionContext) {
    ctx = current;
    if (!current.hasUI || current.mode !== "tui") return;
    current.ui.setWidget(WIDGET, (tui, theme) => {
      let alive = true;
      // Factory disposal occurs on reload/UI reset. An old instance never removes a new owner.
      const ownerGeneration = ++generation;
      adapter?.dispose();
      adapter = undefined;
      const ensure = () => {
        if (!alive || !enabled || ownerGeneration !== generation) return;
        if (!(tui as any).layoutRoot) closePicker();
        if (adapter && !adapter.ownsCurrentRoot()) { closePicker(); adapter.dispose(); adapter = undefined; }
        if (!adapter) {
          try {
            adapter = TimelineAdapter.attach(tui, () => theme, (group, point) => { void choose(group, point); });
            if (!adapter && (tui as any).layoutRoot && !warned) {
              warned = true;
              current.ui.notify("时间轴未启用：当前 Pi 布局结构不兼容。原聊天和 alps 边框保持不变。", "warning");
            }
          } catch (error) {
            if (!warned) { warned = true; current.ui.notify(`时间轴接入失败：${String(error)}`, "warning"); }
          }
        }
      };
      ensure();
      return {
        render() { ensure(); return []; },
        invalidate() {},
        dispose() {
          if (!alive) return;
          alive = false;
          if (ownerGeneration === generation) detach();
        },
      };
    }, { placement: "belowEditor" });
  }

  pi.on("session_start", (_event, current) => {
    detach(); warned = false;
    mount(current);
  });
  // Compaction/tree changes invalidate a selector snapshot, but actual layout builds the new index.
  for (const event of ["session_compact", "session_tree"] as const) {
    pi.on(event, (_event, current) => { detach(); mount(current); });
  }
  pi.on("session_shutdown", () => {
    detach(); ctx = undefined;
  });
  pi.registerCommand("timeline", {
    description: "会话时间轴：on | off | status | list（默认打开提问列表）",
    handler: async (args, current) => {
      const action = args.trim().toLowerCase() || "list";
      if (!current.hasUI || current.mode !== "tui") {
        current.ui.notify("时间轴仅支持 Pi 交互界面；侧栏需要 fullscreen 模式。", "info");
        return;
      }
      ctx = current;
      if (action === "off") {
        enabled = false; detach();
        current.ui.setWidget(WIDGET, undefined);
        current.ui.notify("会话时间轴已关闭。", "info");
      } else if (action === "on") {
        enabled = true; detach(); warned = false; mount(current);
      } else if (action === "status") {
        current.ui.notify(enabled ? adapter?.status() ?? "等待 fullscreen 聊天布局" : "已关闭", "info");
      } else if (action === "list") {
        if (adapter && !adapter.canNavigate()) {
          current.ui.notify(`${adapter.status()}；请等待 fullscreen 聊天完成重绘后再选择。`, "info");
          return;
        }
        const prompts = adapter?.index.prompts ?? [];
        if (!prompts.length) current.ui.notify("当前尚无可导航提问；请在 fullscreen 模式下等待聊天完成一次绘制。", "info");
        else await choose(prompts);
      } else current.ui.notify("用法：/timeline [on|off|status|list]", "info");
    },
  });
}
