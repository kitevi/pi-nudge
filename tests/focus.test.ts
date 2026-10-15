import { assert, describe, it } from "vitest";
import { consumeFocusReports, createFocusReportReader, probeFallbackFocus } from "../src/focus.ts";

const ancestorPs = "10 1\n20 10\n30 20\n";

void describe("focus reports", () => {
	it("keeps a report split across stdin chunks and lets the last report win", () => {
		const read = createFocusReportReader();

		assert.strictEqual(read("\x1b"), undefined);
		assert.strictEqual(read("[I\x1b[O"), "unfocused");
		assert.strictEqual(read("plain"), undefined);
	});

	it("ignores focus bytes inside a bracketed paste, including a paste split across chunks", () => {
		const read = createFocusReportReader();

		assert.strictEqual(read("\x1b[200~hello\x1b[Iworld"), undefined);
		assert.strictEqual(read("\x1b[201~"), undefined);
		assert.strictEqual(read("\x1b[O"), "unfocused");
	});

	it("strips focus reports from editor input without eating a bracketed paste", () => {
		assert.deepStrictEqual(consumeFocusReports("\x1b[Oa"), {
			state: "unfocused",
			rest: "a",
			sawReport: true,
		});
		assert.deepStrictEqual(consumeFocusReports("\x1b[I\x1b[O"), {
			state: "unfocused",
			rest: "",
			sawReport: true,
		});

		const pasted = "\x1b[200~hello\x1b[Iworld\x1b[201~";
		assert.deepStrictEqual(consumeFocusReports(pasted), {
			state: "unknown",
			rest: pasted,
			sawReport: false,
		});
	});
});

void describe("focus probe", () => {
	it("treats a matching X11 window id as focused and a different one as unfocused", async () => {
		const readActive = async () => "window id # 0x600003\n";

		assert.strictEqual(
			await probeFallbackFocus({
				platform: "linux",
				env: { DISPLAY: ":0", WINDOWID: "6291459" },
				readCommand: readActive,
			}),
			"focused",
		);
		assert.strictEqual(
			await probeFallbackFocus({
				platform: "linux",
				env: { DISPLAY: ":0", WINDOWID: "6291459" },
				readCommand: async () => "window id # 0x700003\n",
			}),
			"unfocused",
		);
	});

	it("compares the active window pid when WINDOWID is unset and does not pass an unvalidated id to xprop", async () => {
		const calls: string[][] = [];
		const focused = await probeFallbackFocus({
			platform: "linux",
			pid: 30,
			env: { DISPLAY: ":0" },
			readCommand: async (command, args) => {
				calls.push([command, ...args]);
				if (args[0] === "-root") return "window id # 0x1000001\n";
				if (args[0] === "-id") return "_NET_WM_PID(CARDINAL) = 10\n";
				if (command === "ps") return ancestorPs;
				return undefined;
			},
		});

		assert.strictEqual(focused, "focused");
		assert.deepStrictEqual(calls[1], ["xprop", "-id", "0x1000001", "_NET_WM_PID"]);

		const rejected: string[][] = [];
		const unknown = await probeFallbackFocus({
			platform: "linux",
			env: { DISPLAY: ":0" },
			readCommand: async (command, args) => {
				rejected.push([command, ...args]);
				if (args[0] === "-root") return "window id # $(reboot)\n";
				return "should-not-be-called";
			},
		});

		assert.strictEqual(unknown, "unknown");
		assert.deepStrictEqual(rejected, [["xprop", "-root", "_NET_ACTIVE_WINDOW"]]);
	});

	it("stays unknown inside a multiplexer when the active window pid is not an ancestor", async () => {
		assert.strictEqual(
			await probeFallbackFocus({
				platform: "linux",
				pid: 30,
				env: { DISPLAY: ":0", TMUX: "/tmp/tmux" },
				readCommand: async (command, args) => {
					if (args[0] === "-root") return "window id # 0x1000001\n";
					if (args[0] === "-id") return "_NET_WM_PID(CARDINAL) = 99\n";
					if (command === "ps") return "30 1\n";
					return undefined;
				},
			}),
			"unknown",
		);
	});

	it("treats a frontmost ancestor as focused even when the app name is not in the terminal map", async () => {
		assert.strictEqual(
			await probeFallbackFocus({
				platform: "darwin",
				pid: 30,
				env: { TERM_PROGRAM: "alacritty" },
				readCommand: async (command) => {
					if (command === "osascript") return "10\nNotATerminal\n";
					if (command === "ps") return ancestorPs;
					return undefined;
				},
			}),
			"focused",
		);
	});

	it("treats Cursor as focused when its pid is an ancestor or its name matches vscode", async () => {
		const cursor = async (ps: string | undefined) =>
			probeFallbackFocus({
				platform: "darwin",
				pid: 30,
				env: { TERM_PROGRAM: "vscode" },
				readCommand: async (command) => {
					if (command === "osascript") return "10\nCursor\n";
					if (command === "ps") return ps;
					return undefined;
				},
			});

		assert.strictEqual(await cursor(ancestorPs), "focused");
		assert.strictEqual(await cursor("30 1\n"), "focused");
	});

	it("reports another macOS app as unfocused and stays unknown in a multiplexer", async () => {
		const probe = (env: NodeJS.ProcessEnv) =>
			probeFallbackFocus({
				platform: "darwin",
				pid: 30,
				env,
				readCommand: async (command) => {
					if (command === "osascript") return "99\nSafari\n";
					if (command === "ps") return "30 1\n";
					return undefined;
				},
			});

		assert.strictEqual(await probe({ TERM_PROGRAM: "ghostty" }), "unfocused");
		assert.strictEqual(await probe({ TERM_PROGRAM: "ghostty", TMUX: "/tmp/tmux" }), "unknown");
	});
});
