/** Line evidence and mutation mappings for one literal replacement. */
import { replaceExactText } from './exactTextReplacement.js';
import type { AppliedModelPatch } from './patchApplier.js';

function newlineCount(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index++) if (text[index] === '\n') count++;
  return count;
}

export function prepareExactTextEdit(source: string, oldText: string, newText: string): AppliedModelPatch {
  const replacement = replaceExactText(source, oldText, newText);
  const { start, end, content } = replacement;
  const suffixLength = source.length - end;
  const inserted = content.slice(start, content.length - suffixLength);
  const oldStart = 1 + newlineCount(source.slice(0, start));
  let readEnd = oldStart + newlineCount(source.slice(start, end - 1));
  // Removing a line boundary joins its suffix into an authored line. The suffix
  // must be observed too; retaining a terminal newline leaves that next line untouched.
  if (suffixLength > 0 && source[end - 1] === '\n' && !inserted.endsWith('\n')) readEnd++;
  // EOF may contain a final empty line. Include it in the mapping, without
  // demanding read credit for nonexistent source characters.
  const oldEnd = end === source.length ? 1 + newlineCount(source) : readEnd;
  const newEnd = oldEnd + newlineCount(content) - newlineCount(source);
  return {
    success: true,
    content,
    hunkCount: 1,
    readRanges: [{ start: oldStart, end: readEnd }],
    editRanges: [{ oldStart, oldEnd, newStart: oldStart, newEnd }],
  };
}
