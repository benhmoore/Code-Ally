import React from 'react';
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { expect, it, vi } from 'vitest';
import { MessageDisplay } from '../MessageDisplay.js';
import type { Message } from '@shared/index.js';
import { stripAnsi } from '@utils/terminalText.js';

class Output extends EventEmitter {
  columns = 80;
  rows = 24;
  frames: string[] = [];
  write = (frame: string) => {
    this.frames.push(frame);
    return true;
  };
}

it.each([
  { metadata: undefined, prefix: '>' },
  { metadata: { agentMessage: { messageId: 'message-1', sender: 'agent-1' }, source: 'agent' as const }, prefix: '↳' },
  { metadata: { backgroundTaskResult: true }, prefix: '↳' },
])('distinguishes actual user directions from agent and harness messages ($prefix)', async ({ metadata, prefix }) => {
  const output = new Output();
  const message: Message = { role: 'user', content: '[Agent agent-1] A finding.', metadata };
  const mounted = render(<MessageDisplay message={message} />, {
    stdout: output as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  try {
    await vi.waitFor(() =>
      expect(stripAnsi(output.frames.at(-1) ?? '')).toContain(`${prefix} [Agent agent-1] A finding.`)
    );
  } finally {
    mounted.unmount();
  }
});
