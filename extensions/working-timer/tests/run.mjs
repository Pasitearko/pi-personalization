import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

const modules = resolve(process.argv[2] || process.env.PI_TEST_MODULES || new URL("../../../node_modules", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
const require = createRequire(join(modules, "test.cjs"));
const { createJiti } = require("jiti");
const aliases = Object.fromEntries(["pi-coding-agent", "pi-tui"].map(name =>
  [`@earendil-works/${name}`, join(modules, "@earendil-works", name, "dist/index.js")]));
const jiti = createJiti(import.meta.url, { alias: aliases });
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { RoundTimer, formatDuration, isRoundResult, ENTRY_TYPE } = await jiti.import(join(root, "timer.ts"));
const { default: extension } = await jiti.import(join(root, "index.ts"));
const { createSoundPlayer, playbackScript, SOUND_PATH, MAX_PLAYBACK_MS, SOUND_VOLUME_PERCENT } = await jiti.import(join(root, "sound.ts"));
const { loadThemeFromPath } = await jiti.import(join(modules, "@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"));
const { visibleWidth, getKeybindings, setKeybindings, KeybindingsManager } = await jiti.import(aliases["@earendil-works/pi-tui"]);
setKeybindings(new KeybindingsManager({ "app.interrupt": { defaultKeys: "escape" } }));
const themes = Object.fromEntries(["dark", "light"].map(name => [name, loadThemeFromPath(
  join(modules, `@earendil-works/pi-coding-agent/dist/modes/interactive/theme/${name}.json`), "truecolor")]));
const plain = text => text.replace(/\x1b\[[0-9;]*m/g, "");

function harness(t, { mode = "tui", branch = [], audioFails = false } = {}) {
  const originalSet = globalThis.setInterval, originalClear = globalThis.clearInterval;
  const intervals = new Set();
  globalThis.setInterval = () => { const handle = { unref() {} }; intervals.add(handle); return handle; };
  globalThis.clearInterval = handle => intervals.delete(handle);
  t.after(() => { globalThis.setInterval = originalSet; globalThis.clearInterval = originalClear; });
  const handlers = new Map(), commands = new Map(), saved = [], workingVisibility = [], notices = [];
  let widget, placement, renderCount = 0, input, soundPlays = 0, soundDisposals = 0, now = 0;
  const ctx = {
    hasUI: mode !== "print", mode, signal: new AbortController().signal,
    sessionManager: { getBranch: () => branch },
    ui: {
      notify(message, level) { notices.push({ message, level }); },
      onTerminalInput(handler) { input = handler; return () => { input = undefined; }; },
      setWorkingVisible(value) { workingVisibility.push(value); },
      setWidget(key, factory, options) {
        assert.equal(key, "working-timer");
        widget?.dispose?.();
        widget = factory?.({ requestRender() { renderCount++; } }, themes.dark);
        placement = options?.placement;
      },
    },
  };
  extension({
    on(name, handler) { handlers.set(name, handler); },
    appendEntry(type, data) { saved.push({ type: "custom", customType: type, data }); },
    registerCommand(name, command) { commands.set(name, command); },
  }, { createPlayer: () => ({
    play(onFailure) { soundPlays++; if (audioFails) onFailure?.(); },
    dispose() { soundDisposals++; },
  }), now: () => now });
  return {
    ctx, intervals, handlers, saved, workingVisibility, notices,
    advance(ms) { now += ms; },
    get soundPlays() { return soundPlays; }, get soundDisposals() { return soundDisposals; },
    async command(name) { await commands.get(name).handler("", { ...ctx }); },
    get widget() { return widget; }, get placement() { return placement; },
    get renderCount() { return renderCount; },
    get input() { return input; },
    text(width = 120) { return (widget?.render(width) ?? []).map(plain).join("\n"); },
    async emit(name, event = {}) { await handlers.get(name)?.({ type: name, ...event }, ctx); },
  };
}

const QUOTA_ROW_KEY = Symbol.for("pi.extensions.quota-row.v1");

/** Stand-in for the openai-quota extension's published row host. */
function quotaHost(t, segment) {
  const listeners = new Set();
  const calls = { claim: 0, release: 0, render: 0 };
  let claims = 0;
  globalThis[QUOTA_ROW_KEY] = {
    render() { calls.render++; return typeof segment === "function" ? segment() : segment; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    claim() { calls.claim++; claims++; return () => { calls.release++; claims--; }; },
  };
  t.after(() => { delete globalThis[QUOTA_ROW_KEY]; });
  return {
    calls, get claims() { return claims; }, get listenerCount() { return listeners.size; },
    notify: () => [...listeners].forEach(listener => listener()),
  };
}

await test("duration includes hours and never wraps or becomes negative", () => {
  assert.equal(formatDuration(0), "00:00");
  assert.equal(formatDuration(84999), "01:24");
  assert.equal(formatDuration(3601000), "01:00:01");
  assert.equal(formatDuration(-5), "00:00");
});
await test("retry preserves initial clock; completion freezes duration and records previous", () => {
  let now = 0;
  const timer = new RoundTimer(() => now);
  timer.start(); now = 20000; timer.observeStop("error"); timer.start();
  assert.equal(timer.elapsed(), 20000);
  now = 84000; timer.observeStop("stop");
  assert.deepEqual(timer.finish(), { outcome: "completed", elapsedMs: 84000 });
  now = 150000; assert.equal(timer.elapsed(), 84000);
  timer.start(); now += 52000; timer.finish();
  assert.equal(timer.previous.elapsedMs, 84000);
  assert.match(plain(timer.render(120, themes.dark)[0]), /上轮 01:24/);
  assert.equal(timer.finish(), undefined);
});
await test("parallel and nested tools tracked by id, tool-end returns to waiting", () => {
  const timer = new RoundTimer(() => 0); timer.start();
  timer.toolStart("a", "bash"); timer.toolStart("b", "read"); timer.toolStart("a/1", "mcp");
  assert.equal(timer.phase, "工具执行 · bash +2");
  timer.generating(); assert.match(timer.phase, /工具执行/);
  timer.toolEnd("b"); assert.equal(timer.phase, "工具执行 · bash +1");
  timer.toolEnd("a"); assert.equal(timer.phase, "工具执行 · mcp");
  timer.toolEnd("a/1"); assert.equal(timer.phase, "等待响应");
});
await test("Failed is explicitly red and bold in dark/light; cancellation is separate", () => {
  const timer = new RoundTimer(() => 0); timer.start(); timer.observeStop("error"); timer.finish();
  for (const [name, theme] of Object.entries(themes)) {
    const line = timer.render(120, theme)[0];
    assert.match(plain(line), /✗ Failed.*请求失败/);
    assert.ok(line.includes(name === "dark" ? "38;2;255;107;107" : "38;2;192;57;43"));
    assert.ok(line.includes("\x1b[1m"));
  }
  timer.start(); timer.observeStop("aborted"); timer.finish();
  assert.match(plain(timer.render(120, themes.dark)[0]), /Cancelled/);
});
await test("Unicode, ANSI, narrow widths and long phases always fit", () => {
  const timer = new RoundTimer(() => 0); timer.start(); timer.toolStart("a", "工具😀".repeat(100));
  for (let width = 0; width <= 180; width++) {
    for (const line of timer.render(width, themes.dark)) assert.ok(visibleWidth(line) <= width);
  }
  assert.doesNotMatch(plain(timer.render(35, themes.dark)[0]), /工具执行|上轮/);
});
await test("reserve previous duration before truncating very long tool names", () => {
  const timer = new RoundTimer(() => 0);
  timer.restore([{ outcome: "completed", elapsedMs: 84000 }]); timer.start();
  timer.toolStart("a", "很长的工具名😀".repeat(80));
  for (const width of [76, 80, 120]) {
    const line = timer.render(width, themes.dark)[0];
    assert.match(plain(line), /上轮 01:24$/);
    assert.ok(visibleWidth(line) <= width);
  }
});
await test("reject malformed persisted metadata", () => {
  for (const item of [null, {}, { outcome: "failed", elapsedMs: -1 }, { outcome: "completed", elapsedMs: Infinity },
    { outcome: "completed", elapsedMs: "10" }, { outcome: "unknown", elapsedMs: 10 }]) assert.equal(isRoundResult(item), false);
  assert.equal(isRoundResult({ outcome: "failed", elapsedMs: 10 }), true);
});
await test("widget below editor, no timers at session start; stream/tool phases update", async t => {
  const h = harness(t); await h.emit("session_start");
  assert.equal(h.placement, "belowEditor"); assert.equal(h.text(), ""); assert.equal(h.intervals.size, 0);
  await h.emit("agent_start"); assert.match(h.text(), /Working.*等待响应/); assert.equal(h.intervals.size, 1);
  await h.emit("message_update", { assistantMessageEvent: { type: "text_delta" } });
  assert.match(h.text(), /生成回复/);
  await h.emit("tool_execution_start", { toolCallId: "a", toolName: "bash" }); assert.match(h.text(), /工具执行 · bash/);
  await h.emit("tool_execution_end", { toolCallId: "a", isError: true });
  await h.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
  await h.emit("agent_settled"); assert.match(h.text(), /Completed/); assert.equal(h.intervals.size, 0);
  assert.equal(h.saved.length, 1); assert.equal(h.saved[0].customType, ENTRY_TYPE);
  await h.emit("agent_settled"); assert.equal(h.saved.length, 1);
});
await test("agent_end is not final; automatic retries stay in one round", async t => {
  const h = harness(t); await h.emit("session_start"); await h.emit("agent_start");
  await h.emit("message_end", { message: { role: "assistant", stopReason: "error" } });
  await h.emit("agent_end"); assert.match(h.text(), /Working/); assert.equal(h.saved.length, 0);
  await h.emit("agent_start"); assert.equal(h.intervals.size, 1);
  await h.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
  await h.emit("agent_before_settle", { outcome: "completed" });
  await h.emit("agent_settled"); assert.match(h.text(), /Completed/);
});
await test("final failure and cancellation render independently", async t => {
  const h = harness(t); await h.emit("session_start"); await h.emit("agent_start");
  await h.emit("message_end", { message: { role: "assistant", stopReason: "error" } });
  await h.emit("agent_before_settle", { outcome: "error" }); await h.emit("agent_settled");
  assert.match(h.text(), /Failed/);
  const controller = new AbortController(); h.ctx.signal = controller.signal;
  await h.emit("agent_start"); controller.abort(); await h.emit("agent_settled");
  assert.match(h.text(), /Cancelled/); assert.equal(h.saved[1].data.outcome, "cancelled");
});
await test("Esc during retry uses round cancellation, not the finished attempt signal", async t => {
  const h = harness(t); await h.emit("session_start"); await h.emit("agent_start");
  await h.emit("message_end", { message: { role: "assistant", stopReason: "error" } });
  await h.emit("agent_end"); assert.equal(h.ctx.signal.aborted, false);
  assert.equal(h.input("\x1b"), undefined); // Never consume the key.
  await h.emit("agent_settled"); assert.match(h.text(), /Cancelled/);
});
await test("honor remapped interrupt; cancelling a dialog doesn't cancel the round", async t => {
  const originalKeys = getKeybindings();
  setKeybindings(new KeybindingsManager({ "app.interrupt": { defaultKeys: "escape" } }, { "app.interrupt": "ctrl+x" }));
  t.after(() => setKeybindings(originalKeys));
  const h = harness(t); await h.emit("session_start"); await h.emit("agent_start");
  await h.emit("ui_prompt_start"); h.input("\x18"); await h.emit("ui_prompt_end");
  await h.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
  await h.emit("agent_settled"); assert.match(h.text(), /Completed/);
  await h.emit("agent_start"); h.input("\x18"); await h.emit("agent_settled");
  assert.match(h.text(), /Cancelled/);
});
await test("shutdown cleans timer/widget and restores built-in loader", async t => {
  const h = harness(t); await h.emit("session_start"); await h.emit("agent_start");
  await h.emit("session_shutdown"); assert.equal(h.intervals.size, 0); assert.equal(h.widget, undefined);
  assert.equal(h.input, undefined);
  assert.deepEqual(h.workingVisibility, [false, true]);
  await h.emit("session_shutdown"); assert.equal(h.intervals.size, 0);
});
await test("restore current branch only and use saved previous duration", async t => {
  const branch = [
    { type: "custom", customType: ENTRY_TYPE, data: { outcome: "failed", elapsedMs: 84000 } },
    { type: "custom", customType: ENTRY_TYPE, data: { outcome: "completed", elapsedMs: 52000 } },
    { type: "custom", customType: ENTRY_TYPE, data: { outcome: "bad", elapsedMs: -1 } },
  ];
  const h = harness(t, { branch }); await h.emit("session_start");
  assert.match(h.text(), /Completed.*00:52.*上轮 01:24/);
  await h.emit("agent_start"); assert.match(h.text(), /Working.*上轮 00:52/);
  branch.length = 0; await h.emit("session_tree"); assert.equal(h.text(), ""); assert.equal(h.intervals.size, 0);
});
await test("RPC/print modes have no widget, interval or persisted UI data", async t => {
  const h = harness(t, { mode: "rpc" });
  for (const name of ["session_start", "agent_start", "agent_settled", "session_shutdown"]) await h.emit(name);
  assert.equal(h.widget, undefined); assert.equal(h.intervals.size, 0); assert.equal(h.saved.length, 0);
  h.ctx.mode = "print"; h.ctx.hasUI = false;
  await h.emit("session_start"); await h.emit("agent_start"); assert.equal(h.intervals.size, 0);
});
await test("each final outcome rings exactly once; duplicate settlement is silent", async t => {
  const h = harness(t); await h.emit("session_start");
  for (const outcome of ["completed", "aborted", "error"]) {
    await h.emit("agent_start"); await h.emit("agent_before_settle", { outcome });
    const previous = h.soundPlays; await h.emit("agent_settled"); assert.equal(h.soundPlays, previous + 1);
    await h.emit("agent_settled"); assert.equal(h.soundPlays, previous + 1);
  }
  assert.deepEqual(h.saved.map(entry => entry.data.outcome), ["completed", "cancelled", "failed"]);
});
await test("retry, recoverable tool error and history restore do not ring", async t => {
  const h = harness(t, { branch: [{ type: "custom", customType: ENTRY_TYPE, data: { outcome: "completed", elapsedMs: 10 } }] });
  await h.emit("session_start"); assert.equal(h.soundPlays, 0);
  await h.emit("agent_start"); await h.emit("tool_execution_end", { toolCallId: "a", isError: true });
  await h.emit("message_end", { message: { role: "assistant", stopReason: "error" } });
  await h.emit("agent_end"); await h.emit("agent_start"); assert.equal(h.soundPlays, 0);
  await h.emit("agent_before_settle", { outcome: "completed" }); await h.emit("agent_settled");
  assert.equal(h.soundPlays, 1); await h.emit("session_tree"); assert.equal(h.soundPlays, 1);
});
await test("manual sound-test does not create a round; shutdown and disposal stop playback", async t => {
  const h = harness(t); await h.emit("session_start"); await h.command("sound-test");
  assert.equal(h.soundPlays, 1); assert.equal(h.saved.length, 0); assert.equal(h.intervals.size, 0);
  h.widget.dispose(); assert.equal(h.soundDisposals, 1);
  await h.command("sound-test"); await h.emit("session_shutdown"); assert.equal(h.soundDisposals, 2);
});
await test("sound failures warn once and do not change completed outcomes", async t => {
  const h = harness(t, { audioFails: true }); await h.emit("session_start");
  for (let i = 0; i < 2; i++) { await h.emit("agent_start"); await h.emit("agent_settled"); }
  assert.equal(h.notices.length, 1); assert.equal(h.notices[0].level, "warning");
  assert.deepEqual(h.saved.map(entry => entry.data.outcome), ["completed", "completed"]);
});
await test("RPC/print runs and manual sound command never create a player", async t => {
  for (const mode of ["rpc", "print"]) {
    const h = harness(t, { mode }); await h.emit("agent_start"); await h.emit("agent_settled");
    await h.command("sound-test"); await h.emit("session_shutdown"); assert.equal(h.soundPlays, 0);
    assert.equal(h.soundDisposals, 0);
  }
});

function audioHarness(t, spawnFailure = false) {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  const deadlines = new Map(), launches = [], children = [];
  globalThis.setTimeout = (callback, ms) => { const id = { unref() {} }; deadlines.set(id, { callback, ms }); return id; };
  globalThis.clearTimeout = id => deadlines.delete(id);
  t.after(() => { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; });
  const spawnProcess = (...args) => {
    launches.push(args); if (spawnFailure) throw new Error("spawn unavailable");
    const child = new EventEmitter(); child.kills = 0; child.unrefs = 0;
    child.kill = () => { child.kills++; return true; }; child.unref = () => { child.unrefs++; };
    children.push(child); return child;
  };
  return { deadlines, launches, children, player: createSoundPlayer({ platform: "win32", spawnProcess }) };
}
await test("audio launches hidden non-shell process with asset WAV and safely encoded paths", t => {
  const h = audioHarness(t); h.player.play();
  const [executable, args, options] = h.launches[0]; assert.equal(executable, "powershell.exe");
  assert.deepEqual(options, { windowsHide: true, stdio: "ignore", shell: false });
  assert.equal(Buffer.from(args.at(-1), "base64").toString("utf16le"), playbackScript(SOUND_PATH));
  assert.equal(SOUND_PATH, join(root, "assets", "completion.wav"));
  assert.match(playbackScript(SOUND_PATH), /completion\.wav/);
  assert.match(playbackScript("C:\\测试音效\\经验球音效.wav"), /经验球音效\.wav/);
  assert.ok(playbackScript("C:\\someone's\\audio.mp3").includes("$path = 'C:\\someone''s\\audio.mp3'"));
  assert.equal(h.children[0].unrefs, 1); assert.equal([...h.deadlines.values()][0].ms, MAX_PLAYBACK_MS);
  h.children[0].emit("close", 0); assert.equal(h.deadlines.size, 0);
});
await test("audio defaults to 70 percent per-player volume before playback, not system volume", () => {
  assert.equal(SOUND_VOLUME_PERCENT, 70);
  const script = playbackScript(SOUND_PATH);
  assert.match(script, /setaudio .*volume to 700/);
  assert.ok(script.indexOf("setaudio ") < script.indexOf("'play "));
  assert.doesNotMatch(script, /waveOutSetVolume|SetMasterVolume|nircmd|sndvol/i);
  assert.match(playbackScript(SOUND_PATH, 0), /volume to 0'/);
  assert.match(playbackScript(SOUND_PATH, 100), /volume to 1000'/);
  assert.match(playbackScript(SOUND_PATH, 70.5), /volume to 705'/);
  for (const volume of [-1, 101, NaN, Infinity, "70"]) {
    assert.throws(() => playbackScript(SOUND_PATH, volume), /between 0 and 100/);
  }
});
await test("successful audio and new sound cancellation do not emit failures", t => {
  const h = audioHarness(t); let failures = 0;
  h.player.play(() => failures++); h.player.play(() => failures++);
  assert.equal(h.children[0].kills, 1); h.children[0].emit("close", null); assert.equal(failures, 0);
  h.children[1].emit("close", 0); assert.equal(h.deadlines.size, 0);
  h.player.dispose(); h.player.play(); assert.equal(h.launches.length, 2);
});
await test("spawn/codec/file errors report once, not again on close", t => {
  const h = audioHarness(t); let failures = 0;
  h.player.play(() => failures++); h.children[0].emit("error", new Error("ENOENT")); h.children[0].emit("close", -1);
  assert.equal(failures, 1); assert.equal(h.deadlines.size, 0);
  h.player.play(() => failures++); h.children[1].emit("close", 2); assert.equal(failures, 2);
});
await test("audio timeout and dispose kill children and clear all deadline timers", t => {
  const h = audioHarness(t); let failures = 0;
  h.player.play(() => failures++); [...h.deadlines.values()][0].callback();
  assert.equal(h.children[0].kills, 1); assert.equal(failures, 1); assert.equal(h.deadlines.size, 0);
  h.player.play(() => failures++); h.player.dispose(); h.children[1].emit("close", null);
  assert.equal(h.children[1].kills, 1); assert.equal(failures, 1); assert.equal(h.deadlines.size, 0);
});
await test("synchronous spawn and failing notification handlers cannot throw into the round", t => {
  const h = audioHarness(t, true); let failures = 0;
  assert.doesNotThrow(() => h.player.play(() => { failures++; throw new Error("UI unavailable"); }));
  assert.equal(failures, 1); assert.equal(h.deadlines.size, 0);
});
await test("non-Windows playback is a no-op", () => {
  const player = createSoundPlayer({ platform: "linux", spawnProcess() { throw new Error("must not spawn"); } });
  assert.doesNotThrow(() => player.play()); player.dispose();
});

await test("timer has no speed suffix in any outcome and preserves previous duration", () => {
  let now = 0; const timer = new RoundTimer(() => now);
  timer.restore([{ outcome: "completed", elapsedMs: 105000 }]);
  for (const outcome of ["stop", "error", "aborted"]) {
    timer.start(); timer.generating(); now += 6000; timer.observeStop(outcome);
    assert.doesNotMatch(plain(timer.render(120, themes.dark)[0]), /toks\/s/);
    const result = timer.finish(); assert.deepEqual(Object.keys(result).sort(), ["elapsedMs", "outcome"]);
    for (const theme of Object.values(themes)) for (let width = 0; width <= 180; width++) {
      for (const line of timer.render(width, theme)) {
        assert.ok(visibleWidth(line) <= width); assert.doesNotMatch(plain(line), /toks\/s/);
      }
    }
  }
});
await test("legacy TPS entries restore timing only without editing stored history", () => {
  const legacy = { outcome: "completed", elapsedMs: 6000, outputTokens: 294, generationMs: 6000 };
  assert.equal(isRoundResult(legacy), true);
  const timer = new RoundTimer(() => 0); timer.restore([{ outcome: "completed", elapsedMs: 105000 }, legacy]);
  assert.deepEqual(timer.last, { outcome: "completed", elapsedMs: 6000 });
  assert.match(plain(timer.render(120, themes.dark)[0]), /✓ Completed  00:06  ·  上轮 01:45$/);
  assert.deepEqual(legacy, { outcome: "completed", elapsedMs: 6000, outputTokens: 294, generationMs: 6000 });
  assert.equal(timer.responseStart, undefined); assert.equal(timer.responseEnd, undefined);
});
await test("assistant stream events keep phases and sound but never collect duplicate Alps speed", async t => {
  const h = harness(t); await h.emit("session_start"); await h.emit("agent_start");
  await h.emit("message_start", { message: { role: "assistant" } }); h.advance(6000);
  for (const type of ["text_delta", "thinking_delta", "toolcall_delta"]) {
    await h.emit("message_update", { assistantMessageEvent: { type, delta: "a".repeat(40) } });
    assert.match(h.text(), /生成回复/); assert.doesNotMatch(h.text(), /toks\/s/);
  }
  await h.emit("message_end", { message: { role: "assistant", stopReason: "stop", usage: { output: 294 } } });
  await h.emit("agent_settled"); assert.match(h.text(), /Completed.*00:06/); assert.doesNotMatch(h.text(), /toks\/s/);
  assert.deepEqual(h.saved[0].data, { outcome: "completed", elapsedMs: 6000 }); assert.equal(h.soundPlays, 1);
});

await test("quota segment shares the timer row instead of adding a second row", async t => {
  const host = quotaHost(t, "◕ 5h 78% ↻ 18:30");
  const h = harness(t); await h.emit("session_start");
  assert.equal(host.calls.claim, 1); assert.equal(host.listenerCount, 1);
  await h.emit("agent_start");
  const lines = h.widget.render(120).map(plain);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Working.*等待响应/);
  assert.match(lines[0], /◕ 5h 78% ↻ 18:30$/);
  for (const width of [60, 80, 120, 180]) {
    const out = h.widget.render(width);
    assert.equal(out.length, 1);
    assert.ok(visibleWidth(out[0]) <= width);
    assert.match(plain(out[0]), /5h 78% ↻ 18:30$/);
  }
});
await test("narrow rows dock the quota beneath and never exceed the width", async t => {
  quotaHost(t, "◕ 5h 78% ↻ 18:30");
  const h = harness(t); await h.emit("session_start"); await h.emit("agent_start");
  const narrow = h.widget.render(34).map(plain);
  assert.equal(narrow.length, 2);
  assert.match(narrow[0], /Working/); assert.match(narrow[1], /5h 78%/);
  for (const width of [1, 5, 20, 33, 34, 40, 76, 120, 180]) {
    for (const line of h.widget.render(width)) assert.ok(visibleWidth(line) <= width);
    if (width >= 60) assert.match(plain(h.widget.render(width).join("\n")), /5h 78%/);
  }
});
await test("quota shows alone before the first round and releases the shared row on shutdown", async t => {
  const host = quotaHost(t, "◕ 5h 78%");
  const h = harness(t); await h.emit("session_start");
  assert.deepEqual(h.widget.render(120).map(plain), ["◕ 5h 78%"]);
  host.notify(); // Redraw requests without an active round must not throw.
  await h.emit("session_shutdown");
  assert.equal(host.calls.release, 1); assert.equal(host.claims, 0); assert.equal(host.listenerCount, 0);
});
await test("a missing or incomplete quota host leaves the timer row untouched", async t => {
  for (const value of [undefined, {}, { render: () => "◕ 5h 78%" }, { render: () => "◕ 5h 78%", subscribe: () => () => {} }]) {
    if (value === undefined) delete globalThis[QUOTA_ROW_KEY]; else globalThis[QUOTA_ROW_KEY] = value;
    const h = harness(t); await h.emit("session_start"); await h.emit("agent_start");
    assert.equal(h.widget.render(120).length, 1);
    assert.doesNotMatch(h.text(120), /5h 78%/);
    await h.emit("session_shutdown");
  }
  delete globalThis[QUOTA_ROW_KEY];
});

await test("Pi's actual extension loader accepts the extension", async () => {
  const loader = await jiti.import(join(modules, "@earendil-works/pi-coding-agent/dist/core/extensions/loader.js"));
  const loaded = await loader.loadExtensions([join(root, "index.ts")], process.cwd());
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
});
console.log("Working timer tests complete.");
