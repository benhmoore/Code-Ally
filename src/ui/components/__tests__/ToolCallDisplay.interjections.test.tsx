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
