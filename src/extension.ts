/**
 * pi-nudge — native desktop notifications for the pi coding agent.
 *
 * Nudges you when the agent settles, or a blocking prompt stays open, while
 * your terminal is unfocused. Delivery lives in notify.ts (osascript on macOS,
 * node-notifier elsewhere). Focus reports are read from stdin because pi's
 * fullscreen UI consumes CSI 1004 before extension listeners run; onTerminalInput
 * still strips reports so regular mode does not insert them into the editor.
 *
 * The nudge is debounced: a resumed run, or the prompt closing, within the
 * delay cancels it.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { basename } from "node:path";
import {
	consumeFocusReports,
	createFocusReportReader,
	DISABLE_FOCUS_REPORTING,
	ENABLE_FOCUS_REPORTING,
	probeFallbackFocus,
	type FocusDependencies,
	type FocusState,
} from "./focus.ts";
import { createNotificationSender, type SendNotification } from "./notify.ts";

const DEFAULT_SETTLE_NOTIFY_DELAY_MS = 10_000;
const FOCUS_PROBE_TIMEOUT_MS = 5_000;

export const readProbeCommand = (command: string, args: string[]) =>
	new Promise<string | undefined>((resolve) => {
		execFile(
			command,
			args,
			{ encoding: "utf8", timeout: FOCUS_PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
			(error, stdout) => {
				if (error) {
					if (process.env["PI_NUDGE_DEBUG"] === "1") console.error("[pi-nudge] focus probe failed:", error);
					resolve(undefined);
					return;
				}
				resolve(stdout);
			},
		);
	});

export type SubscribeStdin = (handler: (chunk: string) => void) => () => void;

const defaultSubscribeStdin: SubscribeStdin = (handler) => {
	const listener = (data: string | Buffer) => {
		handler(typeof data === "string" ? data : data.toString("utf8"));
	};
	process.stdin.on("data", listener);
	return () => {
		process.stdin.off("data", listener);
	};
};

export type PiNudgeDependencies = FocusDependencies & {
	writeTerminal: (data: string) => void;
	sendNotification?: SendNotification;
	/** Delay before honoring a settle or prompt; a resumed run cancels the notification. */
	settleNotifyDelayMs?: number;
	setTimer?: (fn: () => void, delayMs: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	/** Observes raw stdin so focus reports are seen even when the TUI consumes them. */
	subscribeStdin?: SubscribeStdin;
};

const runtimeDependencies: PiNudgeDependencies = {
	platform: process.platform,
	env: process.env,
	pid: process.pid,
	writeTerminal: (data) => process.stdout.write(data),
	readCommand: readProbeCommand,
	subscribeStdin: defaultSubscribeStdin,
};

type NudgeKind = "settle" | "prompt";

type PendingNudge = {
	kind: NudgeKind;
	title: string;
	message: string;
};

const projectLabel = (cwd: string) => basename(cwd) || "pi";

