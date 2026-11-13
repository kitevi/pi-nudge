/**
 * Notification delivery for pi-nudge.
 *
 * Two channels. In Kitty, iTerm2, Ghostty and WezTerm the nudge is an escape
 * sequence that asks the terminal to post the notification itself: no helper
 * binary, the terminal's own notification permission, and it reaches the local
 * terminal when pi runs over SSH. Everywhere else the operating system
 * delivers it: osascript on macOS, node-notifier elsewhere (toasts on Windows,
 * notify-send on Linux, Growl as a fallback).
 *
 * macOS goes through the system osascript binary instead of node-notifier.
 * node-notifier's bundled terminal-notifier 3 is universal, but it needs its
 * own notification permission: on macOS 27 its first request was refused
 * without a prompt, and killing it while the prompt is up leaves it denied
 * until changed in System Settings.
 */
import { execFile } from "node:child_process";
import notifier from "node-notifier";
import { inMultiplexer } from "./focus.ts";

export type SendNotification = (title: string, message: string) => void;

/** An escape sequence that asks the terminal emulator to post the notification. */
export type TerminalProtocol = "osc9" | "osc99" | "osc777";

type Delivery = TerminalProtocol | "system";

const DELIVERIES: readonly Delivery[] = ["system", "osc9", "osc99", "osc777"];

/** Neovim, Emacs and JetBrains IDEs set these for programs in their built-in terminals. */
const EMBEDDED_TERMINAL_VARIABLES = ["NVIM", "INSIDE_EMACS", "TERMINAL_EMULATOR"] as const;

/**
 * Ghostty keeps the first 63 bytes of a notification title and 255 of a body.
 * Cutting to the same sizes here ends the text on a whole character.
 */
const TITLE_BYTE_LIMIT = 63;
const BODY_BYTE_LIMIT = 255;

const STRING_TERMINATOR = "\x1b\\";
const ELLIPSIS = "…";

const debug = process.env["PI_NUDGE_DEBUG"] === "1";

const logFailure = (error: unknown) => {
	if (debug) console.error("[pi-nudge] notification failed:", error);
};

/**
 * Strips control characters and `;` so a field is safe as a spawned-process
 * argument and inside an escape sequence, where a control character would end
 * the sequence early and `;` separates OSC 777 fields.
 */
export const sanitizeNotificationField = (value: string) =>
	value
		.replace(/[\x00-\x1f\x7f-\x9f;]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 200);

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Cuts text to at most maxBytes of UTF-8 on a grapheme boundary, ending a cut with an ellipsis. */
const clampBytes = (text: string, maxBytes: number) => {
	if (Buffer.byteLength(text) <= maxBytes) return text;
	const budget = maxBytes - Buffer.byteLength(ELLIPSIS);
	let kept = "";
	for (const { segment } of graphemeSegmenter.segment(text)) {
		if (Buffer.byteLength(kept + segment) > budget) break;
		kept += segment;
	}
	return `${kept.trimEnd()}${ELLIPSIS}`;
};

/**
 * The sequence the terminal pi writes to understands, or undefined when that
 * is not certain. TERM is set by whichever terminal layer pi runs in directly,
 * while TERM_PROGRAM and LC_TERMINAL are inherited through layers that do not
 * set them. So a multiplexer or an editor's built-in terminal, which would
 * swallow the sequence, rules the channel out, as does a TERM_PROGRAM naming
 * any other terminal.
 */
export const detectTerminalProtocol = (env: NodeJS.ProcessEnv): TerminalProtocol | undefined => {
	if (inMultiplexer(env)) return undefined;
	if (EMBEDDED_TERMINAL_VARIABLES.some((name) => env[name] !== undefined)) return undefined;

	const term = env["TERM"];
	if (term === "xterm-kitty") return "osc99";
	if (term === "xterm-ghostty") return "osc777";

	switch (env["TERM_PROGRAM"]) {
		case "iTerm.app":
			return "osc9";
		case "ghostty":
		case "WezTerm":
			return "osc777";
		case undefined:
			// iTerm2 exports LC_TERMINAL so that SSH carries it to the remote host.
			return env["LC_TERMINAL"] === "iTerm2" ? "osc9" : undefined;
		default:
			return undefined;
	}
};

