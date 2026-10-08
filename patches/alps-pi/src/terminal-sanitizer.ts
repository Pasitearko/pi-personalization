/** 功能：提供 terminal display 边界文本净化，剥离用户/扩展可控文本里的危险控制序列 实现者：alps 实现日期：2026-05-30 */

import { normalizeLocalFileHyperlink } from "./local-file-hyperlink.ts";

const ESC = "\x1b";
// [local patch] Only opt-in, validated web/local-file OSC 8 links cross message boundaries.
const HYPERLINK_CLOSE = "\x1b]8;;\x1b\\";

function formatHyperlink(url: string): string {
	return `\x1b]8;;${url}\x1b\\`;
}

/** Accept Pi's OSC 8 form, never arbitrary OSC commands or unsafe URI schemes. */
function readSafeHyperlink(sequence: string, options: TerminalSanitizeOptions): string | undefined {
	const match = /^\x1b\]8;([^;]*);([^\x00-\x1f\x7f-\x9f]*)(?:\x07|\x1b\\)$/.exec(sequence);
	if (!match) return undefined;
	// Pi emits no parameters. Allow a bounded standard id, not arbitrary metadata.
	if (match[1] && !/^id=[A-Za-z0-9._-]{1,128}$/.test(match[1])) return undefined;
	const rawUrl = match[2]!;
	if (rawUrl === "") return "";
	if (/[\s\\\x00-\x1f\x7f-\x9f]/.test(rawUrl)) return undefined;
	// [local patch] Local documents use a separate, explicit filesystem allowlist.
	if (options.preserveLocalFileHyperlinks && /^file:/i.test(rawUrl)) return normalizeLocalFileHyperlink(rawUrl);
	if (!options.preserveHttpHyperlinks || !/^https?:\/\//i.test(rawUrl)) return undefined;
	try {
		const url = new URL(rawUrl);
		if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname || url.username || url.password) return undefined;
		return url.href;
	} catch {
		return undefined;
	}
}
const C1_STRING_START = /[\x90\x9d\x9e\x9f]/;
const C0_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const C1_CONTROL = /[\x80-\x8f\x91-\x9a\x9c]/g;

export type TerminalSanitizeOptions = {
	/** 是否允许换行参与后续布局；默认保留。 */
	allowNewline?: boolean;
	/** 是否允许 tab；默认保留。 */
	allowTab?: boolean;
	/** 是否保留 SGR 颜色/样式序列；主题层已生成的 ANSI 可通过该选项保留。 */
	preserveSgr?: boolean;
	/** [local patch] 仅已渲染的 assistant 正文显式启用；默认仍剥离所有 OSC。 */
	preserveHttpHyperlinks?: boolean;
	/** [local patch] 仅 assistant 正文允许已存在的本机文档/图片/目录，默认关闭。 */
	preserveLocalFileHyperlinks?: boolean;
};

/**
 * 净化进入终端展示层的外部文本。
 * 时机：用户 prompt、extension status、工具正文等在拼接 UI 之前调用。
 * 约束：默认只保留可见文本、白名单空白与可选 SGR。显式启用时仅增加校验后的网页/本机文档 OSC 8；
 * 其它 OSC/DCS/APC/PM/非 SGR CSI 仍一律剥离，且链接在每行/输入结束时闭合。
 */
