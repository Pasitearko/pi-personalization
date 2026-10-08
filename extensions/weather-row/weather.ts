import type { Theme } from "@earendil-works/pi-coding-agent";
import { rgbColor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface WeatherCity { id: string; name: string; latitude: number; longitude: number }
const DEFAULT_CITIES: readonly WeatherCity[] = [
  { id: "shanghai", name: "上海", latitude: 31.2304, longitude: 121.4737 },
  { id: "strasbourg", name: "斯特拉斯堡", latitude: 48.58392, longitude: 7.74553 },
  { id: "tokyo", name: "东京", latitude: 35.6895, longitude: 139.69171 },
];
/** Explicit coordinates only: never geolocate the user or persist a personal home address. */
export function configuredCities(input: unknown): readonly WeatherCity[] {
  try {
    const value: unknown = typeof input === "string" ? JSON.parse(input) : input;
    if (!Array.isArray(value) || value.length < 1 || value.length > 5) return DEFAULT_CITIES;
    const seen = new Set<string>();
    const cities: WeatherCity[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object" || typeof entry.id !== "string" ||
          !/^[a-z0-9-]{1,32}$/.test(entry.id) || seen.has(entry.id) ||
          typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > 40 ||
          /[\u0000-\u001f\u007f-\u009f]/.test(entry.name) ||
          typeof entry.latitude !== "number" || !Number.isFinite(entry.latitude) || Math.abs(entry.latitude) > 90 ||
          typeof entry.longitude !== "number" || !Number.isFinite(entry.longitude) || Math.abs(entry.longitude) > 180) return DEFAULT_CITIES;
      seen.add(entry.id);
      cities.push({id: entry.id, name: entry.name, latitude: entry.latitude, longitude: entry.longitude});
    }
    return cities;
  } catch { return DEFAULT_CITIES; }
}
export const CITIES = configuredCities(process.env.PI_WEATHER_LOCATIONS);
export type CityId = WeatherCity["id"];
export const LOCATION = CITIES[0].name;
export const cityById = (value: unknown): WeatherCity | undefined => CITIES.find(city => city.id === value);
export const locationHitWidth = (city: WeatherCity, width: number): number => Math.min(width, 1 + visibleWidth(`📍 ${city.name}`));
// Query on 15-minute boundaries; only failed requests use exponential backoff.
export const DATA_INTERVAL_MS = 15 * 60_000;
export const RETRY_MS = 60_000;
export const MAX_RETRY_MS = 8 * RETRY_MS;
export const MIN_REFRESH_MS = 15_000;
export const REQUEST_TIMEOUT_MS = 12_000;
export const MAX_DATA_AGE_MS = 60 * 60_000;
const FUTURE_TOLERANCE_MS = 15 * 60_000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60_000;
// All cities use the same data/display timezone. is_day is still computed for
// the requested city's coordinates, not for Shanghai's sunrise/sunset.
export function weatherUrl(city: WeatherCity): string {
  return `https://api.open-meteo.com/v1/forecast?latitude=${city.latitude}&longitude=${city.longitude}` +
    "&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,is_day,wind_speed_10m,wind_direction_10m" +
    "&timezone=Asia%2FShanghai&temperature_unit=celsius&wind_speed_unit=kmh";
}
export const WEATHER_URL = weatherUrl(CITIES[0]);

export interface WeatherSnapshot {
  dataTime: number;
  temperature: number;
  feelsLike?: number;
  humidity?: number;
  windSpeed?: number;
  windDirection?: number;
  code?: number;
  isDay?: boolean;
}
export type WeatherStatus = "ready" | "loading" | "unavailable" | "timeout" | "expired";

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function number(value: unknown, low: number, high: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= low && value <= high
    ? value : undefined;
}

/** API's offset-free ISO time is explicitly Asia/Shanghai, not the machine's local zone. */
export function parseDataTime(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return;
  const normalized = value.length === 16 ? value + ":00" : value;
  const timestamp = Date.parse(normalized + "+08:00");
  if (!Number.isFinite(timestamp)) return;
  // Reject normalized impossible dates such as February 30.
  if (new Date(timestamp + SHANGHAI_OFFSET_MS).toISOString().slice(0, 19) !== normalized) return;
  return timestamp;
}

