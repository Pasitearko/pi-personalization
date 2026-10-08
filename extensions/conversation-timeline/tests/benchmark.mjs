// Synthetic, real Pi SDK benchmark. Run before/after changes with identical arguments.
// node benchmark.mjs <Pi node_modules> [turns=500] [replyLines=120] [samples=10]
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const modules = resolve(process.argv[2]);
const turns = Number(process.argv[3] || 500), replyLines = Number(process.argv[4] || 120), samples = Number(process.argv[5] || 10);
const require = createRequire(join(modules, "test.cjs"));
const { createJiti } = require("jiti");
const aliases = Object.fromEntries(["pi-coding-agent", "pi-tui"].map(name =>
  [`@earendil-works/${name}`, join(modules, "@earendil-works", name, "dist/index.js")]));
const jiti = createJiti(import.meta.url, { alias: aliases });
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { PromptIndexer } = await jiti.import(join(root, "timeline.ts"));
const { TimelineAdapter } = await jiti.import(join(root, "adapter.ts"));
const { Container, Text } = await jiti.import(aliases["@earendil-works/pi-tui"]);
const { renderLayoutFrame } = await jiti.import(join(modules, "@earendil-works/pi-tui/dist/layout.js"));
const { createChatViewport } = await jiti.import(join(modules,
  "@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js"));
const { UserMessageComponent } = await jiti.import(join(modules,
  "@earendil-works/pi-coding-agent/dist/modes/interactive/components/user-message.js"));
const { loadThemeFromPath, setThemeInstance } = await jiti.import(join(modules,
  "@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"));
const theme = loadThemeFromPath(join(modules,
  "@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json"), "truecolor");
setThemeInstance(theme);
const { renderNeonBox } = await jiti.import(resolve(root, "../../node_modules/alps-pi/src/features/chrome-frame/chrome.ts"));
const document = new Container();
for (let i = 0; i < turns; i++) {
  const user = new UserMessageComponent(`提问 ${i + 1}：` + "真实提问与长上下文性能测试 ".repeat(10));
  const original = user.render;
  user.render = function (width) { return renderNeonBox("user", original.call(this, width), width, theme); };
  document.addChild(user);
  document.addChild(new Text((`回复 ${i + 1} 内容\n`).repeat(replyLines), 0, 0));
}
let documentRenders = 0;
const originalDocumentRender = document.render;
document.render = function (width) { documentRenders++; return originalDocumentRender.call(this, width); };
const dock = Object.fromEntries(["pendingMessages", "status", "editor", "footer", "widgetsAbove", "widgetsBelow"]
  .map(name => [name, new Text(name === "editor" ? "EDITOR\ninput\nEDITOR" : name, 0, 0)]));
const viewport = createChatViewport({ document, ...dock, scrollbar: "hidden" });
let requests = 0;
const tui = { layoutRoot: viewport.root, terminal: { columns: 120, rows: 40 }, requestRender() { requests++; } };
const frame = () => renderLayoutFrame(viewport.root, 120, 40, () => tui.requestRender());
const raw = document.render(116), indexer = new PromptIndexer();
async function measure(label, fn) {
  for (let i = 0; i < 3; i++) { fn(); await Promise.resolve(); }
  const times = []; documentRenders = 0; requests = 0;
  for (let i = 0; i < samples; i++) {
    const start = performance.now(); fn(); times.push(performance.now() - start); await Promise.resolve();
  }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ label, meanMs: +(times.reduce((a, b) => a + b, 0) / samples).toFixed(3),
    p95Ms: +times[Math.min(times.length - 1, Math.floor(times.length * .95))].toFixed(3),
    documentRendersPerFrame: documentRenders / samples, correctionRequests: requests }));
}
console.log(JSON.stringify({ turns, replyLines, totalRows: raw.length, samples, sdk: "Pi 1.0.0", synthetic: true }));
await measure("index-only", () => indexer.build(raw, document));
await measure("timeline-off", frame);
const adapter = TimelineAdapter.attach(tui, () => theme, () => {});
await measure("timeline-on-idle", frame);
await measure("timeline-on-streaming", () => {
  document.addChild(new Text("new streaming row", 0, 0)); frame();
});
adapter.dispose();
