/**
 * Focus detection for pi-nudge.
 *
 * Prefers CSI mode 1004 focus reports when the terminal supports them and
 * falls back to conservative best-effort OS probes: the X11 active window on
 * Linux, the frontmost application on macOS. Never guesses — returns
 * "unknown" when nothing reliable is available.
 */
export type FocusState = "unknown" | "focused" | "unfocused";

export const ENABLE_FOCUS_REPORTING = "\x1b[?1004h";
export const DISABLE_FOCUS_REPORTING = "\x1b[?1004l";

export type FocusDependencies = {
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	readCommand?: (command: string, args: string[]) => Promise<string | undefined>;
};

/**
 * Removes focus reports from terminal input. The last report wins when a
 * chunk carries several.
 */
export const consumeFocusReports = (data: string): { state: FocusState; rest: string; sawReport: boolean } => {
	let state: FocusState = "unknown";
	let sawReport = false;
	const rest = data.replace(/\x1b\[([IO])/g, (_report, marker: string) => {
		state = marker === "I" ? "focused" : "unfocused";
		sawReport = true;
		return "";
	});
	return { state, rest, sawReport };
};

const parseWindowId = (value: string | undefined) => {
	if (!value) return undefined;
	const match = value.trim().match(/^(?:0x[0-9a-f]+|\d+)$/i);
	if (!match) return undefined;
	try {
		return BigInt(match[0]);
	} catch {
		return undefined;
	}
};

const MAC_TERMINAL_APPLICATIONS: Record<string, string> = {
	apple_terminal: "terminal",
	ghostty: "ghostty",
	"iterm.app": "iterm2",
	kitty: "kitty",
	vscode: "code",
	wezterm: "wezterm",
};

export const probeFallbackFocus = async (dependencies: FocusDependencies): Promise<FocusState> => {
	if (!dependencies.readCommand) return "unknown";

	try {
		if (dependencies.platform === "linux" && dependencies.env["DISPLAY"] && dependencies.env["WINDOWID"]) {
			const output = await dependencies.readCommand("xprop", ["-root", "_NET_ACTIVE_WINDOW"]);
			const active = output?.match(/window id #\s*(0x[0-9a-f]+|\d+)/i)?.[1];
			const activeId = parseWindowId(active);
			const ownId = parseWindowId(dependencies.env["WINDOWID"]);
			if (activeId === undefined || ownId === undefined) return "unknown";
			return activeId === ownId ? "focused" : "unfocused";
		}

		if (dependencies.platform === "darwin") {
			const terminal = MAC_TERMINAL_APPLICATIONS[(dependencies.env["TERM_PROGRAM"] ?? "").toLowerCase()];
			if (!terminal) return "unknown";
			const output = await dependencies.readCommand("osascript", [
				"-e",
				'tell application "System Events" to get name of first application process whose frontmost is true',
			]);
			if (!output?.trim()) return "unknown";
			return output.trim().toLowerCase() === terminal ? "focused" : "unfocused";
		}
	} catch {
		return "unknown";
	}

	return "unknown";
};
