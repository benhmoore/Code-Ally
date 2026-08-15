import { describe, expect, test } from 'vitest';
import {
  groupToolCallTimeline,
  isSummarizableContextToolCall,
  summarizeToolCallGroup,
} from '../toolCallSummaries.js';
import type { ToolCallTimelineItem } from '../toolCallSummaries.js';
import type { ToolCallTreeNode } from '@shared/index.js';

type MessageTimelineItem = {
  type: 'message';
  timestamp: number;
  label: string;
};

function createToolCall(
  id: string,
  toolName: string,
  overrides: Partial<ToolCallTreeNode> = {}
): ToolCallTreeNode {
  return {
    id,
    toolName,
    status: 'success',
    startTime: Number(id.replace(/\D/g, '')) || 1,
    endTime: (Number(id.replace(/\D/g, '')) || 1) + 5,
    arguments: {},
    ...overrides,
  };
}

function toolItem(toolCall: ToolCallTreeNode): ToolCallTimelineItem {
  return {
    type: 'toolCall',
    toolCall,
    timestamp: toolCall.startTime,
  };
}

function messageItem(timestamp: number, label: string = 'message'): MessageTimelineItem {
  return {
    type: 'message',
    timestamp,
    label,
  };
}

describe('toolCallSummaries', () => {
  describe('isSummarizableContextToolCall', () => {
    test('accepts successful read and discovery tools without visible children', () => {
      expect(isSummarizableContextToolCall(createToolCall('read-1', 'read'))).toBe(true);
      expect(isSummarizableContextToolCall(createToolCall('grep-1', 'grep'))).toBe(true);
      expect(isSummarizableContextToolCall(createToolCall('glob-1', 'glob'))).toBe(true);
      expect(isSummarizableContextToolCall(createToolCall('ls-1', 'ls'))).toBe(true);
      expect(isSummarizableContextToolCall(createToolCall('tree-1', 'tree'))).toBe(true);
    });

    test('rejects calls that need their normal tool rendering', () => {
      expect(isSummarizableContextToolCall(createToolCall('write-1', 'write'))).toBe(false);
      expect(isSummarizableContextToolCall(createToolCall('read-1', 'read', { status: 'error' }))).toBe(false);
      expect(isSummarizableContextToolCall(createToolCall('read-1', 'read', { visibleInChat: false }))).toBe(false);
      expect(isSummarizableContextToolCall(createToolCall('read-1', 'read', { isTransparent: true }))).toBe(false);
      expect(isSummarizableContextToolCall(createToolCall('read-1', 'read', { alwaysShowFullOutput: true }))).toBe(false);
      expect(isSummarizableContextToolCall(createToolCall('read-1', 'read', { isLinkedPlugin: true }))).toBe(false);
      expect(isSummarizableContextToolCall(createToolCall('read-1', 'read', { error: 'failed' }))).toBe(false);
      expect(isSummarizableContextToolCall(createToolCall('read-1', 'read', {
        diffPreview: {
          oldContent: 'a',
          newContent: 'b',
          filePath: 'file.ts',
          operationType: 'replace',
        },
      }))).toBe(false);
    });

    test('visible children prevent summarizing, hidden children do not', () => {
      const visibleChild = createToolCall('child-1', 'read');
      const hiddenChild = createToolCall('child-2', 'read', { visibleInChat: false });

      expect(isSummarizableContextToolCall(createToolCall('read-1', 'read', {
        children: [visibleChild],
      }))).toBe(false);
      expect(isSummarizableContextToolCall(createToolCall('read-2', 'read', {
        children: [hiddenChild],
      }))).toBe(true);
    });
  });

  describe('summarizeToolCallGroup', () => {
    test('builds a compact story from mixed context-gathering tools', () => {
      const summary = summarizeToolCallGroup([
        createToolCall('grep-1', 'grep', { arguments: { pattern: 'ToolCallDisplay' } }),
        createToolCall('grep-2', 'grep', { arguments: { pattern: 'ConversationView' } }),
        createToolCall('glob-3', 'glob', { arguments: { pattern: '**/*.tsx' } }),
        createToolCall('ls-4', 'ls', { arguments: { path: 'src/ui' } }),
        createToolCall('tree-5', 'tree', { arguments: { paths: ['src/ui', 'src/tools'] } }),
        createToolCall('read-6', 'read', {
          arguments: { file_paths: ['src/ui/components/ConversationView.tsx'] },
          result: { files_read: 3, total_lines: 42 } as any,
        }),
      ]);

      expect(summary.stats).toEqual({
        searchPatterns: 2,
        fileGlobs: 1,
        directoriesListed: 1,
        treesInspected: 2,
        filesRead: 3,
        linesRead: 42,
      });
      expect(summary.text).toBe(
        'Searched for 2 patterns, matched 1 glob, listed 1 directory, inspected 2 trees, read 3 files (42 lines).'
      );
      expect(summary.startTime).toBe(1);
      expect(summary.endTime).toBe(11);
    });

    test('falls back to arguments when result counts are absent', () => {
      const summary = summarizeToolCallGroup([
        createToolCall('read-1', 'read', {
          arguments: { file_paths: ['a.ts', 'b.ts'] },
        }),
      ]);

      expect(summary.stats.filesRead).toBe(2);
      expect(summary.text).toBe('Read 2 files.');
    });

    test('uses a single model-provided description as the primary summary', () => {
      const summary = summarizeToolCallGroup([
        createToolCall('read-1', 'read', {
          arguments: {
            description: 'Read conversation view grouping logic',
            file_paths: ['ConversationView.tsx'],
          },
          result: { files_read: 1, total_lines: 30 } as any,
        }),
      ]);

      expect(summary.descriptions).toEqual(['Read conversation view grouping logic']);
      expect(summary.text).toBe('Read conversation view grouping logic.');
    });

    test('uses multiple descriptions and keeps counts as a compact suffix', () => {
      const summary = summarizeToolCallGroup([
        createToolCall('grep-1', 'grep', {
          arguments: { description: 'Find tool timeline rendering', pattern: 'toolCall' },
        }),
        createToolCall('read-2', 'read', {
          arguments: {
            description: 'Read summary utility tests',
            file_paths: ['toolCallSummaries.test.ts'],
          },
          result: { files_read: 1, total_lines: 25 } as any,
        }),
      ]);

      expect(summary.descriptions).toEqual([
        'Find tool timeline rendering',
        'Read summary utility tests',
      ]);
      expect(summary.text).toBe(
        'Find tool timeline rendering; Read summary utility tests (searched for 1 pattern, read 1 file (25 lines)).'
      );
    });

    test('deduplicates repeated descriptions and caps verbose description lists', () => {
      const longDescription = `Read ${'very '.repeat(40)}long context`;
      const summary = summarizeToolCallGroup([
        createToolCall('grep-1', 'grep', {
          arguments: { description: 'Find context tools' },
        }),
        createToolCall('grep-2', 'grep', {
          arguments: { description: 'Find context tools' },
        }),
        createToolCall('read-3', 'read', {
          arguments: { description: 'Read summarizer implementation', file_paths: ['a.ts'] },
        }),
        createToolCall('read-4', 'read', {
          arguments: { description: 'Read conversation integration', file_paths: ['b.ts'] },
        }),
        createToolCall('read-5', 'read', {
          arguments: { description: longDescription, file_paths: ['c.ts'] },
        }),
      ]);

      expect(summary.descriptions).toHaveLength(4);
      expect(summary.descriptions[3]?.endsWith('...')).toBe(true);
      expect(summary.text).toBe(
        'Find context tools; Read summarizer implementation; Read conversation integration; and 1 more context step (searched for 2 patterns, read 3 files).'
      );
    });

    test('rejects empty groups', () => {
      expect(() => summarizeToolCallGroup([])).toThrow('Cannot summarize an empty tool call group');
    });
  });

  describe('groupToolCallTimeline', () => {
    test('groups consecutive context calls before a closing message', () => {
      const grouped = groupToolCallTimeline([
        toolItem(createToolCall('grep-1', 'grep')),
        toolItem(createToolCall('read-2', 'read', {
          result: { files_read: 1, total_lines: 10 } as any,
        })),
        messageItem(3, 'assistant'),
      ]);

      expect(grouped.pendingSummary).toBeUndefined();
      expect(grouped.items).toHaveLength(2);
      expect(grouped.items[0]?.type).toBe('toolCallSummary');
      if (grouped.items[0]?.type === 'toolCallSummary') {
        expect(grouped.items[0].summary.text).toBe('Searched for 1 pattern, read 1 file (10 lines).');
      }
      expect(grouped.items[1]).toEqual(messageItem(3, 'assistant'));
    });

    test('defers trailing context groups so Static output does not need rewriting', () => {
      const grouped = groupToolCallTimeline([
        messageItem(1, 'user'),
        toolItem(createToolCall('read-2', 'read', {
          arguments: { file_paths: ['a.ts'] },
        })),
        toolItem(createToolCall('read-3', 'read', {
          arguments: { file_paths: ['b.ts'] },
        })),
      ]);

      expect(grouped.items).toEqual([messageItem(1, 'user')]);
      expect(grouped.pendingSummary?.text).toBe('Read 2 files.');
    });

    test('keeps non-context calls and failures as rendering boundaries', () => {
      const write = createToolCall('write-2', 'write');
      const failedRead = createToolCall('read-4', 'read', { status: 'error' });
      const grouped = groupToolCallTimeline([
        toolItem(createToolCall('read-1', 'read')),
        toolItem(write),
        toolItem(createToolCall('read-3', 'read')),
        toolItem(failedRead),
      ]);

      expect(grouped.items.map(item => item.type)).toEqual([
        'toolCallSummary',
        'toolCall',
        'toolCallSummary',
        'toolCall',
      ]);
      expect(grouped.pendingSummary).toBeUndefined();
      expect(grouped.items[1]).toEqual(toolItem(write));
      expect(grouped.items[3]).toEqual(toolItem(failedRead));
    });

    test('can be disabled for full tool output mode', () => {
      const items = [
        toolItem(createToolCall('read-1', 'read')),
        toolItem(createToolCall('grep-2', 'grep')),
      ];

      const grouped = groupToolCallTimeline(items, { disabled: true });

      expect(grouped.items).toEqual(items);
      expect(grouped.pendingSummary).toBeUndefined();
    });
  });
});
