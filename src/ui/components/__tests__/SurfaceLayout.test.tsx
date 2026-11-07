import React from 'react';
import { EventEmitter } from 'events';
import { render, Text } from 'ink';
import { describe, expect, test } from 'vitest';
import { ModelSelector } from '../ModelSelector.js';
import { PromptLibrarySelector } from '../PromptLibrarySelector.js';
import { InteractiveSurface } from '../InteractiveSurface.js';

class FakeStdout extends EventEmitter {
  public frames: string[] = [];
  public columns: number;
  public rows: number;

  constructor(columns = 80, rows = 24) {
    super();
    this.columns = columns;
    this.rows = rows;
  }

  write = (frame: string): boolean => {
    this.frames.push(frame);
    return true;
  };
}

const stripAnsi = (value: string): string => value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

function renderFrame(node: React.ReactElement, columns = 80, rows = 24): string[] {
  const stdout = new FakeStdout(columns, rows);
  const instance = render(node, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  instance.unmount();
  const frame = stdout.frames.findLast(candidate => stripAnsi(candidate).trim().length > 0) ?? '';
  return stripAnsi(frame).split('\n');
}

describe('compact interactive surfaces', () => {
  test('long titles and metadata share one bounded row on narrow terminals', () => {
    const lines = renderFrame(
      <InteractiveSurface title="A very long surface title that needs truncation" meta="20 of 100">
        <Text>Content</Text>
      </InteractiveSurface>, 40, 12
    );
    expect(lines.filter(line => line.trim())).toHaveLength(3);
    expect(lines.every(line => line.length <= 40)).toBe(true);
    expect(lines.join('\n')).toContain('Content');
  });
  test('a two-item model selector does not manufacture empty height', () => {
    const lines = renderFrame(
      <ModelSelector
        models={[{ name: 'small' }, { name: 'large' }]}
        selectedIndex={0}
        currentModel="small"
      />
    );

    expect(lines.filter(line => line.trim())).toHaveLength(5);
    expect(lines.join('\n')).toContain('↑↓ move · enter select · esc cancel');
  });

  test('model selection keeps one information row per model and one hint row at 40 columns', () => {
    const lines = renderFrame(
      <ModelSelector models={[{ name: 'qwen3.8:27b-mlx' }, { name: 'small' }]} selectedIndex={0} currentModel="qwen3.8:27b-mlx" />,
      40, 12
    );
    const content = lines.join('\n');
    expect(content.match(/qwen3\.8:27b-mlx/g)).toHaveLength(1);
    expect(content).toContain('1 of 2');
    expect(lines.some(line => line.includes('↑↓ move · enter select · esc cancel'))).toBe(true);
    expect(lines.length).toBeLessThanOrEqual(8);
  });

  test('a one-item prompt library remains compact', () => {
    const lines = renderFrame(
      <PromptLibrarySelector
        prompts={[{
          id: 'one',
          title: 'One prompt',
          content: 'Be concise.',
          createdAt: Date.now(),
        }]}
        selectedIndex={0}
      />
    );

    expect(lines.length).toBeLessThanOrEqual(9);
    expect(lines.join('\n')).toContain('Prompt library · 1');
  });

  test('long lists stay inside a 24-row frame', () => {
    const models = Array.from({ length: 30 }, (_, index) => ({ name: `model-${index}` }));
    const lines = renderFrame(<ModelSelector models={models} selectedIndex={15} />, 80, 24);

    expect(lines.length).toBeLessThan(24);
    expect(lines.join('\n')).toContain('↑ 10 more');
    expect(lines.join('\n')).toContain('↓ 10 more');
  });
});
