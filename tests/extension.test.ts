import { assert, describe, it, vi } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	TerminalInputHandler,
} from "@earendil-works/pi-coding-agent";
import { createPiNudgeExtension, readProbeCommand, type PiNudgeDependencies } from "../src/extension.ts";
import { createNotificationSender, sanitizeNotificationField } from "../src/notify.ts";

const { notifyMock } = vi.hoisted(() => ({ notifyMock: vi.fn() }));

vi.mock("node-notifier", () => ({
	default: { notify: notifyMock },
}));

type ExtensionHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type ScheduledTimer = { fn: () => void; delayMs: number; cancelled: boolean };

const ENABLE_FOCUS_REPORTING = "\x1b[?1004h";
const DISABLE_FOCUS_REPORTING = "\x1b[?1004l";
const waiting = (message = "pi-nudge is ready for input.") => ({
	title: "Pi is waiting for you",
	message,
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const createHarness = (overrides: Partial<PiNudgeDependencies> = {}) => {
	const lifecycle = new Map<string, ExtensionHandler>();
	const writes: string[] = [];
	const notifications: Array<{ title: string; message: string }> = [];
	let terminalInput: TerminalInputHandler | undefined;
	let stdinHandler: ((chunk: string) => void) | undefined;
	let stdinSubscriptions = 0;
	const scheduled: ScheduledTimer[] = [];
	const { subscribeStdin: subscribeOverride, ...restOverrides } = overrides;

	const pi = {
		on(event: string, handler: ExtensionHandler) {
			lifecycle.set(event, handler);
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		mode: "tui",
		cwd: "/tmp/pi-nudge",
		ui: {
			onTerminalInput(handler: TerminalInputHandler) {
				terminalInput = handler;
				return () => {
					terminalInput = undefined;
				};
			},
		},
		isIdle: () => true,
	} as unknown as ExtensionContext;

	createPiNudgeExtension({
		platform: "linux",
		env: { TERM: "xterm-256color" },
		pid: 30,
		writeTerminal: (data) => writes.push(data),
		readCommand: async () => undefined,
		sendNotification: (title, message) => notifications.push({ title, message }),
		setTimer: (fn: () => void, delayMs: number) => {
			const timer: ScheduledTimer = { fn, delayMs, cancelled: false };
			scheduled.push(timer);
			return timer;
		},
		clearTimer: (handle: unknown) => {
			(handle as ScheduledTimer).cancelled = true;
		},
		...restOverrides,
		subscribeStdin:
			subscribeOverride ??
			((handler) => {
				stdinSubscriptions += 1;
				stdinHandler = handler;
				return () => {
					stdinHandler = undefined;
				};
			}),
	})(pi);

	return {
		ctx,
		writes,
		notifications,
		stdinSubscriptions: () => stdinSubscriptions,
		pendingNudges: () => scheduled.filter((timer) => !timer.cancelled).length,
		flushTimers: async () => {
			for (const timer of scheduled.splice(0)) {
				if (!timer.cancelled) timer.fn();
			}
			// Drain focus-fallback promises chained off the timer callbacks.
			await tick();
		},
		run: (event: string, data: unknown = { type: event }) => lifecycle.get(event)?.(data, ctx),
		input: (data: string) => {
			assert.ok(terminalInput, "session_start must install a terminal input listener");
			return terminalInput(data);
		},
		stdin: (data: string) => {
			assert.ok(stdinHandler, "session_start must subscribe to stdin");
			stdinHandler(data);
		},
	};
};

void describe("pi-nudge", () => {
	it("notifies when pi settles while the terminal is unfocused", async () => {
		const harness = createHarness();

		harness.run("session_start");
		assert.deepStrictEqual(harness.writes, [ENABLE_FOCUS_REPORTING]);
		assert.deepStrictEqual(harness.input("\x1b[O"), { consume: true });

		harness.writes.length = 0;
		harness.run("agent_settled");

		// The waiting notification is debounced: nothing fires synchronously.
		assert.deepStrictEqual(harness.notifications, []);
		assert.strictEqual(harness.pendingNudges(), 1);

		await harness.flushTimers();

		assert.deepStrictEqual(harness.notifications, [waiting()]);
	});

	it("stays silent when a new agent run resumes before the settle debounce fires", async () => {
		const harness = createHarness();

		harness.run("session_start");
		harness.input("\x1b[O");

		harness.run("agent_settled");
		assert.strictEqual(harness.pendingNudges(), 1);

		// Auto-retry/continuation resumed the agent: the settle was transient.
		harness.run("agent_start");
		assert.strictEqual(harness.pendingNudges(), 0);

		await harness.flushTimers();
		assert.deepStrictEqual(harness.notifications, []);
	});

	it("keeps the waiting notification quiet while pi is focused", () => {
		const harness = createHarness();

		harness.run("session_start");
		assert.deepStrictEqual(harness.input("\x1b[I"), { consume: true });
		harness.run("agent_settled");

		assert.deepStrictEqual(harness.notifications, []);
		assert.strictEqual(harness.pendingNudges(), 0);
	});

	it("removes focus reports without swallowing adjacent terminal input", async () => {
		const harness = createHarness();

		harness.run("session_start");
		assert.deepStrictEqual(harness.input("\x1b[Oa"), { data: "a" });
		harness.run("agent_settled");
		await harness.flushTimers();

		assert.deepStrictEqual(harness.notifications, [waiting()]);
	});

	it("reads focus from stdin when the TUI consumes the report before the extension listener", async () => {
		const harness = createHarness();

		harness.run("session_start");
		harness.stdin("\x1b");
		harness.stdin("[O");
		harness.run("agent_settled");
		await harness.flushTimers();

		assert.deepStrictEqual(harness.notifications, [waiting()]);
	});

	it("schedules no nudge when stdin reports focus", () => {
		const harness = createHarness();

		harness.run("session_start");
		harness.stdin("\x1b[I");
		harness.run("agent_settled");

		assert.strictEqual(harness.pendingNudges(), 0);
		assert.deepStrictEqual(harness.notifications, []);
	});

	it("does not treat a focus report inside a bracketed paste as terminal focus", async () => {
		let reads = 0;
		const harness = createHarness({
			env: { TERM: "xterm-256color", DISPLAY: ":0", WINDOWID: "6291459" },
			readCommand: async () => {
				reads += 1;
				return "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x700003\n";
			},
		});

		harness.run("session_start");
		harness.stdin("\x1b[200~hello\x1b[Iworld\x1b[201~");
		harness.run("agent_settled");
		await harness.flushTimers();

		assert.strictEqual(reads, 1);
		assert.deepStrictEqual(harness.notifications, [waiting()]);
	});

	it("uses the X11 active window as a focus fallback when no terminal report arrived", async () => {
		const harness = createHarness({
			env: { TERM: "xterm-256color", DISPLAY: ":0", WINDOWID: "6291459" },
			readCommand: async () => "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x700003\n",
		});

		harness.run("session_start");
		harness.run("agent_settled");
		await harness.flushTimers();

		assert.deepStrictEqual(harness.notifications, [waiting()]);
	});

	it("stays quiet when the X11 active window is this terminal", async () => {
		const harness = createHarness({
			env: { TERM: "xterm-256color", DISPLAY: ":0", WINDOWID: "6291459" },
			readCommand: async () => "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x600003\n",
		});

		harness.run("session_start");
		harness.run("agent_settled");
		await harness.flushTimers();

		assert.deepStrictEqual(harness.notifications, []);
	});

	it("uses the frontmost macOS application as a focus fallback when no terminal report arrived", async () => {
		const reads: Array<{ command: string; args: string[] }> = [];
		const harness = createHarness({
			platform: "darwin",
			env: { TERM_PROGRAM: "ghostty" },
			readCommand: async (command, args) => {
				reads.push({ command, args });
				if (command === "osascript") return "99\nFinder\n";
				if (command === "ps") return "30 1\n";
				return undefined;
			},
		});

		harness.run("session_start");
		harness.run("agent_settled");
		await harness.flushTimers();

		assert.strictEqual(reads[0]?.command, "osascript");
		assert.match(reads[0]?.args[1] ?? "", /unix id/);
		assert.deepStrictEqual(harness.notifications, [waiting()]);
	});

	it("stays quiet when the frontmost macOS app is the terminal", async () => {
		const harness = createHarness({
			platform: "darwin",
			env: { TERM_PROGRAM: "ghostty" },
			readCommand: async (command) => {
				if (command === "osascript") return "99\nGhostty\n";
				if (command === "ps") return "30 1\n";
				return undefined;
			},
		});

		harness.run("session_start");
		harness.run("agent_settled");
		await harness.flushTimers();

		assert.deepStrictEqual(harness.notifications, []);
	});

	it("stays quiet when Cursor is an ancestor even though TERM_PROGRAM is vscode", async () => {
		const harness = createHarness({
			platform: "darwin",
			env: { TERM_PROGRAM: "vscode" },
			readCommand: async (command) => {
				if (command === "osascript") return "10\nCursor\n";
				if (command === "ps") return "10 1\n20 10\n30 20\n";
				return undefined;
			},
		});

		harness.run("session_start");
		harness.run("agent_settled");
		await harness.flushTimers();

		assert.deepStrictEqual(harness.notifications, []);
	});

	it("stays quiet inside a multiplexer when the frontmost pid is not an ancestor", async () => {
		const harness = createHarness({
			platform: "darwin",
			env: { TERM_PROGRAM: "ghostty", TMUX: "/tmp/tmux" },
			readCommand: async (command) => {
				if (command === "osascript") return "99\nSafari\n";
				if (command === "ps") return "30 1\n";
				return undefined;
			},
		});

		harness.run("session_start");
		harness.run("agent_settled");
		await harness.flushTimers();

		assert.deepStrictEqual(harness.notifications, []);
	});

	it("does not probe focus or notify outside TUI mode", async () => {
		let reads = 0;
		const harness = createHarness({
			env: { TERM: "xterm-256color", DISPLAY: ":0", WINDOWID: "6291459" },
			readCommand: async () => {
				reads += 1;
				return "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x700003\n";
			},
		});
		harness.ctx.mode = "rpc";

		harness.run("session_start");
		harness.run("agent_settled");
		await harness.flushTimers();

		assert.strictEqual(reads, 0);
		assert.strictEqual(harness.stdinSubscriptions(), 0);
		assert.deepStrictEqual(harness.writes, []);
		assert.deepStrictEqual(harness.notifications, []);
	});

	it("cancels a pending settle notification when the session shuts down", async () => {
		const harness = createHarness();

		harness.run("session_start");
		harness.run("agent_settled");
		assert.strictEqual(harness.pendingNudges(), 1);

		harness.run("session_shutdown", { type: "session_shutdown", reason: "reload" });
		assert.strictEqual(harness.pendingNudges(), 0);
		await harness.flushTimers();

		assert.deepStrictEqual(harness.notifications, []);
	});

	it("disables focus reporting only when the session quits", () => {
		const harness = createHarness();

		harness.run("session_start");
		harness.writes.length = 0;
		harness.run("session_shutdown", { type: "session_shutdown", reason: "reload" });

		assert.deepStrictEqual(harness.writes, []);
		assert.throws(() => harness.input("\x1b[O"), /session_start must install/);
		assert.throws(() => harness.stdin("\x1b[O"), /session_start must subscribe/);

		harness.run("session_start");
		assert.deepStrictEqual(harness.writes, [ENABLE_FOCUS_REPORTING]);
		harness.writes.length = 0;
		harness.run("session_shutdown", { type: "session_shutdown", reason: "quit" });

		assert.deepStrictEqual(harness.writes, [DISABLE_FOCUS_REPORTING]);
		assert.throws(() => harness.input("\x1b[O"), /session_start must install/);
	});

	it("says the run stopped when the settle was an abort", async () => {
		const harness = createHarness();

		harness.run("session_start");
		harness.input("\x1b[O");
		harness.run("agent_settled", { type: "agent_settled", aborted: true });
		await harness.flushTimers();

		assert.deepStrictEqual(harness.notifications, [waiting("pi-nudge stopped and is ready for input.")]);
	});

	it("nudges when a blocking prompt stays open while unfocused, and cancels if it closes", async () => {
		const harness = createHarness();

		harness.run("session_start");
		harness.input("\x1b[O");
		harness.run("ui_prompt_start", {
			type: "ui_prompt_start",
			reason: "ui_prompt",
			kind: "confirm",
			title: "Allow command?",
		});
		assert.strictEqual(harness.pendingNudges(), 1);

		harness.run("ui_prompt_end", { type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm" });
		assert.strictEqual(harness.pendingNudges(), 0);
		await harness.flushTimers();
		assert.deepStrictEqual(harness.notifications, []);

		harness.ctx.isIdle = () => false;
		harness.run("ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm" });
		await harness.flushTimers();

		assert.deepStrictEqual(harness.notifications, [
			{ title: "Pi needs you", message: "pi-nudge is waiting for a response." },
		]);
	});

	it("does not notify when the session ends during the focus probe", async () => {
		let release: (value: string | undefined) => void = () => {};
		const harness = createHarness({
			env: { TERM: "xterm-256color", DISPLAY: ":0", WINDOWID: "6291459" },
			readCommand: () =>
				new Promise((resolve) => {
					release = resolve;
				}),
		});

		harness.run("session_start");
		harness.run("agent_settled");
		await harness.flushTimers();
		harness.run("session_shutdown", { type: "session_shutdown", reason: "quit" });
		release("_NET_ACTIVE_WINDOW(WINDOW): window id # 0x700003\n");
		await tick();

		assert.deepStrictEqual(harness.notifications, []);
	});

	it("does not notify when the agent is busy again or the session context is stale", async () => {
		let release: (value: string | undefined) => void = () => {};
		const defer = () =>
			new Promise<string | undefined>((resolve) => {
				release = resolve;
			});
		const unfocused = "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x700003\n";
		const busy = createHarness({
			env: { TERM: "xterm-256color", DISPLAY: ":0", WINDOWID: "6291459" },
			readCommand: defer,
		});

		busy.run("session_start");
		busy.run("agent_settled");
		await busy.flushTimers();
		busy.run("agent_start");
		release(unfocused);
		await tick();
		assert.deepStrictEqual(busy.notifications, []);

		let throwIdle = false;
		const stale = createHarness({
			env: { TERM: "xterm-256color", DISPLAY: ":0", WINDOWID: "6291459" },
			readCommand: defer,
		});
		stale.ctx.isIdle = () => {
			if (throwIdle) throw new Error("stale");
			return true;
		};

		stale.run("session_start");
		stale.run("agent_settled");
		await stale.flushTimers();
		throwIdle = true;
		release(unfocused);
		await tick();

		assert.deepStrictEqual(stale.notifications, []);
	});

	it("delivers macOS notifications through the native osascript binary", () => {
		// node-notifier's vendored terminal-notifier.app is Intel-only; on macOS
		// delivery must go through osascript (native on every install) instead.
		const runs: Array<{ command: string; args: string[] }> = [];
		const send = createNotificationSender({
			platform: "darwin",
			runCommand: (command, args) => runs.push({ command, args }),
		});

		send('Pi "is" waiting\nfor you', "ready; for input");

		assert.strictEqual(runs.length, 1);
		assert.strictEqual(runs[0]?.command, "osascript");
		assert.strictEqual(
			runs[0]?.args[1],
			'display notification "ready for input" with title "Pi \\"is\\" waiting for you" sound name "default"',
		);
	});

	it("asks node-notifier to play a sound on other platforms", () => {
		notifyMock.mockClear();
		const send = createNotificationSender({ platform: "linux" });

		send("Pi is waiting for you", "pi-nudge is ready for input.");

		assert.strictEqual(notifyMock.mock.calls.length, 1);
		assert.deepStrictEqual(notifyMock.mock.calls[0]?.[0], {
			title: "Pi is waiting for you",
			message: "pi-nudge is ready for input.",
			sound: true,
		});
	});

	it("sanitizes control characters before notification delivery", () => {
		assert.strictEqual(sanitizeNotificationField("Pi;title\x1b]9;injected"), "Pi title ]9 injected");
		assert.strictEqual(sanitizeNotificationField("line one\nline two"), "line one line two");
	});

	it("logs focus probe command failures when PI_NUDGE_DEBUG=1", async () => {
		const previous = process.env["PI_NUDGE_DEBUG"];
		const logged: unknown[][] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => {
			logged.push(args);
		};
		try {
			delete process.env["PI_NUDGE_DEBUG"];
			assert.strictEqual(await readProbeCommand("pi-nudge-missing-binary", []), undefined);
			assert.deepStrictEqual(logged, []);

			process.env["PI_NUDGE_DEBUG"] = "1";
			assert.strictEqual(await readProbeCommand("pi-nudge-missing-binary", []), undefined);
			assert.ok(logged.some((args) => args.some((part) => String(part).includes("[pi-nudge] focus probe failed:"))));
		} finally {
			console.error = original;
			if (previous === undefined) delete process.env["PI_NUDGE_DEBUG"];
			else process.env["PI_NUDGE_DEBUG"] = previous;
		}
	});
});
