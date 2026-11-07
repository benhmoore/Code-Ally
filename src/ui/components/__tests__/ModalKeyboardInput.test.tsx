import React from 'react';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { afterEach, expect, it, vi } from 'vitest';
import { ModalKeyboardInput, type ModalSelection } from '../ModalKeyboardInput.js';

const exit = vi.hoisted(() => vi.fn());
vi.mock('ink', async original => ({ ...await original<typeof import('ink')>(), useApp: () => ({ exit }) }));

class Stdout extends EventEmitter {
  columns = 80; rows = 24; isTTY = true;
  write = () => true;
}
class Stdin extends PassThrough {
  isTTY = true;
  setRawMode = () => this;
  ref = () => this;
  unref = () => this;
}
const mounts: Array<{ unmount: () => void }> = [];
afterEach(() => { for (const instance of mounts.splice(0)) instance.unmount(); exit.mockClear(); });
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
function mount(selection?: ModalSelection, onCyclePermissionMode?: () => void) {
  const stdin = new Stdin();
  const instance = render(<ModalKeyboardInput selection={selection} onCyclePermissionMode={onCyclePermissionMode}/>, {
    stdout: new Stdout() as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true, exitOnCtrlC: false, patchConsole: false,
  });
  mounts.push(instance);
  return { stdin, instance };
}
function selection(count = 3): ModalSelection {
  return { count, selectedIndex: 1, navigate: vi.fn(), activate: vi.fn(), cancel: vi.fn(), createNew: vi.fn() };
}

it('uses the same selection callbacks for navigation, activation, cancellation and creation', async () => {
  const choice = selection();
  const toggle = vi.fn();
  const { stdin } = mount(choice, toggle);
  await settle();
  for (const key of ['\x1b[A', '\x1b[B', '\r', 'N', '\x1b[Z', '\x1b']) {
    stdin.write(key); await settle();
  }
  await settle();
  expect(choice.navigate).toHaveBeenNthCalledWith(1, 0);
  expect(choice.navigate).toHaveBeenNthCalledWith(2, 2);
  expect(choice.activate).toHaveBeenCalledExactlyOnceWith(1);
  expect(choice.createNew).toHaveBeenCalledOnce();
  expect(toggle).toHaveBeenCalledOnce();
  expect(choice.cancel).toHaveBeenCalledOnce();
});

it('never navigates to a negative index or activates an empty selector', async () => {
  const choice = selection(0);
  const { stdin } = mount(choice);
  await settle();
  stdin.write('\x1b[A'); stdin.write('\x1b[B'); stdin.write('\r'); stdin.write('\x03');
  await settle();
  expect(choice.navigate).not.toHaveBeenCalled();
  expect(choice.activate).not.toHaveBeenCalled();
  expect(choice.cancel).toHaveBeenCalledOnce();
});

it('allows wizard-owned text and exits on the third emergency Ctrl+C', async () => {
  const { stdin } = mount();
  await settle();
  stdin.write('wizard text'); await settle();
  stdin.write('\x03'); await settle();
  stdin.write('\x03');
  await settle();
  expect(exit).not.toHaveBeenCalled();
  stdin.write('\x03');
  await settle();
  expect(exit).toHaveBeenCalledOnce();
});
