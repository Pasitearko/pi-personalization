import { spawn, type SpawnOptions } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeLocalFileHyperlink } from "./local-file-hyperlink.ts";
import { installCtrlFileClickRouting, type CtrlFileClickTarget } from "./file-link-click.ts";

const TARGET_ENV = "PI_LOCAL_FILE_OPEN_TARGET";
const WRAPPER_KEY = Symbol.for("alps.pi.windowsLocalFileOpener.v3");
const LEGACY_KEYS = [Symbol.for("alps.pi.windowsLocalFileOpener.v2"), Symbol.for("alps.pi.windowsLocalFileOpener.v1")];
const DEBUG_FLAG = resolve(dirname(fileURLToPath(import.meta.url)), "../.temp/local-file-open-debug.enabled");
const DEBUG_LOG = join(homedir(), ".pi", "agent", "patches", "alps-hyperlinks", "unicode-opener-debug.jsonl");
// Constant script: the target is DATA in a Unicode environment variable, never
// interpolated into PowerShell source or parsed as a cmd/start command.
const OPEN_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	`$path = $env:${TARGET_ENV}`,
	"if ([string]::IsNullOrEmpty($path)) { throw 'Missing local file target' }",
	"$info = New-Object System.Diagnostics.ProcessStartInfo",
	"$info.FileName = $path",
	"$info.UseShellExecute = $true",
	"[void][System.Diagnostics.Process]::Start($info)",
].join("; ");

type OpenUrl = (target: string) => void;
type ReportError = (message: string) => void;
type ReportActivity = (event: "ready" | "unicode") => void;
type ClickTarget = CtrlFileClickTarget & { mode?: string; openUrl?: OpenUrl };
type Owner = { error: ReportError; activity: ReportActivity };
type WrapperMetadata = { owners: Map<symbol, Owner>; original: OpenUrl; wrapper: OpenUrl; disposeRouting?: () => void };

export type WindowsFileOpenPlan =
	| { kind: "delegate"; target: string }
	| { kind: "reject" }
	| { kind: "unicode"; filePath: string; command: string; args: string[]; options: SpawnOptions };

/** Marker-controlled local diagnostics; records no URLs, paths, text or credentials. */
export function isLocalFileOpenDebugEnabled(): boolean {
	try { return existsSync(DEBUG_FLAG); } catch { return false; }
}

function trace(stage: string, details: Record<string, boolean | number | string | null> = {}): void {
	if (!isLocalFileOpenDebugEnabled()) return;
	try {
		appendFileSync(DEBUG_LOG, `${JSON.stringify({ time: new Date().toISOString(), pid: process.pid, version: 3, stage, ...details })}\n`, "utf8");
	} catch { /* Diagnostic failures must not affect the UI or activation. */ }
}

/**
 * Pi's stable TUI Proxy binds methods and hides their properties/identity. A
 * temporary symbol method returns its actual receiver, then is removed before
 * inspecting or replacing callbacks. Frozen/unsupported objects fail closed.
 * Private/version-specific compatibility, not a public Pi unwrapping API.
 */
function resolveClickTarget(reference: ClickTarget): ClickTarget | undefined {
	const key = Symbol("alps-local-file-opener-receiver");
	let receiver: (ClickTarget & Record<symbol, unknown>) | undefined;
	const identify = function (this: ClickTarget) { return this; };
	try {
		if (!Reflect.set(reference, key, identify)) return undefined;
		const probe = Reflect.get(reference, key);
		if (typeof probe !== "function") return undefined;
		receiver = Reflect.apply(probe, reference, []);
		if (!receiver || Reflect.get(receiver, key) !== identify) return undefined;
		return receiver;
	} catch {
		return undefined;
	} finally {
		if (receiver && Reflect.get(receiver, key) === identify) {
			Reflect.deleteProperty(receiver, key);
		} else {
			// Ordinary objects are safely cleaned too; unknown proxies are not used.
			try { Reflect.deleteProperty(reference, key); } catch { /* Unsupported proxy. */ }
		}
	}
}

/** Plan only; filesystem validation is repeated at click time, no launch here. */
export function planWindowsLocalFileOpen(target: string): WindowsFileOpenPlan {
	if (!/^file:/i.test(target)) return { kind: "delegate", target };
	const normalized = normalizeLocalFileHyperlink(target);
	if (!normalized) return { kind: "reject" };
	const filePath = fileURLToPath(normalized);
	if (!/[^\x00-\x7f]/.test(filePath)) return { kind: "delegate", target };
	return {
		kind: "unicode",
		filePath,
		command: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
		args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(OPEN_SCRIPT, "utf16le").toString("base64")],
		options: {
			env: { ...process.env, [TARGET_ENV]: filePath },
			// Windows PowerShell can exit 0 before executing -EncodedCommand under
			// DETACHED_PROCESS. Keep the host attached; unref below still avoids
			// keeping Pi alive. windowsHide suppresses the helper console only.
			stdio: "ignore", detached: false, windowsHide: true, shell: false,
		},
	};
}

