# Pi Personalization
[中文完整说明](README.md) · [MIT](LICENSE) · [Recommendations](docs/RECOMMENDATIONS.md)

An installable Pi package distilled from a locally customized setup: weather, quota row, per-round timer, OpenAI Fast switch, message timestamps, prompt timeline, whole-frame collapse/expand, clean selection/copy, and a minimal theme.

## Previews

These are privacy-safe demo renders, not screenshots of private sessions or accounts. Real Pi / ALPS frames and actual click/selection handlers are used with fictional dialogue, paths, timestamps and values; footer rows are illustrative. Terminal fonts and platform behavior may differ.

![Interface overview with fictional status values](docs/previews/overview.png)

![Whole-frame click: compact and expanded states](docs/previews/frame-click.png)

![Native versus clean selection, including actual copied text](docs/previews/clean-selection.png)

[Preview provenance and privacy notes](docs/previews/README.md)

## Install

```sh
pi install git:github.com/Pasitearko/pi-personalization
```

Restart Pi or use /reload. Node 22.19.0+ (24 LTS recommended); Pi 1.1.0 recommended. The private frame/selection adapters also recognize tested 1.0.4. Unsupported layouts fail closed to native behavior. Fullscreen and terminal mouse/Unicode support are required for advanced interactions.

Base installation never overwrites installed plugins, settings, accounts or fonts. Optional advanced ALPS changes are explicit, exact-version/per-file-SHA-256 guarded, and reversible. Install alps-pi@0.3.4 and @specode/pi-subscription-usage@1.3.1 with Pi, clone this repo, run `node tools/setup.mjs` to preflight, then `node tools/setup.mjs --apply` only after reviewing the output and exiting Pi. The settings helper is separately opt-in: `--settings --apply` fills absent appearance leaves; `--replace-settings` explicitly adopts only the example's appearance leaves.

Mouse: an unmodified left-click release toggles already-collapsible frames; dragging, links and child buttons take priority. ALPS decorations remain drawn but are excluded from Pi's highlight and copied text. Real code indentation, trees, tables and literal box glyphs remain. This does not control terminal-owned Shift selection.

Fast is off for new sessions: /fast ok, /fast no. It requests priority, not proof of server acceptance, and may affect costs/limits. Quota requires the upstream plugin and your own sign-in; no balances/accounts are bundled. Weather uses explicit example coordinates (override PI_WEATHER_LOCATIONS with a JSON city list), sends coordinates to Open-Meteo, and displays weather data in Asia/Shanghai. It does not auto-geolocate.

Paths and tools are portable across Windows/macOS/Linux, but terminals differ. The audio and Unicode-file opener enhancements are Windows-specific; other systems retain their native behavior. No claim is made that every terminal or future Pi release has identical mouse/link/font behavior.

Original source, tools, theme, generated notification tone and docs are MIT. Modified upstream files retain their MIT notices. Fonts are not bundled: the optional letters-only italic build recipe preserves SIL OFL obligations. Third-party skills and MCP servers are recommendations, not redistributed credentials or code.

[CI](https://github.com/Pasitearko/pi-personalization/actions/workflows/ci.yml) runs tests and privacy/package checks on Windows, macOS and Linux. Automated checks do not certify every real terminal's behavior.

Development: `npm ci --ignore-scripts`, `npm test`, `npm run check:privacy`, `npm run package:check`. The test runner patches only this repository's disposable development dependencies. It never writes to the installed Pi or private backup.

See the Chinese README for all commands, guarded patch rollback, font recipe, recommendations, limitations and uninstall instructions.
