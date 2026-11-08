import React from 'react';
import { EventEmitter } from 'node:events';
import { Box, measureElement, render, type DOMElement } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallTreeNode } from '@shared/index.js';
import { ActiveContent } from '../ConversationView.js';
import { ToolCallDisplay } from '../ToolCallDisplay.js';

class Stdout extends EventEmitter {
  columns = 80;
  rows = 40;
  frames: string[] = [];
  write = (frame: string) => { this.frames.push(frame); return true; };
}
const mounted: Array<ReturnType<typeof render>> = [];
afterEach(() => mounted.splice(0).forEach(instance => instance.unmount()));
const plain = (frame: string) => frame.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const base = (status: ToolCallTreeNode['status']): ToolCallTreeNode => ({
  id: 'call', toolName: 'agent', arguments: { task_prompt: 'Inspect fixture' }, status, startTime: 1,
});
const notices = [{ id: 'compact', parentId: 'call', timestamp: 5, oldContextUsage: 40, threshold: 80 }];

describe('live tools use actual rendered heights', () => {
  const states = ['pending', 'validating', 'executing', 'error', 'cancelled', 'success'] as const;
  it.each(states.flatMap(status => [40, 80].map(columns => ({ status, columns }))))(
    'measures the same physical rows as the $status renderer at $columns columns', async ({ status, columns }) => {
      const stdout = new Stdout();
      stdout.columns = columns;
      const call = { ...base(status), expanded: true, endTime: status === 'success' ? 10 : undefined,
        toolUseCount: 2, error: status === 'error' ? 'Detailed fixture error '.repeat(5) : undefined,
        interjections: [{ message: 'direction: retain fixture API stability.\nContinue carefully.', timestamp: 2 }],
        acknowledgments: [{ message: 'acknowledged', timestamp: 3 }],
      };
      let expected: DOMElement | null = null;
      let actual: DOMElement | null = null;
      mounted.push(render(<Box flexDirection="column">
        <Box ref={node => { expected = node; }} paddingLeft={2} width={columns - 2}>
          <ToolCallDisplay toolCall={call} width={columns - 4} compactionNotices={notices}/>
        </Box>
        <Box ref={node => { actual = node; }}>
          <ActiveContent completedToolCalls={[]} runningToolCalls={[call]} width={columns - 2} compactionNotices={notices}/>
        </Box>
      </Box>, { stdout: stdout as unknown as NodeJS.WriteStream, debug: true, patchConsole: false, exitOnCtrlC: false }));
      await vi.waitFor(() => {
        expect(expected && actual).toBeTruthy();
        expect(measureElement(actual!).height).toBe(measureElement(expected!).height);
      });
      const frame = plain(stdout.frames.at(-1) ?? '');
      expect(frame).toContain('direction');
      expect(frame).toContain('acknowledged');
      expect(frame).toContain('Compacted');
      if (status === 'validating') expect(frame).not.toContain('Done (');
    });

  it.each(['output', 'diff', 'collapsed-error'] as const)('measures %s presentation without a second row projection', async kind => {
    const stdout = new Stdout();
    stdout.columns = 40;
    const call: ToolCallTreeNode = { ...base('success'), toolName: 'write', expanded: kind !== 'collapsed-error',
      output: kind === 'output' ? 'wrapped output '.repeat(5) : undefined,
      error: kind === 'collapsed-error' ? 'must remain collapsed' : undefined,
      diffPreview: kind === 'diff' ? { oldContent: 'before\n', newContent: 'after\n', filePath: 'fixture.txt' } : undefined,
    };
    let expected: DOMElement | null = null;
    let actual: DOMElement | null = null;
    mounted.push(render(<Box flexDirection="column">
      <Box ref={node => { expected = node; }} paddingLeft={2} width={38}>
        <ToolCallDisplay toolCall={call} width={36}/>
      </Box>
      <Box ref={node => { actual = node; }}>
        <ActiveContent completedToolCalls={[call]} runningToolCalls={[]} width={38}/>
      </Box>
    </Box>, { stdout: stdout as unknown as NodeJS.WriteStream, debug: true, patchConsole: false, exitOnCtrlC: false }));
    await vi.waitFor(() => expect(measureElement(actual!).height).toBe(measureElement(expected!).height));
    if (kind === 'collapsed-error') expect(plain(stdout.frames.at(-1) ?? '')).not.toContain('must remain collapsed');
  });

  it.each([40, 80])('keeps streaming text visible after oversized expanded output at %s columns', async columns => {
    const stdout = new Stdout();
    stdout.columns = columns;
    const call = { ...base('executing'), toolName: 'bash', expanded: true,
      output: Array.from({ length: 30 }, (_, n) => `output ${n}: ${'wide text '.repeat(10)}`).join('\n') };
    let actual: DOMElement | null = null;
    mounted.push(render(<Box ref={node => { actual = node; }}>
      <ActiveContent completedToolCalls={[]} runningToolCalls={[call]} width={columns - 2}
        streamingContent="LATEST STREAM TOKEN" config={{ show_full_tool_output: true }}/>
    </Box>, { stdout: stdout as unknown as NodeJS.WriteStream, debug: true, patchConsole: false, exitOnCtrlC: false }));
    await vi.waitFor(() => expect(plain(stdout.frames.at(-1) ?? '')).toContain('LATEST STREAM TOKEN'));
    expect(measureElement(actual!).height).toBeLessThanOrEqual(12);
    expect(plain(stdout.frames.at(-1) ?? '')).not.toContain('output 29:');
  });
});
