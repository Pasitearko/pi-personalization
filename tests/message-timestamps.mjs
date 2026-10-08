import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const modules = resolve(process.argv[2] || process.env.PI_TEST_MODULES || new URL("../node_modules",import.meta.url).pathname.replace(/^\/(\w:)/,"$1"));
const require = createRequire(join(modules, "test.cjs"));
const { createJiti } = require("jiti");
const alias = Object.fromEntries(["pi-coding-agent", "pi-tui", "pi-ai"].map(name =>
  [`@earendil-works/${name}`, join(modules, "@earendil-works", name, "dist/index.js")]));
const jiti = createJiti(import.meta.url, { alias });
const root = join(dirname(dirname(fileURLToPath(import.meta.url))), "extensions");
const sdk = await jiti.import(alias["@earendil-works/pi-coding-agent"]);
sdk.initTheme("dark");
const tui = await jiti.import(alias["@earendil-works/pi-tui"]);
const extension = await jiti.import(join(root, "message-timestamps/index.ts"));
const alps = await jiti.import(join(root, "../node_modules/alps-pi/src/features/chrome-frame/patch.ts"));
const plain = text => text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;:]*m/g, "");
const timestamp = new Date(2026, 9, 4, 19, 4, 21).getTime();
const stamp = "10/04 19:04:21";

await test("local date format, leading zeros, and invalid dates", () => {
  assert.equal(extension.formatMessageTimestamp(timestamp), stamp);
  assert.equal(extension.formatMessageTimestamp(new Date(2026, 0, 2, 3, 4, 5).getTime()), "01/02 03:04:05");
  for (const value of [undefined, null, "today", NaN, Infinity, -1, 1e20])
    assert.equal(extension.formatMessageTimestamp(value), undefined);
});

await test("decorate headers without changing body, original arrays, or terminal width", () => {
  for (const label of ["USER", "ASSISTANT", "TOOL edit ✓", "TOOL read ✓", "TOOL bash ✓"]) {
    for (let width = 8; width <= 180; width++) {
      const title = `╭─ ${label} ─ [ 99 ]`;
      if (width < tui.visibleWidth(title + " ╮")) continue;
      const header = title + " " + "─".repeat(width - tui.visibleWidth(title + " ╮")) + "╮";
      const input = [header, "body", "bottom"];
      const result = extension.addHeaderTimestamp(input, width, stamp);
      assert.equal(tui.visibleWidth(result[0]), width);
      assert.deepEqual(result.slice(1), input.slice(1));
      assert.equal(input[0], header);
      if (width >= tui.visibleWidth(title + ` ─ ${stamp} ╮`)) assert.ok(result[0].includes(stamp));
      else assert.strictEqual(result, input);
      assert.strictEqual(extension.addHeaderTimestamp(result, width, stamp), result);
    }
  }
  const think = ["╭─ THINK ─ [ 99 ] ─────────────────────────────────────╮"];
  assert.strictEqual(extension.addHeaderTimestamp(think, 80, stamp), think);
});

await test("straight separators and leading padding match screenshot-style headers", () => {
  for (const label of ["USER", "ASSISTANT", "TOOL edit ✓", "TOOL read ✓", "TOOL bash ✓"]) {
    const head = `─ ${label} ─ [ 3 ] ` + "─".repeat(70);
    const input = ["", head, "body"];
    const width = tui.visibleWidth(head);
    const result = extension.addHeaderTimestamp(input, width, stamp);
    assert.equal(result[0], "");
    assert.match(result[1], /─ \[ 3 \] ─ 10\/04 19:04:21 /);
    assert.equal(tui.visibleWidth(result[1]), width);
    assert.equal(result[2], "body");
  }
});

await test("ANSI color and OSC markers survive decoration", () => {
  const head = "\x1b]133;A\x07\x1b[36m╭─ \x1b[39m\x1b[35mUSER ─ [ 7 ]\x1b[39m\x1b[36m " + "─".repeat(60) + "╮\x1b[39m";
  const width = tui.visibleWidth(head);
  const result = extension.addHeaderTimestamp([head, "body"], width, stamp, s => `\x1b[90m${s}\x1b[39m`);
  assert.equal(tui.visibleWidth(result[0]), width);
  assert.ok(result[0].startsWith("\x1b]133;A\x07"));
  assert.ok(result[0].endsWith("╮\x1b[39m"));
  assert.match(plain(result[0]), /USER ─ \[ 7 \] ─ 10\/04 19:04:21/);
});

