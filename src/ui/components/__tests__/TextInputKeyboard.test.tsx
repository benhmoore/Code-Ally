import React, { useState } from 'react';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { afterEach, expect, it, vi } from 'vitest';
import { TextInput } from '../TextInput.js';

class Stdout extends EventEmitter { columns = 80; rows = 24; write = () => true; }
class Stdin extends PassThrough {
  isTTY = true; setRawMode = () => this; ref = () => this; unref = () => this;
}
const mounts: Array<{ unmount: () => void }> = [];
afterEach(() => mounts.splice(0).forEach(instance => instance.unmount()));
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
function editor(initial: string) {
  const changed = vi.fn(); const submitted = vi.fn(); const stdin = new Stdin();
  function Controlled() {
    const [value, setValue] = useState(initial); const [cursor, setCursor] = useState(initial.length);
    return <TextInput value={value} cursorPosition={cursor} onCursorChange={setCursor}
      onValueChange={next => { changed(next); setValue(next); }} onSubmit={submitted} />;
  }
  mounts.push(render(<Controlled />, { stdout: new Stdout() as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream, debug: true, patchConsole: false, exitOnCtrlC: false }));
  return { changed, submitted, async raw(chunk: string) { await settle(); stdin.write(chunk); await settle(); } };
}

it('applies all cursor/edit transactions in one raw stdin chunk before React commits', async () => {
  const ui = editor('Unicode 試験 🦊 draft');
  await ui.raw('\x01\x05\x15');
  expect(ui.changed).toHaveBeenLastCalledWith('');
  await ui.raw('next');
  await ui.raw('\r');
  expect(ui.submitted).toHaveBeenLastCalledWith('next');
});

it('moves and deletes whole Unicode graphemes across batched keys', async () => {
  const ui = editor('abc👩‍💻🦊');
  await ui.raw('\x7f\x7f');
  expect(ui.changed).toHaveBeenLastCalledWith('abc');
  await ui.raw('\x01\x1b[C\x7f');
  expect(ui.changed).toHaveBeenLastCalledWith('bc');
});

it('replaces optimistic snapshots when controlled external prefill changes', async () => {
  const stdin = new Stdin(); const changed = vi.fn();
  const field = (value: string) => <TextInput value={value} cursorPosition={value.length}
    onValueChange={changed} onCursorChange={vi.fn()} onSubmit={vi.fn()} />;
  const instance = render(field('old draft'), { stdout: new Stdout() as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream, debug: true, patchConsole: false, exitOnCtrlC: false });
  mounts.push(instance);
  await settle(); stdin.write('\x15'); await settle();
  expect(changed).toHaveBeenLastCalledWith('');
  instance.rerender(field('external🦊'));
  await settle(); stdin.write('\x7f'); await settle();
  expect(changed).toHaveBeenLastCalledWith('external');
});
