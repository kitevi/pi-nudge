import { assert, describe, it, vi } from "vitest";
import { createNotificationSender, detectTerminalProtocol } from "../src/notify.ts";

const { notifyMock } = vi.hoisted(() => ({ notifyMock: vi.fn() }));

vi.mock("node-notifier", () => ({
	default: { notify: notifyMock },
}));

const ST = "\x1b\\";
const TMUX = "/tmp/tmux-1000/default,1,0";

const createSender = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform = "linux") => {
	const writes: string[] = [];
	const runs: Array<{ command: string; args: string[] }> = [];
	notifyMock.mockClear();
	const send = createNotificationSender({
		platform,
		env,
		writeTerminal: (data) => writes.push(data),
		runCommand: (command, args) => runs.push({ command, args }),
	});
	return { send, writes, runs, toasts: () => notifyMock.mock.calls.length };
};

void describe("terminal detection", () => {
	it("names the sequence for terminals that post notifications themselves", () => {
		assert.strictEqual(detectTerminalProtocol({ TERM: "xterm-kitty" }), "osc99");
		assert.strictEqual(detectTerminalProtocol({ TERM: "xterm-ghostty" }), "osc777");
		assert.strictEqual(detectTerminalProtocol({ TERM: "xterm-256color", TERM_PROGRAM: "ghostty" }), "osc777");
		assert.strictEqual(detectTerminalProtocol({ TERM: "xterm-256color", TERM_PROGRAM: "WezTerm" }), "osc777");
		assert.strictEqual(detectTerminalProtocol({ TERM: "xterm-256color", TERM_PROGRAM: "iTerm.app" }), "osc9");
	});

	it("recognises iTerm2 over SSH by the LC_TERMINAL it forwards", () => {
		assert.strictEqual(detectTerminalProtocol({ TERM: "xterm-256color", LC_TERMINAL: "iTerm2" }), "osc9");
	});

	it("leaves other terminals to the operating system", () => {
		assert.strictEqual(detectTerminalProtocol({}), undefined);
		assert.strictEqual(detectTerminalProtocol({ TERM: "xterm-256color" }), undefined);
		assert.strictEqual(detectTerminalProtocol({ TERM: "alacritty" }), undefined);
		assert.strictEqual(
			detectTerminalProtocol({ TERM: "xterm-256color", TERM_PROGRAM: "Apple_Terminal" }),
			undefined,
		);
	});

	it("does not trust a terminal name inherited by a terminal started inside it", () => {
		// VS Code started from iTerm2 or Kitty keeps their variables but sets its own TERM_PROGRAM.
		assert.strictEqual(
			detectTerminalProtocol({
				TERM: "xterm-256color",
				TERM_PROGRAM: "vscode",
				LC_TERMINAL: "iTerm2",
				ITERM_SESSION_ID: "w0t0p0",
				KITTY_WINDOW_ID: "1",
			}),
			undefined,
		);
		assert.strictEqual(detectTerminalProtocol({ TERM: "xterm-256color", KITTY_WINDOW_ID: "1" }), undefined);
	});

	it("stays out of multiplexers and editor terminals, which swallow the sequence", () => {
		const ghostty = { TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty" };
		for (const layer of ["TMUX", "ZELLIJ", "STY", "NVIM", "INSIDE_EMACS", "TERMINAL_EMULATOR"]) {
			assert.strictEqual(detectTerminalProtocol({ ...ghostty, [layer]: "1" }), undefined, layer);
		}
	});
});

void describe("terminal delivery", () => {
	it("sends Ghostty and WezTerm an OSC 777 notification with title and body", () => {
		for (const env of [{ TERM: "xterm-ghostty" }, { TERM: "xterm-256color", TERM_PROGRAM: "WezTerm" }]) {
			const { send, writes, toasts } = createSender(env);

			send("Pi is waiting for you", "pi-nudge is ready for input.");

			assert.deepStrictEqual(writes, [
				`\x1b]777;notify;Pi is waiting for you;pi-nudge is ready for input.${ST}`,
			]);
			assert.strictEqual(toasts(), 0);
		}
	});

	it("sends Kitty an OSC 99 title chunk and body chunk under one id", () => {
		const { send, writes, toasts } = createSender({ TERM: "xterm-kitty" });

		send("Pi is waiting for you", "pi-nudge is ready for input.");

		const id = `pi-nudge-${process.pid}`;
		assert.deepStrictEqual(writes, [
			`\x1b]99;i=${id}:d=0;Pi is waiting for you${ST}\x1b]99;i=${id}:p=body;pi-nudge is ready for input.${ST}`,
		]);
		assert.strictEqual(toasts(), 0);
	});

	it("sends iTerm2 one OSC 9 text field instead of running osascript", () => {
		const { send, writes, runs } = createSender({ TERM: "xterm-256color", TERM_PROGRAM: "iTerm.app" }, "darwin");

		send("Pi needs you", "pi-nudge is waiting for a response.");

		assert.deepStrictEqual(writes, [`\x1b]9;Pi needs you — pi-nudge is waiting for a response.${ST}`]);
		assert.deepStrictEqual(runs, []);
	});

	it("keeps field text from ending or splitting the sequence", () => {
		const { send, writes } = createSender({ TERM: "xterm-ghostty" });

		// ESC \ and BEL end an OSC, as do the C1 controls U+009C and U+009D in some terminals.
		send("Allow; rm\x1b\\ -rf?\x07", "a\x9cb;c\x9d");

		assert.deepStrictEqual(writes, [`\x1b]777;notify;Allow rm \\ -rf?;a b c${ST}`]);
	});

	it("cuts Ghostty text to its byte limits without splitting a character", () => {
		const fields = (title: string, message: string) => {
			const { send, writes } = createSender({ TERM: "xterm-ghostty" });
			send(title, message);
			const [, sentTitle, sentMessage] = writes[0]?.match(/^\x1b\]777;notify;([^;]*);(.*)\x1b\\$/u) ?? [];
			return { title: sentTitle, message: sentMessage };
		};

		// 80 bytes of title and 320 of body against limits of 63 and 255.
		const long = fields("é".repeat(40), "😀".repeat(80));
		assert.strictEqual(long.title, `${"é".repeat(30)}…`);
		assert.strictEqual(long.message, `${"😀".repeat(63)}…`);
		assert.strictEqual(Buffer.byteLength(long.title ?? ""), 63);
		assert.strictEqual(Buffer.byteLength(long.message ?? ""), 255);

		// The family emoji is one grapheme of 25 bytes: it goes whole, not in part.
		const family = fields("Pi", `${"é".repeat(120)}👨‍👩‍👧‍👦`);
		assert.strictEqual(family.message, `${"é".repeat(120)}…`);

		const short = fields("Pi is waiting for you", "pi-nudge is ready for input.");
		assert.deepStrictEqual(short, { title: "Pi is waiting for you", message: "pi-nudge is ready for input." });
	});

	it("stays with the operating system inside tmux unless a sequence is chosen", () => {
		const { send, writes, toasts } = createSender({
			TERM: "tmux-256color",
			TERM_PROGRAM: "tmux",
			TMUX,
			GHOSTTY_RESOURCES_DIR: "/usr/share/ghostty",
		});

		send("Pi is waiting for you", "pi-nudge is ready for input.");

		assert.deepStrictEqual(writes, []);
		assert.strictEqual(toasts(), 1);
	});

	it("wraps a chosen sequence in tmux passthrough with every ESC doubled", () => {
		const ghostty = createSender({ TERM: "tmux-256color", TMUX, PI_NUDGE_DELIVERY: "osc777" });
		ghostty.send("Pi", "ready");
		assert.deepStrictEqual(ghostty.writes, [`\x1bPtmux;\x1b\x1b]777;notify;Pi;ready\x1b\x1b\\${ST}`]);
		assert.strictEqual(ghostty.toasts(), 0);

		// Kitty's two chunks are two sequences, so each gets its own wrapper.
		const kitty = createSender({ TERM: "tmux-256color", TMUX, PI_NUDGE_DELIVERY: "osc99" });
		kitty.send("Pi", "ready");
		const id = `pi-nudge-${process.pid}`;
		assert.deepStrictEqual(kitty.writes, [
			`\x1bPtmux;\x1b\x1b]99;i=${id}:d=0;Pi\x1b\x1b\\${ST}\x1bPtmux;\x1b\x1b]99;i=${id}:p=body;ready\x1b\x1b\\${ST}`,
		]);
	});

	it("lets PI_NUDGE_DELIVERY=system turn the terminal channel off", () => {
		const { send, writes, toasts } = createSender({ TERM: "xterm-ghostty", PI_NUDGE_DELIVERY: " System " });

		send("Pi", "ready");

		assert.deepStrictEqual(writes, []);
		assert.strictEqual(toasts(), 1);
	});

	it("ignores a PI_NUDGE_DELIVERY it does not know", () => {
		const { send, writes } = createSender({ TERM: "xterm-ghostty", PI_NUDGE_DELIVERY: "carrier-pigeon" });

		send("Pi", "ready");

		assert.deepStrictEqual(writes, [`\x1b]777;notify;Pi;ready${ST}`]);
	});

	it("keeps the Windows toast unless a sequence is chosen", () => {
		const automatic = createSender({ TERM_PROGRAM: "WezTerm" }, "win32");
		automatic.send("Pi", "ready");
		assert.deepStrictEqual(automatic.writes, []);
		assert.strictEqual(automatic.toasts(), 1);

		const chosen = createSender({ TERM_PROGRAM: "WezTerm", PI_NUDGE_DELIVERY: "osc777" }, "win32");
		chosen.send("Pi", "ready");
		assert.deepStrictEqual(chosen.writes, [`\x1b]777;notify;Pi;ready${ST}`]);
		assert.strictEqual(chosen.toasts(), 0);
	});

	it("uses osascript on macOS in a terminal without notifications of its own", () => {
		const { send, writes, runs } = createSender({ TERM: "xterm-256color", TERM_PROGRAM: "Apple_Terminal" }, "darwin");

		send("Pi", "ready");

		assert.deepStrictEqual(writes, []);
		assert.strictEqual(runs[0]?.command, "osascript");
	});

	it("stays with the operating system when it has no terminal to write to", () => {
		notifyMock.mockClear();
		const send = createNotificationSender({ platform: "linux", env: { TERM: "xterm-kitty" } });

		send("Pi", "ready");

		assert.strictEqual(notifyMock.mock.calls.length, 1);
	});

	it("does not throw when the terminal write fails", () => {
		const send = createNotificationSender({
			platform: "linux",
			env: { TERM: "xterm-kitty" },
			writeTerminal: () => {
				throw new Error("EPIPE");
			},
		});

		assert.doesNotThrow(() => send("Pi", "ready"));
	});
});