await test("real Pi + alps: original user/assistant times, streaming stability, duplicate prompts, reload", async () => {
  const handlers = new Map(), commands = new Map(), notices = [];
  const sessionManager = sdk.SessionManager.inMemory(process.cwd());
  const ctx = { hasUI: true, mode: "tui", sessionManager,
    ui: { notify: message => notices.push(message),
      theme: { fg: (_token, text) => `\x1b[90m${text}\x1b[39m` } } };
  const userMessage = time => ({ role: "user", content: "x".repeat(28), timestamp: time });
  sessionManager.appendMessage(userMessage(timestamp));
  sessionManager.appendMessage(userMessage(timestamp + 1000));
  const originals = [sdk.UserMessageComponent.prototype.render, sdk.AssistantMessageComponent.prototype.render,
    sdk.InteractiveMode.prototype.addMessageToChat, sdk.ToolExecutionComponent.prototype.render,
    sdk.ToolExecutionComponent.prototype.markExecutionStarted];
  const originalNow = Date.now;
  try {
    alps.enablePatch();
    extension.default({ on: (name, handler) => handlers.set(name, handler),
      registerCommand: (name, command) => commands.set(name, command) });
    handlers.get("session_start")({}, ctx);
    assert.equal(notices.length, 0, "startup must be silent");
    await commands.get("timestamps").handler("", ctx);
    assert.match(notices.at(-1), /已启用；USER 挂钩：正常；ASSISTANT 挂钩：正常/);
    // Components that existed before activation are matched against persisted history.
    const first = new sdk.UserMessageComponent("x".repeat(28));
    const second = new sdk.UserMessageComponent("x".repeat(28));
    assert.match(plain(first.render(80)[0]), /USER ─ \[ 7 \] ─ 10\/04 19:04:21/);
    assert.match(plain(second.render(80)[0]), /10\/04 19:04:22/);
    const initial = plain(first.render(80)[0]);
    Date.now = () => timestamp + 86400000;
    assert.equal(plain(first.render(80)[0]), initial);

    const assistantMessage = {
      role: "assistant", content: [{ type: "text", text: "x".repeat(396) }], timestamp,
      provider: "openai", api: "openai-responses", model: "test", stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const assistant = new sdk.AssistantMessageComponent(assistantMessage);
    assert.match(plain(assistant.render(80)[0]), /ASSISTANT ─ \[ 99 \] ─ 10\/04 19:04:21/);
    assistant.updateContent({ ...assistantMessage, content: [{ type: "text", text: "updated" }] });
    assert.match(plain(assistant.render(80)[0]), /10\/04 19:04:21/);

    // Actual Pi component construction preserves time even for text not in persisted history.
    const mode = Object.create(sdk.InteractiveMode.prototype);
    Object.assign(mode, { chatContainer: new tui.Container(), outputPad: 1,
      getMarkdownThemeWithSettings: () => sdk.getMarkdownTheme(), getMarkdownTransformers: () => [] });
    mode.addMessageToChat({ role: "user", content: "new prompt", timestamp: timestamp + 2000 });
    const created = mode.chatContainer.children.find(c => c instanceof sdk.UserMessageComponent);
    assert.match(plain(created.render(80)[0]), /10\/04 19:04:23/);
    for (let width = 0; width <= 100; width++) {
      for (const line of created.render(width)) assert.ok(tui.visibleWidth(line) <= width);
    }

    // Tool timestamps are captured at execution start and stay fixed as output arrives.
    let redraws = 0;
    const toolUI = { requestRender: () => redraws++ };
    const toolHeader = tool => tool.render(100).map(plain).find(line => line.includes("TOOL "));
    Date.now = () => timestamp + 3000;
    const tools = ["edit", "read", "bash"].map(name => new sdk.ToolExecutionComponent(
      name, `live-${name}`, { path: "file.txt", command: "echo ok", oldText: "a", newText: "b" },
      { showImages: false }, undefined, toolUI, process.cwd()));
    for (const tool of tools) {
      tool.markExecutionStarted();
      assert.ok(toolHeader(tool)?.includes("10/04 19:04:24"));
      Date.now = () => timestamp + 60000;
      tool.updateResult({ content: [{ type: "text", text: "partial" }], isError: false }, true);
      assert.ok(toolHeader(tool)?.includes("10/04 19:04:24"));
      tool.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
      assert.match(toolHeader(tool), /TOOL (?:edit|read|bash) ✓/);
      assert.ok(toolHeader(tool).includes("10/04 19:04:24"));
      tool.setExpanded(true);
      assert.ok(toolHeader(tool).includes("10/04 19:04:24"));
      Date.now = () => timestamp + 3000;
    }
    const errorTool = new sdk.ToolExecutionComponent("bash", "live-error", { command: "false" }, {}, undefined, toolUI, process.cwd());
    errorTool.markExecutionStarted();
    errorTool.updateResult({ content: [{ type: "text", text: "failed" }], isError: true });
    assert.ok(toolHeader(errorTool).includes("10/04 19:04:24"));

    // Reopened history uses saved call timestamps, keyed by tool call ID (not name).
    sessionManager.appendMessage({ ...assistantMessage, timestamp: timestamp + 4000,
      content: [{ type: "toolCall", id: "history-read", name: "read", arguments: { path: "old.txt" } }] });
    const savedResult = { role: "toolResult", toolCallId: "history-read", toolName: "read", timestamp: timestamp + 5000,
      content: [{ type: "text", text: "saved output" }], isError: false };
    sessionManager.appendMessage(savedResult);
    const historyTool = new sdk.ToolExecutionComponent("read", "history-read", { path: "old.txt" }, {}, undefined, toolUI, process.cwd());
    historyTool.updateResult(savedResult);
    assert.ok(toolHeader(historyTool).includes("10/04 19:04:25"));
    const missingCall = new sdk.ToolExecutionComponent("read", "imported-read", { path: "old.txt" }, {}, undefined, toolUI, process.cwd());
    missingCall.updateResult({ ...savedResult, toolCallId: "imported-read", timestamp: timestamp + 7000 });
    assert.ok(toolHeader(missingCall).includes("10/04 19:04:28"));

    // One command controls all headers; hiding does not remove timing information.
    await commands.get("timestamps").handler("hide", ctx);
    assert.ok(notices.at(-1).includes("TOOL 挂钩：正常；时间戳隐藏"));
    for (const component of [first, assistant, ...tools, historyTool])
      assert.ok(!component.render(100).map(plain).join("\n").match(/10\/04 19:04:/));
    const redrawsBefore = redraws;
    await commands.get("timestamps").handler("show", ctx);
    assert.ok(redraws > redrawsBefore);
    assert.ok(plain(first.render(100)[0]).includes(stamp));
    for (const tool of tools) assert.ok(toolHeader(tool).includes("10/04 19:04:24"));
    await commands.get("timestamps").handler("toggle", ctx);
    assert.ok(!toolHeader(tools[0]).includes("10/04"));
    await commands.get("timestamps").handler("toggle", ctx);
    assert.ok(toolHeader(tools[0]).includes("10/04"));
    await commands.get("timestamps").handler("invalid", ctx);
    assert.match(notices.at(-1), /用法/);
    assert.ok(toolHeader(tools[0]).includes("10/04"));

    // alps still recognizes ownership: no conflicts or nested frames on re-enable/reload.
    alps.enablePatch();
    assert.equal(alps.getGlobalPatchState().conflicts.size, 0);
    assert.equal(plain(first.render(80)[0]).split(stamp).length, 2);
    handlers.get("session_shutdown")({}, { ...ctx, hasUI: false, mode: "rpc" });
    assert.ok(plain(first.render(80)[0]).includes(stamp));
    handlers.get("session_shutdown")({}, ctx);
    assert.ok(!plain(first.render(80)[0]).includes(stamp));
    alps.disablePatch();
    assert.equal(alps.getGlobalPatchState().conflicts.size, 0);
    assert.strictEqual(sdk.UserMessageComponent.prototype.render, originals[0]);
    assert.strictEqual(sdk.AssistantMessageComponent.prototype.render, originals[1]);
    assert.strictEqual(sdk.InteractiveMode.prototype.addMessageToChat, originals[2]);
    assert.strictEqual(sdk.ToolExecutionComponent.prototype.render, originals[3]);
    assert.strictEqual(sdk.ToolExecutionComponent.prototype.markExecutionStarted, originals[4]);
    alps.enablePatch();
    handlers.get("session_start")({}, ctx);
    assert.match(plain(first.render(80)[0]), /10\/04 19:04:21/);
  } finally {
    Date.now = originalNow;
    handlers.get("session_shutdown")?.({}, ctx);
    alps.disablePatch();
  }
});