/** Own the real fullscreen callback, not its changing stable-reference facade. */
export function installWindowsLocalFileOpener(
	reference: ClickTarget,
	reportError: ReportError = () => undefined,
	launch: typeof spawn = spawn,
	reportActivity: ReportActivity = () => undefined,
): () => void {
	if (process.platform !== "win32") { trace("install_skipped", { reason: "not_windows" }); return () => undefined; }
	let tui: ClickTarget | undefined;
	try {
		if (reference?.mode !== "fullscreen" || typeof reference.openUrl !== "function") {
			trace("install_skipped", { reason: "no_fullscreen_callback" }); return () => undefined;
		}
		tui = resolveClickTarget(reference);
	} catch { /* Unsupported/frozen reference. */ }
	if (!tui || typeof tui.openUrl !== "function") {
		trace("install_skipped", { reason: "unresolved_renderer" }); return () => undefined;
	}
	let current = tui.openUrl;
	// v1 could leave a wrapper after releasing its final owner through the Proxy.
	// Only remove a positively identified, ownerless wrapper; never an active one.
	for (const key of LEGACY_KEYS) {
		const legacy = (current as OpenUrl & Record<symbol, WrapperMetadata | undefined>)[key];
		if (legacy?.wrapper === current && legacy.owners.size === 0) {
			tui.openUrl = legacy.original;
			legacy.disposeRouting?.();
			current = legacy.original;
			trace("legacy_ownerless_removed");
		}
	}
	let metadata = (current as OpenUrl & { [WRAPPER_KEY]?: WrapperMetadata })[WRAPPER_KEY];
	if (!metadata) {
		const fileRouting = installCtrlFileClickRouting(tui);
		if (typeof tui.handleSelectionMouseEvent === "function" && !fileRouting) {
			trace("install_skipped", { reason: "no_ctrl_file_routing" });
			return () => undefined;
		}
		const owners = new Map<symbol, Owner>();
		const report = (message: string) => [...owners.values()].at(-1)?.error(message);
		const activity = (event: "ready" | "unicode") => [...owners.values()].at(-1)?.activity(event);
		const wrapper: OpenUrl = target => {
			const localFile = /^file:/i.test(target);
			trace("callback", { localFile });
			if (localFile && fileRouting && !fileRouting.allowsFileOpen()) {
				trace("plain_file_click_ignored");
				return;
			}
			try {
				const plan = planWindowsLocalFileOpen(target);
				trace("plan", { kind: plan.kind });
				if (plan.kind === "delegate") { current.call(tui, plan.target); return; }
				if (plan.kind === "reject") {
					report("本地链接已拒绝：目标不存在、不可访问或不在安全文件类型范围内。"); return;
				}
				if (isLocalFileOpenDebugEnabled()) activity("unicode");
				let reported = false;
				const fail = (detail: string) => {
					if (reported) return;
					reported = true;
					report(`本地文件打开失败：${detail}`);
				};
				const child = launch(plan.command, plan.args, plan.options);
				trace("spawned");
				child.once("error", error => {
					trace("spawn_error", { code: (error as NodeJS.ErrnoException).code ?? "unknown" });
					fail(error.message);
				});
				child.once("exit", (code, signal) => {
					trace("exit", { code, signal });
					if (code !== 0) fail(signal ? `进程被 ${signal} 终止` : `打开程序退出码 ${code}`);
				});
				child.unref();
			} catch (error) {
				trace("callback_error");
				report(`本地文件打开失败：${error instanceof Error ? error.message : "无法启动系统文件处理程序"}`);
			}
		};
		metadata = { owners, original: current, wrapper, disposeRouting: fileRouting?.dispose };
		Object.defineProperty(wrapper, WRAPPER_KEY, { value: metadata });
		try { tui.openUrl = wrapper; } catch {
			fileRouting?.dispose();
			trace("install_skipped", { reason: "readonly_callback" }); return () => undefined;
		}
	}
	const owner = Symbol("local-file-opener-owner");
	metadata.owners.set(owner, { error: reportError, activity: reportActivity });
	trace("installed", { owners: metadata.owners.size, resolvedReference: tui !== reference });
	if (isLocalFileOpenDebugEnabled()) reportActivity("ready");
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		metadata!.owners.delete(owner);
		trace("released", { owners: metadata!.owners.size });
		if (!metadata!.owners.size) {
			if (tui!.openUrl === metadata!.wrapper) {
				try { tui!.openUrl = metadata!.original; } catch { /* A later owner may freeze the object. */ }
			}
			metadata!.disposeRouting?.();
		}
	};
}
