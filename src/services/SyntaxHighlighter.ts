/**
 * SyntaxHighlighter Service
 *
 * Provides syntax highlighting for code blocks in markdown and tool output.
 * Uses cli-highlight for terminal-based syntax highlighting.
 */

import { highlight, supportsLanguage } from 'cli-highlight';
import { formatError } from '../utils/errorUtils.js';
import { logger } from './Logger.js';

export interface HighlightOptions {
  language?: string;
  theme?: string;
}

export class SyntaxHighlighter {
  private defaultTheme: string;

  constructor(theme: string = 'monokai') {
    this.defaultTheme = theme;
  }

  /**
   * Highlight code with syntax highlighting
   *
   * @param code - The code to highlight
   * @param options - Highlighting options
   * @returns Highlighted code string
   */
  highlight(code: string, options: HighlightOptions = {}): string {
    const language = options.language || this.detectLanguage(code);
    const theme = options.theme || this.defaultTheme;

    try {
      // Check if language is supported
      if (language && supportsLanguage(language)) {
        return highlight(code, { language, theme });
      }
      return code;
    } catch (error) {
      logger.warn(`Syntax highlighting failed for language '${language}':`, formatError(error));
      return code;
    }
  }

  /**
   * Auto-detect programming language from code patterns
   *
   * @param code - The code to analyze
   * @returns Detected language name or 'text'
   */
  detectLanguage(code: string): string {
    // TypeScript patterns (check before JavaScript)
    if (
      code.includes('interface ') ||
      (code.includes('type ') && code.includes('=')) ||
      (code.includes(': string') && !code.includes('{')) ||
      code.includes(': number') ||
      code.includes(': boolean') ||
      code.includes('<T>')
    ) {
      return 'typescript';
    }

    // JavaScript patterns
    if (
      code.includes('function ') ||
      code.includes('=>') ||
      code.includes('const ') ||
      code.includes('let ') ||
      code.includes('var ')
    ) {
      return 'javascript';
    }

    // Python patterns
    if (
      code.includes('def ') ||
      code.includes('import ') ||
      code.includes('from ') ||
      code.includes('class ') && code.includes('self')
    ) {
      return 'python';
    }

    // Bash/Shell patterns
    if (
      code.includes('#!/bin/bash') ||
      code.includes('#!/bin/sh') ||
      code.includes('echo ') ||
      code.includes('export ')
    ) {
      return 'bash';
    }

    // JSON patterns
    if (
      (code.trim().startsWith('{') && code.trim().endsWith('}')) ||
      (code.trim().startsWith('[') && code.trim().endsWith(']'))
    ) {
      try {
        JSON.parse(code);
        return 'json';
      } catch {
        // Not valid JSON
      }
    }

    // HTML patterns
    if (code.includes('<!DOCTYPE') || code.includes('<html') || code.includes('<div')) {
      return 'html';
    }

    // CSS patterns
    if (code.includes('{') && code.includes(':') && code.includes(';') && code.includes('}')) {
      return 'css';
    }

    // Go patterns
    if (code.includes('package ') && (code.includes('func ') || code.includes('import ('))) {
      return 'go';
    }

    // Rust patterns
    if (code.includes('fn ') && (code.includes('let ') || code.includes('mut '))) {
      return 'rust';
    }

    // Java patterns
    if (code.includes('public class ') || code.includes('private ') && code.includes('void ')) {
      return 'java';
    }

    // C/C++ patterns
    if (code.includes('#include') || code.includes('int main(')) {
      return 'cpp';
    }

    // Ruby patterns
    if (code.includes('require ') || code.includes('def ') && code.includes('end')) {
      return 'ruby';
    }

    // PHP patterns
    if (code.includes('<?php')) {
      return 'php';
    }

    // Default to text if no language detected
    return 'text';
  }

  /**
   * Check if a language is supported
   *
   * @param language - Language name to check
   * @returns True if supported
   */
  isLanguageSupported(language: string): boolean {
    return supportsLanguage(language);
  }

  /**
   * Set the default theme
   *
   * @param theme - Theme name
   */
  setTheme(theme: string): void {
    this.defaultTheme = theme;
  }
}
