/**
 * Notification delivery for pi-nudge.
 *
 * macOS goes through the system osascript binary instead of node-notifier:
 * node-notifier's vendored terminal-notifier.app is Intel-only, so it runs
 * under Rosetta — which macOS 28 removes. osascript is native on every macOS
 * install. Everywhere else delegates to node-notifier, so delivery stays
 * native per platform — toasts on Windows, notify-send on Linux, Growl as a
 * fallback — with no dependency on terminal-emulator protocols (no OSC
 * 777/99 escape sequences).
 */
import { execFile } from "node:child_process";
import notifier from "node-notifier";

export type SendNotification = (title: string, message: string) => void;

const debug = process.env["PI_NUDGE_DEBUG"] === "1";

const logFailure = (error: unknown) => {
	if (debug) console.error("[pi-nudge] notification failed:", error);
};

/** Strips control characters and `;` so fields are safe as spawned-process arguments. */
export const sanitizeNotificationField = (value: string) =>
	value
		.replace(/[\x00-\x1f\x7f;]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 200);

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
	/** Fire-and-forget runner for the macOS osascript path; injectable for tests. */
	runCommand?: (command: string, args: string[]) => void;
};

export const createNotificationSender = (dependencies: NotificationDependencies): SendNotification => {
	if (dependencies.platform === "darwin") {
		const run = dependencies.runCommand ?? defaultRunCommand;
		return (rawTitle, rawMessage) => {
			const title = sanitizeNotificationField(rawTitle);
			const message = sanitizeNotificationField(rawMessage);
			// JSON.stringify doubles as AppleScript string-literal quoting; the
			// sanitizer already removed the control characters it would escape.
			run("osascript", [
				"-e",
				`display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`,
			]);
		};
	}

	return (rawTitle, rawMessage) => {
		const title = sanitizeNotificationField(rawTitle);
		const message = sanitizeNotificationField(rawMessage);
		try {
			notifier.notify({ title, message }, (error) => {
				if (error) logFailure(error);
			});
		} catch (error) {
			logFailure(error);
		}
	};
};