export function parseWeather(value: unknown, city: WeatherCity = CITIES[0]): WeatherSnapshot | undefined {
  const root = object(value), current = object(root?.current), units = object(root?.current_units);
  if (!root || !current || !units || root.timezone !== "Asia/Shanghai" || root.utc_offset_seconds !== 28800) return;
  // The service returns a nearby model grid, not necessarily our exact requested coordinate.
  const latitude = number(root.latitude, city.latitude - 0.5, city.latitude + 0.5);
  const longitude = number(root.longitude, city.longitude - 0.5, city.longitude + 0.5);
  if (latitude === undefined || longitude === undefined || units.temperature_2m !== "°C" || units.time !== "iso8601") return;
  const temperature = number(current.temperature_2m, -90, 65), dataTime = parseDataTime(current.time);
  if (temperature === undefined || dataTime === undefined) return;
  const code = number(current.weather_code, 0, 99);
  return {
    dataTime, temperature,
    feelsLike: units.apparent_temperature === "°C" ? number(current.apparent_temperature, -100, 80) : undefined,
    humidity: units.relative_humidity_2m === "%" ? number(current.relative_humidity_2m, 0, 100) : undefined,
    windSpeed: units.wind_speed_10m === "km/h" ? number(current.wind_speed_10m, 0, 500) : undefined,
    windDirection: units.wind_direction_10m === "°" ? number(current.wind_direction_10m, 0, 360) : undefined,
    code: code !== undefined && Number.isInteger(code) ? code : undefined,
    isDay: current.is_day === 1 ? true : current.is_day === 0 ? false : undefined,
  };
}

/** Validate persisted cache separately: only known finite numeric fields survive. */
export function sanitizeSnapshot(value: unknown): WeatherSnapshot | undefined {
  const item = object(value);
  const dataTime = number(item?.dataTime, 0, 8_640_000_000_000_000);
  const temperature = number(item?.temperature, -90, 65);
  if (!item || dataTime === undefined || temperature === undefined) return;
  const code = number(item.code, 0, 99);
  return {
    dataTime, temperature,
    feelsLike: number(item.feelsLike, -100, 80), humidity: number(item.humidity, 0, 100),
    windSpeed: number(item.windSpeed, 0, 500), windDirection: number(item.windDirection, 0, 360),
    code: code !== undefined && Number.isInteger(code) ? code : undefined,
    isDay: typeof item.isDay === "boolean" ? item.isDay : undefined,
  };
}

export function isCurrent(snapshot: WeatherSnapshot, now = Date.now()): boolean {
  const age = now - snapshot.dataTime;
  return Number.isFinite(age) && age <= MAX_DATA_AGE_MS && age >= -FUTURE_TOLERANCE_MS;
}

export function condition(code?: number, isDay?: boolean): { icon: string; label: string } {
  if (code === 0) return { icon: isDay === false ? "🌙" : isDay === true ? "☀️" : "🌡️", label: "晴" };
  if (code === 1) return { icon: isDay === true ? "🌤️" : "☁️", label: "晴间多云" };
  if (code === 2) return { icon: "☁️", label: "多云" };
  if (code === 3) return { icon: "☁️", label: "阴" };
  if (code === 45 || code === 48) return { icon: "🌫️", label: "雾" };
  const conditions: Record<number, [string, string]> = {
    51: ["🌦️", "毛毛雨"], 53: ["🌦️", "毛毛雨"], 55: ["🌦️", "毛毛雨"],
    56: ["🌧️", "冻毛毛雨"], 57: ["🌧️", "冻毛毛雨"],
    61: ["🌧️", "小雨"], 63: ["🌧️", "中雨"], 65: ["🌧️", "大雨"],
    66: ["🌧️", "冻雨"], 67: ["🌧️", "冻雨"],
    71: ["❄️", "小雪"], 73: ["❄️", "中雪"], 75: ["❄️", "大雪"], 77: ["❄️", "雪粒"],
    80: ["🌦️", "阵雨"], 81: ["🌦️", "阵雨"], 82: ["🌧️", "强阵雨"],
    85: ["❄️", "阵雪"], 86: ["❄️", "强阵雪"],
    95: ["⛈️", "雷雨"], 96: ["⛈️", "雷雨伴冰雹"], 99: ["⛈️", "雷雨伴冰雹"],
  };
  const item = code === undefined ? undefined : conditions[code];
  return item ? { icon: item[0], label: item[1] } : { icon: "🌡️", label: "" };
}

