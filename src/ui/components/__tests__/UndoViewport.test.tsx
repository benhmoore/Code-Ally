import React from 'react';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { afterEach, expect, it, vi } from 'vitest';
import { UndoPrompt } from '../UndoPrompt.js';
import { RewindOptionsSelector } from '../RewindOptionsSelector.js';
import { stripAnsi } from '@utils/terminalText.js';

class Stdout extends EventEmitter {
  columns = 40; rows = 12; frames: string[] = [];
  write = (frame: string) => { this.frames.push(stripAnsi(frame)); return true; };
}
class Stdin extends PassThrough {
  isTTY = true; setRawMode = () => this; ref = () => this; unref = () => this;
}
const mounts: Array<{ unmount: () => void }> = [];
afterEach(() => mounts.splice(0).forEach(instance => instance.unmount()));
const settle = () => new Promise(resolve => setTimeout(resolve, 10));
function mount(element: React.ReactElement, geometry: { columns: number; rows: number }) {
  const stdout = Object.assign(new Stdout(), geometry); const stdin = new Stdin();
  mounts.push(render(element, { stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream, debug: true, patchConsole: false, exitOnCtrlC: false }));
  return { stdout, frame: () => stdout.frames.at(-1) ?? '', async page() { stdin.write('\x1b[6~'); await settle(); } };
}

it.each([{ columns: 40, rows: 12 }, { columns: 80, rows: 24 }])(
  'pins undo choices while every filename and diff line remains inspectable at $columns×$rows', async geometry => {
    const previews = [
      { operation_type: 'write', file_path: '/tmp/very-long-fixture-directory-name/complete-filename-FIRST.txt',
        patch_number: 1, timestamp: new Date().toISOString(), current_content: Array.from({ length: 25 }, (_, i) => `REMOVED-${i}`).join('\n'), predicted_content: '' },
      { operation_type: 'delete', file_path: '/tmp/another-very-long-fixture-directory-name/complete-filename-SECOND.txt',
        patch_number: 2, timestamp: new Date().toISOString(), current_content: '', predicted_content: 'LAST-RESTORED-LINE' },
    ];
    const ui = mount(<UndoPrompt request={{ requestId: 'undo', count: 2, patches: [], previewData: previews }} selectedIndex={1} />, geometry);
    await settle();
    for (let index = 0; index < 100; index++) {
      expect(ui.frame()).toContain('Confirm undo');
      expect(ui.frame()).toContain('Confirm'); expect(ui.frame()).toContain('Cancel');
      expect(ui.frame()).toContain('esc cancel');
      expect(ui.frame().split('\n').length).toBeLessThanOrEqual(geometry.rows);
      await ui.page();
    }
    const seen = ui.stdout.frames.join('\n');
    expect(seen).toContain('REMOVED-24'); expect(seen).toContain('LAST-RESTORED-LINE');
    expect(seen).toContain('File will be deleted'); expect(seen).toContain('File will be recreated');
    expect(seen).toContain('SECOND.txt');
  }
);

it('pins rewind file-effect choices while all file details can be paged in a short terminal', async () => {
  const ui = mount(<RewindOptionsSelector targetMessage={{ role: 'user', content: 'Original target\nComplete second line' }}
    fileChanges={{ fileCount: 8, files: Array.from({ length: 8 }, (_, i) => ({ path: `/tmp/long-directory/FILE-${i}-COMPLETE.txt` })) }} onConfirm={vi.fn()} />, { columns: 40, rows: 12 });
  await settle();
  for (let index = 0; index < 70; index++) {
    expect(ui.frame()).toContain('Rewind options');
    expect(ui.frame()).toContain('Conversation only (keep files)');
    expect(ui.frame()).toContain('Conversation + tracked files (8)');
    expect(ui.frame()).toContain('Cancel');
    expect(ui.frame().split('\n').length).toBeLessThanOrEqual(12);
    await ui.page();
  }
  expect(ui.stdout.frames.join('\n').replace(/\s/g, '')).toContain('FILE-7-COMPLETE.txt');
  expect(ui.stdout.frames.join('\n')).toContain('Complete second line');
});
