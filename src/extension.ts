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
 * delay cancels it. Notifications name the current task from the raw input and
 * mark the tab in pi's footer until the user returns.
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
const LABEL_MAX_GRAPHEMES = 32;
const LABEL_INPUT_LIMIT = 512;

const GENERIC_INPUTS =
	/^(?:hi|hello|hey|yo|ok(?:ay)?|yes|no|sure|continue|go on|keep going|proceed|next|do it|lgtm|retry|try again|again|thanks|thank you)[.!]?$/i;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const truncateLabel = (text: string) => {
	const graphemes = Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
	if (graphemes.length <= LABEL_MAX_GRAPHEMES) return text;
	const cut = graphemes.slice(0, LABEL_MAX_GRAPHEMES).join("");
	const lastSpace = cut.lastIndexOf(" ");
	const boundary = lastSpace >= LABEL_MAX_GRAPHEMES / 2 ? cut.slice(0, lastSpace) : cut;
	return `${boundary.trimEnd()}…`;
};

/** The latest request, reduced to a short task label for notifications and the footer. */
export const inputLabel = (raw: string) => {
	const sample = raw.slice(0, LABEL_INPUT_LIMIT).toWellFormed();
	const text = sample
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!text) return undefined;

	const command = text.match(/^\/([A-Za-z][\w:-]*)(?:\s+([\s\S]*))?$/);
	const commandName = command?.[1];
	const args = command?.[2]?.trim();
	const candidate = commandName ? (args && !GENERIC_INPUTS.test(args) ? args : commandName) : text;
	const clean = candidate.replace(/^[#>*\-\s]+/, "").trim();
	if (!clean || GENERIC_INPUTS.test(clean)) return undefined;
	return truncateLabel(clean);
};

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
	const labelSetting = dependencies.env["PI_NUDGE_LABEL"]?.toLowerCase();
	const labelsEnabled = labelSetting !== "off" && labelSetting !== "0" && labelSetting !== "false";

	return (pi: ExtensionAPI) => {
		let taskLabel: string | undefined;
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

		const setFooterLabel = (ctx: ExtensionContext, label: string | undefined) => {
			try {
				ctx.ui.setStatus("pi-nudge", label);
			} catch {
				// The footer is optional UI; the notification still carries the label.
			}
		};

		const deliver = (nudge: PendingNudge, ctx: ExtensionContext) => {
			const label = labelsEnabled ? taskLabel : undefined;
			if (label) setFooterLabel(ctx, label);
			notify(nudge.title, label ? `${label} · ${nudge.message}` : nudge.message);
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
					deliver(current, ctx);
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
					deliver(current, ctx);
				});
			}, settleDelayMs);
		};

		pi.on("input", (event) => {
			// input fires before prompt-template and skill expansion, so the label
			// names the task instead of the expanded template body.
			if (!labelsEnabled || event.source === "extension") return;
			const label = inputLabel(event.text);
			if (label) taskLabel = label;
		});

		pi.on("session_start", (_event, ctx) => {
			setFooterLabel(ctx, undefined);
			taskLabel = undefined;
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
				if (state === "focused") setFooterLabel(ctx, undefined);
				return rest.length === 0 ? { consume: true } : { data: rest };
			});
			stopStdin = subscribeStdin((chunk) => {
				const state = readFocusReports(chunk);
				if (!state) return;
				focus = state;
				if (state === "focused") setFooterLabel(ctx, undefined);
			});
			if (writeTerminalSafely(ENABLE_FOCUS_REPORTING)) focusReportingEnabled = true;
		});

		pi.on("agent_start", (_event, ctx) => {
			// A run starting means any pending settle was transient (auto-retry,
			// compaction retry, queued follow-up); stay silent.
			agentBusy = true;
			cancelNudge();
			setFooterLabel(ctx, undefined);
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

		pi.on("ui_prompt_end", (_event, ctx) => {
			promptWaiting = false;
			setFooterLabel(ctx, undefined);
			if (pending?.kind === "prompt") cancelNudge();
		});

		pi.on("session_shutdown", (event, ctx) => {
			setFooterLabel(ctx, undefined);
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
