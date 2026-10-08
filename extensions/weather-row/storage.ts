import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { CITIES, cityById, sanitizeSnapshot, type CityId, type WeatherSnapshot } from "./weather.ts";

export interface WeatherCache {
  version: 1;
  selected: CityId;
  snapshots: Partial<Record<CityId, WeatherSnapshot>>;
}
export interface WeatherStorage {
  load(): Promise<WeatherCache | undefined>;
  save(cache: WeatherCache): Promise<void>;
  flush(): Promise<void>;
}

export function parseCache(value: unknown): WeatherCache | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const root = value as Record<string, unknown>;
  if (root.version !== 1 || !cityById(root.selected)) return;
  const snapshots: WeatherCache["snapshots"] = {};
  if (root.snapshots && typeof root.snapshots === "object" && !Array.isArray(root.snapshots)) {
    const items = root.snapshots as Record<string, unknown>;
    for (const city of CITIES) {
      const snapshot = sanitizeSnapshot(items[city.id]);
      if (snapshot) snapshots[city.id] = snapshot;
    }
  }
  return { version: 1, selected: root.selected as CityId, snapshots };
}

/** Serial, atomic, best-effort persistence; no credentials or conversation data. */
export function createWeatherStorage(file = join(getAgentDir(), "cache", "weather-cities-v1.json")): WeatherStorage {
  let pending = Promise.resolve();
  return {
    async load() {
      await pending;
      try {
        if ((await stat(file)).size > 65_536) return;
        return parseCache(JSON.parse(await readFile(file, "utf8")));
      } catch { return undefined; }
    },
    save(cache) {
      // Capture now, not when an earlier write finishes: preserve click/save ordering.
      const text = JSON.stringify(cache);
      const operation = pending.then(async () => {
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          await mkdir(dirname(file), { recursive: true });
          await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
          await rename(temporary, file);
        } finally {
          await unlink(temporary).catch(() => {});
        }
      });
      pending = operation.catch(() => {});
      return operation;
    },
    flush: () => pending,
  };
}