export function sanitizeTerminalText(value: unknown, options: TerminalSanitizeOptions = {}): string {
	const input = value === undefined || value === null ? "" : String(value);
	if (!input) return "";
	const preserveSgr = options.preserveSgr !== false;
	let activeUrl: string | undefined;
	let result = "";
	for (let index = 0; index < input.length;) {
		const sequence = readAnsiSequence(input, index);
		if (sequence) {
			if (isSgrSequence(sequence.code)) {
				if (preserveSgr) result += sequence.code;
			} else if ((options.preserveHttpHyperlinks || options.preserveLocalFileHyperlinks) && sequence.code.startsWith(`${ESC}]8;`)) {
				const url = readSafeHyperlink(sequence.code, options);
				// Rejecting a nested link must not leave its text using an earlier target.
				if (activeUrl && url === undefined) result += HYPERLINK_CLOSE;
				activeUrl = url || undefined;
				if (url !== undefined) result += url ? formatHyperlink(url) : HYPERLINK_CLOSE;
			}
			index += sequence.length;
			continue;
		}
		const char = input[index]!;
		if (char === "\n") {
			if (options.allowNewline !== false) {
				result += activeUrl ? HYPERLINK_CLOSE + char + formatHyperlink(activeUrl) : char;
			}
			index += 1;
			continue;
		}
		if (char === "\t") {
			if (options.allowTab !== false) result += char;
			index += 1;
			continue;
		}
		if (C0_CONTROL.test(char) || C1_CONTROL.test(char) || C1_STRING_START.test(char)) {
			C0_CONTROL.lastIndex = 0;
			C1_CONTROL.lastIndex = 0;
			C1_STRING_START.lastIndex = 0;
			index += 1;
			continue;
		}
		C0_CONTROL.lastIndex = 0;
		C1_CONTROL.lastIndex = 0;
		C1_STRING_START.lastIndex = 0;
		result += char;
		index += 1;
	}
	return result + (activeUrl ? HYPERLINK_CLOSE : "");
}

/** 将外部文本压缩为单行安全内容，适合 last prompt 与状态片段。 */
export function sanitizeTerminalSingleLineText(value: unknown, options: Omit<TerminalSanitizeOptions, "allowNewline" | "allowTab"> = {}): string {
	return sanitizeTerminalText(value, { ...options, allowNewline: false, allowTab: false }).replace(/\s+/g, " ").trim();
}

/** 判断一段 ANSI 是否为 SGR 样式序列；非 SGR CSI 不允许穿过展示边界。 */
function isSgrSequence(sequence: string): boolean {
	return /^\x1b\[[0-9;:]*m$/.test(sequence) || /^\x9b[0-9;:]*m$/.test(sequence);
}

/** 读取 ESC/C1 控制序列；不完整序列按 ESC 单字节剥离，避免残留控制前缀。 */
function readAnsiSequence(input: string, index: number): { code: string; length: number } | null {
	const char = input[index];
	if (char === ESC) return readEscSequence(input, index);
	if (char === "\x9b") return readCsiSequence(input, index, 1);
	if (char === "\x90" || char === "\x9d" || char === "\x9e" || char === "\x9f") return readStringControlSequence(input, index, 1);
	return null;
}

/** 读取 ESC 开头的 CSI/OSC/DCS/APC/PM 序列。 */
function readEscSequence(input: string, index: number): { code: string; length: number } {
	const next = input[index + 1];
	if (next === "[") return readCsiSequence(input, index, 2);
	if (next === "]" || next === "P" || next === "_" || next === "^") return readStringControlSequence(input, index, 2);
	return { code: input.slice(index, Math.min(input.length, index + 2)), length: Math.min(2, input.length - index) };
}

/** 读取 CSI 到最终字节；用于区分 SGR 与清屏/移动光标等危险控制。 */
function readCsiSequence(input: string, index: number, prefixLength: number): { code: string; length: number } {
	for (let end = index + prefixLength; end < input.length; end += 1) {
		const code = input.charCodeAt(end);
		if (code >= 0x40 && code <= 0x7e) return { code: input.slice(index, end + 1), length: end + 1 - index };
	}
	return { code: input.slice(index), length: input.length - index };
}

/** 读取 OSC/DCS/APC/PM 到 BEL 或 ST；未闭合时吞掉剩余文本，避免控制串泄漏。 */
function readStringControlSequence(input: string, index: number, prefixLength: number): { code: string; length: number } {
	for (let end = index + prefixLength; end < input.length; end += 1) {
		if (input[end] === "\x07") return { code: input.slice(index, end + 1), length: end + 1 - index };
		if (input[end] === ESC && input[end + 1] === "\\") return { code: input.slice(index, end + 2), length: end + 2 - index };
	}
	return { code: input.slice(index), length: input.length - index };
}
