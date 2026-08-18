import type { ToolCallTreeNode } from '@shared/index.js';

export interface ToolCallTimelineItem {
  type: 'toolCall';
  toolCall: ToolCallTreeNode;
  timestamp: number;
}

export interface ToolCallSummary {
  id: string;
  calls: ToolCallTreeNode[];
  text: string;
  descriptions: string[];
  startTime: number;
  endTime?: number;
  stats: ToolCallSummaryStats;
}

export interface ToolCallSummaryStats {
  searchPatterns: number;
  fileGlobs: number;
  directoriesListed: number;
  treesInspected: number;
  filesRead: number;
  linesRead: number;
}

export interface ToolCallSummaryTimelineItem {
  type: 'toolCallSummary';
  summary: ToolCallSummary;
  timestamp: number;
}

export interface GroupToolCallTimelineOptions {
  disabled?: boolean;
}

const SUMMARIZABLE_CONTEXT_TOOL_NAMES = new Set([
  'read',
  'grep',
  'glob',
  'ls',
  'tree',
]);
const MAX_DESCRIPTION_LENGTH = 120;
const MAX_DESCRIPTIONS_IN_SUMMARY = 3;

export function isSummarizableContextToolCall(toolCall: ToolCallTreeNode): boolean {
  return (
    toolCall.status === 'success' &&
    SUMMARIZABLE_CONTEXT_TOOL_NAMES.has(toolCall.toolName) &&
    toolCall.visibleInChat !== false &&
    !toolCall.isTransparent &&
    !toolCall.alwaysShowFullOutput &&
    !toolCall.isLinkedPlugin &&
    !toolCall.error &&
    !toolCall.diffPreview &&
    !hasVisibleChildren(toolCall)
  );
}

export function summarizeToolCallGroup(calls: ToolCallTreeNode[]): ToolCallSummary {
  if (calls.length === 0) {
    throw new Error('Cannot summarize an empty tool call group');
  }

  const stats = calls.reduce<ToolCallSummaryStats>(
    (acc, call) => {
      switch (call.toolName) {
        case 'read': {
          acc.filesRead += countReadFiles(call);
          acc.linesRead += numberFrom(call.result?.total_lines);
          break;
        }
        case 'grep':
          acc.searchPatterns += 1;
          break;
        case 'glob':
          acc.fileGlobs += 1;
          break;
        case 'ls':
          acc.directoriesListed += 1;
          break;
        case 'tree':
          acc.treesInspected += countTreePaths(call);
          break;
      }

      return acc;
    },
    {
      searchPatterns: 0,
      fileGlobs: 0,
      directoriesListed: 0,
      treesInspected: 0,
      filesRead: 0,
      linesRead: 0,
    }
  );

  const startTime = Math.min(...calls.map(call => call.startTime));
  const endTimes = calls
    .map(call => call.endTime)
    .filter((endTime): endTime is number => typeof endTime === 'number');
  const endTime = endTimes.length > 0 ? Math.max(...endTimes) : undefined;
  const first = calls[0]!;
  const last = calls[calls.length - 1]!;
  const descriptions = extractGroupDescriptions(calls);

  return {
    id: `tool-summary-${first.id}-${last.id}-${calls.length}`,
    calls,
    text: buildSummaryText(stats, descriptions, calls.length),
    descriptions,
    startTime,
    endTime,
    stats,
  };
}

/**
 * Collapse runs of context-gathering tool calls into single summary items.
 *
 * A trailing run is returned as `pendingSummary` rather than as an item: it can still
 * absorb further context calls, and callers render already-emitted items into
 * append-only output that cannot be rewritten.
 */
export function groupToolCallTimeline<TOther extends { type: string; timestamp: number }>(
  items: readonly (ToolCallTimelineItem | TOther)[],
  options: GroupToolCallTimelineOptions = {}
): {
  items: Array<ToolCallTimelineItem | ToolCallSummaryTimelineItem | TOther>;
  pendingSummary?: ToolCallSummary;
} {
  if (options.disabled) {
    return { items: [...items] };
  }

  const grouped: Array<ToolCallTimelineItem | ToolCallSummaryTimelineItem | TOther> = [];
  let pendingSummary: ToolCallSummary | undefined;
  let buffer: ToolCallTreeNode[] = [];

  const flushBuffer = (isTrailing: boolean): void => {
    if (buffer.length === 0) {
      return;
    }

    const summary = summarizeToolCallGroup(buffer);
    buffer = [];

    if (isTrailing) {
      pendingSummary = summary;
      return;
    }

    grouped.push({
      type: 'toolCallSummary',
      summary,
      timestamp: summary.startTime,
    });
  };

  for (const item of items) {
    if (isToolCallTimelineItem(item) && isSummarizableContextToolCall(item.toolCall)) {
      buffer.push(item.toolCall);
      continue;
    }

    flushBuffer(false);
    grouped.push(item);
  }

  flushBuffer(true);

  return { items: grouped, pendingSummary };
}

