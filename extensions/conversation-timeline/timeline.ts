import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";

export interface PromptAnchor {
  id: string;
  line: number;
  ordinal: number;
  summary: string;
}
export interface PromptIndex { prompts: PromptAnchor[]; totalLines: number }
export const ZONE_START = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))*\x1b\]133;A(?:\x07|\x1b\\)/;

/** ACP injects delegate notifications via sendUserMessage, so role alone is insufficient. */
export function isAcpNotification(text: string): boolean {
  const plain = stripTerminalSequences(text).replace(/^\uFEFF/, "").trimStart();
  // Batch recovery notices may precede the actual acp_delegate header.
  const header = plain.replace(/^⚠\uFE0F?\s+Recovery notice:[^\r\n]*\r?\n\s*/i, "");
  const delegateHeader = /^\[acp_delegate(?:\s+(?:completed|failed(?:\s+⚠\uFE0F?)?|cancelled|canceled))?\](?:\s|$)/i;
  const automated = /This is an automated system notification,\s*NOT a user message\./i;
  // Both signatures are required: genuine questions mentioning ACP remain navigable.
  return delegateHeader.test(header) && automated.test(plain);
}

export function summary(text: string): string {
  const plain = stripTerminalSequences(text).replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/[╭╮╰╯│─]/g, " ").replace(/\s+/g, " ").trim();
  // SDK truncation may append an SGR reset; summaries themselves stay unstyled.
  return stripTerminalSequences(truncateToWidth(plain, 90, "…")) || "（图片或空文本提问）";
}

/** Uses the last completed Container render's child heights, never re-renders children. */
export class PromptIndexer {
  private identities = new WeakMap<object, string>();
  private sequence = 0;
  private descriptions = new WeakMap<object, { text: string; excluded: boolean; summary: string }>();
  private lastIndex?: PromptIndex;
  private describe(component: object, text: string) {
    let cached = this.descriptions.get(component);
    if (!cached || cached.text !== text) {
      const excluded = isAcpNotification(text);
      cached = { text, excluded, summary: excluded ? "" : summary(text) };
      this.descriptions.set(component, cached);
    }
    return cached;
  }
  private fallbackSignature = "";
  private fallbackVersion = 0;
  private id(component: object): string {
    let id = this.identities.get(component);
    if (!id) { id = `prompt-${++this.sequence}`; this.identities.set(component, id); }
    return id;
  }
  build(lines: string[], document?: any): PromptIndex {
    const native: number[] = [];
    // Production uses component heights: never scan every historical AI/tool line.
    if (!document) for (let i = 0; i < lines.length; i++) if (ZONE_START.test(lines[i])) native.push(i);
    const found: { id: string; line: number; summary: string }[] = [];
    let attachedSkill: { anchor: typeof found[number]; text: string } | undefined;
    const visited = new Set<object>();
    const walk = (component: any, start: number, height: number) => {
      if (!component || height <= 0 || visited.has(component)) return;
      visited.add(component);
      const name = component.constructor?.name;
      // Pi marks BOTH user and non-tool assistant messages with OSC133 A.
      // The protocol marks zones, not roles: only actual user components qualify.
      if (name === "AssistantMessageComponent" || component.lastMessage?.role === "assistant") return;
      const user = name === "UserMessageComponent" ||
        (typeof component.text === "string" && typeof component.outputPad === "number" &&
         Array.isArray(component.markdownTransformers));
      if (user) {
        const description = this.describe(component, component.text ?? "");
        if (description.excluded) { attachedSkill = undefined; return; }
        let mark: number | undefined;
        // Usually the first row is the user frame's OSC boundary. Search ONLY
        // this user's own span if a renderer inserts leading padding.
        for (let row = start; row < Math.min(lines.length, start + height); row++) {
          if (ZONE_START.test(lines[row])) { mark = row; break; }
        }
        if (attachedSkill && attachedSkill.text === component.text) {
          // The skill frame and trailing user text belong to the same prompt.
          attachedSkill.anchor.summary = description.summary;
        } else found.push({ id: this.id(component), line: mark ?? start, summary: description.summary });
        attachedSkill = undefined;
        return;
      }
      const skill = component.skillBlock;
      if (skill && typeof skill.name === "string" && typeof skill.content === "string") {
        const description = this.describe(component, skill.userMessage || `[skill] ${skill.name}`);
        if (description.excluded) { attachedSkill = undefined; return; }
        const anchor = { id: this.id(component), line: start, summary: description.summary };
        found.push(anchor);
        attachedSkill = typeof skill.userMessage === "string" && skill.userMessage ? { anchor, text: skill.userMessage } : undefined;
        return;
      }
      const children = component.mouseLayout?.children;
      if (!Array.isArray(children)) return;
      let offset = start;
      for (const child of children) {
        const childHeight = Number.isFinite(child.height) ? Math.max(0, Math.floor(child.height)) : 0;
        walk(child.component, offset, childHeight);
        offset += childHeight;
      }
    };
    walk(document, 0, lines.length);
    const fallback: { line: number; summary: string }[] = [];
    // Protocol-only fallback is for isolated text indexing/tests only. In the
    // real document, unknown OSC zones (assistant/tool/custom) never become prompts.
    for (let i = 0; !document && i < native.length; i++) {
      const line = native[i];
      const zoneEnd = native[i + 1] ?? lines.length;
      if (isAcpNotification(lines.slice(line, zoneEnd).join("\n"))) continue;
      const end = Math.min(zoneEnd, line + 5);
      const snippet: string[] = [];
      for (let row = line; row < end; row++) {
        snippet.push(lines[row]);
        if (/\x1b\]133;B(?:\x07|\x1b\\)/.test(lines[row])) break;
      }
      fallback.push({ line, summary: summary(snippet.join(" ")) });
    }
    // OSC-only renderers expose no stable message id. Any fallback set change
    // invalidates old picker ids rather than silently reusing an ordinal.
    const signature = JSON.stringify(fallback.map(p => p.summary));
    if (signature !== this.fallbackSignature) { this.fallbackSignature = signature; this.fallbackVersion++; }
    found.push(...fallback.map((p, i) => ({ ...p, id: `osc-${this.fallbackVersion}-${i}` })));
    found.sort((a, b) => a.line - b.line);
    const prompts = found.filter(p => p.line >= 0 && p.line < lines.length);
    const previous = this.lastIndex;
    if (previous && previous.totalLines === lines.length && previous.prompts.length === prompts.length &&
        prompts.every((p, i) => p.id === previous.prompts[i].id && p.line === previous.prompts[i].line &&
          p.summary === previous.prompts[i].summary)) return previous;
    this.lastIndex = { totalLines: lines.length, prompts: prompts.map((p, i) => ({ ...p, ordinal: i + 1 })) };
    return this.lastIndex;
  }
}

export function groupMarkers(index: PromptIndex, height: number): Map<number, PromptAnchor[]> {
  const groups = new Map<number, PromptAnchor[]>();
  const rows = Math.max(0, Math.floor(height));
  if (!rows) return groups;
  for (const prompt of index.prompts) {
    const row = Math.max(0, Math.min(rows - 1,
      Math.round(prompt.line / Math.max(1, index.totalLines - 1) * (rows - 1))));
    const group = groups.get(row) ?? [];
    group.push(prompt);
    groups.set(row, group);
  }
  return groups;
}

export function currentPrompt(index: PromptIndex, scrollTop: number): PromptAnchor | undefined {
  let low = 0, high = index.prompts.length - 1, result = 0;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (index.prompts[mid].line <= scrollTop) { result = mid; low = mid + 1; }
    else high = mid - 1;
  }
  return index.prompts[result];
}
