/**
 * Notification delivery for pi-nudge.
 *
 * Delegates to node-notifier, so delivery is native per platform —
 * Notification Center on macOS, toasts on Windows, notify-send on Linux,
 * Growl as a fallback — with no dependency on terminal-emulator protocols
 * (no OSC 777/99 escape sequences).
 */
import notifier from "node-notifier";

export type SendNotification = (title: string, message: string) => void;

const debug = process.env["PI_NUDGE_DEBUG"] === "1";

/** Strips control characters and `;` so fields are safe as spawned-process arguments. */
export const sanitizeNotificationField = (value: string) =>
	value
		.replace(/[\x00-\x1f\x7f;]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 200);

export const createNodeNotifierSender = (): SendNotification => {
	return (rawTitle, rawMessage) => {
		const title = sanitizeNotificationField(rawTitle);
		const message = sanitizeNotificationField(rawMessage);
		try {
			notifier.notify({ title, message }, (error) => {
				if (error && debug) console.error("[pi-nudge] notification failed:", error);
			});
		} catch (error) {
			if (debug) console.error("[pi-nudge] notification failed:", error);
		}
	};
};
