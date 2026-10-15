# pi-nudge

Native desktop notifications for the [pi](https://github.com/earendil-works/pi-mono) coding agent.
Nudges you when the agent settles while your terminal is unfocused, so you know pi is waiting for
input without watching the terminal.

## How it works

- Tracks terminal focus with CSI mode 1004 focus reports where supported, falling back to
  best-effort OS probes (X11 active window on Linux, frontmost application on macOS).
- When the agent settles (`agent_settled`) and pi stays idle for 10 seconds while unfocused,
  sends one notification. A run resuming within the delay (auto-retry, compaction retry, queued
  follow-up) cancels the pending nudge.
- Delivery: `osascript` on macOS — node-notifier's bundled terminal-notifier is
  Intel-only and needs Rosetta, which macOS 28 removes — and
  [node-notifier](https://github.com/mikaelbr/node-notifier) elsewhere: toasts on Windows,
  `notify-send` on Linux, Growl as a fallback. No terminal-emulator dependency — no OSC escape
  sequences.

## Install

    pi install git:github.com/kitevi/pi-nudge

On macOS the first notification triggers the notification permission prompt, and notifications are
labeled with the system osascript sender (Script Editor).

## Develop

    npm install --no-package-lock
    npm run typecheck
    npm test

Dependencies float on `latest`; lockfiles are not committed.

Set `PI_NUDGE_DEBUG=1` to log notification delivery failures to stderr.
