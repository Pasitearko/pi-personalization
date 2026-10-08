// Real upstream subscription plugin + local display adapter + working timer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const modules = resolve(process.argv[2] || process.env.PI_TEST_MODULES || new URL("../node_modules",import.meta.url).pathname.replace(/^\/(\w:)/,"$1"));
const require = createRequire(join(modules, "test.cjs"));
const { createJiti } = require("jiti");
const aliases = Object.fromEntries(["pi-coding-agent", "pi-tui", "pi-ai"].map(name =>
  [`@earendil-works/${name}`, join(modules, "@earendil-works", name, "dist/index.js")]));
const jiti = createJiti(import.meta.url, { alias: aliases });
const root = join(dirname(dirname(fileURLToPath(import.meta.url))), "extensions");
const pkg = join(root, "../node_modules/@specode/pi-subscription-usage");
const sdk = await jiti.import(aliases["@earendil-works/pi-coding-agent"]);
const { visibleWidth } = await jiti.import(aliases["@earendil-works/pi-tui"]);
const { loadThemeFromPath } = await jiti.import(join(modules, "@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"));
const theme = loadThemeFromPath(join(modules, "@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json"), "truecolor");
const strip = text => text.replace(/\x1b\[[0-9;]*m/g, "");
const timerExtension = (await jiti.import(join(root, "working-timer/index.ts"))).default;
const rowModule = await jiti.import(join(root, "subscription-usage-row/index.ts"));
const upstreamExtension = (await jiti.import(join(pkg, "src/usage.ts"))).default;
const statusModule = await jiti.import(join(pkg, "src/status.ts"));

async function boot({ provider = "openai-codex", mode = "tui", rowFirst = true, failure = false, delayRow = false, manualQuery = true } = {}) {
  const widgets = new Map(), statuses = new Map(), notifications = [];
  const bus = new EventEmitter();
  const events = { emit: (name, data) => bus.emit(name, data), on(name, cb) { bus.on(name, cb); return () => bus.off(name, cb); } };
  const originalFetch = globalThis.fetch;
  let fetches = 0, soundPlays = 0;
  globalThis.fetch = async (url) => {
    fetches++;
    if (failure || String(url).includes("reset-credits")) return new Response("", { status: 503 });
    return new Response(JSON.stringify({ rate_limit: {
      primary_window: { used_percent: 17, limit_window_seconds: 18000, reset_at: (Date.now() + 150000) / 1000 },
      secondary_window: { used_percent: 3, limit_window_seconds: 604800, reset_at: (Date.now() + (6 * 24 + 19) * 3600000 + 30000) / 1000 },
    } }));
  };
  const ui = {
    notify(message) { notifications.push(message); },
    setStatus(key, value) { value === undefined ? statuses.delete(key) : statuses.set(key, value); },
    setWidget(key, factory) {
      widgets.get(key)?.dispose?.(); widgets.delete(key);
      if (factory) widgets.set(key, factory({ requestRender() {} }, theme));
    },
    setWorkingVisible() {}, onTerminalInput() { return () => {}; },
    select() { throw new Error("Tests must not redeem credits"); },
  };
  const model = { provider, id: "gpt-test", name: "gpt-test", contextWindow: 200000, baseUrl: "https://chatgpt.com/backend-api" };
  const ctx = {
    cwd: process.cwd(), mode, hasUI: true, signal: new AbortController().signal, model,
    isProjectTrusted: () => false,
    sessionManager: sdk.SessionManager.inMemory(process.cwd()),
    modelRegistry: { getAvailable: () => [model], getAll: () => [model],
      isUsingOAuth: () => true, getProviderAuth: async () => ({ auth: { apiKey: "opaque-test-token" } }) }, ui,
  };
  function load(extension, options) {
    const handlers = new Map(), commands = new Map();
    extension({ events, on: (name, handler) => handlers.set(name, handler),
      registerCommand: (name, command) => commands.set(name, command), appendEntry() {} }, options);
    return { handlers, commands };
  }
  const timer = load(timerExtension, { createPlayer: () => ({ play() { soundPlays++; }, dispose() {} }) });
  const row = load(rowModule.default);
  const upstream = load(upstreamExtension);
  const order = rowFirst ? [row, timer, upstream] : [upstream, timer, row];
  for (const ext of order) {
    if (delayRow && ext === row) {
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
    }
    await ext.handlers.get("session_start")?.({}, ctx);
  }
  if (manualQuery) await upstream.commands.get("usage").handler("", ctx);
  return {
    ctx, row, timer, upstream, widgets, statuses, events, bus,
    render: (width = 180) => (widgets.get("working-timer")?.render(width) ?? []).map(strip),
    get fetches() { return fetches; }, get soundPlays() { return soundPlays; },
    async stop() {
      for (const ext of [upstream, timer, row]) await ext.handlers.get("session_shutdown")?.({}, ctx);
      globalThis.fetch = originalFetch;
    },
  };
}

for (const rowFirst of [true, false]) await test(`real plugin emits spaced quota after timer, no duplicate footer (rowFirst=${rowFirst})`, async () => {
  const s = await boot({ rowFirst });
  try {
    await s.timer.handlers.get("agent_start")({}, s.ctx);
    const lines = s.render();
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Working.*等待响应  │  5h  83%  ↻ 2m  │  1w  97%  ↻ 6d 19h$/);
    assert.deepEqual([...s.widgets.keys()], ["working-timer"]);
    assert.equal(s.statuses.has("subscription-usage"), false);
    assert.ok(s.fetches > 0);
    await s.timer.handlers.get("agent_settled")({}, s.ctx);
    assert.equal(s.soundPlays, 1);
  } finally { await s.stop(); }
});