export const createPiNudgeExtension = (dependencies: PiNudgeDependencies) => {
	const notify =
		dependencies.sendNotification ?? createNotificationSender({ platform: dependencies.platform });
	const settleDelayMs = dependencies.settleNotifyDelayMs ?? DEFAULT_SETTLE_NOTIFY_DELAY_MS;
	const setTimer = dependencies.setTimer ?? ((fn: () => void, delayMs: number) => setTimeout(fn, delayMs));
	const clearTimer =
		dependencies.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
	const subscribeStdin = dependencies.subscribeStdin ?? defaultSubscribeStdin;

	return (pi: ExtensionAPI) => {
		let focus: FocusState = "unknown";
		let stopTerminalInput: (() => void) | undefined;
		let stopStdin: (() => void) | undefined;
		let readFocusReports = createFocusReportReader();
		let focusReportingEnabled = false;
		let tuiSessionActive = false;
		let nudgeTimer: unknown;
		let nudgeGeneration = 0;
		let pending: PendingNudge | undefined;
		let agentBusy = false;
		let promptWaiting = false;

		const idleNow = (ctx: ExtensionContext) => {
			try {
				return ctx.isIdle();
			} catch {
				return false;
			}
		};

		const cancelNudge = () => {
			nudgeGeneration += 1;
			pending = undefined;
			if (nudgeTimer === undefined) return;
			clearTimer(nudgeTimer);
			nudgeTimer = undefined;
		};

		const focusForAttention = async (): Promise<FocusState> => {
			if (!tuiSessionActive) return "unknown";
			if (focus !== "unknown") return focus;
			const fallback = await probeFallbackFocus(dependencies);
			if (!tuiSessionActive) return "unknown";
			return focus === "unknown" ? fallback : focus;
		};

		const writeTerminalSafely = (data: string) => {
			try {
				dependencies.writeTerminal(data);
				return true;
			} catch {
				return false;
			}
		};

		const detachFocusListeners = () => {
			stopTerminalInput?.();
			stopTerminalInput = undefined;
			stopStdin?.();
			stopStdin = undefined;
		};

		const scheduleNudge = (nudge: PendingNudge, ctx: ExtensionContext) => {
			cancelNudge();
			if (!tuiSessionActive || focus === "focused") return;
			if (nudge.kind === "settle" && !idleNow(ctx)) return;
			if (nudge.kind === "prompt" && !promptWaiting) return;

			const generation = nudgeGeneration;
			pending = nudge;
			nudgeTimer = setTimer(() => {
				nudgeTimer = undefined;
				if (generation !== nudgeGeneration || !pending) return;
				const current = pending;
				pending = undefined;
				if (!tuiSessionActive || focus === "focused") return;
				if (current.kind === "prompt") {
					if (!promptWaiting) return;
				} else if (agentBusy || !idleNow(ctx)) {
					return;
				}
				if (focus === "unfocused") {
					notify(current.title, current.message);
					return;
				}
				void focusForAttention().then((state) => {
					if (generation !== nudgeGeneration || !tuiSessionActive || focus === "focused") return;
					if (state !== "unfocused") return;
					if (current.kind === "prompt") {
						if (!promptWaiting) return;
					} else if (agentBusy || !idleNow(ctx)) {
						return;
					}
					notify(current.title, current.message);
				});
			}, settleDelayMs);
		};

		pi.on("session_start", (_event, ctx) => {
			detachFocusListeners();
			tuiSessionActive = false;
			focus = "unknown";
			agentBusy = false;
			promptWaiting = false;
			cancelNudge();
			readFocusReports = createFocusReportReader();
			if (ctx.mode !== "tui") return;
			tuiSessionActive = true;

			stopTerminalInput = ctx.ui.onTerminalInput((data) => {
				const { state, rest, sawReport } = consumeFocusReports(data);
				if (!sawReport) return undefined;
				focus = state;
				return rest.length === 0 ? { consume: true } : { data: rest };
			});
			stopStdin = subscribeStdin((chunk) => {
				const state = readFocusReports(chunk);
				if (state) focus = state;
			});
			if (writeTerminalSafely(ENABLE_FOCUS_REPORTING)) focusReportingEnabled = true;
		});

		pi.on("agent_start", () => {
			// A run starting means any pending settle was transient (auto-retry,
			// compaction retry, queued follow-up); stay silent.
			agentBusy = true;
			cancelNudge();
		});

		pi.on("agent_settled", (event, ctx) => {
			agentBusy = false;
			const project = projectLabel(ctx.cwd);
			const message = event.aborted
				? `${project} stopped and is ready for input.`
				: `${project} is ready for input.`;
			scheduleNudge({ kind: "settle", title: "Pi is waiting for you", message }, ctx);
		});

		pi.on("ui_prompt_start", (event, ctx) => {
			promptWaiting = true;
			const title = event.title?.trim() ? event.title.trim() : "Pi needs you";
			scheduleNudge(
				{
					kind: "prompt",
					title,
					message: `${projectLabel(ctx.cwd)} is waiting for a response.`,
				},
				ctx,
			);
		});

		pi.on("ui_prompt_end", () => {
			promptWaiting = false;
			if (pending?.kind === "prompt") cancelNudge();
		});

		pi.on("session_shutdown", (event) => {
			detachFocusListeners();
			tuiSessionActive = false;
			focus = "unknown";
			agentBusy = false;
			promptWaiting = false;
			cancelNudge();
			// Fullscreen pi keeps 1004 on for mouse-selection cleanup across
			// session swaps. Disable only when the process is actually leaving
			// the terminal, so a regular-mode shell does not receive raw reports.
			if (event.reason === "quit" && focusReportingEnabled) {
				writeTerminalSafely(DISABLE_FOCUS_REPORTING);
				focusReportingEnabled = false;
			}
		});
	};
};

export default createPiNudgeExtension(runtimeDependencies);
