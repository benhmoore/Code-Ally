/**
 * Terminal utilities
 *
 * Provides functions for terminal control including:
 * - Setting window/tab titles
 * - Sending notifications/bells
 */

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

  // OSC 9;4;<state>;<percentage> ST
  // Using BEL (\x07) as string terminator for broader compatibility
  process.stdout.write(`\x1b]9;4;${code};${clampedPercent}\x07`);
}

/**
 * Clear terminal tab progress bar
 *
 * Removes the progress indicator from the terminal tab.
 */
export function clearTerminalProgress(): void {
  // OSC 9;4;0; ST - state 0 removes the progress indicator
  process.stdout.write('\x1b]9;4;0;\x07');
}
