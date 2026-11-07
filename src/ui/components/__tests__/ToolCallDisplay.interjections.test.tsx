import React from 'react';
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolCallDisplay } from '../ToolCallDisplay.js';
import type { ToolCallState } from '@shared/index.js';

class Stdout extends EventEmitter {
  columns = 100;
  rows = 30;
  frames: string[] = [];
  write = (frame: string) => { this.frames.push(frame); return true; };
}
const mounted: Array<{ unmount: () => void }> = [];
afterEach(() => mounted.splice(0).forEach(item => item.unmount()));

describe('nested tool direction rendering', () => {
  it('shows denied review reasons without executing embedded terminal controls', async () => {
    const stdout = new Stdout();
    const call: ToolCallState = {
      id: 'denied', toolName: 'write', arguments: {}, status: 'error', startTime: 1,
      permissionDecision: {
        toolName: 'write', source: 'reviewer', verdict: 'deny', timestamp: 2,
        reason: 'Not authorized\n\u001b[2J', reviewerModel: 'tev1:4b',
      },
    };
    mounted.push(render(<ToolCallDisplay toolCall={call}/>, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true, exitOnCtrlC: false, patchConsole: false,
    }));
    await vi.waitFor(() => expect(stdout.frames.at(-1)).toContain('Auto denied · tev1:4b · Not authorized \\x1b[2J'));
    expect(stdout.frames.at(-1)).not.toContain('\u001b[2J');
  });

  it('keeps reviewer decisions beside their tool after remount, including collapsed calls', async () => {
    const call: ToolCallState = {
      id: 'reviewed', toolName: 'write', arguments: { file_path: 'example.ts' },
      status: 'success', startTime: 1, endTime: 5, collapsed: true,
      permissionDecision: {
        toolName: 'write', source: 'reviewer', verdict: 'allow',
        reason: 'Authorized workspace edit', reviewerModel: 'tev1:4b', timestamp: 2,
      },
    };
    for (let mount = 0; mount < 2; mount++) {
      const stdout = new Stdout();
      const instance = render(<ToolCallDisplay toolCall={call}/>, {
        stdout: stdout as unknown as NodeJS.WriteStream,
        debug: true, exitOnCtrlC: false, patchConsole: false,
      });
      mounted.push(instance);
      await vi.waitFor(() => expect(stdout.frames.at(-1)).toContain('Auto approved · tev1:4b'));
      instance.unmount();
    }
  });

  it('renders runtime-owned directions and acknowledgments identically after remount without event replay', async () => {
    const call: ToolCallState = { id: 'delegation', toolName: 'agent', arguments: { agent_type: 'task' }, status: 'success', startTime: 1, endTime: 5,
      interjections: [{ id: 'direction', message: 'Keep the exported API stable.', timestamp: 2 }],
      acknowledgments: [{ id: 'ack', message: 'I will preserve the API.', timestamp: 3 }] };
    for (let mount = 0; mount < 2; mount++) {
      const stdout = new Stdout();
      // No ActivityProvider is required: the row is a pure projection of its props.
      const instance = render(<ToolCallDisplay toolCall={call}/>, { stdout: stdout as unknown as NodeJS.WriteStream,
        debug: true, exitOnCtrlC: false, patchConsole: false });
      mounted.push(instance);
      await vi.waitFor(() => expect(stdout.frames.at(-1)).toContain('Keep the exported API stable.'));
      expect(stdout.frames.at(-1)).toContain('I will preserve the API.');
      instance.unmount();
    }
  });
});
