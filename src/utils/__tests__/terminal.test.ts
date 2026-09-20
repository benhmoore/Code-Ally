import { describe, expect, it } from 'vitest';
import { fileUrl, hyperlink, HYPERLINK_CLOSE, supportsHyperlinks } from '../terminal.js';

describe('hyperlink', () => {
  it('wraps text in an OSC 8 sequence that is closed afterwards', () => {
    expect(hyperlink('label', 'file:///tmp/a.ts')).toBe(`\x1b]8;;file:///tmp/a.ts\x1b\\label${HYPERLINK_CLOSE}`);
  });

  it('builds percent-encoded file URLs from absolute paths', () => {
    expect(fileUrl('/tmp/my dir/a#1.ts')).toBe('file:///tmp/my%20dir/a%231.ts');
  });
});

describe('supportsHyperlinks', () => {
  const tty = true;

  it('recognises emulators known to render OSC 8', () => {
    for (const program of ['iTerm.app', 'WezTerm', 'Hyper', 'vscode', 'ghostty']) {
      expect(supportsHyperlinks({ TERM_PROGRAM: program }, tty), program).toBe(true);
    }
    for (const term of ['xterm-kitty', 'alacritty', 'foot', 'wezterm']) {
      expect(supportsHyperlinks({ TERM: term }, tty), term).toBe(true);
    }
    expect(supportsHyperlinks({ WT_SESSION: 'x' }, tty)).toBe(true);
    expect(supportsHyperlinks({ KONSOLE_VERSION: '230800' }, tty)).toBe(true);
    expect(supportsHyperlinks({ TERMINAL_EMULATOR: 'JetBrains-JediTerm' }, tty)).toBe(true);
    expect(supportsHyperlinks({ VTE_VERSION: '6800' }, tty)).toBe(true);
  });

  it('stays plain for unknown or unsupporting terminals', () => {
    expect(supportsHyperlinks({ TERM_PROGRAM: 'Apple_Terminal' }, tty)).toBe(false);
    expect(supportsHyperlinks({ TERM: 'xterm-256color' }, tty)).toBe(false);
    expect(supportsHyperlinks({ VTE_VERSION: '4900' }, tty)).toBe(false);
    expect(supportsHyperlinks({}, tty)).toBe(false);
  });

  it('never emits links without a TTY or under CI', () => {
    expect(supportsHyperlinks({ TERM_PROGRAM: 'iTerm.app' }, false)).toBe(false);
    expect(supportsHyperlinks({ TERM_PROGRAM: 'iTerm.app', CI: 'true' }, tty)).toBe(false);
  });

  it('honours FORCE_HYPERLINK in both directions', () => {
    expect(supportsHyperlinks({ FORCE_HYPERLINK: '1' }, false)).toBe(true);
    expect(supportsHyperlinks({ FORCE_HYPERLINK: '0', TERM_PROGRAM: 'iTerm.app' }, tty)).toBe(false);
  });
});
