/**
 * Terminal utilities
 *
 * Provides functions for terminal control including:
 * - Setting window/tab titles
 * - Sending notifications/bells
 * - Clickable hyperlinks (OSC 8)
 */

import { pathToFileURL } from 'node:url';

/** Closes any open OSC 8 hyperlink. */
export const HYPERLINK_CLOSE = '\x1b]8;;\x1b\\';

/**
 * Wrap text in an OSC 8 hyperlink so the terminal shows `text` and opens
 * `url` when it is clicked. Terminals without OSC 8 support ignore the
 * sequence and show the plain text.
 */
export function hyperlink(text: string, url: string): string {
  return `\x1b]8;;${url}\x1b\\${text}${HYPERLINK_CLOSE}`;
}

/** file:// URL for an absolute path, percent-encoded per RFC 8089. */
export function fileUrl(absolutePath: string): string {
  return pathToFileURL(absolutePath).href;
}

/**
 * Whether the terminal renders OSC 8 hyperlinks as clickable text.
 *
 * There is no capability query for OSC 8, so this is the same heuristic the
 * ecosystem uses: recognise emulators known to support it and assume nothing
 * about the rest. Unknown terminals get plain text, never a broken sequence.
 * FORCE_HYPERLINK=1 or =0 overrides the detection.
 */
export function supportsHyperlinks(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = process.stdout.isTTY === true
): boolean {
  // The conventional override for terminals the heuristic cannot see, such as
  // a supporting emulator reached through tmux or ssh.
  if (env.FORCE_HYPERLINK !== undefined && env.FORCE_HYPERLINK !== '') {
    return env.FORCE_HYPERLINK !== '0';
  }

  if (!isTTY || env.CI) {
    return false;
  }

  const program = env.TERM_PROGRAM ?? '';
  if (program === 'Apple_Terminal') {
    return false;
  }
  if (['iTerm.app', 'WezTerm', 'Hyper', 'vscode', 'ghostty'].includes(program)) {
    return true;
  }

  const term = env.TERM ?? '';
  if (/kitty|alacritty|wezterm|foot|ghostty/i.test(term)) {
    return true;
  }

  if (env.WT_SESSION || env.KONSOLE_VERSION || env.TERMINAL_EMULATOR === 'JetBrains-JediTerm') {
    return true;
  }

  const vte = Number.parseInt(env.VTE_VERSION ?? '', 10);
  return Number.isFinite(vte) && vte >= 5000;
}

/**
 * Set the terminal window/tab title
 *
 * Uses ANSI escape codes to set the title in most terminal emulators
 * (iTerm2, Terminal.app, VS Code terminal, etc.)
 *
 * @param title - The title to display in the terminal window/tab
 */
export function setTerminalTitle(title: string): void {
  if (!title || typeof title !== 'string') {
    return;
  }

  // Set process.title to a short identifier to prevent "(node)" suffix
  // Many terminals show: "window_title (process_name)"
  // By setting process.title to "ally", it shows as: "Session Title (ally)"
  process.title = 'ally';

  // ANSI escape sequence for setting terminal title
  // \x1b]0; = OSC 0 (set icon name and window title)
  // \x07 = BEL (bell character, terminates the sequence)
  process.stdout.write(`\x1b]0;${title}\x07`);
}

/**
 * Clear the terminal title (reset to default)
 */
export function clearTerminalTitle(): void {
  process.stdout.write('\x1b]0;\x07');
}

/**
 * Send a terminal bell
 *
 * Triggers a bell/badge when the terminal is unfocused.
 * Most terminals will show a badge or play a sound.
 */
export function sendTerminalNotification(): void {
  // Standard terminal bell - works across most terminals
  // Most terminals will only show notification/badge when unfocused
  process.stdout.write('\x07');
}

/**
 * Progress bar state for OSC 9;4 sequences
 */
export type ProgressState = 'normal' | 'error' | 'indeterminate' | 'warning';

let lastProgressPayload: string | null | undefined = undefined;

/**
 * Set terminal tab progress bar
 *
 * Uses OSC 9;4 escape sequence to display a progress bar in the terminal tab.
 * Supported by: iTerm2 3.6.6+, Windows Terminal, ConEmu, VTE/GNOME Terminal
 *
 * @param percentage - Progress percentage (0-100), ignored for indeterminate state
 * @param state - Progress state: 'normal', 'error', 'indeterminate', or 'warning'
 */
export function setTerminalProgress(
  percentage: number,
  state: ProgressState = 'normal'
): void {
  // Clamp percentage to valid range
  const clampedPercent = Math.max(0, Math.min(100, Math.round(percentage)));

  // State codes for OSC 9;4 (ConEmu/Windows Terminal standard)
  // 0 = hidden/clear (use clearTerminalProgress instead)
  // 1 = normal (green)
  // 2 = error (red)
  // 3 = indeterminate (animated, ignores percentage)
  // 4 = warning/paused (yellow)
  const stateCode: Record<ProgressState, number> = {
    normal: 1,
    error: 2,
    indeterminate: 3,
    warning: 4,
  };

  const code = stateCode[state];
  const payload = `${code}:${clampedPercent}`;
  if (lastProgressPayload === payload) {
    return;
  }

  if (!process.stdout.isTTY) {
    return;
  }

  // OSC 9;4;<state>;<percentage> ST
  // Using BEL (\x07) as string terminator for broader compatibility
  process.stdout.write(`\x1b]9;4;${code};${clampedPercent}\x07`);
  lastProgressPayload = payload;
}

/**
 * Clear terminal tab progress bar
 *
 * Removes the progress indicator from the terminal tab.
 */
export function clearTerminalProgress(): void {
  if (lastProgressPayload === null) {
    return;
  }

  if (!process.stdout.isTTY) {
    return;
  }

  // OSC 9;4;0; ST - state 0 removes the progress indicator
  process.stdout.write('\x1b]9;4;0;\x07');
  lastProgressPayload = null;
}