export function windDirection(degrees: number): string {
  return ["北风", "东北风", "东风", "东南风", "南风", "西南风", "西风", "西北风"]
    [Math.round(degrees / 45) % 8];
}
export const formatNumber = (value: number): string => value.toFixed(1).replace(/\.0$/, "");
export function formatDataTime(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp + SHANGHAI_OFFSET_MS).toISOString();
  const today = new Date(now + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
  return (date.slice(0, 10) === today ? "" : date.slice(5, 10) + " ") + date.slice(11, 16);
}

export function renderWeather(snapshot: WeatherSnapshot | undefined, status: WeatherStatus,
  width: number, theme: Theme, now = Date.now(), city: WeatherCity = CITIES[0]): string[] {
  if (width <= 0) return [];
  const locationColor = theme.appearance === "light" ? rgbColor(26, 125, 130) : rgbColor(125, 211, 207);
  const location = theme.style(`📍 ${city.name}`, { fg: locationColor });
  const divider = theme.fg("dim", "  │  ");
  if (!snapshot || snapshot.dataTime > now + FUTURE_TOLERANCE_MS) {
    const state = snapshot ? "expired" : status;
    const message = state === "loading" ? "⏳ 天气读取中" : state === "timeout" ? "⚠️ 天气读取超时"
      : state === "expired" ? "⚠️ 天气数据过期" : "⚠️ 天气暂不可用";
    return [truncateToWidth(" " + location + divider + theme.fg(state === "loading" ? "muted" : "warning", message), width)];
  }
  const weather = condition(snapshot.code, snapshot.isDay);
  const primary = weather.icon + " " + (weather.label ? weather.label + " " : "") + `${formatNumber(snapshot.temperature)}°C`;
  const parts: { key: string; text: string }[] = [
    { key: "location", text: location },
    { key: "weather", text: theme.style(primary, { fg: "text", bold: true }) },
  ];
  const stale = !isCurrent(snapshot, now);
  const failed = status === "unavailable" || status === "timeout" || status === "expired";
  if (stale || failed) {
    const warning = stale && failed ? "⚠️ 数据过期·更新失败" : stale ? "⚠️ 数据过期" : "⚠️ 更新失败";
    // Mandatory warning: retain it when optional metrics are removed on narrow screens.
    parts.splice(1, 0, { key: "warning", text: theme.fg("warning", warning) });
  }
  if (snapshot.feelsLike !== undefined) parts.push({ key: "feels", text: theme.fg("muted", `🌡️ 体感 ${formatNumber(snapshot.feelsLike)}°C`) });
  if (snapshot.humidity !== undefined) parts.push({ key: "humidity", text: theme.fg("muted", `💧 ${formatNumber(snapshot.humidity)}%`) });
  if (snapshot.windSpeed !== undefined) {
    const wind = snapshot.windSpeed < 1 ? "静风"
      : (snapshot.windDirection === undefined ? "" : windDirection(snapshot.windDirection) + " ") + `${formatNumber(snapshot.windSpeed)} km/h`;
    parts.push({ key: "wind", text: theme.fg("muted", `🍃 ${wind}`) });
  }
  parts.push({ key: "time", text: theme.fg("dim", `🕒 ${formatDataTime(snapshot.dataTime, now)}`) });
  const line = () => " " + parts.map(part => part.text).join(divider);
  for (const optional of ["feels", "wind", "humidity", "time"]) {
    if (visibleWidth(line()) <= width) break;
    const index = parts.findIndex(part => part.key === optional);
    if (index >= 0) parts.splice(index, 1);
  }
  return [truncateToWidth(line(), width)];
}
