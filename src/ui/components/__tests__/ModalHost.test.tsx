import React, { useEffect } from 'react';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { render, Text } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputPrompt } from '../InputPrompt.js';
import type { CompletionProvider } from '@services/CompletionProvider.js';
import { ModalHost } from '../ModalHost.js';
import { useModalState, type ModalState } from '../../hooks/useModalState.js';
import { ActivityStream } from '@services/ActivityStream.js';
import type { ModalSelection } from '../ModalKeyboardInput.js';

const keyboard = vi.hoisted(() => ({ selection: undefined as ModalSelection | undefined }));
vi.mock('../ModalKeyboardInput.js', () => ({
  ModalKeyboardInput: ({ selection }: { selection?: ModalSelection }) => {
    keyboard.selection = selection;
    return <Text>KEYBOARD</Text>;
  },
}));
vi.mock('../RewindSelector.js', () => ({ RewindSelector: () => <Text>REWIND</Text> }));
vi.mock('../RewindOptionsSelector.js', () => ({ RewindOptionsSelector: () => <Text>REWIND OPTIONS</Text> }));
vi.mock('../UndoFileList.js', () => ({ UndoFileList: () => <Text>UNDO FILE LIST</Text> }));
vi.mock('../UndoPrompt.js', () => ({ UndoPrompt: () => <Text>UNDO CONFIRM</Text> }));
vi.mock('../SessionSelector.js', () => ({ SessionSelector: () => <Text>SESSION</Text> }));
class Output extends EventEmitter {
  columns = 80;
  rows = 24;
  frames: string[] = [];
  write = (frame: string) => {
    this.frames.push(frame);
    return true;
  };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const mounts: Array<{ unmount: () => void }> = [];
afterEach(() => {
  mounts.splice(0).forEach(mount => mount.unmount());
  keyboard.selection = undefined;
});
function mount() {
  let modal!: ModalState;
  const stream = new ActivityStream();
  const reportError = vi.fn();
  function Harness() {
    modal = useModalState();
    return (
      <ModalHost
        modal={modal}
        activityStream={stream}
        status={<Text>STATUS</Text>}
        onPermissionInstruct={() => {}}
        reportError={reportError}
      >
        <Text>NORMAL INPUT</Text>
      </ModalHost>
    );
  }
  const stdout = new Output();
  const instance = render(<Harness />, { stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
  mounts.push(instance);
  const frame = () => stdout.frames.findLast(value => value.includes('STATUS') || value.includes('NORMAL INPUT')) ?? '';
  return {
    get modal() {
      return modal;
    },
    stdout,
    frame,
    reportError,
  };
}

describe('modal host', () => {
  it('gives layered rewind options priority with one status and keyboard owner', async () => {
    const harness = mount();
    await tick();
    const message = { role: 'user' as const, content: 'target', timestamp: 1 };
    harness.modal.setRewindRequest({ requestId: 'rewind', selectedIndex: 0, targets: [message] });
    await tick();
    await vi.waitFor(() => expect(harness.frame()).toContain('REWIND'));
    await vi.waitFor(() => expect(keyboard.selection?.count).toBe(1));
    harness.modal.setRewindOptionsRequest({
      selectedIndex: 0,
      targetMessage: message,
      fileChanges: { fileCount: 0, files: [] },
    });
    await tick();
    await vi.waitFor(() => expect(harness.frame()).toContain('REWIND OPTIONS'));
    expect(keyboard.selection).toBeUndefined();
    expect(harness.frame().match(/STATUS/g)).toHaveLength(1);
    expect(harness.frame().match(/KEYBOARD/g)).toHaveLength(1);
    expect(harness.frame()).not.toContain('NORMAL INPUT');
    harness.modal.setRewindOptionsRequest(undefined);
    await tick();
    await vi.waitFor(() => expect(keyboard.selection?.count).toBe(1));
  });

  it('keeps undo confirmation above its file list and restores the list when dismissed', async () => {
    const harness = mount();
    await tick();
    harness.modal.setUndoFileListRequest({ requestId: 'files', selectedIndex: 0, fileList: [] });
    await tick();
    harness.modal.setUndoRequest({ requestId: 'confirm', count: 1, patches: [], previewData: [] });
    await tick();
    await vi.waitFor(() => expect(harness.frame()).toContain('UNDO CONFIRM'));
    expect(harness.frame()).not.toContain('UNDO FILE LIST');
    expect(keyboard.selection?.count).toBe(2);
    harness.modal.setUndoRequest(undefined);
    await tick();
    await vi.waitFor(() => expect(harness.frame()).toContain('UNDO FILE LIST'));
  });

  it('unmounts the ordinary editor and cancels its pending completion work while a modal is open', async () => {
    const getCompletions = vi.fn(async () => []);
    const stream = new ActivityStream();
    const stdin = new PassThrough();
    function Harness() {
      const modal = useModalState();
      const { setSessionSelectRequest } = modal;
      useEffect(() => {
        setSessionSelectRequest({ requestId: 'session', sessions: [], selectedIndex: 0 });
      }, [setSessionSelectRequest]);
      return (
        <ModalHost
          modal={modal}
          activityStream={stream}
          status={<Text>STATUS</Text>}
          onPermissionInstruct={() => {}}
          reportError={() => {}}
        >
          <InputPrompt
            onSubmit={() => {}}
            draft={{ text: '/co', cursor: 3 }}
            completionProvider={{ getCompletions } as unknown as CompletionProvider}
          />
        </ModalHost>
      );
    }
    const instance = render(<Harness />, {
      stdout: new Output(),
      stdin,
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    mounts.push(instance);
    await new Promise(resolve => setTimeout(resolve, 200));
    stdin.write('/more typing');
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(getCompletions).not.toHaveBeenCalled();
  });

  it('replaces exclusive dialogs and routes selection without mounting the ordinary input', async () => {
    const harness = mount();
    await tick();
    harness.modal.setSessionSelectRequest({ requestId: 'session', sessions: [], selectedIndex: 0 });
    await tick();
    await vi.waitFor(() => expect(keyboard.selection?.count).toBe(0));
    keyboard.selection?.cancel();
    await tick();
    // The activity handler closes real requests; host only answers them.
    await vi.waitFor(() => expect(harness.frame()).toContain('SESSION'));
    harness.modal.setSessionSelectRequest(undefined);
    await tick();
    await vi.waitFor(() => expect(harness.frame()).toContain('NORMAL INPUT'));
    expect(harness.reportError).not.toHaveBeenCalled();
  });
});
