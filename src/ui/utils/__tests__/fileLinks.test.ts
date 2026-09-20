import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileHyperlink, linkFileNameIn, terminalHyperlinksEnabled } from '../fileLinks.js';
import { stripAnsi } from '@utils/terminalText.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('terminalHyperlinksEnabled', () => {
  it('requires both the preference and a supporting terminal', () => {
    vi.stubEnv('FORCE_HYPERLINK', '1');
    expect(terminalHyperlinksEnabled({ enable_terminal_hyperlinks: true })).toBe(true);
    expect(terminalHyperlinksEnabled({})).toBe(true);
    expect(terminalHyperlinksEnabled({ enable_terminal_hyperlinks: false })).toBe(false);

    vi.stubEnv('FORCE_HYPERLINK', '0');
    expect(terminalHyperlinksEnabled({ enable_terminal_hyperlinks: true })).toBe(false);
  });
});

describe('fileHyperlink', () => {
  it('links the label to the resolved file URL', () => {
    const linked = fileHyperlink('a.ts', '/tmp/a.ts');

    expect(stripAnsi(linked)).toBe('a.ts');
    expect(linked).toContain('\x1b]8;;file:///tmp/a.ts\x1b\\');
  });

  it('resolves workspace-relative paths against the working directory', () => {
    expect(fileHyperlink('a.ts', 'src/a.ts')).toContain(`file://${process.cwd()}/src/a.ts`);
  });
});

describe('linkFileNameIn', () => {
  it('links only the file name inside a subtext', () => {
    const linked = linkFileNameIn('Read config (a.ts - 12 lines)', '/tmp/a.ts');

    expect(stripAnsi(linked)).toBe('Read config (a.ts - 12 lines)');
    expect(linked).toBe(`Read config (${fileHyperlink('a.ts', '/tmp/a.ts')} - 12 lines)`);
  });

  it('leaves text without the file name untouched', () => {
    expect(linkFileNameIn('Read config (a...', '/tmp/a-long-name.ts')).toBe('Read config (a...');
  });
});
