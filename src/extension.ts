/**
 * pi-nudge — native desktop notifications for the pi coding agent.
 *
 * Nudges you when the agent settles while your terminal is unfocused, so you
 * know pi is waiting for input without watching the terminal. Delivery is
 * delegated to node-notifier (see notify.ts); this file wires pi's session
 * events to focus tracking and the settle debounce.
 *
 * The agent_settled "waiting" notification is debounced: when a new agent
 * run starts within the delay (auto-retry, compaction retry, queued
 * follow-up), the settle was transient and no notification is sent.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import {
	consumeFocusReports,
	DISABLE_FOCUS_REPORTING,
	ENABLE_FOCUS_REPORTING,
	probeFallbackFocus,
	type FocusDependencies,
	type FocusState,
} from "./focus.ts";
import { createNodeNotifierSender, type SendNotification } from "./notify.ts";

const DEFAULT_SETTLE_NOTIFY_DELAY_MS = 10_000;

export type PiNudgeDependencies = FocusDependencies & {
	writeTerminal: (data: string) => void;
	sendNotification?: SendNotification;
	/** Delay before honoring agent_settled; a resumed run cancels the notification. */
	settleNotifyDelayMs?: number;
	setTimer?: (fn: () => void, delayMs: number) => unknown;
	clearTimer?: (handle: unknown) => void;
};

const runtimeDependencies: PiNudgeDependencies = {
	platform: process.platform,
	env: process.env,
	writeTerminal: (data) => process.stdout.write(data),
	readCommand: (command, args) =>
		new Promise((resolve) => {
			execFile(command, args, { encoding: "utf8", timeout: 1000 }, (error, stdout) => {
				resolve(error ? undefined : stdout);
			});
		}),
};

export const createPiNudgeExtension = (dependencies: PiNudgeDependencies) => {
	const notify = dependencies.sendNotification ?? createNodeNotifierSender();
	const settleDelayMs = dependencies.settleNotifyDelayMs ?? DEFAULT_SETTLE_NOTIFY_DELAY_MS;
	const setTimer = dependencies.setTimer ?? ((fn: () => void, delayMs: number) => setTimeout(fn, delayMs));
	const clearTimer =
		dependencies.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));

	return (pi: ExtensionAPI) => {
		let focus: FocusState = "unknown";
		let stopTerminalInput: (() => void) | undefined;
		let focusReportingEnabled = false;
		let tuiSessionActive = false;
		let settleTimer: unknown;
		let agentBusy = false;

		const cancelSettleNotification = () => {
			if (settleTimer === undefined) return;
			clearTimer(settleTimer);
			settleTimer = undefined;
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

		const stopFocusTracking = () => {
			stopTerminalInput?.();
			stopTerminalInput = undefined;
			if (focusReportingEnabled) writeTerminalSafely(DISABLE_FOCUS_REPORTING);
			focusReportingEnabled = false;
			tuiSessionActive = false;
			focus = "unknown";
		};

		pi.on("session_start", (_event, ctx) => {
			stopFocusTracking();
			agentBusy = false;
			cancelSettleNotification();
			if (ctx.mode !== "tui") return;
			tuiSessionActive = true;

			stopTerminalInput = ctx.ui.onTerminalInput((data) => {
				const { state, rest, sawReport } = consumeFocusReports(data);
				if (!sawReport) return undefined;
				focus = state;
				return rest.length === 0 ? { consume: true } : { data: rest };
			});
			focusReportingEnabled = writeTerminalSafely(ENABLE_FOCUS_REPORTING);
		});

		pi.on("agent_start", () => {
			// A run starting means any pending settle was transient (auto-retry,
			// compaction retry, queued follow-up); stay silent.
			agentBusy = true;
			cancelSettleNotification();
		});

		pi.on("agent_settled", (_event, ctx) => {
			agentBusy = false;
			cancelSettleNotification();
			if (!ctx.isIdle() || focus === "focused") return;
			const notifyWaiting = () =>
				notify("Pi is waiting for you", "The agent has finished and is ready for input.");
			// Debounce: only notify if the agent is still settled when the delay
			// elapses, re-checking busy/focus state at fire time.
			settleTimer = setTimer(() => {
				settleTimer = undefined;
				if (agentBusy || !ctx.isIdle() || focus === "focused") return;
				if (focus === "unfocused") {
					notifyWaiting();
					return;
				}
				void focusForAttention().then((current) => {
					if (current === "unfocused" && !agentBusy) notifyWaiting();
				});
			}, settleDelayMs);
		});

		pi.on("session_shutdown", () => {
			stopFocusTracking();
			agentBusy = false;
			cancelSettleNotification();
		});
	};
};

export default createPiNudgeExtension(runtimeDependencies);
