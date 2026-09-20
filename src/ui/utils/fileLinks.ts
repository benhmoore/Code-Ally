/**
 * Clickable file references for the conversation.
 *
 * Tool rows and diff headers show file names; when the terminal renders OSC 8
 * hyperlinks, those names open the file on click. The decision to emit links
 * combines the user's preference with terminal support.
 */

import path from 'node:path';
import { fileUrl, hyperlink, supportsHyperlinks } from '@utils/terminal.js';
import { resolvePath } from '@utils/pathUtils.js';

/** Whether file names and links should be emitted as OSC 8 hyperlinks. */
export function terminalHyperlinksEnabled(config?: { enable_terminal_hyperlinks?: boolean }): boolean {
  return config?.enable_terminal_hyperlinks !== false && supportsHyperlinks();
}

/** A label that opens `filePath` (absolute, ~-prefixed or workspace-relative) on click. */
export function fileHyperlink(label: string, filePath: string): string {
  return hyperlink(label, fileUrl(resolvePath(filePath)));
}

/**
 * Link the first occurrence of `filePath`'s base name inside `text`, leaving
 * the text unchanged when the name does not appear (for example after
 * truncation).
 */
export function linkFileNameIn(text: string, filePath: string): string {
  const name = path.basename(filePath);
  const start = name ? text.indexOf(name) : -1;
  if (start < 0) {
    return text;
  }
  return text.slice(0, start) + fileHyperlink(name, filePath) + text.slice(start + name.length);
}
