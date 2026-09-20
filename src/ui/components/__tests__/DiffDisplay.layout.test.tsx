import React from 'react';
import { EventEmitter } from 'node:events';
import { Box, render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stripAnsi } from '@utils/terminalText.js';
import { DiffDisplay } from '../DiffDisplay.js';

class FakeStdout extends EventEmitter {
  public readonly frames: string[] = [];
  columns = 160;
  rows = 40;
  isTTY = true;
  write = (frame: string): boolean => { this.frames.push(frame); return true; };
}

const mounted: Array<{ unmount: () => void }> = [];

afterEach(() => {
  for (const instance of mounted.splice(0)) instance.unmount();
});

const oldContent = 'const answer = 41;\nconst label = "old";\n';
const newContent = 'const answer = 42;\nconst label = "new";\nconst extra = true;\n';

const renderDiff = async (layout: 'unified' | 'side-by-side', width: number): Promise<string[]> => {
  const stdout = new FakeStdout();
  stdout.columns = width;
  const instance = render(
    <Box width={width}>
      <DiffDisplay oldContent={oldContent} newContent={newContent} filePath="answer.ts" layout={layout} syntaxHighlight={false} />
    </Box>,
    { stdout: stdout as unknown as NodeJS.WriteStream, debug: true, exitOnCtrlC: false, patchConsole: false }
  );
  mounted.push(instance);
  await vi.waitFor(() => expect(stdout.frames.length).toBeGreaterThan(0));
  return stripAnsi(stdout.frames.at(-1) ?? '').split('\n');
};

describe('DiffDisplay layout', () => {
  it('puts a removed line and its replacement on one row side by side', async () => {
    const lines = await renderDiff('side-by-side', 160);
    const row = lines.find((line) => line.includes('const answer = 41;'));

    expect(row).toBeDefined();
    expect(row).toContain('const answer = 42;');
    expect(row).toMatch(/-\s+const answer = 41;.*│.*\+\s+const answer = 42;/);
    expect(lines.find((line) => line.includes('const extra = true;'))).not.toContain('const label');
  });

  it('keeps removed and added lines on separate rows in unified layout', async () => {
    const lines = await renderDiff('unified', 160);
    const removed = lines.find((line) => line.includes('const answer = 41;'));

    expect(removed).toBeDefined();
    expect(removed).not.toContain('const answer = 42;');
  });
});
