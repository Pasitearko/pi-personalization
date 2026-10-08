import { truncateToWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { groupMarkers, type PromptAnchor, type PromptIndex } from "./timeline.ts";

export interface GutterSource {
  index: PromptIndex;
  height: number;
  activeId?: string;
}
export interface GutterTheme { fg(color: "accent" | "dim" | "muted", text: string): string }
export interface MarkerPoint { x: number; y: number; top: number }

export class TimelineGutter implements Component {
  private displayed = new Map<number, PromptAnchor[]>();
  private width = 0;
  private groupedIndex?: PromptIndex;
  private groupedHeight = -1;
  private rendered?: { index: PromptIndex; height: number; activeId?: string; width: number; palette: string; lines: string[] };
  constructor(
    private source: () => GutterSource,
    private theme: () => GutterTheme,
    private activate: (group: PromptAnchor[], point?: MarkerPoint) => void,
  ) {}
  invalidate() { this.rendered = undefined; }
  render(width: number): string[] {
    this.width = width;
    const source = this.source(), theme = this.theme();
    const palette = [theme.fg("accent", "●"), theme.fg("muted", "●"), theme.fg("dim", "│")].join("|");
    const cached = this.rendered;
    if (cached && cached.index === source.index && cached.height === source.height &&
        cached.activeId === source.activeId && cached.width === width && cached.palette === palette) return cached.lines;
    if (this.groupedIndex !== source.index || this.groupedHeight !== source.height) {
      this.displayed = groupMarkers(source.index, source.height);
      this.groupedIndex = source.index; this.groupedHeight = source.height;
    }
    const lines = Array.from({ length: source.height }, (_, row) => {
      const group = this.displayed.get(row);
      const glyph = group ? (group.length > 1 ? "◉" : "●") : "│";
      const color = group?.some(p => p.id === source.activeId) ? "accent" : group ? "muted" : "dim";
      return truncateToWidth(` ${theme.fg(color, glyph)}  `, width, "");
    });
    this.rendered = { index: source.index, height: source.height, activeId: source.activeId, width, palette, lines };
    return lines;
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // No raw protocol hook, focus request, capture, or interception of wheel/drag.
    if (event.button !== "left" || event.x < 1 || event.x >= this.width || event.y < 0 || event.y >= event.height) return;
    const group = this.displayed.get(event.y);
    if (!group) return;
    if (event.type === "press") return { handled: true, render: false };
    if (event.type === "click") {
      this.activate(group.slice(), { x: event.screenX - event.x + 1,
        y: event.screenY, top: event.screenY - event.y });
      return { handled: true, render: false };
    }
  }
}
