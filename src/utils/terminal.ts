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
