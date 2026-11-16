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
- Notifications name the current task from the latest meaningful raw input. A leading slash command is
  reduced to its arguments, so `/review concurrency` labels the tab `concurrency` rather than
  showing the expanded template. Labels are capped at 32 graphemes, lead the notification body,
  and also appear in pi's footer until you focus that tab, start the next run, or answer the
  prompt. Set `PI_NUDGE_LABEL=off` to keep request text out of notifications and the footer.
- The macOS fallback asks LaunchServices which application is frontmost, through `lsappinfo`.
  That sends no Apple Events, so it needs no automation permission.
- Delivery: the terminal posts the notification where it can (Kitty, iTerm2, Ghostty, WezTerm)
  and the operating system does everywhere else. See [Delivery](#delivery).

## Install

    pi install git:github.com/kitevi/pi-nudge

## Delivery

In Kitty, iTerm2, Ghostty and WezTerm pi-nudge writes an escape sequence and the terminal posts
the notification. That needs no helper program, uses the terminal's own notification permission,
and reaches your local terminal when pi runs over SSH. In Kitty and Ghostty, clicking the
notification brings that window back.

| Terminal | Sequence | Recognised by                                              |
| -------- | -------- | ---------------------------------------------------------- |
| Kitty    | OSC 99   | `TERM=xterm-kitty`                                         |
| Ghostty  | OSC 777  | `TERM=xterm-ghostty` or `TERM_PROGRAM=ghostty`             |
| WezTerm  | OSC 777  | `TERM_PROGRAM=WezTerm`                                     |
| iTerm2   | OSC 9    | `TERM_PROGRAM=iTerm.app`, or `LC_TERMINAL=iTerm2` over SSH |

iTerm2 only shows these once Settings → Profiles → Terminal → "Notification Center alerts" is on.
Ghostty shows at most one notification a second, so two pi sessions that settle in the same
second produce one.

Everywhere else the operating system delivers the notification, with the default sound:
`osascript` on macOS and [node-notifier](https://github.com/mikaelbr/node-notifier) elsewhere
(`notify-send` on Linux, toasts on Windows, Growl as a fallback). That covers other terminals,
Windows, and anything between pi and the terminal that would swallow the sequence: tmux, Zellij,
screen, and the built-in terminals of Neovim, Emacs and JetBrains IDEs.

Set `PI_NUDGE_DELIVERY` to `system`, `osc9`, `osc99` or `osc777` to choose yourself: `system`,
for example, when your terminal's notifications are turned off.

### tmux

tmux drops these sequences unless `allow-passthrough` is on, and with `on` it still drops them
from panes outside the visible window, so inside tmux pi-nudge stays with the operating system.
To get terminal notifications through tmux, for example over SSH, set both of these and pi-nudge
wraps the sequence in tmux's passthrough:

    set -g allow-passthrough all        # in ~/.tmux.conf
    export PI_NUDGE_DELIVERY=osc777     # the sequence your outer terminal takes

### macOS through osascript

These notifications are sent as Script Editor: they carry its name and icon and need its
notification permission. macOS may not ask for that permission when `osascript` runs from a
terminal; the command succeeds and nothing appears. If that happens, open Script Editor, run
`display notification "test"` once and allow notifications when asked, or turn Script Editor on
under System Settings → Notifications.

node-notifier's bundled terminal-notifier is not used on macOS: it needs its own permission, and
a refused or interrupted request silently stops notifications.

## Develop

    npm install
    npm run typecheck
    npm test

Set `PI_NUDGE_DEBUG=1` to log focus-probe and notification delivery failures to stderr.
