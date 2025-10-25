/**
 * Tests for ArgumentParser
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ArgumentParser, type CLIOptions } from '../ArgumentParser.js';

describe('ArgumentParser', () => {
  let parser: ArgumentParser;

  beforeEach(() => {
    parser = new ArgumentParser();
  });

  describe('Model Settings', () => {
    it('should parse --model flag', () => {
      const options = parser.parse(['node', 'ally', '--model', 'qwen2.5:7b']);
      expect(options.model).toBe('qwen2.5:7b');
    });

    it('should parse --endpoint flag', () => {
      const options = parser.parse([
        'node',
        'ally',
        '--endpoint',
        'http://localhost:11434',
      ]);
      expect(options.endpoint).toBe('http://localhost:11434');
    });

    it('should parse --temperature flag', () => {
      const options = parser.parse(['node', 'ally', '--temperature', '0.7']);
      expect(options.temperature).toBe(0.7);
    });

    it('should parse --context-size flag', () => {
      const options = parser.parse(['node', 'ally', '--context-size', '32768']);
      expect(options.contextSize).toBe(32768);
    });

    it('should parse --max-tokens flag', () => {
      const options = parser.parse(['node', 'ally', '--max-tokens', '4096']);
      expect(options.maxTokens).toBe(4096);
    });
  });

  describe('Configuration Management', () => {
    it('should parse --init flag', () => {
      const options = parser.parse(['node', 'ally', '--init']);
      expect(options.init).toBe(true);
    });

    it('should parse --config flag', () => {
      const options = parser.parse(['node', 'ally', '--config']);
      expect(options.config).toBe(true);
    });

    it('should parse --config-show flag', () => {
      const options = parser.parse(['node', 'ally', '--config-show']);
      expect(options.configShow).toBe(true);
    });

    it('should parse --config-reset flag', () => {
      const options = parser.parse(['node', 'ally', '--config-reset']);
      expect(options.configReset).toBe(true);
    });
  });

  describe('Security and Behavior', () => {
    it('should parse --yes-to-all flag', () => {
      const options = parser.parse(['node', 'ally', '--yes-to-all']);
      expect(options.yesToAll).toBe(true);
    });

    it('should parse -y shorthand', () => {
      const options = parser.parse(['node', 'ally', '-y']);
      expect(options.yesToAll).toBe(true);
    });

    it('should parse --verbose flag', () => {
      const options = parser.parse(['node', 'ally', '--verbose']);
      expect(options.verbose).toBe(true);
    });

    it('should parse -v shorthand', () => {
      const options = parser.parse(['node', 'ally', '-v']);
      expect(options.verbose).toBe(true);
    });

    it('should parse --debug flag', () => {
      const options = parser.parse(['node', 'ally', '--debug']);
      expect(options.debug).toBe(true);
    });

    it('should parse --skip-ollama-check flag', () => {
      const options = parser.parse(['node', 'ally', '--skip-ollama-check']);
      expect(options.skipOllamaCheck).toBe(true);
    });

    it('should parse --focus flag', () => {
      const options = parser.parse(['node', 'ally', '--focus', '/path/to/dir']);
      expect(options.focus).toBe('/path/to/dir');
    });
  });

  describe('Session Management', () => {
    it('should parse --session flag', () => {
      const options = parser.parse([
        'node',
        'ally',
        '--session',
        'my-session',
      ]);
      expect(options.session).toBe('my-session');
    });

    it('should parse --once flag', () => {
      const options = parser.parse([
        'node',
        'ally',
        '--once',
        'Hello world',
      ]);
      expect(options.once).toBe('Hello world');
    });

    it('should parse -1 shorthand', () => {
      const options = parser.parse(['node', 'ally', '-1', 'Hello world']);
      expect(options.once).toBe('Hello world');
    });

    it('should parse --list-sessions flag', () => {
      const options = parser.parse(['node', 'ally', '--list-sessions']);
      expect(options.listSessions).toBe(true);
    });

    it('should parse --delete-session flag', () => {
      const options = parser.parse([
        'node',
        'ally',
        '--delete-session',
        'old-session',
      ]);
      expect(options.deleteSession).toBe('old-session');
    });

    it('should parse --no-session flag', () => {
      const options = parser.parse(['node', 'ally', '--no-session']);
      expect(options.noSession).toBe(true);
    });

    it('should parse --resume flag without value', () => {
      const options = parser.parse(['node', 'ally', '--resume']);
      expect(options.resume).toBe(true);
    });

    it('should parse --resume flag with session name', () => {
      const options = parser.parse([
        'node',
        'ally',
        '--resume',
        'session-123',
      ]);
      expect(options.resume).toBe('session-123');
    });
  });

  describe('Advanced Settings', () => {
    it('should parse --auto-confirm flag', () => {
      const options = parser.parse(['node', 'ally', '--auto-confirm']);
      expect(options.autoConfirm).toBe(true);
    });
  });

  describe('Multiple Flags', () => {
    it('should parse multiple flags together', () => {
      const options = parser.parse([
        'node',
        'ally',
        '--model',
        'qwen2.5:7b',
        '--temperature',
        '0.5',
        '--verbose',
        '--session',
        'test-session',
      ]);

      expect(options.model).toBe('qwen2.5:7b');
      expect(options.temperature).toBe(0.5);
      expect(options.verbose).toBe(true);
      expect(options.session).toBe('test-session');
    });

    it('should parse complex command with many flags', () => {
      const options = parser.parse([
        'node',
        'ally',
        '--model',
        'llama2',
        '--endpoint',
        'http://localhost:11434',
        '--temperature',
        '0.3',
        '--context-size',
        '16384',
        '--max-tokens',
        '7000',
        '--verbose',
      ]);

      expect(options.model).toBe('llama2');
      expect(options.endpoint).toBe('http://localhost:11434');
      expect(options.temperature).toBe(0.3);
      expect(options.contextSize).toBe(16384);
      expect(options.maxTokens).toBe(7000);
      expect(options.verbose).toBe(true);
    });
  });

  describe('Default Values', () => {
    it('should return undefined for unprovided optional flags', () => {
      const options = parser.parse(['node', 'ally']);

      expect(options.model).toBeUndefined();
      expect(options.init).toBeUndefined();
      expect(options.verbose).toBeUndefined();
      expect(options.session).toBeUndefined();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty arguments gracefully', () => {
      const options = parser.parse(['node', 'ally']);
      expect(options).toBeDefined();
    });

    it('should handle quoted strings in --once', () => {
      const options = parser.parse([
        'node',
        'ally',
        '--once',
        'What is the meaning of life?',
      ]);
      expect(options.once).toBe('What is the meaning of life?');
    });

    it('should handle paths with spaces in --focus', () => {
      const options = parser.parse([
        'node',
        'ally',
        '--focus',
        '/path/with spaces/dir',
      ]);
      expect(options.focus).toBe('/path/with spaces/dir');
    });
  });
});