const chooseDelivery = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Delivery => {
	const requested = env["PI_NUDGE_DELIVERY"]?.trim().toLowerCase();
	const forced = DELIVERIES.find((delivery) => delivery === requested);
	if (forced) return forced;
	// Untested through the Windows console host, which sits between pi and the
	// terminal; the toast is known to work there.
	if (platform === "win32") return "system";
	return detectTerminalProtocol(env) ?? "system";
};

const terminalSequences = (protocol: TerminalProtocol, title: string, message: string): string[] => {
	switch (protocol) {
		case "osc9":
			// One text field. The sanitizer left no `;` in it, so it cannot read as
			// one of the ConEmu commands that share OSC 9.
			return [`\x1b]9;${clampBytes(`${title} — ${message}`, BODY_BYTE_LIMIT)}${STRING_TERMINATOR}`];
		case "osc99": {
			// The id joins the title chunk (d=0: more to come) to the body chunk,
			// and lets the next nudge from this pi replace the one still showing.
			const id = `pi-nudge-${process.pid}`;
			return [
				`\x1b]99;i=${id}:d=0;${title}${STRING_TERMINATOR}`,
				`\x1b]99;i=${id}:p=body;${message}${STRING_TERMINATOR}`,
			];
		}
		case "osc777":
			return [
				`\x1b]777;notify;${clampBytes(title, TITLE_BYTE_LIMIT)};${clampBytes(message, BODY_BYTE_LIMIT)}${STRING_TERMINATOR}`,
			];
	}
};

/** tmux hands a sequence to the outer terminal only inside this wrapper, with every ESC doubled. */
const wrapForTmux = (sequence: string) =>
	`\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}${STRING_TERMINATOR}`;

const defaultRunCommand = (command: string, args: string[]) => {
	try {
		execFile(command, args, (error) => {
			if (error) logFailure(error);
		});
	} catch (error) {
		logFailure(error);
	}
};

export type NotificationDependencies = {
	platform: NodeJS.Platform;
	/** Names the terminal and carries PI_NUDGE_DELIVERY. Without it delivery stays with the operating system. */
	env?: NodeJS.ProcessEnv;
	/** Writes an escape sequence to the terminal. Without it delivery stays with the operating system. */
	writeTerminal?: (data: string) => void;
	/** Fire-and-forget runner for the macOS osascript path; injectable for tests. */
	runCommand?: (command: string, args: string[]) => void;
};

const createSystemSender = (dependencies: NotificationDependencies): SendNotification => {
	if (dependencies.platform === "darwin") {
		const run = dependencies.runCommand ?? defaultRunCommand;
		return (rawTitle, rawMessage) => {
			const title = sanitizeNotificationField(rawTitle);
			const message = sanitizeNotificationField(rawMessage);
			// JSON.stringify doubles as AppleScript string-literal quoting; the
			// sanitizer already removed the control characters it would escape.
			run("osascript", [
				"-e",
				`display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "default"`,
			]);
		};
	}

	return (rawTitle, rawMessage) => {
		const title = sanitizeNotificationField(rawTitle);
		const message = sanitizeNotificationField(rawMessage);
		try {
			notifier.notify({ title, message, sound: true }, (error) => {
				if (error) logFailure(error);
			});
		} catch (error) {
			logFailure(error);
		}
	};
};

export const createNotificationSender = (dependencies: NotificationDependencies): SendNotification => {
	const env = dependencies.env ?? {};
	const write = dependencies.writeTerminal;
	const delivery = chooseDelivery(dependencies.platform, env);
	if (!write || delivery === "system") return createSystemSender(dependencies);

	const wrap = env["TMUX"] === undefined ? (sequence: string) => sequence : wrapForTmux;
	return (rawTitle, rawMessage) => {
		const title = sanitizeNotificationField(rawTitle);
		const message = sanitizeNotificationField(rawMessage);
		try {
			write(terminalSequences(delivery, title, message).map(wrap).join(""));
		} catch (error) {
			logFailure(error);
		}
	};
};
