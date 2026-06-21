import { describe, it, expect } from 'vitest';
import {
  inlineMarkdownToSegments,
  parseMarkdownContent,
  renderInlineMarkdownForTerminal,
  renderInlineMarkdownLinesForTerminal,
} from '../MarkdownText.js';
import type { StyledSegment } from '../MarkdownText.js';
import { stripAnsi } from '@utils/terminalText.js';

const segmentText = (segments: StyledSegment[] = []): string =>
  segments.map((segment) => segment.text).join('');

describe('MarkdownText', () => {
  it('parses inline markdown without retaining delimiter syntax', () => {
    const segments = inlineMarkdownToSegments('**Build Commands** and `npm run build` plus *note*');

    expect(segmentText(segments)).toBe('Build Commands and npm run build plus note');
    expect(segmentText(segments)).not.toContain('**');
    expect(segmentText(segments)).not.toContain('`');
    expect(segments.find((segment) => segment.text === 'Build Commands')?.bold).toBe(true);
    expect(segments.find((segment) => segment.text === 'npm run build')?.code).toBe(true);
    expect(segments.find((segment) => segment.text === 'note')?.italic).toBe(true);
  });

  it('uses marked inline tokens for screenshot-style paragraphs', () => {
    const nodes = parseMarkdownContent('**Build Commands**\n  • `npm run build` - Builds both web and API');
    const paragraph = nodes[0];

    expect(paragraph?.type).toBe('paragraph');
    expect(segmentText(paragraph?.segments)).toBe('Build Commands\n  • npm run build - Builds both web and API');
    expect(segmentText(paragraph?.segments)).not.toContain('**');
    expect(segmentText(paragraph?.segments)).not.toContain('`');
  });

  it('preserves nested emphasis and inline code styles in list items', () => {
    const [list] = parseMarkdownContent('- **Preview-first deployment:** Changes pushed to `main`');
    const item = list?.children?.[0];

    expect(list?.type).toBe('list');
    expect(segmentText(item?.segments)).toBe('Preview-first deployment: Changes pushed to main');
    expect(item?.segments?.find((segment) => segment.text === 'Preview-first deployment:')?.bold).toBe(true);
    expect(item?.segments?.find((segment) => segment.text === 'main')?.code).toBe(true);
  });

  it('supports model color tags, hard breaks, and links as styled tokens', () => {
    const segments = inlineMarkdownToSegments('<cyan>focus **now**</cyan><br>[docs](https://example.test)');

    expect(segmentText(segments)).toBe('focus now\ndocs');
    expect(segments.find((segment) => segment.text === 'focus ')?.color).toBe('cyan');
    expect(segments.find((segment) => segment.text === 'now')?.bold).toBe(true);
    expect(segments.find((segment) => segment.text === 'now')?.color).toBe('cyan');
    expect(segments.find((segment) => segment.text === 'docs')?.underline).toBe(true);
  });

  it('renders terminal lines without leaking ANSI state across hard breaks', () => {
    const rendered = renderInlineMarkdownLinesForTerminal('<cyan>first<br>second</cyan>');

    expect(rendered.map(stripAnsi)).toEqual(['first', 'second']);
    expect(rendered[0]).toMatch(/\x1b\[36mfirst\x1b\[39m/);
    expect(rendered[1]).toMatch(/\x1b\[36msecond\x1b\[39m/);
  });

  it('renders inline markdown to terminal text without raw markdown delimiters', () => {
    const rendered = renderInlineMarkdownForTerminal('**Build** with `npm test`');

    expect(stripAnsi(rendered)).toBe('Build with npm test');
    expect(stripAnsi(rendered)).not.toContain('**');
    expect(stripAnsi(rendered)).not.toContain('`');
  });

  it('normalizes inline markdown before measuring table cells', () => {
    const [table] = parseMarkdownContent('| Name | Command |\n| --- | --- |\n| **Build** | `npm run build` |');

    expect(table?.type).toBe('table');
    expect(stripAnsi(table?.header?.[0] ?? '')).toBe('Name');
    expect(stripAnsi(table?.rows?.[0]?.[0] ?? '')).toBe('Build');
    expect(stripAnsi(table?.rows?.[0]?.[1] ?? '')).toBe('npm run build');
    expect(stripAnsi(table?.rows?.[0]?.[0] ?? '')).not.toContain('**');
  });

  it('captures GitHub-style task list state', () => {
    const [list] = parseMarkdownContent('- [x] **Done**\n- [ ] Todo');
    const [done, todo] = list?.children ?? [];

    expect(done?.task).toBe(true);
    expect(done?.checked).toBe(true);
    expect(segmentText(done?.segments)).toBe('Done');
    expect(todo?.task).toBe(true);
    expect(todo?.checked).toBe(false);
    expect(segmentText(todo?.segments)).toBe('Todo');
  });
});
