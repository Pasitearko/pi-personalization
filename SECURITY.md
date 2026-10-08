# Security and privacy

This is executable extension code: install only after reviewing the source. Advanced patches explicitly modify installed third-party sources; stop Pi first. The patcher checks exact package versions, per-file pristine/already-patched hashes, allowed roots and symlinks before writing. It saves a local undo receipt and refuses unknown modifications. It does not silently reapply old files after updates.

Settings are opt-in. By default `--settings --apply` fills missing appearance fields only. `--replace-settings` changes only the example's appearance leaves; providers, accounts, models, package choices and shortcuts outside the example are retained. A full local settings backup may contain your private data; never upload `personalization-undo/`.

Weather contacts Open-Meteo with your explicitly configured coordinates, without authentication or automatic geolocation. Subscription quota queries are performed by the independently installed upstream plugin using your own credentials. Fast mode can affect billing/limits and does not guarantee server acceptance. Local-file links may launch an OS handler: verify the target before Ctrl-clicking. The Windows Unicode opener uses data via an environment variable, not executable path interpolation.

No remote telemetry, auto updater, publish hook or credential import is included. Do not commit auth files, MCP caches/tokens, sessions, provider configuration, proxy CA keys, private backups or screenshots containing personal conversations. Run `npm run check:privacy` before publication; its heuristic checks are a supplement, not proof of absence of all secrets. Prefer a new issue containing a minimal reproduction; do not paste secrets into a public issue.
