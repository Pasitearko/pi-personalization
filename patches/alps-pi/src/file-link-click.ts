// Private Pi 1.0.4 compatibility: keep file links in previousScreen for hit
// testing, but not in terminal output where Windows Terminal consumes Ctrl-click.
// HTTP(S), text, colours, images and all non-file controls remain unchanged.
const OSC8 = "\x1b]8;";
const CLOSE = "\x1b]8;;\x1b\\";
const MAX_PENDING = 16384;
const WRITE_KEY = Symbol.for("alps.pi.ctrlFileLinkWriter.v1");

type Write = (data: string) => void;
type Terminal = { write: Write };
type MouseEvent = { button: number; release: boolean; x: number; y: number };
type MouseHandler = (event: MouseEvent) => unknown;
export type CtrlFileClickTarget = {
	terminal?: Terminal;
	handleSelectionMouseEvent?: MouseHandler;
	requestRender?: (force?: boolean) => void;
};
type Filter = { filter(data: string): string; flush(): string };
type WriteMetadata = { owners: Set<symbol>; original: Write; wrapper: Write; filter: Filter; descriptor?: PropertyDescriptor };

/** Bounded streaming filter; file opens become link closes, never plain URI text. */
export function createFileLinkOutputFilter(): Filter {
	let pending = "", discarding = false;
	return {
		filter(data: string): string {
			let input = pending + data, output = "";
			pending = "";
			if (discarding) {
				const bel = input.indexOf("\x07"), st = input.indexOf("\x1b\\");
				const end = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st);
				if (end < 0) { pending = input.endsWith("\x1b") ? "\x1b" : ""; return ""; }
				input = input.slice(end + (end === bel ? 1 : 2));
				discarding = false;
			}
			while (input) {
				const start = input.indexOf(OSC8);
				if (start < 0) {
					// A control prefix can itself be split across terminal.write calls.
					let suffix = 0;
					for (let n = 1; n < OSC8.length; n++) if (input.endsWith(OSC8.slice(0, n))) suffix = n;
					output += suffix ? input.slice(0, -suffix) : input;
					pending = suffix ? input.slice(-suffix) : "";
					break;
				}
				output += input.slice(0, start);
				input = input.slice(start);
				const bel = input.indexOf("\x07", OSC8.length), st = input.indexOf("\x1b\\", OSC8.length);
				const end = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st);
				if (end < 0) {
					if (input.length <= MAX_PENDING) pending = input;
					else {
						output += CLOSE; // Discard until terminator, never leak URI fragments.
						discarding = true;
						pending = input.endsWith("\x1b") ? "\x1b" : "";
					}
					break;
				}
				const length = end + (end === bel ? 1 : 2);
				const body = input.slice(OSC8.length, end), separator = body.indexOf(";");
				const target = separator < 0 ? "" : body.slice(separator + 1);
				output += /^file:/i.test(target) ? CLOSE : input.slice(0, length);
				input = input.slice(length);
			}
			return output;
		},
		flush(): string {
			const tail = pending;
			pending = "";
			if (discarding) { discarding = false; return CLOSE; }
			return tail.startsWith(OSC8) ? CLOSE : tail;
		},
	};
}

function installFileLinkOutputFilter(terminal: Terminal): (() => void) | undefined {
	const current = terminal.write;
	let metadata = (current as Write & { [WRITE_KEY]?: WriteMetadata })[WRITE_KEY];
	if (!metadata) {
		const filter = createFileLinkOutputFilter(), owners = new Set<symbol>();
		const descriptor = Object.getOwnPropertyDescriptor(terminal, "write");
		const wrapper: Write = data => {
			const output = owners.size ? filter.filter(data) : filter.flush() + data;
			if (output) current.call(terminal, output);
		};
		metadata = { owners, original: current, wrapper, filter, descriptor };
		Object.defineProperty(wrapper, WRITE_KEY, { value: metadata });
		try { terminal.write = wrapper; } catch { return undefined; }
		if (terminal.write !== wrapper) return undefined;
	}
	const owner = Symbol("ctrl-file-link-writer-owner");
	metadata.owners.add(owner);
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		metadata!.owners.delete(owner);
		if (!metadata!.owners.size && terminal.write === metadata!.wrapper) {
			const tail = metadata!.filter.flush();
			try {
				if (metadata!.descriptor) Object.defineProperty(terminal, "write", metadata!.descriptor);
				else Reflect.deleteProperty(terminal, "write");
			} catch { return; }
			if (tail) metadata!.original.call(terminal, tail);
		}
	};
}

/** Scope permission to a Ctrl-left release; ordinary clicks and drags cannot launch. */
export function installCtrlFileClickRouting(tui: CtrlFileClickTarget): {
	allowsFileOpen(): boolean;
	dispose(): void;
} | undefined {
	if (typeof tui.handleSelectionMouseEvent !== "function" || typeof tui.terminal?.write !== "function") return undefined;
	const original = tui.handleSelectionMouseEvent;
	const descriptor = Object.getOwnPropertyDescriptor(tui, "handleSelectionMouseEvent");
	const releaseWriter = installFileLinkOutputFilter(tui.terminal);
	if (!releaseWriter) return undefined;
	let ctrlPressed = false, inCtrlRelease = false;
	const wrapper: MouseHandler = function (event) {
		const left = (event.button & 3) === 0;
		if (!event.release && (event.button & (32 | 64)) === 0) ctrlPressed = left && (event.button & 16) !== 0;
		const previous = inCtrlRelease;
		inCtrlRelease = event.release && ctrlPressed;
		try { return original.call(tui, event); }
		finally {
			inCtrlRelease = previous;
			if (event.release) ctrlPressed = false;
		}
	};
	try { tui.handleSelectionMouseEvent = wrapper; } catch { releaseWriter(); return undefined; }
	if (tui.handleSelectionMouseEvent !== wrapper) { releaseWriter(); return undefined; }
	// Re-emit an unchanged screen through the filter, removing already published
	// terminal file hyperlinks as well as future ones. Internal hit data stays intact.
	let active = true;
	const routing = {
		allowsFileOpen: () => inCtrlRelease,
		dispose() {
			if (!active) return;
			active = false;
			if (tui.handleSelectionMouseEvent === wrapper) {
				try {
					if (descriptor) Object.defineProperty(tui, "handleSelectionMouseEvent", descriptor);
					else Reflect.deleteProperty(tui, "handleSelectionMouseEvent");
				} catch { /* Later owner may freeze it. */ }
			}
			releaseWriter();
			try { tui.requestRender?.(true); } catch { /* Disposed renderers may reject refresh. */ }
		},
	};
	try { tui.requestRender?.(true); } catch { routing.dispose(); return undefined; }
	return routing;
}
