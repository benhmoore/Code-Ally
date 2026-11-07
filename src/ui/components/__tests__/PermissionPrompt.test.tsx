import React from 'react';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { render, Text } from 'ink';
import { BottomAlignedLayout } from '../BottomAlignedLayout.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionPrompt, type PermissionRequest } from '../PermissionPrompt.js';
import { PermissionChoice, SensitivityTier } from '@agent/TrustManager.js';
import { TerminalContext, deriveWidths } from '../../contexts/TerminalContext.js';
import { stripAnsi, visibleLength } from '@utils/terminalText.js';
class Output extends EventEmitter {
  columns = 40;
  rows = 12;
  frames: string[] = [];
  write = (frame: string) => {
    this.frames.push(frame);
    return true;
  };
}
class Input extends PassThrough {
  isTTY = true;
  setRawMode = () => this;
  ref = () => this;
  unref = () => this;
}
const mounted: Array<{ unmount(): void }> = [];
afterEach(() => mounted.splice(0).forEach(instance => instance.unmount()));
const base: PermissionRequest = {
  toolName: 'bash',
  command: 'npm test',
  sensitivity: SensitivityTier.SENSITIVE,
  options: [PermissionChoice.ALLOW, PermissionChoice.ALWAYS_ALLOW, PermissionChoice.DENY],
  decisionReason: 'Review required for this command',
};
function mount(request: PermissionRequest) {
  const stdout = new Output();
  const stdin = new Input();
  const instance = render(
    <TerminalContext.Provider value={deriveWidths(40, 12)}>
      <PermissionPrompt
        request={request}
        selectedIndex={0}
        permissionMode="auto"
        instructText=""
        onInstructTextChange={() => {}}
      />
    </TerminalContext.Provider>,
    { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false }
  );
  mounted.push(instance);
  const frame = () => stripAnsi(stdout.frames.findLast(value => value.trim()) ?? '');
  return { stdout, stdin, frame };
}

describe('permission operation inspection', () => {
  it('presents shell arguments as an operation and directory rather than serialized JSON', async () => {
    const f = mount({ ...base, command: 'git status --short --branch', arguments: { working_dir: '/project' } });
    await vi.waitFor(() => expect(f.frame()).toContain('Run: git status --short --branch'));
    for (let index = 0; index < 3; index++) {
      f.stdin.write('\x1b[6~');
      await new Promise(resolve => setImmediate(resolve));
    }
    await vi.waitFor(() => expect(f.stdout.frames.join('')).toContain('In: /project'));
    expect(f.stdout.frames.join('')).not.toContain('"working_dir"');
  });

  it('does not present generic Bash sensitivity as a risk verdict or repeat the decision reason', async () => {
    const f = mount({ ...base, sensitivity: SensitivityTier.EXTREMELY_SENSITIVE, decisionReason: 'Needs review' });
    await vi.waitFor(() => expect(f.frame()).toContain('Needs review'));
    expect(f.frame()).not.toContain('High impact');
    expect(f.frame().match(/Needs review/g)).toHaveLength(1);
  });

  it('keeps approval choices and reasons visible while paging through the complete command', async () => {
    const command = Array.from({ length: 15 }, (_, index) => `step-${index}`).join('\n');
    const f = mount({ ...base, command });
    await vi.waitFor(() => expect(f.frame()).toContain('Review required'));
    expect(f.frame()).toContain('Allow');
    for (let index = 0; index < 20; index++) {
      f.stdin.write('\x1b[6~');
      await new Promise(resolve => setImmediate(resolve));
    }
    await vi.waitFor(() => expect(f.stdout.frames.join('')).toContain('step-14'));
    expect(f.frame()).toContain('Deny');
    expect(
      f
        .frame()
        .split('\n')
        .every(line => visibleLength(line) <= 40)
    ).toBe(true);
    expect(f.frame().split('\n').length).toBeLessThanOrEqual(12);
  });

  it('keeps the operation and decision options visible inside the compact application footer', async () => {
    const stdout = new Output();
    const instance = render(
      <TerminalContext.Provider value={deriveWidths(40, 12)}>
        <BottomAlignedLayout
          historyKey={0}
          footer={
            <>
              <Text>Working</Text>
              <PermissionPrompt
                request={base}
                selectedIndex={0}
                permissionMode="manual"
                instructText=""
                onInstructTextChange={() => {}}
              />
            </>
          }
        >
          <Text>history</Text>
        </BottomAlignedLayout>
      </TerminalContext.Provider>,
      { stdout, stdin: new Input(), debug: true, patchConsole: false, exitOnCtrlC: false }
    );
    mounted.push(instance);
    await vi.waitFor(() => {
      const frame = stripAnsi(stdout.frames.findLast(value => value.trim()) ?? '');
      expect(frame).toContain('Permission');
      expect(frame).toContain('npm test');
      expect(frame).toContain('Allow');
      expect(frame).toContain('Deny');
    });
  });

  it('keeps an existing approval explicit after a mode change and resets the notice for the next request', async () => {
    const stdout = new Output();
    const initial = { ...base, requestId: 'first' };
    const tree = (request: PermissionRequest, requestedPermissionMode: 'manual' | 'auto') => (
      <TerminalContext.Provider value={deriveWidths(40, 12)}>
        <PermissionPrompt
          request={request}
          selectedIndex={0}
          permissionMode="manual"
          requestedPermissionMode={requestedPermissionMode}
          instructText=""
          onInstructTextChange={() => {}}
        />
      </TerminalContext.Provider>
    );
    const instance = render(tree(initial, 'manual'), {
      stdout,
      stdin: new Input(),
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    mounted.push(instance);
    const frame = () => stripAnsi(stdout.frames.findLast(value => value.trim()) ?? '').replace(/\s+/g, ' ');
    await vi.waitFor(() => expect(frame()).toContain('npm test'));
    expect(frame()).not.toContain('new mode applies next');
    instance.rerender(tree(initial, 'auto'));
    await vi.waitFor(() => expect(frame()).toContain('Approve or deny this request; the new mode applies next.'));
    instance.rerender(tree({ ...base, requestId: 'second' }, 'auto'));
    await vi.waitFor(() => expect(frame()).not.toContain('new mode applies next'));
  });

  it('renders terminal control characters visibly rather than letting them hide the command', async () => {
    const f = mount({ ...base, command: '\x1b[2Jdanger' });
    await vi.waitFor(() => expect(f.frame()).toContain('\\x1b[2Jdanger'));
    expect(f.stdout.frames.join('')).not.toContain('\x1b[2J');
  });
});
