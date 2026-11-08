import React from 'react';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { render, Text } from 'ink';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentWizardView } from '../AgentWizardView.js';
import { ProjectWizardView } from '../ProjectWizardView.js';
import { PromptAddWizard } from '../PromptAddWizard.js';
import { stripAnsi } from '@utils/terminalText.js';
import { InteractiveSurface } from '../InteractiveSurface.js';
import { SelectionIndicator } from '../SelectionIndicator.js';

class Stdout extends EventEmitter {
  columns = 100; rows = 36;
  frames: string[] = [];
  write = (frame: string) => { this.frames.push(frame); return true; };
}
class Stdin extends PassThrough {
  isTTY = true;
  setRawMode = () => this;
  ref = () => this;
  unref = () => this;
}
const mounts: Array<{ unmount: () => void }> = [];
afterEach(() => mounts.splice(0).forEach(instance => instance.unmount()));
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
function mount(element: React.ReactElement, geometry = { columns: 100, rows: 36 }) {
  const stdout = Object.assign(new Stdout(), geometry);
  const stdin = new Stdin();
  const instance = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true, exitOnCtrlC: false, patchConsole: false,
  });
  mounts.push(instance);
  const press = async (key: string) => { await settle(); stdin.write(key); await settle(); };
  return Object.assign(press, { frame: () => stripAnsi(stdout.frames.at(-1) ?? '') });
}

it('cancels the agent editor exactly once for one Escape', async () => {
  const cancel = vi.fn();
  const press = mount(<AgentWizardView onCancel={cancel} onComplete={vi.fn()} />);
  await press('\x1b');
  expect(cancel).toHaveBeenCalledOnce();
});

it('cancels the project name editor exactly once for one Escape', async () => {
  const cancel = vi.fn();
  const press = mount(<ProjectWizardView onSkip={cancel} onComplete={vi.fn()} />);
  await press('\r');
  await press('\x1b');
  expect(cancel).toHaveBeenCalledOnce();
});

it('gives prompt Escape and Enter to the focused editor and moves backward with Shift+Tab', async () => {
  const cancel = vi.fn(); const submit = vi.fn(); const focus = vi.fn();
  const press = mount(<PromptAddWizard title="Title" content="Body" tags="" focusedField="title"
    onCancel={cancel} onSubmit={submit} onFieldChange={vi.fn()} onFieldFocus={focus} />);
  await press('\x1b[Z');
  expect(focus).toHaveBeenCalledExactlyOnceWith('tags');
  await press('\r');
  expect(submit).toHaveBeenCalledOnce();
  await press('\x1b');
  expect(cancel).toHaveBeenCalledOnce();
});

it('reserves vertical arrows for inspecting multiline prompt content', async () => {
  const focus = vi.fn();
  const press = mount(<PromptAddWizard title="Title" content={'first\nsecond\nlast'} tags="" focusedField="content"
    onCancel={vi.fn()} onSubmit={vi.fn()} onFieldChange={vi.fn()} onFieldFocus={focus} />);
  await press('\x1b[A'); await press('\x1b[B');
  expect(focus).not.toHaveBeenCalled();
});


it.each([{ columns: 40, rows: 12 }, { columns: 80, rows: 24 }])(
  'keeps heading, multiline cursor and cancel controls visible at $columns×$rows', async geometry => {
    const value = Array.from({ length: 16 }, (_, i) => `INSPECT-${i}`).join('\n');
    const press = mount(<PromptAddWizard title="Title" content={value} tags="" focusedField="content"
      onCancel={vi.fn()} onSubmit={vi.fn()} onFieldChange={vi.fn()} onFieldFocus={vi.fn()} />, geometry);
    await settle();
    expect(press.frame()).toContain('Edit prompt');
    expect(press.frame()).toContain('Content:');
    expect(press.frame()).toContain('INSPECT-15');
    expect(press.frame()).toContain('esc cancel');
    expect(press.frame().split('\n').length).toBeLessThanOrEqual(geometry.rows);
  }
);

it('keeps agent validation errors visible above the active editor in a short terminal', async () => {
  const press = mount(<AgentWizardView onCancel={vi.fn()} onComplete={vi.fn()} />, { columns: 40, rows: 12 });
  await press('\r');
  expect(press.frame()).toContain('Create Agent');
  expect(press.frame()).toContain('Description cannot be empty');
  expect(press.frame()).toContain('Detailed Description');
  expect(press.frame()).toContain('esc');
  expect(press.frame().split('\n').length).toBeLessThanOrEqual(12);
});


it('preserves the first typed chunk when returning from agent navigation to the editor', async () => {
  const press = mount(<AgentWizardView onCancel={vi.fn()} onComplete={vi.fn()} />);
  await press('\x1b[B');
  await press('RECOVER 試験 🦊');
  expect(press.frame()).toContain('RECOVER 試験 🦊');
});


it('lets a short-terminal confirmation summary be inspected while keeping title and actions visible', async () => {
  const press = mount(<InteractiveSurface scrollable title="Confirm agent" footer={<Text>enter create · esc cancel</Text>}>
    <Text>SUMMARY NAME</Text>
    {Array.from({ length: 30 }, (_, index) => <Text key={index}>DETAIL {index}</Text>)}
    <SelectionIndicator isSelected>Create Agent</SelectionIndicator>
  </InteractiveSurface>, { columns: 40, rows: 12 });
  await settle();
  expect(press.frame()).toContain('Create Agent');
  for (let index = 0; index < 8; index++) await press('\x1b[5~');
  expect(press.frame()).toContain('SUMMARY NAME');
  expect(press.frame()).toContain('Confirm agent');
  expect(press.frame()).toContain('enter create · esc cancel');
  expect(press.frame().split('\n').length).toBeLessThanOrEqual(12);
});
