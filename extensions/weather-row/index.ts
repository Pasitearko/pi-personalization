import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import {
  CITIES, cityById, DATA_INTERVAL_MS, formatDataTime, isCurrent, locationHitWidth, MAX_RETRY_MS, MIN_REFRESH_MS,
  parseWeather, RETRY_MS, renderWeather, REQUEST_TIMEOUT_MS, weatherUrl,
  type CityId, type WeatherCity, type WeatherSnapshot, type WeatherStatus,
} from "./weather.ts";
import { createWeatherStorage, type WeatherCache, type WeatherStorage } from "./storage.ts";

const WIDGET_KEY = "weather-row";
interface Flight { controller: AbortController; timeout: ReturnType<typeof setTimeout>; promise: Promise<void> }
interface CityState {
  snapshot?: WeatherSnapshot; status: WeatherStatus; lastAttempt: number; flight?: Flight;
  failures: number; nextRefreshAt: number;
}

export default function weatherExtension(pi: ExtensionAPI, storage: WeatherStorage = createWeatherStorage()) {
  let context: ExtensionContext | undefined;
  let states = new Map<CityId, CityState>();
  let selected: CityId = CITIES[0].id;
  let selectionChanged = false;
  let cacheLoaded = false;
  let saveRequested = false;
  let loadPromise: Promise<WeatherCache | undefined> | undefined;
  let pendingPersistence = Promise.resolve();
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let requestRender: (() => void) | undefined;
  let restoreWidgetHook: (() => void) | undefined;
  let generation = 0;
  const interactive = (ctx: ExtensionContext) => ctx.hasUI && ctx.mode === "tui";
  const active = () => !!context && interactive(context);
  const currentCity = () => cityById(selected)!;

  function collectCache(): WeatherCache {
    const cache: WeatherCache = { version: 1, selected, snapshots: {} };
    for (const [id, state] of states) if (state.snapshot) cache.snapshots[id] = state.snapshot;
    return cache;
  }
  function persist() {
    if (!cacheLoaded) { saveRequested = true; return; }
    saveRequested = false;
    void storage.save(collectCache()).catch(() => {}); // Disk failure must not break input.
  }

  function stop() {
    // A click can precede disk hydration. Capture this generation's selection and
    // merge it with the pending disk cache before closing, never erasing other cities.
    if (saveRequested && !cacheLoaded && loadPromise) {
      const loading = loadPromise, chosen = collectCache();
      saveRequested = false;
      pendingPersistence = pendingPersistence.then(async () => {
        const previous = await loading;
        await storage.save({ ...chosen, snapshots: { ...previous?.snapshots, ...chosen.snapshots } });
      }).catch(() => {});
    }
    generation++;
    restoreWidgetHook?.(); restoreWidgetHook = undefined;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = undefined;
    for (const state of states.values()) {
      if (state.flight) { clearTimeout(state.flight.timeout); state.flight.controller.abort(); }
      state.flight = undefined;
    }
    context = undefined;
    requestRender = undefined;
  }

  function selectCity(city: WeatherCity) {
    if (!active()) return;
    selected = city.id;
    selectionChanged = true;
    persist();
    requestRender?.();
    // Deliberately no refresh: mouse/command switching only reads per-city cache.
  }
  function nextCity() {
    selectCity(CITIES[(CITIES.findIndex(city => city.id === selected) + 1) % CITIES.length]);
  }

  // One wake-up for the earliest city's deadline; no periodic idle checks.
  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = undefined;
    if (!active() || !cacheLoaded) return;
    const due = Math.min(...[...states.values()].filter(state => !state.flight)
      .map(state => Math.max(state.nextRefreshAt, state.lastAttempt + MIN_REFRESH_MS)));
    if (!Number.isFinite(due)) return;
    const version = generation;
    refreshTimer = setTimeout(() => {
      if (version !== generation || !active()) return;
      refreshTimer = undefined;
      void refreshDueCities();
    }, Math.max(0, due - Date.now()));
    refreshTimer.unref?.();
  }

  function refreshCity(city: WeatherCity): Promise<void> {
    if (!active()) return Promise.resolve();
    const state = states.get(city.id)!;
    if (state.flight) return state.flight.promise;
    if (Date.now() - state.lastAttempt < MIN_REFRESH_MS) return Promise.resolve();
    state.lastAttempt = Date.now();
    state.status = "loading";
    requestRender?.();
    const version = generation;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timeout.unref?.();
    const flight: Flight = { controller, timeout, promise: Promise.resolve() };
    state.flight = flight;
    scheduleRefresh();
    const valid = () => version === generation && active();
    flight.promise = (async () => {
      try {
        // Fixed official public endpoint, Pi's global HTTP dispatcher, no auth headers.
        const response = await fetch(weatherUrl(city), { signal: controller.signal, redirect: "error", cache: "no-store" });
        if (!valid()) { await response.body?.cancel(); return; }
        if (!response.ok) { await response.body?.cancel(); throw new Error("http"); }
        const parsed = parseWeather(await response.json(), city);
        if (!valid()) return;
        if (controller.signal.aborted) throw new Error("timeout");
        if (!parsed) throw new Error("schema");
        if (!isCurrent(parsed) || (state.snapshot && parsed.dataTime < state.snapshot.dataTime)) throw new Error("expired");
        state.snapshot = parsed;
        state.status = "ready";
        state.failures = 0;
        const now = Date.now(), currentBatch = Math.floor(now / DATA_INTERVAL_MS) * DATA_INTERVAL_MS;
        // A valid old batch is still usable: keep it until the next boundary,
        // without extra minute-by-minute requests for an upstream publication delay.
        state.nextRefreshAt = currentBatch + DATA_INTERVAL_MS;
        persist();
      } catch (error) {
        if (!valid()) return;
        const message = error instanceof Error ? error.message : "";
        state.status = controller.signal.aborted ? "timeout" : message === "expired" ? "expired" : "unavailable";
        state.failures = Math.min(state.failures + 1, 4);
        state.nextRefreshAt = Date.now() + Math.min(RETRY_MS * 2 ** (state.failures - 1), MAX_RETRY_MS);
        // Retain this city's last successful snapshot, always with an explicit warning.
        // A failure cannot erase the other cities or expose raw errors in the UI.
      } finally {
        clearTimeout(timeout);
        if (state.flight === flight) state.flight = undefined;
        if (valid()) { requestRender?.(); scheduleRefresh(); }
      }
    })();
    return flight.promise;
  }
  function refreshDueCities() {
    const now = Date.now();
    const pending = CITIES.filter(city => {
      const state = states.get(city.id)!;
      return !state.flight && now >= Math.max(state.nextRefreshAt, state.lastAttempt + MIN_REFRESH_MS);
    }).map(city => refreshCity(city));
    scheduleRefresh();
    return Promise.all(pending);
  }

  function attach(ctx: ExtensionContext) {
    stop();
    context = ctx;
    selected = CITIES[0].id;
    selectionChanged = false;
    cacheLoaded = false;
    saveRequested = false;
    states = new Map(CITIES.map(city => [city.id, {
      status: "loading", lastAttempt: -Infinity, failures: 0, nextRefreshAt: -Infinity,
    }]));
    const version = generation;
    const ui = ctx.ui;
    const originalSetWidget = ui.setWidget;
    let moving = false;
    let moveQueued = false;
    const mount = () => {
      if (version !== generation || !active()) return;
      moving = true;
      try {
        originalSetWidget.call(ui, WIDGET_KEY, (tui, theme) => {
          requestRender = () => tui.requestRender();
          return {
            render: (width) => {
              const city = currentCity(), state = states.get(city.id)!;
              return renderWeather(state.snapshot, state.status, width, theme, Date.now(), city);
            },
            handleMouse(event: TuiMouseEvent) {
              if (version !== generation || !active() || event.y !== 0 || event.shift || event.ctrl || event.alt ||
                  event.x < 1 || event.x >= locationHitWidth(currentCity(), event.width) ||
                  (event.button !== "left" && !(event.type === "click" && event.button === "none"))) return;
              // Handling press is required for Pi to synthesize a click on release.
              // Do not request focus: keyboard input/caret stays in the editor.
              if (event.type === "press" || event.type === "release") return { handled: true, render: false };
              if (event.type === "click") { nextCity(); return { handled: true, render: true }; }
            },
            invalidate() {},
            dispose() { if (!moving && version === generation) stop(); },
          };
        }, { placement: "aboveEditor" });
      } finally { moving = false; }
    };
    // Preserve plan → weather → editor ordering, without patching third-party packages.
    const wrappedSetWidget: typeof originalSetWidget = (key, content, options) => {
      originalSetWidget.call(ui, key, content, options);
      if (key !== "plannotator-progress" || content === undefined || moveQueued || version !== generation) return;
      moveQueued = true;
      queueMicrotask(() => {
        if (version !== generation || !active()) return;
        moveQueued = false; mount();
      });
    };
    ui.setWidget = wrappedSetWidget;
    restoreWidgetHook = () => { if (ui.setWidget === wrappedSetWidget) ui.setWidget = originalSetWidget; };
    mount();
    loadPromise = pendingPersistence.then(() => storage.load()).catch(() => undefined);
    void (async () => {
      const cache = await loadPromise;
      if (version !== generation || !active()) return;
      if (cache) {
        if (!selectionChanged) selected = cache.selected;
        for (const city of CITIES) {
          const state = states.get(city.id)!;
          if (!state.snapshot && cache.snapshots[city.id]) {
            state.snapshot = cache.snapshots[city.id];
            // A manual request may already have failed while disk I/O was pending.
            if (!state.flight && state.lastAttempt === -Infinity) state.status = "ready";
          }
        }
      }
      cacheLoaded = true;
      if (saveRequested) persist();
      requestRender?.();
      await refreshDueCities(); // Startup prefetches all three; switching never fetches.
    })();
  }

  pi.on("session_start", (_event, ctx) => { if (interactive(ctx)) attach(ctx); });
  pi.on("session_shutdown", async (_event, ctx) => {
    stop();
    if (interactive(ctx)) ctx.ui.setWidget(WIDGET_KEY, undefined);
    await pendingPersistence;
    await storage.flush().catch(() => {});
  });
  pi.registerCommand("weather", {
    description: "刷新当前城市；/weather next 仅切换缓存；可指定已配置的城市 ID",
    handler: async (args, ctx) => {
      if (!interactive(ctx)) return;
      // Pi creates a fresh command context object each time; identity is not a
      // session boundary. Only attach when no live TUI widget/session is active.
      if (!active()) attach(ctx);
      const action = args.trim().toLowerCase();
      if (action === "next") { nextCity(); return; }
      const target = CITIES.find(city => city.id === action || city.name === action);
      if (target) { selectCity(target); return; }
      if (action && action !== "refresh") {
        ctx.ui.notify("用法：/weather（刷新当前城市）或 /weather next（仅切换缓存）；也可指定已配置的城市 ID。", "warning");
        return;
      }
      const city = currentCity(), state = states.get(city.id)!;
      if (!state.flight && Date.now() - state.lastAttempt < MIN_REFRESH_MS) {
        ctx.ui.notify("天气刚查询过，请等待至少 15 秒再手动刷新。", "info");
        return;
      }
      const version = generation;
      await refreshCity(city);
      if (version !== generation || !active()) return;
      if (state.snapshot && state.status === "ready") {
        ctx.ui.notify(`${city.name}天气已刷新 · 数据 ${formatDataTime(state.snapshot.dataTime)}（上海时间） · 来源 Open-Meteo 模型格点天气，非家门口传感器实测。`, "info");
      } else {
        ctx.ui.notify(`${city.name}天气刷新失败${state.snapshot ? "，保留最近成功的数据并标注更新失败" : "，暂无可用缓存"}。`, "warning");
      }
    },
  });
}
