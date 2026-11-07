import React from 'react';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Text, render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionSelector } from '../SessionSelector.js';
import { PromptLibrarySelector } from '../PromptLibrarySelector.js';
import { MessageSelector } from '../MessageSelector.js';
import { RewindSelector } from '../RewindSelector.js';
import { ModalHost } from '../ModalHost.js';
import { TerminalContext, deriveWidths } from '../../contexts/TerminalContext.js';
import { useModalState, type ModalState } from '../../hooks/useModalState.js';
import { visibleLength, stripAnsi } from '@utils/terminalText.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ActivityEventType, type SessionInfo, type PromptInfo } from '@shared/index.js';
import type { PatchMetadata } from '@services/PatchManager.js';

const click = vi.hoisted(() => ({ handlers: [] as Array<(() => void) | undefined> }));
vi.mock('../../contexts/PointerContext.js', () => ({
  useClickable: (_ref: unknown, handler?: () => void) => {
    click.handlers.push(handler);
  },
}));
class Output extends EventEmitter {
  columns = 40;
  rows = 12;
  isTTY = true;
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
const mounts: Array<{ unmount(): void }> = [];
afterEach(() => {
  mounts.splice(0).forEach(instance => instance.unmount());
  click.handlers = [];
});
const sessions = Array.from({ length: 30 }, (_, index): SessionInfo => ({
  session_id: `s${index}`,
  display_name: `Session ${index} ${'界'.repeat(80)}`,
  message_count: 5,
  last_modified_timestamp: 1,
  working_dir: '/very/long/project/path',
  lastUserMessage: 'First\nsecond '.repeat(30),
}));
const prompts = sessions.map((session, index): PromptInfo => ({
  id: session.session_id,
  title: `Prompt ${index}`,
  content: 'content\n'.repeat(50),
  createdAt: new Date(1).toISOString(),
  tags: ['very-long-tag'.repeat(10)],
}));
function mount(node: React.ReactNode) {
  const stdout = new Output();
  const stdin = new Input();
  const instance = render(<TerminalContext.Provider value={deriveWidths(40, 12)}>{node}</TerminalContext.Provider>, {
    stdout,
    stdin,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  mounts.push(instance);
  const frame = () => stripAnsi(stdout.frames.findLast(value => value.trim()) ?? '');
  return { stdout, stdin, frame };
}

describe('daily selector interactions', () => {
  it.each(['session', 'library'] as const)(
    'keeps long %s rows bounded and pointer actions use absolute window indexes',
    async kind => {
      const onOptionPress = vi.fn();
      const f = mount(
        kind === 'session' ? (
          <SessionSelector sessions={sessions} selectedIndex={20} onOptionPress={onOptionPress} />
        ) : (
          <PromptLibrarySelector prompts={prompts} selectedIndex={20} onOptionPress={onOptionPress} />
        )
      );
      await vi.waitFor(() => expect(f.frame()).toContain('21 of 30'));
      expect(f.frame().split('\n').length).toBeLessThanOrEqual(12);
      expect(
        f
          .frame()
          .split('\n')
          .every(line => visibleLength(line) <= 40)
      ).toBe(true);
      click.handlers.findLast(Boolean)!();
      expect(onOptionPress).toHaveBeenCalledWith(20);
    }
  );

  it('offers only usable shortcuts when lists are empty', async () => {
    const empty = mount(<MessageSelector messages={[]} selectedIndex={-1} />);
    await vi.waitFor(() => expect(empty.frame()).toContain('No previous user messages'));
    expect(empty.frame()).toContain('n new');
    expect(empty.frame()).not.toContain('enter use');
    const rewind = mount(<RewindSelector messages={[]} selectedIndex={-1} />);
    await vi.waitFor(() => expect(rewind.frame()).toContain('esc close'));
  });

  it('summarizes all changes after a rewind target, including later turns', async () => {
    const patches = [10, 25].map((timestamp, index): PatchMetadata => ({
      patch_number: index,
      timestamp: new Date(timestamp).toISOString(),
      operation_type: 'edit',
      file_path: `file${index}.ts`,
      patch_file: 'patch',
    }));
    const f = mount(
      <RewindSelector
        messages={[
          { role: 'user', content: 'First', timestamp: 10 },
          { role: 'user', content: 'Second', timestamp: 20 },
        ]}
        selectedIndex={0}
        patches={patches}
      />
    );
    await vi.waitFor(() => expect(f.frame()).toContain('2 files to review'));
    expect(f.frame()).toContain('enter review');
  });

  it.each(['loading', 'error'] as const)('never labels %s rewind metadata as zero file changes', async kind => {
    const f = mount(
      <RewindSelector
        messages={[{ role: 'user', content: 'Earlier work', timestamp: 10 }]}
        selectedIndex={0}
        patchesLoadState={kind === 'loading' ? { kind } : { kind, message: 'Failed' }}
      />
    );
    await vi.waitFor(() =>
      expect(f.frame()).toContain(kind === 'loading' ? 'Checking file changes' : 'File changes unavailable')
    );
    expect(f.frame()).not.toContain('No file changes');
  });

  it('keeps long error details, Retry, and Escape inside a narrow viewport', async () => {
    const f = mount(
      <SessionSelector
        sessions={[]}
        selectedIndex={0}
        loadState={{ kind: 'error', message: 'Long path /directory/'.repeat(100) }}
        onRetry={() => {}}
      />
    );
    await vi.waitFor(() => expect(f.frame()).toContain('r retry'));
    expect(f.frame()).toContain('Resume session');
    expect(f.frame()).toContain('esc close');
    expect(f.frame().split('\n').length).toBeLessThanOrEqual(12);
    expect(
      f
        .frame()
        .split('\n')
        .every(line => visibleLength(line) <= 40)
    ).toBe(true);
  });

  it('supports Home/End/Page navigation in the real modal host and exposes retry for failed lists', async () => {
    let modal!: ModalState;
    const stream = new ActivityStream();
    const retry = vi.fn();
    stream.subscribe(ActivityEventType.SESSION_SELECT_REQUEST, retry);
    function Harness() {
      modal = useModalState();
      return (
        <ModalHost
          modal={modal}
          activityStream={stream}
          status={null}
          reportError={() => {}}
          onPermissionInstruct={() => {}}
        >
          <Text>Ready</Text>
        </ModalHost>
      );
    }
    const f = mount(<Harness />);
    await vi.waitFor(() => expect(modal).toBeDefined());
    modal.setSessionSelectRequest({ requestId: 'pick', sessions, selectedIndex: 0 });
    await vi.waitFor(() => expect(f.frame()).toContain('1 of 30'));
    for (const [key, index] of [
      ['\x1b[F', 29],
      ['\x1b[5~', 24],
      ['\x1b[H', 0],
      ['\x1b[6~', 5],
    ] as const) {
      f.stdin.write(key);
      await vi.waitFor(() => expect(modal.sessionSelectRequest?.selectedIndex).toBe(index));
    }
    modal.setSessionSelectRequest({
      requestId: 'failed',
      sessions: [],
      selectedIndex: 0,
      loadState: { kind: 'error', message: 'Disk unavailable' },
    });
    await vi.waitFor(() => expect(f.frame()).toContain('r retry'));
    f.stdin.write('r');
    await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce());
  });
});
