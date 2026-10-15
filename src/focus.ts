/**
 * Focus detection for pi-nudge.
 *
 * Prefers CSI mode 1004 focus reports when the terminal supports them.
 * pi's fullscreen UI consumes those reports before extension input listeners
 * run, so callers also feed raw stdin through {@link createFocusReportReader}.
 * Until a report arrives, fall back to a conservative OS probe: the X11 active
 * window on Linux, the frontmost application on macOS. Returns "unknown" when
 * nothing reliable is available — including inside a multiplexer, where a
 * process-tree miss must not be treated as unfocused.
 */
export type FocusState = "unknown" | "focused" | "unfocused";

export const ENABLE_FOCUS_REPORTING = "\x1b[?1004h";
export const DISABLE_FOCUS_REPORTING = "\x1b[?1004l";

const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const OUTSIDE_PASTE_TOKENS = [PASTE_START, FOCUS_IN, FOCUS_OUT] as const;

export type FocusDependencies = {
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	/** Process whose ancestors count as this terminal. Defaults to process.pid. */
	pid?: number;
	readCommand?: (command: string, args: string[]) => Promise<string | undefined>;
};

const WINDOW_ID_PATTERN = /^(?:0x[0-9a-f]+|\d+)$/i;

const isProperPrefix = (value: string, tokens: readonly string[]) =>
	value.length > 0 && tokens.some((token) => token.startsWith(value) && value.length < token.length);

/** Longest suffix of data[from..] that is a proper prefix of one of tokens. */
const longestProperPrefix = (data: string, from: number, tokens: readonly string[]) => {
	const maxLength = Math.max(...tokens.map((token) => token.length)) - 1;
	const start = Math.max(from, data.length - maxLength);
	for (let index = start; index < data.length; index++) {
		const suffix = data.slice(index);
		if (isProperPrefix(suffix, tokens)) return suffix;
	}
	return "";
};

/**
 * Reads DEC 1004 focus reports from a raw stdin stream. Reports inside a
 * bracketed paste are ignored. A report split across chunks is kept in a
 * short carry. The last report in the chunk wins.
 */
export const createFocusReportReader = () => {
	let carry = "";
	let inPaste = false;

	return (chunk: string): FocusState | undefined => {
		const data = carry + chunk;
		carry = "";
		let last: FocusState | undefined;
		let index = 0;

		while (index < data.length) {
			if (inPaste) {
				const end = data.indexOf(PASTE_END, index);
				if (end === -1) {
					carry = longestProperPrefix(data, index, [PASTE_END]);
					break;
				}
				inPaste = false;
				index = end + PASTE_END.length;
				continue;
			}

			if (data.startsWith(PASTE_START, index)) {
				inPaste = true;
				index += PASTE_START.length;
				continue;
			}
			if (data.startsWith(FOCUS_IN, index)) {
				last = "focused";
				index += FOCUS_IN.length;
				continue;
			}
			if (data.startsWith(FOCUS_OUT, index)) {
				last = "unfocused";
				index += FOCUS_OUT.length;
				continue;
			}

			if (data.length - index < PASTE_START.length) {
				const partial = longestProperPrefix(data, index, OUTSIDE_PASTE_TOKENS);
				if (partial.length === data.length - index) {
					carry = partial;
					break;
				}
			}
			index += 1;
		}

		return last;
	};
};

/**
 * Removes focus reports from terminal input so regular mode does not insert
 * them into the editor. Bytes inside a bracketed paste are left alone. The
 * last report wins when a chunk carries several.
 */
export const consumeFocusReports = (data: string): { state: FocusState; rest: string; sawReport: boolean } => {
	let state: FocusState = "unknown";
	let sawReport = false;
	const parts: string[] = [];
	let index = 0;
	let inPaste = false;

	while (index < data.length) {
		if (inPaste) {
			const end = data.indexOf(PASTE_END, index);
			if (end === -1) {
				parts.push(data.slice(index));
				break;
			}
			parts.push(data.slice(index, end + PASTE_END.length));
			index = end + PASTE_END.length;
			inPaste = false;
			continue;
		}

		if (data.startsWith(PASTE_START, index)) {
			parts.push(PASTE_START);
			index += PASTE_START.length;
			inPaste = true;
			continue;
		}
		if (data.startsWith(FOCUS_IN, index)) {
			state = "focused";
			sawReport = true;
			index += FOCUS_IN.length;
			continue;
		}
		if (data.startsWith(FOCUS_OUT, index)) {
			state = "unfocused";
			sawReport = true;
			index += FOCUS_OUT.length;
			continue;
		}

		parts.push(data.charAt(index));
		index += 1;
	}

	return { state, rest: parts.join(""), sawReport };
};

const parseWindowId = (value: string | undefined) => {
	if (!value) return undefined;
	const token = value.trim();
	if (!WINDOW_ID_PATTERN.test(token)) return undefined;
	try {
		return BigInt(token);
	} catch {
		return undefined;
	}
};

const MAC_TERMINAL_NAMES: Record<string, readonly string[]> = {
	alacritty: ["alacritty"],
	apple_terminal: ["terminal"],
	cursor: ["cursor"],
	ghostty: ["ghostty"],
	"iterm.app": ["iterm2", "iterm"],
	iterm2: ["iterm2", "iterm"],
	kitty: ["kitty"],
	vscode: ["code", "cursor", "windsurf", "vscodium", "code - insiders", "visual studio code"],
	warp: ["warp"],
	warpterminal: ["warp"],
	wezterm: ["wezterm"],
	zed: ["zed"],
};

