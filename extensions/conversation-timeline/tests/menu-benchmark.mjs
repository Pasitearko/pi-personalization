// Synthetic picker render cost, not live terminal FPS or whole-Pi idle CPU.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const modules = resolve(process.argv[2] || process.env.PI_TEST_MODULES || new URL("../../../node_modules", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
const require = createRequire(join(modules, "benchmark.cjs"));
const { createJiti } = require("jiti");
const alias = Object.fromEntries(["pi-coding-agent", "pi-tui"].map(name =>
  [`@earendil-works/${name}`, join(modules, "@earendil-works", name, "dist/index.js")]));
const jiti = createJiti(import.meta.url, { alias });
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { TimelinePicker } = await jiti.import(join(root, "picker.ts"));
const { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } = await jiti.import(alias["@earendil-works/pi-tui"]);
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
const { loadThemeFromPath } = await jiti.import(join(modules,
  "@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"));
const theme = loadThemeFromPath(join(modules,
  "@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json"), "truecolor");
const samples = 200;
for (const count of [20, 500, 1000]) {
  const prompts = Array.from({ length: count }, (_, i) => ({ id: `p-${i}`, line: i * 10, ordinal: i + 1,
    summary: "中文提问 🌤️：检查跳转位置、边框和性能" }));
  const picker = new TimelinePicker(prompts, theme, () => 40, () => {}, () => 9);
  picker.render(42);
  function measure(select, refresh = false) {
    for (let i = 0; i < 20; i++) {
      if (select) picker.handleInput("\x1b[B");
      if (refresh) picker.invalidate();
      picker.render(42);
    }
    const start = performance.now();
    for (let i = 0; i < samples; i++) {
      if (select) picker.handleInput("\x1b[B");
      if (refresh) picker.invalidate();
      picker.render(42);
    }
    return Number(((performance.now() - start) / samples).toFixed(4));
  }
  console.log(JSON.stringify({ count, samples, unchangedMs: measure(false),
    forcedFreshMs: measure(false, true), selectionChangedMs: measure(true) }));
}
