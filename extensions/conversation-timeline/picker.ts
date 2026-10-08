import { SelectList, truncateToWidth, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { PromptAnchor } from "./timeline.ts";

/** Small rounded menu. Reuses SDK selection/focus semantics, not a second renderer. */
export class TimelinePicker implements Component {
  private list: SelectList;
  private offset = 0;
  private listHeight = 0;
  private capacity = 0;
  private framed = false;
  private width = 0;
  private rendered?: { width: number; rows: number; selected?: string; palette: string; lines: string[] };
  constructor(private prompts: PromptAnchor[], private theme: any, private screenRows: () => number,
    private done: (id: string | null) => void, private maxHeight?: () => number) {
    this.list = this.createList(1);
  }
  private createList(capacity: number): SelectList {
    const list = new SelectList(this.prompts.map(p => ({ value: p.id, label: `第 ${p.ordinal} 轮  ${p.summary}` })),
      capacity, {
        selectedPrefix: text => this.theme.fg("syntaxVariable", text),
        selectedText: text => this.theme.fg("syntaxVariable", text.replace(/^→ /, "❯ ")),
        description: text => this.theme.fg("muted", text),
        scrollInfo: text => this.theme.fg("dim", text),
        noMatch: text => this.theme.fg("muted", text),
      });
    list.onSelect = item => this.done(item.value);
    list.onCancel = () => this.done(null);
    return list;
  }
  invalidate() { this.rendered = undefined; this.list.invalidate(); }
  handleInput(data: string) { this.list.handleInput(data); }
  render(width: number): string[] {
    this.width = width;
    const rows = Math.max(1, Math.min(9, Math.floor(this.maxHeight?.() ?? this.screenRows() * 0.8)));
    const selected = this.list.getSelectedItem()?.value;
    const palette = ["syntaxVariable", "borderMuted", "muted", "dim"]
      .map(color => this.theme.fg(color, "·")).join("|");
    const cached = this.rendered;
    if (cached && cached.width === width && cached.rows === rows && cached.selected === selected &&
        cached.palette === palette) return cached.lines;
    const remember = (lines: string[]) => {
      this.rendered = { width, rows, selected: this.list.getSelectedItem()?.value, palette, lines };
      return lines;
    };
    this.framed = width >= 8 && rows >= 3;
    const budget = rows - (this.framed ? 2 : 0);
    let capacity = Math.max(1, Math.min(6, this.prompts.length, budget));
    if (this.prompts.length > capacity && budget > 1) capacity = Math.min(capacity, budget - 1);
    if (capacity !== this.capacity) {
      const selected = this.list.getSelectedItem()?.value;
      this.list = this.createList(capacity);
      const index = this.prompts.findIndex(p => p.id === selected);
      if (index >= 0) this.list.setSelectedIndex(index);
      this.capacity = capacity;
    }
    const inner = this.framed ? width - 2 : width;
    const lines = this.list.render(inner).slice(0, budget);
    this.offset = this.framed ? 1 : 0;
    this.listHeight = lines.length;
    if (!this.framed) return remember(lines.map(line => truncateToWidth(line, width, "")));
    const edge = (text: string) => this.theme.fg("borderMuted", text);
    const rule = (left: string, label: string, right: string, color: string) => {
      const title = truncateToWidth(label, Math.max(0, inner - 2), "");
      return edge(left + "─ ") + this.theme.fg(color, title) +
        edge("─".repeat(Math.max(0, inner - 2 - visibleWidth(title))) + right);
    };
    return remember([rule("╭", `附近提问 · ${this.prompts.length} `, "╮", "syntaxVariable"),
      ...lines.map(line => {
        const content = truncateToWidth(line, inner, "");
        return edge("│") + content + " ".repeat(Math.max(0, inner - visibleWidth(content))) + edge("│");
      }), rule("╰", "↑↓ 选择 · Esc 关闭 ", "╯", "dim")]);
  }
  handleMouse(event: TuiMouseEvent) {
    if ((this.framed && (event.x < 1 || event.x >= this.width - 1)) ||
        event.y < this.offset || event.y >= this.offset + this.listHeight) return;
    return this.list.handleMouse({ ...event, x: event.x - (this.framed ? 1 : 0),
      y: event.y - this.offset, width: this.width - (this.framed ? 2 : 0), height: this.listHeight });
  }
}