function isToolCallTimelineItem(item: { type: string }): item is ToolCallTimelineItem {
  return item.type === 'toolCall';
}

function hasVisibleChildren(toolCall: ToolCallTreeNode): boolean {
  return (toolCall.children ?? []).some(child => child.visibleInChat !== false);
}

function countReadFiles(call: ToolCallTreeNode): number {
  const resultCount = numberFrom(call.result?.files_read);
  if (resultCount > 0) {
    return resultCount;
  }

  const argCount = countValue(call.arguments?.file_path);
  return argCount > 0 ? argCount : 1;
}

function countTreePaths(call: ToolCallTreeNode): number {
  const argCount = countValue(call.arguments?.paths);
  return argCount > 0 ? argCount : 1;
}

function countValue(value: unknown): number {
  if (Array.isArray(value)) {
    return value.length;
  }

  return typeof value === 'string' && value.trim().length > 0 ? 1 : 0;
}

function numberFrom(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function extractGroupDescriptions(calls: ToolCallTreeNode[]): string[] {
  const descriptions: string[] = [];
  const seen = new Set<string>();

  for (const call of calls) {
    const description = extractDescription(call);
    if (!description) {
      continue;
    }

    const key = description.toLocaleLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    descriptions.push(description);
  }

  return descriptions;
}

function extractDescription(call: ToolCallTreeNode): string | null {
  const description = call.arguments?.description;
  if (typeof description !== 'string') {
    return null;
  }

  const normalized = description.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length <= MAX_DESCRIPTION_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_DESCRIPTION_LENGTH - 3).trimEnd()}...`;
}

function buildSummaryText(
  stats: ToolCallSummaryStats,
  descriptions: string[],
  callCount: number
): string {
  const countPhrase = buildCountPhrase(stats);

  if (descriptions.length > 0) {
    const descriptionText = formatDescriptionList(descriptions);
    if (callCount > 1 && countPhrase) {
      return `${stripTerminalPunctuation(descriptionText)} (${countPhrase}).`;
    }

    return ensureSentence(descriptionText);
  }

  const text = countPhrase || 'checked context';
  return ensureSentence(capitalize(text));
}

function formatDescriptionList(descriptions: string[]): string {
  const visibleDescriptions = descriptions.slice(0, MAX_DESCRIPTIONS_IN_SUMMARY);
  const remainingCount = descriptions.length - visibleDescriptions.length;
  const text = visibleDescriptions.join('; ');

  if (remainingCount === 0) {
    return text;
  }

  return `${text}; and ${pluralize(remainingCount, 'more context step')}`;
}

function buildCountPhrase(stats: ToolCallSummaryStats): string {
  const phrases: string[] = [];

  if (stats.searchPatterns > 0) {
    phrases.push(`searched for ${pluralize(stats.searchPatterns, 'pattern')}`);
  }

  if (stats.fileGlobs > 0) {
    phrases.push(`matched ${pluralize(stats.fileGlobs, 'glob')}`);
  }

  if (stats.directoriesListed > 0) {
    phrases.push(`listed ${pluralize(stats.directoriesListed, 'directory', 'directories')}`);
  }

  if (stats.treesInspected > 0) {
    phrases.push(`inspected ${pluralize(stats.treesInspected, 'tree')}`);
  }

  if (stats.filesRead > 0) {
    const lineSuffix = stats.linesRead > 0 ? ` (${pluralize(stats.linesRead, 'line')})` : '';
    phrases.push(`read ${pluralize(stats.filesRead, 'file')}${lineSuffix}`);
  }

  return phrases.join(', ');
}

function ensureSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function stripTerminalPunctuation(text: string): string {
  return text.trim().replace(/[.!?]+$/u, '');
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function pluralize(count: number, singular: string, plural: string = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