const namesForTerminal = (termProgram: string | undefined) => {
	if (!termProgram) return undefined;
	return MAC_TERMINAL_NAMES[termProgram.toLowerCase()];
};

const inMultiplexer = (env: NodeJS.ProcessEnv) =>
	env["TMUX"] !== undefined || env["ZELLIJ"] !== undefined || env["STY"] !== undefined;

const parseProcessParents = (output: string) => {
	const parents = new Map<number, number>();
	for (const line of output.split(/\r?\n/)) {
		const match = line.trim().match(/^(\d+)\s+(\d+)$/);
		if (!match?.[1] || !match[2]) continue;
		parents.set(Number(match[1]), Number(match[2]));
	}
	return parents;
};

const processIncludes = (rootPid: number, targetPid: number, parents: Map<number, number>) => {
	const seen = new Set<number>();
	let current: number | undefined = rootPid;
	while (current !== undefined && current > 0 && !seen.has(current)) {
		if (current === targetPid) return true;
		seen.add(current);
		current = parents.get(current);
	}
	return false;
};

/** True when targetPid is this process or an ancestor. Undefined when ps cannot be read. */
const pidIsThisTerminal = async (
	dependencies: FocusDependencies,
	targetPid: number,
): Promise<boolean | undefined> => {
	const output = await dependencies.readCommand?.("ps", ["-ax", "-o", "pid=,ppid="]);
	if (!output) return undefined;
	const parents = parseProcessParents(output);
	if (parents.size === 0) return undefined;
	return processIncludes(dependencies.pid ?? process.pid, targetPid, parents);
};

const FRONTMOST_APPLICATION_SCRIPT = [
	'tell application "System Events"',
	"set frontProcess to first application process whose frontmost is true",
	'(unix id of frontProcess as text) & linefeed & (name of frontProcess)',
	"end tell",
].join("\n");

const probeMacFocus = async (dependencies: FocusDependencies): Promise<FocusState> => {
	const output = await dependencies.readCommand?.("osascript", ["-e", FRONTMOST_APPLICATION_SCRIPT]);
	if (!output?.trim()) return "unknown";

	const lines = output.split(/\r?\n/);
	const frontPid = Number(lines[0]?.trim());
	const frontName = lines.slice(1).join("\n").trim().toLowerCase();
	const pidOk = Number.isInteger(frontPid) && frontPid > 0;
	const names = namesForTerminal(dependencies.env["TERM_PROGRAM"]);
	const nameMatches = frontName.length > 0 && names?.some((name) => name === frontName) === true;

	if (pidOk) {
		const ancestor = await pidIsThisTerminal(dependencies, frontPid);
		if (ancestor === true) return "focused";
		if (nameMatches) return "focused";
		if (inMultiplexer(dependencies.env)) return "unknown";
		if (ancestor === false) return "unfocused";
		if (names !== undefined && frontName.length > 0) return "unfocused";
		return "unknown";
	}

	if (nameMatches) return "focused";
	if (inMultiplexer(dependencies.env)) return "unknown";
	if (names !== undefined && frontName.length > 0) return "unfocused";
	return "unknown";
};

const activeWindowId = (output: string | undefined) => {
	const token = output?.match(/window id #\s*(0x[0-9a-f]+|\d+)/i)?.[1];
	if (!token || !WINDOW_ID_PATTERN.test(token)) return undefined;
	return token;
};

const probeLinuxFocus = async (dependencies: FocusDependencies): Promise<FocusState> => {
	if (!dependencies.env["DISPLAY"]) return "unknown";

	const root = await dependencies.readCommand?.("xprop", ["-root", "_NET_ACTIVE_WINDOW"]);
	const activeToken = activeWindowId(root);
	const activeId = parseWindowId(activeToken);
	if (!activeToken || activeId === undefined) return "unknown";

	const ownToken = dependencies.env["WINDOWID"];
	if (ownToken) {
		const ownId = parseWindowId(ownToken);
		if (ownId === undefined) return "unknown";
		return activeId === ownId ? "focused" : "unfocused";
	}

	const pidOutput = await dependencies.readCommand?.("xprop", ["-id", activeToken, "_NET_WM_PID"]);
	const windowPid = Number(pidOutput?.match(/_NET_WM_PID(?:\([^)]*\))?\s*=\s*(\d+)/)?.[1]);
	if (!Number.isInteger(windowPid) || windowPid <= 0) return "unknown";

	const ancestor = await pidIsThisTerminal(dependencies, windowPid);
	if (ancestor === true) return "focused";
	if (ancestor === false && !inMultiplexer(dependencies.env)) return "unfocused";
	return "unknown";
};

export const probeFallbackFocus = async (dependencies: FocusDependencies): Promise<FocusState> => {
	if (!dependencies.readCommand) return "unknown";

	try {
		if (dependencies.platform === "linux") return await probeLinuxFocus(dependencies);
		if (dependencies.platform === "darwin") return await probeMacFocus(dependencies);
	} catch (error) {
		if (process.env["PI_NUDGE_DEBUG"] === "1") console.error("[pi-nudge] focus probe failed:", error);
		return "unknown";
	}

	return "unknown";
};
