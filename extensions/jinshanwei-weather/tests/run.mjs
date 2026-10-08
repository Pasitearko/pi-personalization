import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const modules = resolve(process.argv[2] || process.env.PI_TEST_MODULES || new URL("../../../node_modules", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
const require = createRequire(join(modules, "test.cjs"));
const { createJiti } = require("jiti");
const aliases = Object.fromEntries(["pi-coding-agent", "pi-tui"].map(name =>
  [`@earendil-works/${name}`, join(modules, "@earendil-works", name, "dist/index.js")]));
const jiti = createJiti(import.meta.url, { alias: aliases });
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const w = await jiti.import(join(root, "weather.ts"));
const s = await jiti.import(join(root, "storage.ts"));
const { default: extension } = await jiti.import(join(root, "index.ts"));
const { visibleWidth } = await jiti.import(aliases["@earendil-works/pi-tui"]);
const { dispatchMouseEvent } = await jiti.import(join(modules, "@earendil-works/pi-tui/dist/tui.js"));
const { loadThemeFromPath } = await jiti.import(join(modules, "@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"));
const themes = Object.fromEntries(["dark", "light"].map(name => [name, loadThemeFromPath(
  join(modules, `@earendil-works/pi-coding-agent/dist/modes/interactive/theme/${name}.json`), "truecolor")]));
const plain = text => text.replace(/\x1b\[[0-9;]*m/g, "");
const NOW = Date.parse("2026-10-02T05:05:00Z");
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function sample(timestamp = NOW, city = w.CITIES[0]) {
  const time = new Date(Math.floor(timestamp / 900_000) * 900_000 + 28_800_000).toISOString().slice(0, 16);
  return {
    latitude: city.latitude + 0.03, longitude: city.longitude + 0.03, timezone: "Asia/Shanghai", utc_offset_seconds: 28800,
    current_units: { time: "iso8601", temperature_2m: "°C", apparent_temperature: "°C", relative_humidity_2m: "%", wind_speed_10m: "km/h", wind_direction_10m: "°" },
    current: { time, temperature_2m: [24.5, 12.5, 27.5][w.CITIES.indexOf(city)], apparent_temperature: 23.7, relative_humidity_2m: 54, wind_speed_10m: 16.1, wind_direction_10m: 50, weather_code: 3, is_day: city.id === "strasbourg" ? 0 : 1 },
  };
}
const response = (data = sample()) => ({ ok: true, json: async () => data });
const cacheFixture = (selected = "tokyo", timestamp = NOW) => ({ version: 1, selected,
  snapshots: Object.fromEntries(w.CITIES.map(city => [city.id, w.parseWeather(sample(timestamp, city), city)])) });
function harness(t, { mode = "tui", hasUI = true, cache: initialCache, storage: suppliedStorage } = {}) {
  const original = {
    fetch: globalThis.fetch, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, now: Date.now,
  };
  let now = NOW, renderCount = 0, placement, cache = clone(initialCache), loads = 0;
  const widgets = new Map(), intervals = new Map(), timeouts = new Map(), calls = [], queue = [], handlers = new Map(), commands = new Map(), notices = [], saves = [];
  const handle = () => ({ unref() {} });
  globalThis.setInterval = (fn, ms) => { const id = handle(); intervals.set(id, { fn, ms }); return id; };
  globalThis.clearInterval = id => intervals.delete(id);
  globalThis.setTimeout = (fn, ms) => {
    const id = handle();
    timeouts.set(id, { fn: () => { timeouts.delete(id); fn(); }, ms, at: now + ms });
    return id;
  };
  globalThis.clearTimeout = id => timeouts.delete(id);
  Date.now = () => now;
  globalThis.fetch = async (url, options) => {
    const city = w.CITIES.find(city => w.weatherUrl(city) === url);
    assert.ok(city, `unexpected URL: ${url}`); assert.equal(options.redirect, "error");
    assert.equal(options.headers, undefined); assert.equal(options.cache, "no-store"); assert.ok(options.signal instanceof AbortSignal);
    calls.push({ url, options, city });
    const item = queue.length ? queue.shift() : response(sample(now, city));
    if (typeof item === "function") return item(options, city);
    if (item instanceof Error) throw item;
    return await item;
  };
  const storage = suppliedStorage ?? {
    async load() { loads++; return clone(cache); },
    async save(value) { cache = clone(value); saves.push(clone(value)); },
    async flush() {},
  };
  const ctx = { mode, hasUI, ui: {
    setWidget(key, factory, options) {
      widgets.get(key)?.dispose?.(); widgets.delete(key);
      if (factory !== undefined) widgets.set(key, typeof factory === "function"
        ? factory({ requestRender() { renderCount++; } }, themes.dark) : { render: () => factory });
      if (key === "jinshanwei-weather") placement = options?.placement;
    },
    notify(message, level) { notices.push({ message, level }); },
    setFooter() { assert.fail("must not replace footer"); },
    setEditorComponent() { assert.fail("must not replace editor"); },
  } };
  extension({ on(name, fn) { handlers.set(name, fn); }, registerCommand(name, command) { commands.set(name, command); } }, storage);
  t.after(async () => {
    await handlers.get("session_shutdown")?.({}, ctx);
    globalThis.fetch = original.fetch;
    globalThis.setInterval = original.setInterval; globalThis.clearInterval = original.clearInterval;
    globalThis.setTimeout = original.setTimeout; globalThis.clearTimeout = original.clearTimeout; Date.now = original.now;
  });
  return {
    ctx, intervals, timeouts, calls, queue, notices, commands, saves,
    get cache() { return cache; }, get loads() { return loads; },
    get widget() { return widgets.get("jinshanwei-weather"); },
    get widgetOrder() { return [...widgets.keys()]; },
    get placement() { return placement; }, get renderCount() { return renderCount; },
    advance(ms) { now += ms; }, emit(name) { return handlers.get(name)?.({}, ctx); },
    get nextTimerMs() { return Math.min(...[...timeouts.values()].map(timer => timer.at - now)); },
    async runDue() {
      for (let i = 0; i < 100; i++) {
        const timer = [...timeouts.values()].filter(timer => timer.at <= now).sort((a, b) => a.at - b.at)[0];
        if (!timer) return;
        timer.fn(); await flush();
      }
      assert.fail("timer busy loop");
    },
    // Pi constructs a new context wrapper for every slash-command invocation.
    command(args = "") { return commands.get("weather").handler(args, { ...ctx }); },
    text(width = 160) { return (widgets.get("jinshanwei-weather")?.render(width) ?? []).map(plain).join("\n"); },
    mouse(overrides = {}) {
      return dispatchMouseEvent(widgets.get("jinshanwei-weather"), {
        type: "click", button: "left", x: 4, y: 0, screenX: 4, screenY: 0, width: 160, height: 1,
        shift: false, ctrl: false, alt: false, clickCount: 1, ...overrides,
      });
    },
  };
}

await test("three verified fixed cities, common Shanghai timezone, explicit units and quarter-hour scheduling with capped backoff", () => {
  assert.deepEqual(w.CITIES.map(city => city.id), ["shanghai", "strasbourg", "tokyo"]);
  for (const city of w.CITIES) {
    const url = new URL(w.weatherUrl(city));
    assert.equal(url.origin, "https://api.open-meteo.com");
    assert.equal(url.searchParams.get("latitude"), `${city.latitude}`); assert.equal(url.searchParams.get("longitude"), `${city.longitude}`);
    assert.equal(url.searchParams.get("timezone"), "Asia/Shanghai"); assert.equal(url.searchParams.get("wind_speed_unit"), "kmh");
  }
  assert.equal(w.WEATHER_URL, w.weatherUrl(w.CITIES[0]));
  assert.equal(w.DATA_INTERVAL_MS, 900_000); assert.equal(w.RETRY_MS, 60_000); assert.equal(w.MAX_RETRY_MS, 480_000);
  assert.equal(w.REQUEST_TIMEOUT_MS, 12_000); assert.equal(w.MIN_REFRESH_MS, 15_000);
});
await test("each city's grid validates independently and zero is not missing", () => {
  for (const city of w.CITIES) {
    const item = sample(NOW, city); item.current.temperature_2m = 0; item.current.relative_humidity_2m = 0; item.current.wind_speed_10m = 0;
    const result = w.parseWeather(item, city);
    assert.equal(result.temperature, 0); assert.equal(result.humidity, 0); assert.equal(result.windSpeed, 0);
    assert.equal(result.dataTime, Date.parse("2026-10-02T05:00:00Z"));
  }
  assert.equal(w.parseWeather(sample(NOW, w.CITIES[1]), w.CITIES[2]), undefined);
});
await test("invalid required values, timezone, units or coordinates rejected", () => {
  for (const value of [null, [], {}, { current: {} }]) assert.equal(w.parseWeather(value), undefined);
  for (const value of [null, undefined, NaN, Infinity, "24.5", -100, 90]) {
    const item = sample(); item.current.temperature_2m = value; assert.equal(w.parseWeather(item), undefined);
  }
  for (const change of [s => s.timezone = "GMT", s => s.utc_offset_seconds = 0,
    s => s.latitude = 50, s => s.longitude = -120, s => s.current_units.temperature_2m = "°F", s => s.current.time = "bad"]) {
    const item = sample(); change(item); assert.equal(w.parseWeather(item), undefined);
  }
});
await test("missing optional values omitted, never forged as zero", () => {
  const item = sample(); item.current.apparent_temperature = null; item.current.relative_humidity_2m = 101;
  item.current.wind_speed_10m = -1; item.current.wind_direction_10m = NaN; item.current.weather_code = 1.5; item.current.is_day = null;
  const parsed = w.parseWeather(item);
  for (const name of ["feelsLike", "humidity", "windSpeed", "windDirection", "code", "isDay"]) assert.equal(parsed[name], undefined);
});
await test("Shanghai ISO timestamps reject impossible dates; all three display the same Shanghai clock", () => {
  assert.equal(w.parseDataTime("2026-10-02T13:00"), Date.parse("2026-10-02T05:00:00Z"));
  assert.equal(w.parseDataTime("2026-10-02T13:00:15"), Date.parse("2026-10-02T05:00:15Z"));
  for (const value of [null, "2026-02-30T13:00", "2026-10-02T25:00", "2026-10-02T13:99", "2026-10-02T13:00Z", "<script>"])
    assert.equal(w.parseDataTime(value), undefined);
  for (const city of w.CITIES) assert.match(plain(w.renderWeather(w.parseWeather(sample(NOW, city), city), "ready", 160, themes.dark, NOW, city)[0]), /🕒 13:00/);
});
await test("staleness, future tolerance, cross-day timestamp", () => {
  const item = w.parseWeather(sample()); assert.equal(w.isCurrent(item, NOW), true);
  assert.equal(w.isCurrent(item, item.dataTime + w.MAX_DATA_AGE_MS + 1), false);
  assert.equal(w.isCurrent(item, item.dataTime - 900_001), false);
  assert.equal(w.formatDataTime(Date.parse("2026-10-01T15:55:00Z"), Date.parse("2026-10-01T16:05:00Z")), "10-01 23:55");
});
await test("WMO icons and city-local day/night remain truthful", () => {
  assert.equal(w.condition(0, true).icon, "☀️"); assert.equal(w.condition(0, false).icon, "🌙");
  for (const [code, label] of [[2, "多云"], [3, "阴"], [45, "雾"], [61, "小雨"], [65, "大雨"], [75, "大雪"], [95, "雷雨"], [99, "雷雨伴冰雹"]]) assert.equal(w.condition(code).label, label);
  assert.equal(w.condition(4).label, ""); assert.equal(w.condition(undefined).label, "");
  const item = sample(NOW, w.CITIES[1]); item.current.weather_code = 0;
  assert.match(plain(w.renderWeather(w.parseWeather(item, w.CITIES[1]), "ready", 160, themes.dark, NOW, w.CITIES[1])[0]), /🌙/);
});
await test("wind directions and calm wind", () => {
  for (const [degrees, name] of [[0, "北风"], [45, "东北风"], [90, "东风"], [180, "南风"], [270, "西风"], [360, "北风"]]) assert.equal(w.windDirection(degrees), name);
  const item = w.parseWeather(sample()); item.windSpeed = 0;
  assert.match(plain(w.renderWeather(item, "ready", 160, themes.dark, NOW)[0]), /静风/);
});
await test("all city names, emoji and warning rows fit every narrow width in both themes", () => {
  for (const city of w.CITIES) for (const theme of Object.values(themes)) {
    const item = w.parseWeather(sample(NOW, city), city);
    const full = plain(w.renderWeather(item, "ready", 160, theme, NOW, city)[0]);
    assert.match(full, new RegExp(city.name)); assert.match(full, /体感 23\.7°C/); assert.match(full, /💧 54%/); assert.match(full, /东北风 16\.1 km\/h/); assert.match(full, /🕒 13:00/);
    for (let width = 0; width <= 160; width++) for (const status of ["ready", "unavailable"]) {
      for (const line of w.renderWeather(item, status, width, theme, NOW, city)) assert.ok(visibleWidth(line) <= width);
    }
    const compact = plain(w.renderWeather(item, "ready", 32, theme, NOW, city)[0]);
    assert.match(compact, /°C/); assert.doesNotMatch(compact, /体感|💧|🍃|🕒/);
  }
});
await test("missing data is explicit; old cached values always carry warning; future values hidden", () => {
  for (const status of ["loading", "unavailable", "timeout", "expired"]) assert.doesNotMatch(plain(w.renderWeather(undefined, status, 120, themes.dark, NOW)[0]), /°C|km\/h|%/);
  const item = w.parseWeather(sample());
  const stale = plain(w.renderWeather(item, "ready", 160, themes.dark, NOW + 2 * w.MAX_DATA_AGE_MS)[0]);
  assert.match(stale, /数据过期/); assert.match(stale, /24\.5°C/);
  const failed = plain(w.renderWeather(item, "unavailable", 160, themes.dark, NOW)[0]); assert.match(failed, /更新失败/); assert.match(failed, /24\.5°C/);
  assert.match(plain(w.renderWeather(item, "unavailable", 35, themes.dark, NOW)[0]), /更新失败/);
  const future = plain(w.renderWeather(item, "ready", 160, themes.dark, NOW - 2 * w.MAX_DATA_AGE_MS)[0]); assert.doesNotMatch(future, /24\.5°C/);
});
await test("cache validates city ids/version/numeric fields and drops unknown fields", () => {
  for (const value of [null, [], {}, { version: 1, selected: "other" }, { ...cacheFixture(), version: 2 }]) assert.equal(s.parseCache(value), undefined);
  const cache = cacheFixture(); cache.snapshots.tokyo.temperature = "27.5"; cache.snapshots.shanghai.secret = "discard"; cache.snapshots.other = { temperature: 55 };
  const parsed = s.parseCache(cache);
  assert.equal(parsed.snapshots.tokyo, undefined); assert.equal(parsed.snapshots.shanghai.secret, undefined); assert.equal(parsed.snapshots.other, undefined);
});
await test("atomic storage persists last selection/cache, serializes saves and removes temporary files", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-weather-test-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = s.createWeatherStorage(join(dir, "cache.json")); assert.equal(await store.load(), undefined);
  await Promise.all([store.save(cacheFixture("strasbourg")), store.save(cacheFixture("tokyo"))]); await store.flush();
  assert.equal((await store.load()).selected, "tokyo");
  assert.equal(JSON.parse(await readFile(join(dir, "cache.json"), "utf8")).snapshots.tokyo.temperature, 27.5);
  assert.deepEqual(await readdir(dir), ["cache.json"]);
});
await test("malformed and oversized disk cache ignored", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-weather-test-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "cache.json"), store = s.createWeatherStorage(file);
  await writeFile(file, "not JSON"); assert.equal(await store.load(), undefined);
  await writeFile(file, " ".repeat(65_537)); assert.equal(await store.load(), undefined);
});
await test("startup mounts immediately and prefetches three cities without blocking or replacing editor/footer", async t => {
  const h = harness(t), gate = deferred(); h.queue.push(gate.promise);
  assert.equal(h.emit("session_start"), undefined); assert.equal(h.placement, "aboveEditor"); assert.match(h.text(), /读取中/);
  await flush(); assert.equal(h.calls.length, 3); assert.equal(h.intervals.size, 0);
  gate.resolve(response()); await flush(); assert.match(h.text(), /24\.5°C/);
  assert.equal(h.timeouts.size, 1); assert.equal(h.nextTimerMs, 10 * 60_000);
});
await test("location click cycles cached cities and clock without any extra fetch or focus change", async t => {
  const h = harness(t); h.emit("session_start"); await flush();
  assert.match(h.text(), /上海.*24\.5°C/);
  assert.equal(h.mouse({ type: "press" }).handled, true); assert.equal(h.mouse({ type: "release" }).handled, true);
  const clicked = h.mouse(); assert.equal(clicked.handled, true); assert.notEqual(clicked.focus, true);
  assert.match(h.text(), /斯特拉斯堡.*12\.5°C/); assert.match(h.text(), /🕒 13:00/);
  h.mouse(); assert.match(h.text(), /东京.*27\.5°C/); h.mouse(); assert.match(h.text(), /上海.*24\.5°C/);
  assert.equal(h.calls.length, 3); assert.equal(h.cache.selected, "shanghai");
});
await test("only location hitbox responds; temperature/other rows/buttons/modifiers do not switch", async t => {
  const h = harness(t); h.emit("session_start"); await flush();
  for (const overrides of [{ x: 0 }, { x: w.locationHitWidth(w.CITIES[0], 160) }, { x: 60 }, { y: 1 }, { button: "right" }, { button: "middle" }, { shift: true }, { ctrl: true }, { alt: true }, { type: "wheel" }, { type: "drag" }]) assert.equal(h.mouse(overrides), undefined);
  assert.match(h.text(), /上海/); assert.equal(h.calls.length, 3);
  h.text(8); assert.equal(h.mouse({ x: 8, width: 8 }), undefined);
});
await test("command next and direct city selection only switch cache; invalid action does not query", async t => {
  const h = harness(t); h.emit("session_start"); await flush();
  await h.command("next"); assert.match(h.text(), /斯特拉斯堡/);
  await h.command("tokyo"); assert.match(h.text(), /东京/); await h.command("上海"); assert.match(h.text(), /上海/);
  await h.command("unknown"); assert.match(h.notices.at(-1).message, /用法/); assert.equal(h.calls.length, 3);
});
await test("switching during initial prefetch uses loading state and never queries an extra city", async t => {
  const h = harness(t), gates = w.CITIES.map(() => deferred()); h.queue.push(...gates.map(gate => gate.promise));
  h.emit("session_start"); await flush(); h.mouse(); assert.match(h.text(), /斯特拉斯堡.*读取中/);
  h.mouse(); assert.match(h.text(), /东京.*读取中/); assert.equal(h.calls.length, 3);
  gates.forEach((gate, i) => gate.resolve(response(sample(NOW, w.CITIES[i])))); await flush(); assert.match(h.text(), /东京.*27\.5°C/);
});
await test("remembered city/cache displays before network completes", async t => {
  const h = harness(t, { cache: cacheFixture("tokyo") }), gates = w.CITIES.map(() => deferred()); h.queue.push(...gates.map(gate => gate.promise));
  h.emit("session_start"); await flush(); assert.match(h.text(), /东京.*27\.5°C/); assert.equal(h.calls.length, 3);
  h.mouse(); assert.match(h.text(), /上海.*24\.5°C/); assert.equal(h.cache.selected, "shanghai");
  gates.forEach((gate, i) => gate.resolve(response(sample(NOW, w.CITIES[i])))); await flush();
});
await test("click before cache load is not overwritten and cached snapshots survive deferred selection save", async t => {
  const load = deferred(), saves = [];
  const h = harness(t, { storage: { load: () => load.promise, save: async value => saves.push(clone(value)), flush: async () => {} } });
  h.emit("session_start"); h.mouse(); assert.match(h.text(), /斯特拉斯堡/); assert.equal(h.calls.length, 0); assert.equal(saves.length, 0);
  load.resolve(cacheFixture("tokyo")); await flush(); assert.match(h.text(), /斯特拉斯堡/); assert.equal(saves[0].selected, "strasbourg");
  assert.equal(Object.keys(saves[0].snapshots).length, 3); assert.equal(h.calls.length, 3);
});
await test("fresh command contexts do not reattach, reset selection or fetch on next", async t => {
  const h = harness(t); h.emit("session_start"); await flush();
  await h.command("next"); assert.match(h.text(), /斯特拉斯堡/);
  await h.command("next"); assert.match(h.text(), /东京/);
  await h.command("next"); assert.match(h.text(), /上海/);
  assert.equal(h.calls.length, 3); assert.equal(h.loads, 1); assert.equal(h.intervals.size, 0); assert.equal(h.timeouts.size, 1);
});
await test("early selection persists on shutdown after merging pending disk cache", async t => {
  const load = deferred(), saves = [];
  const h = harness(t, { storage: { load: () => load.promise, save: async value => saves.push(clone(value)), flush: async () => {} } });
  h.emit("session_start"); h.mouse(); const closing = h.emit("session_shutdown");
  assert.equal(h.widget, undefined); load.resolve(cacheFixture("tokyo")); await closing; await flush();
  assert.equal(saves.at(-1).selected, "strasbourg"); assert.equal(Object.keys(saves.at(-1).snapshots).length, 3);
  assert.equal(h.calls.length, 0); assert.equal(h.intervals.size, 0);
});
await test("late hydration cannot erase a real manual refresh failure warning", async t => {
  const load = deferred();
  const h = harness(t, { storage: { load: () => load.promise, save: async () => {}, flush: async () => {} } });
  h.emit("session_start"); h.queue.push(new Error("offline")); await h.command();
  load.resolve(cacheFixture("shanghai")); await flush();
  assert.match(h.text(), /24\.5°C/); assert.match(h.text(), /更新失败/);
  assert.equal(h.calls.length, 3); // failed manual city + two untouched startup cities
});
await test("cache read/write failures do not break UI or successful API data", async t => {
  const h = harness(t, { storage: { load: async () => { throw Error("disk"); }, save: async () => { throw Error("disk"); }, flush: async () => {} } });
  h.emit("session_start"); await flush(); assert.match(h.text(), /24\.5°C/); h.mouse(); assert.match(h.text(), /斯特拉斯堡/); assert.equal(h.calls.length, 3);
});
await test("manual refresh deduplicates in-flight selected-city request and explains data source", async t => {
  const h = harness(t), gate = deferred(); h.queue.push(gate.promise); h.emit("session_start"); await flush();
  const pending = h.command(); assert.equal(h.calls.length, 3); gate.resolve(response()); await pending;
  assert.match(h.notices.at(-1).message, /Open-Meteo.*格点/); assert.match(h.notices.at(-1).message, /13:00.*上海时间/);
});
await test("manual cooldown is per city and successful refresh updates only selected city", async t => {
  const h = harness(t); h.emit("session_start"); await flush(); await h.command(); assert.equal(h.calls.length, 3); assert.match(h.notices.at(-1).message, /15 秒/);
  h.advance(15_000); await h.command("next"); await h.command(); assert.equal(h.calls.length, 4); assert.equal(h.calls.at(-1).city.id, "strasbourg");
  assert.match(h.notices.at(-1).message, /斯特拉斯堡.*已刷新/);
});
await test("one timer sleeps until the next quarter; no minute wake-ups or fetch on model rounds/switching", async t => {
  const h = harness(t); h.emit("session_start"); await flush(); h.emit("agent_start"); h.emit("agent_end"); h.mouse(); assert.equal(h.calls.length, 3);
  assert.equal(h.intervals.size, 0); assert.equal(h.timeouts.size, 1); assert.equal(h.nextTimerMs, 10 * 60_000);
  for (let i = 0; i < 9; i++) {
    h.advance(w.RETRY_MS); await h.runDue(); assert.equal(h.calls.length, 3); assert.equal(h.timeouts.size, 1);
  }
  h.advance(w.RETRY_MS); await h.runDue(); assert.equal(h.calls.length, 6); assert.match(h.text(), /13:15/);
  assert.deepEqual(h.calls.slice(3).map(call => call.city.id), ["shanghai", "strasbourg", "tokyo"]);
  assert.equal(h.nextTimerMs, w.DATA_INTERVAL_MS);
});
await test("20:19 with valid 19:45 data keeps it until 20:30; new API data renders immediately without forging the time", async t => {
  const h = harness(t); h.advance((7 * 60 + 14) * 60_000);
  const staleTime = Date.parse("2026-10-02T11:45:00Z"), latestTime = Date.parse("2026-10-02T12:15:00Z");
  h.queue.push(...w.CITIES.map(city => response(sample(staleTime, city))));
  h.emit("session_start"); await flush(); assert.match(h.text(), /19:45/);
  assert.equal(h.nextTimerMs, 11 * 60_000);
  h.advance(11 * 60_000 - 1); await h.runDue(); assert.equal(h.calls.length, 3); assert.match(h.text(), /19:45/);
  h.queue.push(...w.CITIES.map(city => response(sample(latestTime, city)))); h.advance(1); await h.runDue();
  assert.equal(h.calls.length, 6); assert.match(h.text(), /20:15/); assert.doesNotMatch(h.text(), /19:45/);
  assert.equal(h.nextTimerMs, w.DATA_INTERVAL_MS);
});
await test("valid late upstream batches stay in use without extra requests until the next quarter", async t => {
  const h = harness(t); h.emit("session_start"); await flush(); h.advance(10 * 60_000);
  h.queue.push(response(sample(NOW, w.CITIES[0])), response(sample(NOW, w.CITIES[1])), response(sample(NOW + 10 * 60_000, w.CITIES[2])));
  await h.runDue(); assert.match(h.text(), /13:00/); assert.equal(h.calls.length, 6); assert.equal(h.nextTimerMs, w.DATA_INTERVAL_MS);
  h.advance(w.DATA_INTERVAL_MS - 1); await h.runDue(); assert.equal(h.calls.length, 6); assert.match(h.text(), /13:00/);
  h.advance(1); await h.runDue(); assert.equal(h.calls.length, 9); assert.match(h.text(), /13:30/);
  assert.deepEqual(h.calls.slice(6).map(call => call.city.id), ["shanghai", "strasbourg", "tokyo"]);
});
await test("new data renders without waiting for the other cities or disk writes; a pending city has no automatic retry", async t => {
  const saves = [], disk = deferred();
  const h = harness(t, { storage: { load: async () => undefined,
    save: value => { saves.push(clone(value)); return disk.promise; }, flush: async () => {} } });
  h.emit("session_start"); await flush(); h.advance(10 * 60_000);
  const gates = w.CITIES.map(() => deferred()); h.queue.push(...gates.map(gate => gate.promise));
  await h.runDue(); assert.equal(h.calls.length, 6); assert.equal(h.timeouts.size, 3); // Request deadlines only.
  const renders = h.renderCount;
  gates[0].resolve(response(sample(NOW + 10 * 60_000))); await flush();
  assert.match(h.text(), /13:15/); assert.ok(h.renderCount > renders);
  assert.equal(saves.at(-1).snapshots.shanghai.dataTime, Date.parse("2026-10-02T05:15:00Z"));
  assert.equal(h.timeouts.size, 3); // Two request deadlines plus one next-batch timer.
  gates.slice(1).forEach((gate, i) => gate.resolve(response(sample(NOW + 10 * 60_000, w.CITIES[i + 1]))));
  disk.resolve(); await flush(); assert.equal(h.timeouts.size, 1); assert.equal(h.nextTimerMs, w.DATA_INTERVAL_MS);
});
await test("a regressed API batch cannot replace a newer successful snapshot", async t => {
  const h = harness(t); h.emit("session_start"); await flush(); h.advance(15_000);
  h.queue.push(response(sample(NOW - w.DATA_INTERVAL_MS))); await h.command();
  assert.match(h.text(), /13:00/); assert.doesNotMatch(h.text(), /12:45/); assert.match(h.text(), /更新失败/);
  h.advance(w.RETRY_MS); await h.runDue();
  assert.equal(h.calls.length, 5); assert.doesNotMatch(h.text(), /更新失败/);
});
await test("failures back off 1/2/4/8 minutes capped, survive quarter boundaries and reset on success", async t => {
  const h = harness(t);
  const offline = () => h.queue.push(...w.CITIES.map(() => new Error("offline")));
  offline(); h.emit("session_start"); await flush();
  for (const minutes of [1, 2, 4, 8, 8]) {
    const delay = minutes * 60_000, calls = h.calls.length;
    assert.equal(h.nextTimerMs, delay); assert.equal(h.timeouts.size, 1);
    h.advance(delay - 1); await h.runDue(); assert.equal(h.calls.length, calls);
    offline(); h.advance(1); await h.runDue(); assert.equal(h.calls.length, calls + 3);
  }
  assert.equal(h.nextTimerMs, w.MAX_RETRY_MS);
  h.advance(w.MAX_RETRY_MS); await h.runDue(); assert.equal(h.calls.length, 21);
  assert.equal(h.nextTimerMs, 9 * 60_000); assert.match(h.text(), /13:30/);
  offline(); h.advance(h.nextTimerMs); await h.runDue();
  assert.equal(h.nextTimerMs, w.RETRY_MS); // Successful recovery reset the failure count.
});
await test("manual refresh bypasses a city's backoff, still enforces cooldown and restores boundary scheduling", async t => {
  const h = harness(t); h.queue.push(new Error("offline")); h.emit("session_start"); await flush();
  h.queue.push(new Error("offline")); h.advance(w.RETRY_MS); await h.runDue();
  assert.equal(h.calls.length, 4); assert.equal(h.nextTimerMs, 2 * w.RETRY_MS);
  await h.command(); assert.equal(h.calls.length, 4); assert.match(h.notices.at(-1).message, /15 秒/);
  h.advance(w.MIN_REFRESH_MS); await h.command(); assert.equal(h.calls.length, 5); assert.doesNotMatch(h.text(), /更新失败/);
  assert.equal(h.nextTimerMs, 8 * 60_000 + 45_000);
  h.advance(h.nextTimerMs); h.queue.push(new Error("offline")); await h.runDue();
  assert.equal(h.calls.length, 8); assert.equal(h.nextTimerMs, w.RETRY_MS);
});
await test("a valid but late batch resets error backoff and sleeps until the next quarter", async t => {
  const h = harness(t); h.advance(10 * 60_000);
  h.queue.push(...w.CITIES.map(() => new Error("offline"))); h.emit("session_start"); await flush();
  h.advance(w.RETRY_MS); h.queue.push(...w.CITIES.map(() => new Error("offline"))); await h.runDue();
  assert.equal(h.nextTimerMs, 2 * w.RETRY_MS);
  h.advance(2 * w.RETRY_MS); h.queue.push(...w.CITIES.map(city => response(sample(NOW, city)))); await h.runDue();
  assert.match(h.text(), /13:00/); assert.equal(h.nextTimerMs, 12 * 60_000);
  h.advance(w.RETRY_MS); await h.runDue(); assert.equal(h.calls.length, 9); assert.match(h.text(), /13:00/);
  h.advance(h.nextTimerMs); h.queue.push(...w.CITIES.map(() => new Error("offline"))); await h.runDue();
  assert.equal(h.nextTimerMs, w.RETRY_MS); // Even late-but-valid success resets backoff.
});
await test("an accepted future timestamp does not skip the next real quarter boundary", async t => {
  const h = harness(t); h.advance(8 * 60_000); // 13:13, next boundary at 13:15.
  h.queue.push(...w.CITIES.map(city => response(sample(NOW + 10 * 60_000, city))));
  h.emit("session_start"); await flush(); assert.match(h.text(), /13:15/); assert.equal(h.nextTimerMs, 2 * 60_000);
  h.advance(2 * 60_000); await h.runDue(); assert.equal(h.calls.length, 6); assert.equal(h.nextTimerMs, w.DATA_INTERVAL_MS);
});
await test("manual requests near a quarter retain the 15-second cooldown without a timer busy loop", async t => {
  const h = harness(t); h.emit("session_start"); await flush(); h.advance(10 * 60_000 - 1_000); await h.command();
  assert.equal(h.calls.length, 4); assert.equal(h.nextTimerMs, 1_000);
  h.advance(1_000); await h.runDue(); assert.equal(h.calls.length, 6); assert.equal(h.nextTimerMs, 14_000);
  h.advance(14_000); await h.runDue(); assert.equal(h.calls.length, 7); assert.match(h.text(), /13:15/);
  assert.equal(h.nextTimerMs, w.DATA_INTERVAL_MS - 14_000);
});
await test("resuming after missed quarters fetches once per city instead of catching up obsolete batches", async t => {
  const h = harness(t); h.emit("session_start"); await flush(); h.advance(70 * 60_000); await h.runDue();
  assert.equal(h.calls.length, 6); assert.match(h.text(), /14:15/); assert.equal(h.nextTimerMs, w.DATA_INTERVAL_MS);
});
await test("shutdown clears the scheduled timer and an old callback cannot affect a new generation", async t => {
  const h = harness(t); h.emit("session_start"); await flush();
  const oldTimer = [...h.timeouts.values()][0]; await h.emit("session_shutdown"); assert.equal(h.timeouts.size, 0);
  h.emit("session_start"); await flush(); const count = h.renderCount, calls = h.calls.length;
  oldTimer.fn(); await flush(); assert.equal(h.renderCount, count); assert.equal(h.calls.length, calls);
  assert.equal(h.timeouts.size, 1); assert.equal(h.nextTimerMs, 10 * 60_000);
});
await test("one city's failed refresh retains last values with warning; others remain healthy", async t => {
  const h = harness(t); h.emit("session_start"); await flush(); h.advance(w.DATA_INTERVAL_MS);
  h.queue.push(new Error("secret raw details")); await h.runDue();
  assert.match(h.text(), /24\.5°C.*更新失败|更新失败.*24\.5°C/); assert.doesNotMatch(h.text(), /secret/);
  h.mouse(); assert.match(h.text(), /斯特拉斯堡.*12\.5°C/); assert.doesNotMatch(h.text(), /更新失败/); h.mouse(); assert.doesNotMatch(h.text(), /更新失败/);
  await h.command("shanghai"); h.advance(15_000); await h.command(); assert.doesNotMatch(h.text(), /更新失败/);
});
await test("old cache remains visible with explicit stale marker when refresh fails", async t => {
  const h = harness(t, { cache: cacheFixture("tokyo", NOW - 2 * w.MAX_DATA_AGE_MS) });
  h.queue.push(...w.CITIES.map(() => new Error("offline"))); h.emit("session_start"); await flush();
  assert.match(h.text(), /东京/); assert.match(h.text(), /数据过期·更新失败/); assert.match(h.text(), /27\.5°C/); assert.equal(h.calls.length, 3);
});
await test("HTTP errors cancel body and malformed city responses are isolated", async t => {
  const h = harness(t); let cancelled = false;
  h.queue.push({ ok: false, body: { cancel: async () => { cancelled = true; } } }, response({ current: {} }));
  h.emit("session_start"); await flush(); assert.equal(cancelled, true); assert.match(h.text(), /暂不可用/);
  h.mouse(); assert.match(h.text(), /暂不可用/); h.mouse(); assert.match(h.text(), /东京.*27\.5°C/);
});
await test("12-second abort timeout marks only affected city and clears deadlines", async t => {
  const h = harness(t);
  h.queue.push(({ signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))));
  h.emit("session_start"); await flush(); const timeout = [...h.timeouts.values()].find(timer => timer.ms === 12_000); timeout.fn(); await flush();
  assert.equal(h.calls[0].options.signal.aborted, true); assert.match(h.text(), /读取超时/); assert.equal(h.timeouts.size, 1); assert.equal(h.nextTimerMs, w.RETRY_MS);
  h.mouse(); assert.match(h.text(), /斯特拉斯堡.*12\.5°C/);
});
await test("late timeout response cannot overwrite values even if transport ignores signal", async t => {
  const h = harness(t), gate = deferred(); h.queue.push(gate.promise); h.emit("session_start"); await flush();
  [...h.timeouts.values()].find(timer => timer.ms === 12_000).fn(); gate.resolve(response()); await flush(); assert.match(h.text(), /读取超时/); assert.doesNotMatch(h.text(), /24\.5/);
});
await test("stale/future fetched data is rejected as new snapshot", async t => {
  const h = harness(t); h.queue.push(response(sample(NOW - 2 * w.MAX_DATA_AGE_MS))); h.emit("session_start"); await flush();
  assert.match(h.text(), /数据过期/); assert.doesNotMatch(h.text(), /24\.5/);
  h.advance(15_000); h.queue.push(response(sample(NOW + 2 * w.MAX_DATA_AGE_MS))); await h.command(); assert.match(h.text(), /数据过期/);
});
await test("shutdown aborts all cities and ignores late bootstrap/network responses", async t => {
  const h = harness(t), gates = w.CITIES.map(() => deferred()); h.queue.push(...gates.map(gate => gate.promise)); h.emit("session_start"); await flush();
  await h.emit("session_shutdown"); const count = h.renderCount; assert.ok(h.calls.every(call => call.options.signal.aborted)); assert.equal(h.widget, undefined); assert.equal(h.intervals.size, 0);
  assert.equal(h.timeouts.size, 0); // Cleared even before transports ignoring abort settle.
  gates.forEach((gate, i) => gate.resolve(response(sample(NOW, w.CITIES[i])))); await flush(); assert.equal(h.renderCount, count); assert.equal(h.timeouts.size, 0);
});
await test("shutdown before disk cache load cannot resurrect UI or fetch", async t => {
  const gate = deferred(); const h = harness(t, { storage: { load: () => gate.promise, save: async () => {}, flush: async () => {} } });
  h.emit("session_start"); await h.emit("session_shutdown"); gate.resolve(cacheFixture()); await flush();
  assert.equal(h.widget, undefined); assert.equal(h.calls.length, 0); assert.equal(h.intervals.size, 0);
});
await test("new session cancels old generation without corrupting new snapshots", async t => {
  const h = harness(t), gates = w.CITIES.map(() => deferred()); h.queue.push(...gates.map(gate => gate.promise)); h.emit("session_start"); await flush();
  h.emit("session_start"); await flush(); assert.equal(h.calls.length, 6); assert.equal(h.intervals.size, 0); assert.ok(h.calls.slice(0, 3).every(call => call.options.signal.aborted));
  gates.forEach((gate, i) => { const data = sample(NOW, w.CITIES[i]); data.current.temperature_2m = 59; gate.resolve(response(data)); }); await flush();
  assert.match(h.text(), /24\.5°C/); assert.doesNotMatch(h.text(), /59°C/);
});
await test("widget disposal stops requests/timer and old mouse targets cannot switch the new session", async t => {
  const h = harness(t); h.emit("session_start"); await flush(); const old = h.widget; old.dispose(); assert.equal(h.intervals.size, 0);
  h.emit("session_start"); await flush(); assert.equal(old.handleMouse({ type: "click", button: "left", x: 4, y: 0, width: 160 }), undefined); assert.match(h.text(), /上海/);
});
await test("RPC/print/no-UI performs no network, persistence or timers", async t => {
  const h = harness(t, { mode: "rpc" }); h.emit("session_start"); await h.command(); await h.emit("session_shutdown");
  h.ctx.mode = "print"; h.emit("session_start"); await h.command(); h.ctx.mode = "tui"; h.ctx.hasUI = false; h.emit("session_start"); await flush();
  assert.equal(h.widget, undefined); assert.equal(h.calls.length, 0); assert.equal(h.intervals.size, 0); assert.equal(h.timeouts.size, 0); assert.equal(h.loads, 0); assert.equal(h.saves.length, 0);
});
await test("checklist added after weather preserves plan → weather and cached mouse switching", async t => {
  const h = harness(t); h.emit("session_start"); await flush(); h.ctx.ui.setWidget("plannotator-progress", ["☐ implement"]); await flush();
  assert.deepEqual(h.widgetOrder, ["plannotator-progress", "jinshanwei-weather"]); assert.equal(h.calls.length, 3); assert.equal(h.intervals.size, 0); assert.equal(h.timeouts.size, 1);
  h.mouse(); assert.match(h.text(), /斯特拉斯堡/); assert.equal(h.calls.length, 3);
});
await test("checklist-first startup and repeated checklist edits do not refetch or duplicate timer", async t => {
  const h = harness(t); h.ctx.ui.setWidget("plannotator-progress", ["☐ first"]); h.emit("session_start"); await flush();
  h.ctx.ui.setWidget("plannotator-progress", ["☑ first"]); h.ctx.ui.setWidget("plannotator-progress", ["☑ first", "☐ next"]); await flush();
  assert.deepEqual(h.widgetOrder, ["plannotator-progress", "jinshanwei-weather"]); assert.equal(h.calls.length, 3); assert.equal(h.intervals.size, 0); assert.equal(h.timeouts.size, 1);
});
await test("ordering hook restores setter and queued reordering cannot resurrect shutdown UI", async t => {
  const h = harness(t), original = h.ctx.ui.setWidget; h.emit("session_start"); await flush(); assert.notEqual(h.ctx.ui.setWidget, original);
  h.ctx.ui.setWidget("plannotator-progress", ["☐ work"]); await h.emit("session_shutdown"); await flush();
  assert.equal(h.ctx.ui.setWidget, original); assert.deepEqual(h.widgetOrder, ["plannotator-progress"]); assert.equal(h.intervals.size, 0);
});
await test("unrelated widgets and later hooks are passed through unchanged", async t => {
  const h = harness(t); h.emit("session_start"); await flush(); const wrapped = h.ctx.ui.setWidget;
  const later = (...args) => wrapped(...args); h.ctx.ui.setWidget = later; h.ctx.ui.setWidget("unrelated", ["keep me"]); await flush();
  assert.deepEqual(h.widgetOrder, ["jinshanwei-weather", "unrelated"]); await h.emit("session_shutdown"); assert.equal(h.ctx.ui.setWidget, later);
});
await test("Pi's actual extension loader accepts weather alongside timer and quota", async () => {
  const loader = await jiti.import(join(modules, "@earendil-works/pi-coding-agent/dist/core/extensions/loader.js"));
  const loaded = await loader.loadExtensions([join(root, "index.ts"), join(root, "../working-timer/index.ts"), join(root, "../subscription-usage-row/index.ts")], process.cwd());
  assert.deepEqual(loaded.errors, []); assert.equal(loaded.extensions.length, 3); assert.ok(loaded.extensions.some(item => item.commands.has("weather")));
});
console.log("Three-city weather tests complete.");
