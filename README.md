# pi-nudge

Native desktop notifications for the [pi](https://github.com/earendil-works/pi-mono) coding agent.
Nudges you when the agent settles while your terminal is unfocused, so you know pi is waiting for
input without watching the terminal.

## How it works

- Tracks terminal focus with CSI mode 1004 focus reports. pi's fullscreen UI consumes those
  reports before extension listeners run, so this extension also watches raw stdin. Reports
  inside a bracketed paste are ignored. Until a report arrives, it falls back to the X11
  active window on Linux and the frontmost application on macOS, and stays quiet when that
  probe is inconclusive.
- Inside tmux, enable focus events (`set -g focus-events on`) so reports reach pi. Without
  them, a multiplexer session stays quiet rather than guessing.
- When the agent settles (`agent_settled`) and pi stays idle for 10 seconds while unfocused,
  sends one notification. The same delay applies while a blocking prompt stays open
  (`ui_prompt_start`). A run resuming within the delay (auto-retry, compaction retry, queued
  follow-up), or the prompt closing, cancels the pending nudge.
- The macOS fallback asks System Events which application is frontmost. The first probe can
  prompt for automation access.
- Delivery: `osascript` on macOS — node-notifier's bundled terminal-notifier is
  Intel-only and needs Rosetta, which macOS 28 removes — and
  [node-notifier](https://github.com/mikaelbr/node-notifier) elsewhere: toasts on Windows,
  `notify-send` on Linux, Growl as a fallback. Notifications use the default sound.
  No terminal-emulator dependency — no OSC escape sequences.

## Install

    pi install git:github.com/kitevi/pi-nudge

On macOS the first notification triggers the notification permission prompt, and notifications are
labeled with the system osascript sender (Script Editor).

## Develop

    npm install
    npm run typecheck
    npm test

Set `PI_NUDGE_DEBUG=1` to log focus-probe and notification delivery failures to stderr.
