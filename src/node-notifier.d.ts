/**
 * Minimal type declarations for node-notifier, which ships no types of its
 * own. Covers only the surface pi-nudge uses.
 */
declare module "node-notifier" {
	export interface NotificationOptions {
		title?: string;
		subtitle?: string;
		message?: string;
		sound?: boolean | string;
		icon?: string;
		contentImage?: string;
		open?: string;
		wait?: boolean;
		timeout?: number | false;
	}

	export type NotifyCallback = (
		error: Error | null,
		response?: string,
		metadata?: Record<string, string>,
	) => void;

	export interface Notifier {
		notify(options: NotificationOptions | string, callback?: NotifyCallback): void;
	}

	const notifier: Notifier;
	export default notifier;
}
