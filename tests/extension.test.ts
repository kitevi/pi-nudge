import { assert, describe, it } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	TerminalInputHandler,
} from "@earendil-works/pi-coding-agent";
import { createPiNudgeExtension, type PiNudgeDependencies } from "../src/extension.ts";
import { sanitizeNotificationField } from "../src/notify.ts";

type ExtensionHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type ScheduledTimer = { fn: () => void; delayMs: number; cancelled: boolean };

const createHarness = (overrides: Partial<PiNudgeDependencies> = {}) => {
	const lifecycle = new Map<string, ExtensionHandler>();
	const writes: string[] = [];
	const notifications: Array<{ title: string; message: string }> = [];
	let terminalInput: TerminalInputHandler | undefined;
	const scheduled: ScheduledTimer[] = [];

	const pi = {
		on(event: string, handler: ExtensionHandler) {
			lifecycle.set(event, handler);
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		mode: "tui",
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
		...overrides,
	})(pi);

	return {
		ctx,
		writes,
		notifications,
		pendingSettleTimers: () => scheduled.filter((timer) => !timer.cancelled).length,
		flushTimers: async () => {
			for (const timer of scheduled.splice(0)) {
				if (!timer.cancelled) timer.fn();
			}
			// Drain focus-fallback promises chained off the timer callbacks.
			await new Promise((resolve) => setTimeout(resolve, 0));
		},
		run: (event: string, data: unknown = { type: event }) => lifecycle.get(event)?.(data, ctx),
		input: (data: string) => {
			assert.ok(terminalInput, "session_start must install a terminal input listener");
			return terminalInput(data);
		},
	};
};

void describe("pi-nudge", () => {
	it("notifies when pi settles while the terminal is unfocused", async () => {
		const harness = createHarness();

		harness.run("session_start");
		assert.ok(harness.writes.includes("\x1b[?1004h"), "focus reporting must be enabled");
		assert.deepStrictEqual(harness.input("\x1b[O"), { consume: true });

		harness.writes.length = 0;
		harness.run("agent_settled");

		// The waiting notification is debounced: nothing fires synchronously.
		assert.deepStrictEqual(harness.notifications, []);
		assert.strictEqual(harness.pendingSettleTimers(), 1);

		await harness.flushTimers();

		assert.deepStrictEqual(harness.notifications, [
			{ title: "Pi is waiting for you", message: "The agent has finished and is ready for input." },
		]);
	});

	it("stays silent when a new agent run resumes before the settle debounce fires", async () => {
		const harness = createHarness();

		harness.run("session_start");
		harness.input("\x1b[O");

		harness.run("agent_settled");
		assert.strictEqual(harness.pendingSettleTimers(), 1);

		// Auto-retry/continuation resumed the agent: the settle was transient.
		harness.run("agent_start");
		assert.strictEqual(harness.pendingSettleTimers(), 0);

		await harness.flushTimers();
		assert.deepStrictEqual(harness.notifications, []);
	});

	it("keeps the waiting notification quiet while pi is focused", () => {
		const harness = createHarness();

		harness.run("session_start");
		assert.deepStrictEqual(harness.input("\x1b[I"), { consume: true });
		harness.run("agent_settled");

		assert.deepStrictEqual(harness.notifications, []);
		assert.strictEqual(harness.pendingSettleTimers(), 0);
	});

	it("removes focus reports without swallowing adjacent terminal input", async () => {
		const harness = createHarness();

		harness.run("session_start");
		assert.deepStrictEqual(harness.input("\x1b[Oa"), { data: "a" });
		harness.run("agent_settled");
		await harness.flushTimers();

		assert.strictEqual(harness.notifications.length, 1);
	});

	it("uses the X11 active window as a focus fallback when no terminal report arrived", async () => {
		const harness = createHarness({
			env: { TERM: "xterm-256color", DISPLAY: ":0", WINDOWID: "6291459" },
			readCommand: async () => "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x700003\n",
		});

		harness.run("session_start");
		harness.run("agent_settled");
		await harness.flushTimers();

		assert.strictEqual(harness.notifications.length, 1);
	});

	it("uses the frontmost macOS application as a focus fallback when no terminal report arrived", async () => {
		const reads: Array<{ command: string; args: string[] }> = [];
		const harness = createHarness({
			platform: "darwin",
			env: { TERM_PROGRAM: "ghostty" },
			readCommand: async (command, args) => {
				reads.push({ command, args });
				return "Finder\n";
			},
		});

		harness.run("session_start");
		harness.run("agent_settled");
		await harness.flushTimers();

		assert.strictEqual(reads[0]?.command, "osascript");
		assert.strictEqual(harness.notifications.length, 1);
	});

	it("does not probe focus or notify outside TUI mode", async () => {
		let reads = 0;
		const harness = createHarness({
			env: { TERM: "xterm-256color", DISPLAY: ":0", WINDOWID: "6291459" },
			readCommand: async () => {
				reads++;
				return "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x700003\n";
			},
		});
		harness.ctx.mode = "rpc";

		harness.run("session_start");
		harness.run("agent_settled");
		await harness.flushTimers();

		assert.strictEqual(reads, 0);
		assert.deepStrictEqual(harness.notifications, []);
	});

	it("cancels a pending settle notification when the session shuts down", async () => {
		const harness = createHarness();

		harness.run("session_start");
		harness.run("agent_settled");
		assert.strictEqual(harness.pendingSettleTimers(), 1);

		harness.run("session_shutdown");
		assert.strictEqual(harness.pendingSettleTimers(), 0);
		await harness.flushTimers();

		assert.deepStrictEqual(harness.notifications, []);
	});

	it("disables focus reporting and releases listeners on session shutdown", () => {
		const harness = createHarness();

		harness.run("session_start");
		harness.writes.length = 0;
		harness.run("session_shutdown");

		assert.deepStrictEqual(harness.writes, ["\x1b[?1004l"]);
		assert.throws(() => harness.input("\x1b[O"), /session_start must install/);
	});

	it("sanitizes control characters before notification delivery", () => {
		assert.strictEqual(sanitizeNotificationField("Pi;title\x1b]9;injected"), "Pi title ]9 injected");
		assert.strictEqual(sanitizeNotificationField("line one\nline two"), "line one line two");
	});
});
