import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const modules = resolve(process.argv[2] || process.env.PI_TEST_MODULES || new URL("../../../node_modules", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
const require = createRequire(join(modules, "test.cjs"));
const { createJiti } = require("jiti");
const aliases = Object.fromEntries(["pi-coding-agent", "pi-tui"].map(name =>
  [`@earendil-works/${name}`, join(modules, "@earendil-works", name, "dist/index.js")]));
const jiti = createJiti(import.meta.url, { alias: aliases });
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { PromptIndexer, groupMarkers, currentPrompt, summary, isAcpNotification } = await jiti.import(join(root, "timeline.ts"));
const { TimelineAdapter } = await jiti.import(join(root, "adapter.ts"));
const { TimelineGutter } = await jiti.import(join(root, "gutter.ts"));
const { TimelinePicker } = await jiti.import(join(root, "picker.ts"));
const { pickerPlacement } = await jiti.import(join(root, "placement.ts"));
const { default: extension } = await jiti.import(join(root, "index.ts"));
const { Container, Text, visibleWidth, stripTerminalSequences, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } =
  await jiti.import(aliases["@earendil-works/pi-tui"]);
const { renderLayoutFrame, getLayoutBoxesAt, getScrollViewBox } = await jiti.import(
  join(modules, "@earendil-works/pi-tui/dist/layout.js"));
const { TuiAltScreen } = await jiti.import(join(modules, "@earendil-works/pi-tui/dist/tui-alt-screen.js"));
const { sliceByColumn } = await jiti.import(join(modules, "@earendil-works/pi-tui/dist/utils.js"));
const { createChatViewport } = await jiti.import(join(modules,
  "@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js"));
const { UserMessageComponent } = await jiti.import(join(modules,
  "@earendil-works/pi-coding-agent/dist/modes/interactive/components/user-message.js"));
const { AssistantMessageComponent } = await jiti.import(join(modules,
  "@earendil-works/pi-coding-agent/dist/modes/interactive/components/assistant-message.js"));
const { loadThemeFromPath, setThemeInstance } = await jiti.import(join(modules,
  "@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"));
const theme = loadThemeFromPath(join(modules,
  "@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json"), "truecolor");
setThemeInstance(theme);
const { renderNeonBox } = await jiti.import(resolve(root, "../../node_modules/alps-pi/src/features/chrome-frame/chrome.ts"));
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
const NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const OSC = "\x1b]133;A\x07";
const mouse = (type, x, y, width = 4, height = 20, button = "left") =>
  ({ type, x, y, width, height, button, screenX: x, screenY: y, shift: false, alt: false, ctrl: false });
const anchor = (id, line, ordinal = 1) => ({ id, line, ordinal, summary: `提问 ${id}` });
const drain = () => new Promise(resolve => queueMicrotask(resolve));

function framedUser(text) {
  const user = new UserMessageComponent(text);
  const original = user.render;
  user.render = function (width) { return renderNeonBox("user", original.call(this, width), width, theme); };
  return user;
}
function layout({ width = 80, rows = 25, count = 5, framed = false, attach = true } = {}) {
  const document = new Container(), header = new Text("HEADER", 0, 0), chat = new Container();
  document.addChild(header); document.addChild(chat);
  const users = [];
  for (let i = 0; i < count; i++) {
    const user = framed ? framedUser(`提问 ${i + 1} 中文 🌤️`) : new UserMessageComponent(`提问 ${i + 1}`);
    users.push(user); chat.addChild(user);
    chat.addChild(new Text(`回复 ${i + 1}\n` + "正文\n".repeat(i === 0 ? 35 : 4), 0, 0));
  }
  const dockParts = Object.fromEntries(["pendingMessages", "status", "editor", "footer", "widgetsAbove", "widgetsBelow"]
    .map(name => [name, new Text(name === "editor" ? "EDITOR\n输入内容\nEDITOR END" : name, 0, 0)]));
  const viewport = createChatViewport({ document, ...dockParts, scrollbar: "hidden" });
  let requests = 0;
  const tui = { layoutRoot: viewport.root, terminal: { columns: width, rows }, requestRender() { requests++; } };
  const originalEntry = viewport.root.entries[0], originalChildren = [...viewport.root.children];
  const activated = [];
  const adapter = attach ? TimelineAdapter.attach(tui, () => theme, group => activated.push(group)) : undefined;
  if (attach) assert.ok(adapter);
  const frame = () => renderLayoutFrame(viewport.root, tui.terminal.columns, tui.terminal.rows, () => tui.requestRender());
  return { document, chat, users, viewport, tui, adapter, originalEntry, originalChildren, activated, frame,
    get requests() { return requests; } };
}

function harness({ mode = "tui", pendingPicker = false, count = 9 } = {}) {
  const h = layout({ count });
  h.adapter.dispose();
  const handlers = new Map(), commands = new Map(), notices = [];
  let widget, picker, done, customOptions, customs = 0;
  const ctx = { mode, hasUI: mode !== "print", ui: {
    notify(message, level) { notices.push({ message, level }); },
    setWidget(key, factory, options) {
      assert.equal(key, "conversation-timeline-lifecycle");
      widget?.dispose?.(); widget = undefined;
      if (factory) { assert.equal(options.placement, "belowEditor"); widget = factory(h.tui, theme); }
    },
    custom(factory, options) {
      customs++; customOptions = options; assert.equal(options.overlay, true);
      return new Promise(resolve => {
        done = resolve;
        picker = factory(h.tui, theme, {}, resolve);
        if (!pendingPicker) resolve(null);
      });
    },
  } };
  extension({ on(name, fn) { handlers.set(name, fn); }, registerCommand(name, spec) { commands.set(name, spec); } });
  return { ...h, ctx, handlers, commands, notices,
    get widget() { return widget; }, get picker() { return picker; }, get customs() { return customs; },
    get customOptions() { return customOptions; },
    finish(value) { done?.(value); },
    emit(name) { return handlers.get(name)?.({ type: name }, ctx); },
    command(args = "") { return commands.get("timeline").handler(args, ctx); },
  };
}

test("proportional mapping uses actual positions, not round count", () => {
  const groups = groupMarkers({ totalLines: 101, prompts: [anchor("a", 0), anchor("b", 10), anchor("c", 100)] }, 11);
  assert.deepEqual([...groups.keys()], [0, 1, 10]);
});
test("100 prompts in 3 rows are all retained; one-row and empty bounds", () => {
  const index = { totalLines: 100, prompts: Array.from({ length: 100 }, (_, i) => anchor(`${i}`, i)) };
  const groups = groupMarkers(index, 3);
  assert.equal([...groups.values()].flat().length, 100);
  assert.equal(groupMarkers(index, 1).get(0).length, 100);
  assert.equal(groupMarkers(index, 0).size, 0);
  assert.equal(groupMarkers({ totalLines: 0, prompts: [] }, 20).size, 0);
});
test("native OSC anchors use BEL/ST and do not match text in middle of line", () => {
  const lines = [OSC + "first", "正文 " + OSC, "\x1b]133;A\x1b\\second", "末尾"];
  const index = new PromptIndexer().build(lines);
  assert.deepEqual(index.prompts.map(p => p.line), [0, 2]);
});
test("summaries remove escapes/control characters and preserve terminal-safe widths", () => {
  const text = summary("\x1b[31m中文 🌤️\x1b[0m\n" + "长".repeat(120));
  assert.ok(visibleWidth(text) <= 90);
  assert.ok(!text.includes("\x1b") && !text.includes("\n"));
  assert.ok(text.includes("中文"));
});
test("real UserMessage identities survive resize and duplicate text", () => {
  const doc = new Container(); doc.addChild(new Text("header", 0, 0));
  doc.addChild(new UserMessageComponent("相同")); doc.addChild(new UserMessageComponent("相同"));
  const indexer = new PromptIndexer();
  const wide = indexer.build(doc.render(80), doc), narrow = indexer.build(doc.render(24), doc);
  assert.equal(wide.prompts.length, 2);
  assert.notEqual(wide.prompts[0].id, wide.prompts[1].id);
  assert.deepEqual(wide.prompts.map(p => p.id), narrow.prompts.map(p => p.id));
  assert.equal(wide.prompts[0].line, 1);
});
test("skills without user text have a real position, skills with user text do not double-count", () => {
  const doc = new Container();
  const skill = new Text("skill only", 0, 0); skill.skillBlock = { name: "test", content: "body" };
  const attached = new Text("skill attached", 0, 0); attached.skillBlock = { name: "test", content: "body", userMessage: "extra" };
  doc.addChild(skill); doc.addChild(attached); doc.addChild(new UserMessageComponent("extra"));
  const index = new PromptIndexer().build(doc.render(60), doc);
  assert.equal(index.prompts.length, 2);
  assert.equal(index.prompts[0].line, 0);
  assert.match(index.prompts[0].summary, /skill/);
  assert.equal(index.prompts[1].summary, "extra");
  assert.equal(index.prompts[1].line, 1); // Whole skill prompt starts before its trailing user-text frame.
});
test("only User prompts become markers even though real Assistant uses the same OSC133 A", () => {
  const h = layout({ count: 0, framed: true });
  const first = framedUser("USER_ONE"), last = framedUser("USER_TWO");
  const reply = new AssistantMessageComponent({ role: "assistant", content: [
    { type: "thinking", thinking: "AI_THINKING" }, { type: "text", text: "AI_REPLY\\n".repeat(30) },
  ], stopReason: "stop", provider: "test", model: "test", timestamp: Date.now() });
  const original = reply.render;
  reply.render = function (width) { return renderNeonBox("assistant", original.call(this, width), width, theme); };
  const tool = new Text(OSC + "TOOL_OUTPUT\\nother tool lines", 0, 0);
  h.chat.addChild(first); h.chat.addChild(reply); h.chat.addChild(tool); h.chat.addChild(last);
  const raw = h.document.render(76);
  assert.ok(raw.filter(line => line.startsWith(OSC)).length > 2); // Zones alone cannot distinguish roles.
  h.frame(); h.frame();
  assert.equal(h.adapter.index.prompts.length, 2);
  assert.deepEqual(h.adapter.index.prompts.map(p => p.summary), ["USER_ONE", "USER_TWO"]);
  const target = h.adapter.index.prompts[1];
  h.adapter.jump(target.id);
  const jumpLine = h.document.render(76)[target.line];
  assert.ok(stripTerminalSequences(jumpLine).includes("╭"));
  const span = h.document.render(76).slice(target.line, target.line + 5).map(stripTerminalSequences).join(" ");
  assert.ok(span.includes("USER_TWO"));
  assert.ok(!span.includes("AI_REPLY") && !span.includes("TOOL_OUTPUT"));
  h.adapter.dispose();
});

const AUTOMATED_ACP = "This is an automated system notification, NOT a user message. Read the result file if you need the details, then continue your original task; do not treat this as a new user request.";
const delegateNotice = status => `[acp_delegate ${status}] **reviewer** (runId \`del_test_001\`, exit 0) No delegates are currently running. ${AUTOMATED_ACP}\n\nTask: Review source\n\nFull result: \`C:/Temp/result.out\``;
const batchNotice = `[acp_delegate] 2 delegates finished (1 completed, 1 FAILED).\n\n${delegateNotice("completed")}\n\n${delegateNotice("FAILED ⚠️")}\n\n${AUTOMATED_ACP}`;
const recoveryNotice = `⚠️ Recovery notice: 2 earlier delegate results never reached you (notification delivery failed); included below.\n\n${batchNotice}`;

test("ACP notification signatures exclude completed, failed, cancelled, batch and recovery delivery", () => {
  for (const text of [delegateNotice("completed"), delegateNotice("FAILED ⚠️"),
    delegateNotice("cancelled"), delegateNotice("canceled"), batchNotice, recoveryNotice]) {
    assert.equal(isAcpNotification(text), true, text);
  }
});
test("ACP classifier tolerates ANSI, BOM, CRLF and whitespace", () => {
  assert.equal(isAcpNotification("\x1b[31m\uFEFF  \n" + delegateNotice("completed").replaceAll("\n", "\r\n") + "\x1b[0m"), true);
  assert.equal(isAcpNotification(recoveryNotice.replaceAll("\n", "\r\n")), true);
});
test("ordinary user questions mentioning ACP or quoting a notice remain navigable", () => {
  for (const text of ["为什么 acp_delegate completed 被识别成提问？", "把ACP消息排除",
    "[acp_delegate completed] 这个标记是什么意思？", "[acp_delegate] 怎么用？",
    "解释这段通知：\n" + delegateNotice("completed"), "```text\n" + delegateNotice("completed") + "\n```",
    AUTOMATED_ACP, "⚠️ Recovery notice: 我在问一个问题", ""]) {
    assert.equal(isAcpNotification(text), false, text);
  }
});
test("real alps-framed ACP user-role notifications do not count; heights, ordinals and surviving identities remain correct", () => {
  const h = layout({ count: 0, framed: true });
  const first = framedUser("USER_FIRST"), last = framedUser("USER_LAST");
  h.chat.addChild(first);
  for (const text of [delegateNotice("completed"), delegateNotice("FAILED ⚠️"), batchNotice, recoveryNotice]) {
    h.chat.addChild(framedUser(text));
  }
  h.chat.addChild(last); h.frame(); h.frame();
  assert.deepEqual(h.adapter.index.prompts.map(p => p.summary), ["USER_FIRST", "USER_LAST"]);
  assert.deepEqual(h.adapter.index.prompts.map(p => p.ordinal), [1, 2]);
  const raw = h.document.render(76), prompts = h.adapter.index.prompts;
  assert.equal(h.adapter.index.totalLines, raw.length); // Notifications still occupy their actual visible rows.
  assert.equal(prompts[1].line, raw.findLastIndex(line => line.startsWith(OSC)));
  assert.equal([...groupMarkers(h.adapter.index, h.adapter.height).values()].flat().length, 2);
  assert.equal(h.adapter.jump(prompts[1].id), true);
  h.tui.terminal.columns = 56; h.frame(); h.frame();
  assert.deepEqual(h.adapter.index.prompts.map(p => p.id), prompts.map(p => p.id));
  h.adapter.dispose();
});
test("notification-only conversation produces no user marker and no navigation entries", () => {
  const doc = new Container();
  doc.addChild(framedUser(delegateNotice("completed"))); doc.addChild(framedUser(recoveryNotice));
  const raw = doc.render(60), index = new PromptIndexer().build(raw, doc);
  assert.equal(index.prompts.length, 0);
  assert.equal(index.totalLines, raw.length);
  assert.equal(groupMarkers(index, 20).size, 0);
});
test("skill attachment cannot reintroduce an excluded ACP notification", () => {
  const doc = new Container(), notice = delegateNotice("completed"), skill = new Text("skill", 0, 0);
  skill.skillBlock = { name: "test", content: "body", userMessage: notice };
  doc.addChild(skill); doc.addChild(new UserMessageComponent(notice));
  doc.addChild(new UserMessageComponent("[acp_delegate completed] 什么意思？"));
  const index = new PromptIndexer().build(doc.render(80), doc);
  assert.equal(index.prompts.length, 1);
  assert.match(index.prompts[0].summary, /什么意思/);
});
test("OSC-only fallback excludes notifications even when batch closing is beyond five lines", () => {
  const manyLines = `[acp_delegate] 1 delegates finished (1 completed).\n${"body\n".repeat(12)}${AUTOMATED_ACP}`;
  const lines = [OSC + "FIRST", OSC + manyLines.split("\n")[0], ...manyLines.split("\n").slice(1), OSC + "LAST"];
  const index = new PromptIndexer().build(lines);
  assert.deepEqual(index.prompts.map(p => p.summary), ["FIRST", "LAST"]);
});

test("current round follows scroll position", () => {
  const index = { totalLines: 80, prompts: [anchor("a", 5), anchor("b", 50)] };
  assert.equal(currentPrompt(index, 0).id, "a");
  assert.equal(currentPrompt(index, 49).id, "a");
  assert.equal(currentPrompt(index, 50).id, "b");
});
test("real alps frames preserve OSC anchor at outer top and index exact offsets", () => {
  const h = layout({ framed: true });
  const frame = h.frame(); h.frame();
  const scrollBox = getScrollViewBox(frame, h.viewport.transcript);
  assert.equal(h.adapter.index.prompts.length, 5);
  for (const prompt of h.adapter.index.prompts) {
    const line = scrollBox.scrollContentLines[prompt.line];
    assert.ok(line.startsWith(OSC));
    assert.ok(stripTerminalSequences(line).includes("╭"));
  }
  h.adapter.dispose();
});
test("gutter is outside transcript, dock identity/width are untouched at all widths", () => {
  for (const width of [24, 40, 80, 120]) {
    const h = layout({ width, framed: true });
    h.frame(); const frame = h.frame();
    const scroll = getScrollViewBox(frame, h.viewport.transcript);
    assert.equal(scroll.rect.width, width - 4);
    assert.equal(frame.primaryScrollView, h.viewport.transcript);
    assert.equal(frame.root.children[1].component, h.originalChildren[1]);
    assert.equal(frame.root.children[1].rect.width, width);
    assert.equal(frame.lines.length, h.tui.terminal.rows);
    for (const line of frame.lines) assert.ok(visibleWidth(line) <= width);
    const gutterBox = frame.root.children[0].children[1];
    assert.equal(gutterBox.rect.x, width - 4);
    assert.equal(gutterBox.rect.height, scroll.rect.height);
    h.adapter.dispose();
  }
});
test("real alps right borders remain within reduced chat width and do not touch gutter", () => {
  const h = layout({ framed: true }); h.frame();
  const frame = h.frame(), scroll = getScrollViewBox(frame, h.viewport.transcript);
  const lines = scroll.scrollContentLines.map(stripTerminalSequences);
  assert.ok(lines.some(line => line.includes("╮")));
  assert.ok(lines.some(line => line.includes("╯")));
  assert.ok(lines.some(line => line.includes("│")));
  for (const line of lines.filter(line => /[╮╯│]/.test(line))) assert.ok(visibleWidth(line) <= 76);
  assert.equal(frame.root.children[0].children[1].rect.x, 76);
  h.adapter.dispose();
});
test("below 24 columns restores full chat width, resize recomputes marker positions", async () => {
  const h = layout(); h.frame(); await drain(); h.frame();
  h.tui.terminal.columns = 20;
  let frame = h.frame(); h.frame();
  assert.equal(getScrollViewBox(frame, h.viewport.transcript).rect.width, 20);
  assert.match(h.adapter.status(), /不足 24/);
  h.tui.terminal.columns = 100; h.tui.terminal.rows = 40;
  h.frame(); await drain(); frame = h.frame();
  assert.equal(getScrollViewBox(frame, h.viewport.transcript).rect.width, 96);
  assert.equal(h.adapter.height, frame.root.children[0].rect.height);
  h.adapter.dispose();
});
test("one/two-row viewport keeps all prompts reachable by collisions", () => {
  for (const rows of [8, 9]) {
    const h = layout({ rows, count: 100 }); h.frame(); const frame = h.frame();
    assert.ok(h.adapter.height >= 0);
    const groups = groupMarkers(h.adapter.index, h.adapter.height);
    if (h.adapter.height) assert.equal([...groups.values()].flat().length, 100);
    assert.equal(frame.primaryScrollView, h.viewport.transcript);
    h.adapter.dispose();
  }
});
test("height/follow correction is bounded and stable frames schedule no more", async () => {
  const h = layout(); h.frame(); await drain();
  const first = h.requests;
  h.frame(); await drain(); h.frame(); await drain();
  assert.equal(h.requests, first);
  h.adapter.dispose();
});
test("click jumps latest anchor and disables follow; streaming does not pull back", () => {
  const h = layout(); h.frame(); h.frame();
  const target = h.adapter.index.prompts[1];
  assert.ok(h.adapter.jump(target.id));
  assert.equal(h.viewport.transcript.scrollTop, target.line);
  assert.equal(h.viewport.transcript.isFollowingEnd, false);
  h.chat.addChild(new Text("新 token\n".repeat(100), 0, 0));
  h.frame(); assert.equal(h.viewport.transcript.scrollTop, target.line);
  assert.equal(h.adapter.activeId(), target.id);
  h.viewport.transcript.scrollToEnd(); h.frame();
  assert.equal(h.viewport.transcript.isFollowingEnd, true);
  assert.equal(h.adapter.jump("missing"), false);
  h.adapter.dispose();
});
test("last prompt clamps safely and still highlights selected round", () => {
  const h = layout({ count: 2 }); h.frame(); h.frame();
  const target = h.adapter.index.prompts.at(-1);
  h.adapter.jump(target.id);
  assert.ok(h.viewport.transcript.scrollTop <= target.line);
  assert.equal(h.viewport.transcript.isFollowingEnd, false);
  assert.equal(h.adapter.activeId(), target.id);
  h.adapter.dispose();
});
test("normalized gutter hit path stays outside chat; press does not request focus", () => {
  const h = layout(); h.frame(); const frame = h.frame();
  const gutter = frame.root.children[0].children[1];
  const row = [...groupMarkers(h.adapter.index, h.adapter.height).keys()][0];
  const boxes = getLayoutBoxesAt(frame, gutter.rect.x + 1, gutter.rect.y + row);
  assert.ok(boxes.some(box => box.component === gutter.component));
  const event = mouse("press", 1, row, 4, gutter.rect.height);
  assert.equal(gutter.component.handleMouse(event)?.handled, true);
  assert.equal(gutter.component.handleMouse(event)?.focus, undefined);
  gutter.component.handleMouse({ ...event, type: "click" });
  assert.equal(h.activated.length, 1);
  assert.equal(gutter.component.handleMouse({ ...event, type: "wheel", wheelDelta: 3 }), undefined);
  assert.equal(gutter.component.handleMouse({ ...event, type: "drag" }), undefined);
  assert.equal(gutter.component.handleMouse({ ...event, x: 0 }), undefined);
  h.adapter.dispose();
});
test("real fullscreen SGR mouse press/release clicks marker once; wheel and editor focus survive", () => {
  const h = layout(); h.frame(); const frame = h.frame();
  const native = new TuiAltScreen({ columns: 80, rows: 25, write() {} });
  native.requestRender = () => {};
  native.setLayoutRoot(h.viewport.root);
  native.currentLayout = frame;
  native.previousScreen = frame.lines;
  const editor = { render: () => ["current input"], invalidate() {}, handleInput() {} };
  native.setFocus(editor);
  const gutter = frame.root.children[0].children[1];
  const row = [...groupMarkers(h.adapter.index, h.adapter.height).keys()][0];
  const x = gutter.rect.x + 2, y = gutter.rect.y + row + 1; // SGR uses one-based coordinates.
  native.handleViewportInput(`\x1b[<0;${x};${y}M`);
  native.handleViewportInput(`\x1b[<0;${x};${y}m`);
  assert.equal(h.activated.length, 1);
  assert.equal(native.focusedComponent, editor);
  h.viewport.transcript.scrollToStart();
  native.currentLayout = h.frame();
  native.handleViewportInput(`\x1b[<65;${x};${y}M`);
  assert.ok(h.viewport.transcript.scrollTop > 0);
  h.adapter.dispose();
});

test("gutter uses single-cell glyphs, groups all items, and fits narrow render", () => {
  const index = { totalLines: 100, prompts: [anchor("a", 0), anchor("b", 1), anchor("c", 99)] };
  const clicked = [], gutter = new TimelineGutter(() => ({ index, height: 3, activeId: "b" }), () => theme, group => clicked.push(group));
  const lines = gutter.render(4);
  assert.ok(stripTerminalSequences(lines[0]).includes("◉"));
  assert.ok(lines.every(line => visibleWidth(line) === 4));
  gutter.handleMouse(mouse("click", 1, 0, 4, 3));
  assert.equal(clicked[0].length, 2);
  assert.ok(gutter.render(1).every(line => visibleWidth(line) <= 1));
});
test("dispose restores exact entry/descriptors, is idempotent and allows reload", () => {
  const h = layout(); h.frame();
  h.adapter.dispose(); h.adapter.dispose();
  assert.equal(h.viewport.root.entries[0], h.originalEntry);
  assert.deepEqual(h.viewport.root.children, h.originalChildren);
  assert.equal(Object.hasOwn(h.document, "render"), false);
  assert.equal(Object.hasOwn(h.viewport.transcript, "updateLayout"), false);
  const again = TimelineAdapter.attach(h.tui, () => theme, () => {});
  assert.ok(again); again.dispose();
});
test("a newer wrapper/owner is never overwritten on disposal", () => {
  const h = layout();
  const ownRender = h.document.render;
  const newer = function (width) { return ownRender.call(this, width); };
  h.document.render = newer;
  const newerEntry = { component: new Text("OTHER", 0, 0), basis: 0, grow: 1 };
  h.viewport.root.entries[0] = newerEntry; h.viewport.root.children[0] = newerEntry.component;
  h.adapter.dispose();
  assert.equal(h.document.render, newer);
  assert.equal(h.viewport.root.entries[0], newerEntry);
});
test("unknown/duplicate layout safely rejects without changing original layout", () => {
  const h = layout();
  assert.equal(TimelineAdapter.attach(h.tui, () => theme, () => {}), undefined);
  assert.equal(TimelineAdapter.attach({ layoutRoot: new Container() }, () => theme, () => {}), undefined);
  h.adapter.dispose();
});
test("picker mouse, arrows, Enter and Esc choose/cancel without token changes", () => {
  const prompts = [anchor("a", 0, 1), anchor("b", 5, 2)];
  const selected = [];
  const picker = new TimelinePicker(prompts, theme, () => 30, value => selected.push(value));
  picker.render(60);
  picker.handleMouse(mouse("press", 2, 2, 60, 5));
  picker.handleMouse(mouse("click", 2, 2, 60, 5));
  assert.equal(selected.at(-1), "b");
  const keyboard = new TimelinePicker(prompts, theme, () => 30, value => selected.push(value));
  keyboard.handleInput("\x1b[B"); keyboard.handleInput("\r");
  assert.equal(selected.at(-1), "b");
  keyboard.handleInput("\x1b"); assert.equal(selected.at(-1), null);
});
test("picker preserves selected item and makes it visible after terminal shrinks", () => {
  const prompts = Array.from({ length: 30 }, (_, i) => anchor(`${i}`, i, i + 1));
  let rows = 40, result;
  const picker = new TimelinePicker(prompts, theme, () => rows, value => { result = value; });
  picker.render(70);
  for (let i = 0; i < 20; i++) picker.handleInput("\x1b[B");
  rows = 6;
  const lines = picker.render(35).map(stripTerminalSequences);
  assert.ok(lines.some(line => line.includes("第 21 轮")));
  assert.ok(lines.length <= Math.floor(rows * 0.8));
  picker.handleInput("\r"); assert.equal(result, "20");
});
test("small popover placement clamps to chat edges and preserves the alps right border", () => {
  for (const columns of [1, 8, 24, 40, 80, 140]) for (const rows of [1, 4, 12, 40]) {
    const top = rows > 4 ? 2 : 0, height = Math.max(1, rows - top - 2);
    for (const y of [top, top + Math.floor(height / 2), top + height - 1]) {
      const p = pickerPlacement(columns, rows, 100, { x: columns - 3, y, top }, height);
      assert.ok(p.col >= 0 && p.col + p.width <= columns);
      assert.ok(p.row >= top && p.row + p.maxHeight <= Math.min(rows, top + height));
      assert.ok(p.width <= 42 && p.maxHeight <= 9);
      if (columns >= 24) assert.ok(p.col + p.width < columns - 5, "alps right border must remain exposed");
    }
  }
});
test("gutter passes absolute marker coordinates rather than local mouse offsets", () => {
  let point;
  const gutter = new TimelineGutter(() => ({ height: 10, index: { totalLines: 100, prompts: [anchor("a", 55)] } }),
    () => theme, (_group, location) => { point = location; });
  gutter.render(4);
  gutter.handleMouse({ ...mouse("click", 2, 5, 4, 10), screenX: 121, screenY: 12 });
  assert.deepEqual(point, { x: 120, y: 12, top: 7 });
});
test("compact rounded menu has exact cell widths, title, highlight and only one line per prompt", () => {
  const prompts = [anchor("中文 🌤️", 1, 12), anchor("second", 2, 13), anchor("third", 3, 14)];
  const picker = new TimelinePicker(prompts, theme, () => 40, () => {}, () => 9);
  for (const width of [8, 17, 30, 42]) {
    const raw = picker.render(width), lines = raw.map(stripTerminalSequences);
    assert.equal(lines.length, 5);
    assert.ok(raw.every(line => visibleWidth(line) === width));
    assert.ok(lines[0].startsWith("╭") && lines[0].endsWith("╮"));
    assert.ok(lines.at(-1).startsWith("╰") && lines.at(-1).endsWith("╯"));
    assert.ok(lines[1].includes("❯"));
    if (width >= 30) assert.ok(lines[0].includes("附近提问 · 3"));
  }
});
test("compact picker scrolls many prompts, ignores its frame, and safely degrades to one row", () => {
  const prompts = Array.from({ length: 100 }, (_, i) => anchor(String(i), i, i + 1));
  const selected = [], picker = new TimelinePicker(prompts, theme, () => 40, id => selected.push(id), () => 9);
  const first = picker.render(42); assert.equal(first.length, 9);
  picker.handleMouse(mouse("click", 0, 2, 42, 9));
  picker.handleMouse(mouse("click", 41, 2, 42, 9));
  picker.handleMouse(mouse("click", 2, 0, 42, 9));
  assert.deepEqual(selected, []);
  for (let i = 0; i < 20; i++) picker.handleInput("\x1b[B");
  assert.ok(picker.render(42).map(stripTerminalSequences).some(line => line.includes("第 21 轮")));
  picker.handleInput("\r"); assert.equal(selected.at(-1), "20");
  for (const rows of [1, 2, 3]) {
    const tiny = new TimelinePicker(prompts, theme, () => rows, id => selected.push(id), () => rows);
    assert.ok(tiny.render(12).length <= rows);
    tiny.handleInput("\x1b[B"); tiny.handleInput("\r"); assert.equal(selected.at(-1), "1");
  }
});
test("marker opens adjacent dynamic popover; resize clamps it without touching dock or body width", async () => {
  const h = harness({ count: 50, pendingPicker: true }); await h.emit("session_start");
  h.frame(); const frame = h.frame();
  const box = frame.root.children[0].children[1];
  const [row, group] = [...box.component.displayed].find(([, items]) => items.length > 1);
  const dock = h.viewport.root.entries[1].component;
  const event = { ...mouse("click", 1, row, 4, box.rect.height), screenX: box.rect.x + 1, screenY: box.rect.y + row };
  box.component.handleMouse(event);
  assert.equal(h.customs, 1);
  assert.equal(typeof h.customOptions.overlayOptions, "function");
  let p = h.customOptions.overlayOptions();
  assert.equal(p.anchor, "top-left");
  assert.ok(p.col + p.width < box.rect.x - 1);
  assert.ok(p.row <= event.screenY && p.row + p.maxHeight > event.screenY);
  assert.ok(h.picker.render(p.width).length <= p.maxHeight);
  h.tui.terminal.columns = 40; h.tui.terminal.rows = 14; h.frame(); h.frame();
  p = h.customOptions.overlayOptions();
  assert.ok(p.col >= 0 && p.col + p.width <= 34);
  assert.ok(p.row >= 0 && p.row + p.maxHeight <= 14);
  assert.ok(h.picker.render(p.width).every(line => visibleWidth(line) === p.width));
  assert.equal(h.viewport.root.entries[1].component, dock);
  h.finish(group[0].id); await drain();
  assert.equal(h.viewport.transcript.isFollowingEnd, false);
  await h.emit("session_shutdown");
});
test("real overlay compositing preserves alps/gutter/dock; SGR menu click restores editor focus", () => {
  const h = layout({ framed: true, count: 30 }); h.frame(); const frame = h.frame();
  const box = frame.root.children[0].children[1], dock = frame.root.children[1];
  const prompts = h.adapter.index.prompts.slice(0, 3);
  const native = new TuiAltScreen({ columns: 80, rows: 25, write() {}, hideCursor() {}, showCursor() {} });
  native.requestRender = () => {}; native.layoutRoot = h.viewport.root; native.currentLayout = frame;
  const editor = { render: () => ["draft"], invalidate() {}, handleInput() {} };
  native.setFocus(editor); let selected;
  const p = pickerPlacement(80, 25, prompts.length, { x: 77, y: 4, top: box.rect.y }, box.rect.height);
  const picker = new TimelinePicker(prompts, theme, () => 25, id => { selected = id; native.hideOverlay(); }, () => p.maxHeight);
  native.showOverlay(picker, { anchor: "top-left", ...p });
  const painted = native.compositeOverlays(frame.lines, 80, 25);
  assert.ok(p.row + p.maxHeight <= dock.rect.y);
  for (let row = 0; row < frame.lines.length; row++) {
    assert.equal(stripTerminalSequences(sliceByColumn(painted[row], 75, 80)),
      stripTerminalSequences(sliceByColumn(frame.lines[row], 75, 80)), "right border/gutter changed");
    if (row >= dock.rect.y) assert.equal(painted[row], frame.lines[row], "dock changed");
  }
  assert.ok(painted.some(line => stripTerminalSequences(line).includes("附近提问 · 3")));
  const x = p.col + 3, y = p.row + 3; // SGR is one-based; second item is local row 2.
  native.previousScreen = painted;
  native.handleViewportInput(`\x1b[<0;${x};${y}M`); native.handleViewportInput(`\x1b[<0;${x};${y}m`);
  assert.equal(selected, prompts[1].id); assert.equal(native.focusedComponent, editor);
  h.adapter.dispose();
});

test("command picker is also compact, while a single marker still jumps without any popover", async () => {
  const h = harness({ pendingPicker: true }); await h.emit("session_start"); h.frame(); const frame = h.frame();
  const box = frame.root.children[0].children[1];
  const [row] = [...box.component.displayed].find(([, items]) => items.length === 1);
  box.component.handleMouse({ ...mouse("click", 1, row, 4, box.rect.height), screenX: box.rect.x + 1, screenY: box.rect.y + row });
  assert.equal(h.customs, 0);
  const pending = h.command("list");
  const p = h.customOptions.overlayOptions(); assert.ok(p.width <= 42 && p.maxHeight <= 9);
  h.finish(null); await pending; await h.emit("session_shutdown");
});

test("extension keeps widget zero lines and on/off leaves dock identity unchanged", async () => {
  const h = harness(); await h.emit("session_start");
  assert.deepEqual(h.widget.render(), []);
  h.frame(); h.frame();
  await h.command("status"); assert.match(h.notices.at(-1).message, /已开启/);
  await h.command("off"); assert.equal(h.viewport.root.entries[0], h.originalEntry);
  await h.command("on"); h.frame(); h.frame();
  assert.equal(h.viewport.root.entries[1].component, h.originalChildren[1]);
  await h.emit("session_shutdown");
  assert.equal(h.viewport.root.entries[0], h.originalEntry);
});
test("pending collision selector is cancelled across compaction/session change", async () => {
  const h = harness({ pendingPicker: true }); await h.emit("session_start"); h.frame(); h.frame();
  const promise = h.command("list"); assert.equal(h.customs, 1);
  const scrollTop = h.viewport.transcript.scrollTop;
  await h.emit("session_compact"); await promise;
  assert.equal(h.viewport.transcript.scrollTop, scrollTop);
  await h.emit("session_shutdown");
});
test("a rebuilt transcript invalidates old object anchors", () => {
  const h = layout(); h.frame(); const id = h.adapter.index.prompts[0].id;
  h.chat.clear(); h.chat.addChild(new UserMessageComponent("新的分支")); h.frame();
  assert.equal(h.adapter.jump(id), false);
  h.adapter.dispose();
});
test("RPC/print never mount the gutter or change layout", async () => {
  for (const mode of ["rpc", "print"]) {
    const h = harness({ mode }); await h.emit("session_start");
    assert.equal(h.widget, undefined);
    assert.equal(h.viewport.root.entries[0], h.originalEntry);
    await h.emit("session_shutdown");
  }
});
test("stable proxy can switch regular/fullscreen without losing original scroll instance", async () => {
  const h = harness(); await h.emit("session_start"); h.frame();
  const root = h.tui.layoutRoot;
  h.tui.layoutRoot = undefined;
  assert.deepEqual(h.widget.render(), []);
  h.tui.layoutRoot = root;
  h.widget.render(); h.frame();
  assert.equal(h.viewport.root.entries[0].component[NODE]().entries[0].component, h.viewport.transcript);
  await h.emit("session_shutdown");
});

test("regular mode rejects stale navigation and fullscreen awaits fresh layout", () => {
  const h = layout(); h.frame(); h.frame();
  const id = h.adapter.index.prompts[0].id, root = h.tui.layoutRoot;
  const position = h.viewport.transcript.scrollTop;
  h.tui.layoutRoot = undefined;
  assert.equal(h.adapter.ownsCurrentRoot(), true); // Retained but suspended.
  h.document.render(80);
  assert.equal(h.adapter.canNavigate(), false);
  assert.equal(h.adapter.jump(id), false);
  assert.equal(h.viewport.transcript.scrollTop, position);
  h.tui.layoutRoot = root;
  assert.equal(h.adapter.canNavigate(), false);
  h.frame();
  assert.equal(h.adapter.canNavigate(), true);
  h.adapter.dispose();
});
test("same-root replacement or newer method owner invalidates ownership", () => {
  const h = layout(); h.frame();
  const slot = h.viewport.root.entries[0], child = h.viewport.root.children[0];
  h.viewport.root.entries[0] = h.originalEntry;
  assert.equal(h.adapter.ownsCurrentRoot(), false);
  assert.equal(h.adapter.jump(h.adapter.index.prompts[0].id), false);
  h.viewport.root.entries[0] = slot; h.viewport.root.children[0] = child;
  const own = h.document.render;
  h.document.render = function (width) { return own.call(this, width); };
  assert.equal(h.adapter.ownsCurrentRoot(), false);
  h.adapter.dispose();
});
test("changed OSC-only fallback sets invalidate old picker ids rather than reuse ordinal", () => {
  const indexer = new PromptIndexer();
  const old = indexer.build([OSC + "one", OSC + "two"]);
  const resized = indexer.build(["header", OSC + "one", OSC + "two"]);
  assert.deepEqual(old.prompts.map(p => p.id), resized.prompts.map(p => p.id));
  const newer = indexer.build([OSC + "new", OSC + "one", OSC + "two"]);
  assert.ok(!newer.prompts.some(p => p.id === old.prompts[1].id));
});
test("regular /timeline list tells user mode limitation and does not open a false navigation picker", async () => {
  const h = harness(); await h.emit("session_start"); h.frame(); h.frame();
  h.tui.layoutRoot = undefined;
  await h.command("list");
  assert.equal(h.customs, 0);
  assert.match(h.notices.at(-1).message, /普通终端模式/);
  await h.emit("session_shutdown");
});
test("navigation waits for reduced-width layout after resize", () => {
  const h = layout(); h.frame(); assert.equal(h.adapter.canNavigate(), true);
  const id = h.adapter.index.prompts[0].id;
  h.tui.terminal.columns = 100;
  assert.equal(h.adapter.canNavigate(), false);
  assert.equal(h.adapter.jump(id), false);
  h.frame(); assert.equal(h.adapter.canNavigate(), true);
  h.adapter.dispose();
});

test("production indexing reads user spans, not every historical AI/tool row", () => {
  const doc = new Container();
  doc.addChild(framedUser("FIRST"));
  doc.addChild(new Text("historical AI/tool output\n".repeat(10000), 0, 0));
  doc.addChild(framedUser("LAST"));
  const raw = doc.render(80); let reads = 0;
  const measured = new Proxy(raw, { get(target, key, receiver) {
    if (typeof key === "string" && /^\d+$/.test(key)) reads++;
    return Reflect.get(target, key, receiver);
  } });
  const index = new PromptIndexer().build(measured, doc);
  assert.deepEqual(index.prompts.map(p => p.summary), ["FIRST", "LAST"]);
  assert.equal(index.totalLines, raw.length);
  assert.ok(reads <= 4, `expected only user zone reads, got ${reads} for ${raw.length} rows`);
});
test("unchanged layout reuses index identity, but equal-height user edits invalidate description and ACP exclusion", () => {
  const doc = new Container();
  const user = { text: "Original", outputPad: 1, markdownTransformers: [],
    render() { return [OSC + this.text]; }, invalidate() {} };
  doc.addChild(user); const indexer = new PromptIndexer();
  const first = indexer.build(doc.render(80), doc);
  assert.equal(indexer.build(doc.render(80), doc), first);
  user.text = "Modified";
  const edited = indexer.build(doc.render(80), doc);
  assert.notEqual(edited, first); assert.equal(edited.prompts[0].summary, "Modified");
  assert.equal(edited.prompts[0].id, first.prompts[0].id);
  user.text = delegateNotice("completed");
  assert.equal(indexer.build(doc.render(80), doc).prompts.length, 0);
  user.text = "Again";
  assert.equal(indexer.build(doc.render(80), doc).prompts[0].id, first.prompts[0].id);
});
test("HStack measures and lays out one cached document render per frame, never two", async () => {
  const h = layout({ attach: false }); let renders = 0;
  const original = h.document.render;
  const spy = function (width) { renders++; return original.call(this, width); };
  h.document.render = spy;
  h.adapter = TimelineAdapter.attach(h.tui, () => theme, () => {});
  h.frame(); await drain(); h.frame(); await drain(); renders = 0;
  for (let i = 0; i < 10; i++) { h.frame(); await drain(); }
  assert.equal(renders, 10);
  h.adapter.dispose(); assert.equal(h.document.render, spy);
});
test("standalone measurement expires before next turn; streaming frames never reuse old content", async () => {
  const h = layout({ attach: false }); let renders = 0;
  const original = h.document.render;
  h.document.render = function (width) { renders++; return original.call(this, width); };
  h.adapter = TimelineAdapter.attach(h.tui, () => theme, () => {});
  h.frame(); await drain();
  const top = h.adapter.index.totalLines; renders = 0;
  h.viewport.transcript.render(76); assert.equal(renders, 1);
  await drain(); h.chat.addChild(new Text("new reply row", 0, 0));
  h.document.render(76); assert.equal(renders, 2);
  assert.ok(h.adapter.index.totalLines > top);
  const before = h.adapter.index.totalLines;
  h.chat.addChild(new Text("another reply row", 0, 0)); h.frame();
  assert.equal(renders, 3); assert.ok(h.adapter.index.totalLines > before);
  h.adapter.dispose();
});
test("measurement cache is width-scoped and scroll render descriptor restores exactly", () => {
  const h = layout({ attach: false }); let renders = 0;
  const original = h.document.render, before = Object.getOwnPropertyDescriptor(h.viewport.transcript, "render");
  h.document.render = function (width) { renders++; return original.call(this, width); };
  h.adapter = TimelineAdapter.attach(h.tui, () => theme, () => {});
  h.viewport.transcript.render(76); h.document.render(75);
  assert.equal(renders, 2);
  h.adapter.dispose();
  assert.deepEqual(Object.getOwnPropertyDescriptor(h.viewport.transcript, "render"), before);
});
test("following growth in the same reply no longer schedules corrective frames", async () => {
  const h = layout();
  // The viewport top must already be within this reply, not an earlier short round.
  h.chat.addChild(new Text("current reply body\n".repeat(60), 0, 0));
  h.frame(); await drain(); h.frame(); await drain();
  const active = h.adapter.activeId(), requestsBefore = h.requests;
  for (let i = 0; i < 10; i++) {
    h.chat.addChild(new Text("streamed reply row", 0, 0)); h.frame(); await drain();
    assert.equal(h.adapter.activeId(), active);
  }
  assert.equal(h.requests, requestsBefore);
  h.chat.addChild(new UserMessageComponent("a brand new user round"));
  h.chat.addChild(new Text("reply body\n".repeat(50), 0, 0));
  h.frame(); await drain();
  assert.equal(h.requests, requestsBefore + 1); // New active marker still receives its necessary correction.
  h.frame(); await drain(); assert.equal(h.requests, requestsBefore + 1);
  h.adapter.dispose();
});
test("gutter caches unchanged rows, refreshes highlight/theme/size and invalidation", () => {
  const source = { index: { totalLines: 100, prompts: [anchor("a", 0), anchor("b", 99)] }, height: 10, activeId: "a" };
  let palette = "one";
  const gutter = new TimelineGutter(() => source, () => ({ fg: (color, text) => `${palette}:${color}:${text}` }), () => {});
  const first = gutter.render(40); assert.equal(gutter.render(40), first);
  source.activeId = "b"; const highlighted = gutter.render(40); assert.notEqual(highlighted, first);
  palette = "two"; const themed = gutter.render(40); assert.notEqual(themed, highlighted);
  gutter.invalidate(); const invalidated = gutter.render(40); assert.notEqual(invalidated, themed);
  source.height = 4; assert.equal(gutter.render(40).length, 4);
  assert.ok(gutter.render(1).every(line => visibleWidth(line) <= 1));
});
test("later scroll-render owner is preserved and disables stale timeline navigation", () => {
  const h = layout(); h.frame(); const foreign = () => ["owned by later extension"];
  h.viewport.transcript.render = foreign;
  assert.equal(h.adapter.ownsCurrentRoot(), false); assert.equal(h.adapter.canNavigate(), false);
  h.adapter.dispose(); assert.equal(h.viewport.transcript.render, foreign);
});

test("picker reuses only its last small frame and invalidates on size, theme or explicit refresh", () => {
  let rows = 9, recolor = false;
  const palette = { fg: (color, text) => (recolor ? "\x1b[32m" : "") + theme.fg(color, text) };
  const picker = new TimelinePicker(Array.from({ length: 100 }, (_, i) => anchor(String(i), i, i + 1)),
    palette, () => 40, () => {}, () => rows);
  const first = picker.render(42); assert.equal(picker.render(42), first);
  const narrowed = picker.render(30); assert.notEqual(narrowed, first);
  rows = 5; const shorter = picker.render(30); assert.notEqual(shorter, narrowed); assert.ok(shorter.length <= 5);
  recolor = true; const themed = picker.render(30); assert.notEqual(themed, shorter);
  picker.invalidate(); const refreshed = picker.render(30); assert.notEqual(refreshed, themed);
  assert.equal(picker.render(30), refreshed);
  assert.equal(picker.rendered.lines, refreshed); assert.ok(picker.rendered.lines.length <= 9);
});
test("picker cache never swallows keyboard, wheel or mouse selection", () => {
  let selected;
  const picker = new TimelinePicker(Array.from({ length: 20 }, (_, i) => anchor(String(i), i, i + 1)),
    theme, () => 40, id => { selected = id; }, () => 9);
  const first = picker.render(42);
  picker.handleInput("\x1b[B"); const keyboard = picker.render(42); assert.notEqual(keyboard, first);
  assert.ok(keyboard.map(stripTerminalSequences).some(line => line.includes("❯ 第 2 轮")));
  picker.handleMouse({ ...mouse("wheel", 2, 2, 42, 9), wheelDelta: 1 });
  const wheeled = picker.render(42); assert.notEqual(wheeled, keyboard);
  assert.ok(wheeled.map(stripTerminalSequences).some(line => line.includes("❯ 第 3 轮")));
  picker.handleMouse(mouse("press", 2, 1, 42, 9));
  const pressed = picker.render(42); assert.notEqual(pressed, wheeled);
  picker.handleMouse(mouse("click", 2, 1, 42, 9)); assert.equal(selected, "0");
});
test("settled timeline stays idle and pending microtasks cannot repaint after disposal", async () => {
  const h = layout(); h.frame(); await drain(); h.frame(); await drain();
  const idle = h.requests;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(h.requests, idle);
  h.frame(); h.adapter.dispose(); const stopped = h.requests;
  await drain(); await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(h.requests, stopped);
});

test("Pi's actual extension loader accepts timeline alongside existing local extensions", async () => {
  const loader = await jiti.import(join(modules, "@earendil-works/pi-coding-agent/dist/core/extensions/loader.js"));
  const extensions = [join(root, "index.ts"), ...["working-timer", "jinshanwei-weather", "subscription-usage-row"]
    .map(name => resolve(root, "..", name, "index.ts"))];
  const loaded = await loader.loadExtensions(extensions, process.cwd());
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 4);
});
