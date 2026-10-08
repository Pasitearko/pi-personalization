import { lstatSync } from "node:fs";
import { extname, isAbsolute, join, parse } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// [local patch] Positive allowlist: never pass arbitrary local launch targets.
const DOCUMENT_EXTENSIONS = new Set([
	".txt", ".md", ".markdown", ".json", ".jsonc", ".yaml", ".yml",
	".toml", ".ini", ".cfg", ".conf", ".log", ".csv", ".tsv",
	// User opt-in: HTML opens through the system association (browser), not a sandbox.
	".html", ".htm",
	".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif", ".ico", ".pdf",
]);
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;

/**
 * Validate an existing local document/image/directory URL without launching it.
 * Only explicit file:/// URIs; no hosts, UNC, query/fragment, device paths, ADS,
 * standalone scripts, executables, shortcuts, symlinks, or directory junctions.
 * HTML/HTM are explicitly allowed; browsers may execute embedded page scripts.
 * Filesystem validation happens at render time, not as an execution sandbox.
 */
export function normalizeLocalFileHyperlink(rawUrl: string): string | undefined {
	if (!/^file:\/\/\/(?!\/)/i.test(rawUrl) || /[\s\\]/.test(rawUrl) || CONTROL_CHARACTERS.test(rawUrl)) return undefined;
	try {
		const url = new URL(rawUrl);
		if (url.protocol !== "file:" || url.hostname || url.username || url.password || url.port || url.search || url.hash) return undefined;
		const filePath = fileURLToPath(url);
		if (!isAbsolute(filePath) || CONTROL_CHARACTERS.test(filePath)) return undefined;
		if (process.platform === "win32" && !/^[A-Za-z]:[\\/]/.test(filePath)) return undefined;

		const { root } = parse(filePath);
		const parts = filePath.slice(root.length).split(/[\\/]/).filter(Boolean);
		if (parts.some(part => part === "." || part === "..")) return undefined;
		if (process.platform === "win32" && parts.some(part =>
			/[<>:"|?*]/.test(part) || /[ .]$/.test(part) || WINDOWS_DEVICE.test(part)
		)) return undefined;

		// Walk from the local root rather than stat-ing a path through a junction:
		// reject any link before traversing its target (including UNC targets).
		let current = root;
		let info = lstatSync(current);
		if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
		for (let index = 0; index < parts.length; index += 1) {
			current = join(current, parts[index]!);
			info = lstatSync(current);
			if (info.isSymbolicLink()) return undefined;
			if (index < parts.length - 1 && !info.isDirectory()) return undefined;
		}
		if (!info.isDirectory() && !(info.isFile() && DOCUMENT_EXTENSIONS.has(extname(current).toLowerCase()))) return undefined;
		return pathToFileURL(current).href;
	} catch {
		// Missing, inaccessible, malformed, or unsupported: render plain text.
		return undefined;
	}
}