await test("fast startup response is retained even when adapter session_start is delayed", async () => {
  const s = await boot({ rowFirst: false, delayRow: true, manualQuery: false });
  try {
    assert.match(s.render()[0], /5h  83%/);
    assert.equal(s.statuses.has("subscription-usage"), false);
  } finally { await s.stop(); }
});

await test("quota remains before the first round and docks below on narrow screens", async () => {
  const s = await boot();
  try {
    assert.match(s.render()[0], /^5h  83%/);
    await s.timer.handlers.get("agent_start")({}, s.ctx);
    assert.equal(s.render(60).length, 2);
    for (let width = 0; width <= 180; width++) {
      for (const line of s.widgets.get("working-timer").render(width)) assert.ok(visibleWidth(line) <= width);
    }
  } finally { await s.stop(); }
});

await test("adapter returns to standalone row when timer is removed", async () => {
  const s = await boot();
  try {
    await s.timer.handlers.get("session_shutdown")({}, s.ctx);
    assert.deepEqual([...s.widgets.keys()], ["subscription-usage-row"]);
    assert.match(strip(s.widgets.get("subscription-usage-row").render(120)[0]), /5h  83%/);
  } finally { await s.stop(); }
});

await test("unsupported provider shows timer only; failures clear percentages", async () => {
  const s = await boot({ provider: "deepseek" });
  try {
    await s.timer.handlers.get("agent_start")({}, s.ctx);
    assert.doesNotMatch(s.render().join(" "), /5h|97%/);
    assert.equal(s.fetches, 0);
  } finally { await s.stop(); }
  const failed = await boot({ failure: true });
  try {
    assert.match(failed.render()[0], /额度查询失败/);
    assert.doesNotMatch(failed.render()[0], /83%|97%/);
    assert.equal(failed.statuses.has("subscription-usage"), false);
  } finally { await failed.stop(); }
});

await test("model change clears old data; invalid events ignored; cleanup is complete", async () => {
  const s = await boot();
  try {
    s.row.handlers.get("model_select")({}, s.ctx);
    assert.deepEqual(s.render(), []);
    s.events.emit(rowModule.STATUS_EVENT, { v: 2, status: "ready", windows: [] });
    assert.deepEqual(s.render(), []);
    s.events.emit(rowModule.STATUS_EVENT, { v: 1, status: "ready", windows: [{ label: "5h", displayPercent: 200 }] });
    assert.deepEqual(s.render(), []);
  } finally { await s.stop(); }
  assert.equal(s.bus.listenerCount(rowModule.STATUS_EVENT), 0);
  assert.equal(globalThis[rowModule.ROW_KEY], undefined);
  assert.equal(s.widgets.size, 0);
});

await test("display uses selected percent, preserves structured countdown, omits absent reset", () => {
  const report = { providerId: "test", providerName: "test", capturedAt: Date.now(), buckets: [
    { id: "week", label: "Weekly", unit: "percent", used: 3, remaining: 97, windowMinutes: 10080, resetsAt: (Date.now() + 7200500) / 1000 },
  ], metrics: [] };
  const event = statusModule.buildUsageStatusEvent(report, undefined, "used");
  assert.equal(event.windows[0].displayPercent, 3);
  assert.match(strip(rowModule.renderUsage(event, theme)), /1w  3%  ↻ 2h/);
  assert.equal(rowModule.spacedCountdown("2h13m"), "2h 13m");
  assert.equal(rowModule.spacedCountdown("<1m"), "<1m");
  assert.equal(strip(rowModule.renderUsage({ v: 1, status: "ready", windows: [{ label: "quota", displayPercent: 50 }] }, theme)), "quota  50%");
});

await test("RPC keeps upstream fallback and does not install terminal widgets", async () => {
  const s = await boot({ mode: "rpc" });
  try {
    assert.equal(s.widgets.size, 0);
    assert.match(s.statuses.get("subscription-usage"), /5h 83%/);
  } finally { await s.stop(); }
});

await test("Pi loader accepts display adapter", async () => {
  const loader = await jiti.import(join(modules, "@earendil-works/pi-coding-agent/dist/core/extensions/loader.js"));
  const loaded = await loader.loadExtensions([join(root, "subscription-usage-row/index.ts")], process.cwd());
  assert.deepEqual(loaded.errors, []);
});
