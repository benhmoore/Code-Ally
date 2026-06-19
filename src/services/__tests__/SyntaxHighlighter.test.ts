/**
 * Tests for SyntaxHighlighter service
 */

import { describe, it, expect } from 'vitest';
import { SyntaxHighlighter } from '../SyntaxHighlighter.js';

describe('SyntaxHighlighter', () => {
  const highlighter = new SyntaxHighlighter();

  it('should detect JavaScript code', () => {
    const code = 'const x = 5; function test() {}';
    expect(highlighter.detectLanguage(code)).toBe('javascript');
  });

  it('should detect TypeScript code', () => {
    const code = 'interface Test { name: string; }';
    expect(highlighter.detectLanguage(code)).toBe('typescript');
  });

  it('should prefer TypeScript React filename detection over content fallback', () => {
    expect(highlighter.detectLanguage('export default function App() {}', 'src/App.tsx')).toBe('tsx');
  });

  it('should detect Python code', () => {
    const code = 'def test():\n    pass';
    expect(highlighter.detectLanguage(code)).toBe('python');
  });

  it('should detect Python from filename', () => {
    expect(highlighter.detectLanguage('print("hello")', 'scripts/task.py')).toBe('python');
  });

  it('should detect PowerShell from filename', () => {
    expect(highlighter.detectLanguage('Write-Host "hello"', 'scripts/install.ps1')).toBe('powershell');
  });

  it('should detect HTML from filename', () => {
    expect(highlighter.detectLanguage('<button>Save</button>', 'src/app.component.html')).toBe('html');
  });

  it('should detect JSON code', () => {
    const code = '{"key": "value"}';
    expect(highlighter.detectLanguage(code)).toBe('json');
  });

  it('should map JSON-with-comments filenames to JSON highlighting', () => {
    expect(highlighter.detectLanguage('{/* comment */}', 'config/settings.jsonc')).toBe('json');
  });

  it('should detect Bash code', () => {
    const code = '#!/bin/bash\necho "test"';
    expect(highlighter.detectLanguage(code)).toBe('bash');
  });

  it('should detect common extensionless filenames', () => {
    expect(highlighter.detectLanguage('FROM node:20', 'Dockerfile')).toBe('dockerfile');
    expect(highlighter.detectLanguage('build:\n\tgo build ./...', 'Makefile')).toBe('makefile');
  });

  it('should detect Go code', () => {
    const code = 'package main\nfunc main() {}';
    expect(highlighter.detectLanguage(code)).toBe('go');
  });

  it('should default to text for unknown languages', () => {
    const code = 'some random text';
    expect(highlighter.detectLanguage(code)).toBe('text');
  });

  it('should highlight code without throwing', () => {
    const code = 'const x = 5;';
    expect(() => highlighter.highlight(code)).not.toThrow();
  });

  it('should handle unsupported languages gracefully', () => {
    const code = 'some code';
    const result = highlighter.highlight(code, { language: 'unknown' });
    expect(result).toBe(code);
  });

  it('should set and use custom theme', () => {
    highlighter.setTheme('dracula');
    expect(() => highlighter.highlight('const x = 5;')).not.toThrow();
  });

  it('should check language support', () => {
    expect(highlighter.isLanguageSupported('javascript')).toBe(true);
    expect(highlighter.isLanguageSupported('unknown')).toBe(false);
  });
});
