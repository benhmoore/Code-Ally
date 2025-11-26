/**
 * CommandHistory unit tests
 *
 * Tests command history storage, navigation, persistence, and search
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CommandHistory } from '../CommandHistory.js';

describe('CommandHistory', () => {
  let tempDir: string;
  let historyPath: string;

  beforeEach(async () => {
    // Create a temporary directory for test history
    tempDir = join(tmpdir(), `code-ally-test-${Date.now()}-${Math.random().toString(36).substring(7)}`);
    await fs.mkdir(tempDir, { recursive: true });
    historyPath = join(tempDir, 'history.json');
  });

  afterEach(async () => {
    // Cleanup
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('initialization and loading', () => {
    it('should initialize with empty history', () => {
      const history = new CommandHistory({ storagePath: historyPath });
      expect(history.isEmpty()).toBe(true);
      expect(history.size()).toBe(0);
    });

    it('should load from non-existent file without error', async () => {
      const history = new CommandHistory({ storagePath: historyPath });
      await history.load();
      expect(history.isEmpty()).toBe(true);
    });

    it('should load existing history from file', async () => {
      // Create a history file
      const testHistory = [
        { command: 'echo hello', timestamp: Date.now() - 2000 },
        { command: 'ls -la', timestamp: Date.now() - 1000 },
        { command: '/help', timestamp: Date.now() },
      ];
      await fs.writeFile(historyPath, JSON.stringify(testHistory), 'utf-8');

      const history = new CommandHistory({ storagePath: historyPath });
      await history.load();

      expect(history.size()).toBe(3);
      expect(history.getCommands()).toEqual(['echo hello', 'ls -la', '/help']);
    });

    it('should handle malformed JSON gracefully', async () => {
      await fs.writeFile(historyPath, 'invalid json{{{', 'utf-8');

      const history = new CommandHistory({ storagePath: historyPath });
      await history.load();

      expect(history.isEmpty()).toBe(true);
    });

    it('should filter out invalid entries', async () => {
      const testHistory = [
        { command: 'echo hello', timestamp: Date.now() },
        { invalid: 'entry' }, // Missing required fields
        { command: 'ls -la', timestamp: 'invalid' }, // Invalid timestamp type
        { command: 'pwd', timestamp: Date.now() },
      ];
      await fs.writeFile(historyPath, JSON.stringify(testHistory), 'utf-8');

      const history = new CommandHistory({ storagePath: historyPath });
      await history.load();

      expect(history.size()).toBe(2);
      expect(history.getCommands()).toEqual(['echo hello', 'pwd']);
    });
  });

  describe('adding commands', () => {
    it('should add a command', () => {
      const history = new CommandHistory({ storagePath: historyPath });
      history.addCommand('echo test');

      expect(history.size()).toBe(1);
      expect(history.getCommands()).toEqual(['echo test']);
    });

    it('should trim whitespace', () => {
      const history = new CommandHistory({ storagePath: historyPath });
      history.addCommand('  echo test  ');

      expect(history.getCommands()).toEqual(['echo test']);
    });

    it('should skip empty commands', () => {
      const history = new CommandHistory({ storagePath: historyPath });
      history.addCommand('');
      history.addCommand('   ');
      history.addCommand('\n\t');

      expect(history.isEmpty()).toBe(true);
    });

    it('should skip consecutive duplicates', () => {
      const history = new CommandHistory({ storagePath: historyPath });
      history.addCommand('echo hello');
      history.addCommand('echo hello');
      history.addCommand('ls');
      history.addCommand('ls');
      history.addCommand('ls');

      expect(history.size()).toBe(2);
      expect(history.getCommands()).toEqual(['echo hello', 'ls']);
    });

    it('should allow non-consecutive duplicates', () => {
      const history = new CommandHistory({ storagePath: historyPath });
      history.addCommand('echo hello');
      history.addCommand('ls');
      history.addCommand('echo hello'); // Allowed - not consecutive

      expect(history.size()).toBe(3);
      expect(history.getCommands()).toEqual(['echo hello', 'ls', 'echo hello']);
    });

    it('should respect max size', () => {
      const history = new CommandHistory({ storagePath: historyPath, maxSize: 5 });

      for (let i = 0; i < 10; i++) {
        history.addCommand(`command ${i}`);
      }

      expect(history.size()).toBe(5);
      // Should keep the last 5
      expect(history.getCommands()).toEqual([
        'command 5',
        'command 6',
        'command 7',
        'command 8',
        'command 9',
      ]);
    });
  });

  describe('navigation', () => {
    let history: CommandHistory;

    beforeEach(() => {
      history = new CommandHistory({ storagePath: historyPath });
      history.addCommand('first');
      history.addCommand('second');
      history.addCommand('third');
    });

    it('should get previous command from initial state', () => {
      const result = history.getPrevious(-1);
      expect(result).toEqual({ command: 'third', index: 2 });
    });

    it('should navigate backward through history', () => {
      let result = history.getPrevious(-1);
      expect(result?.command).toBe('third');

      result = history.getPrevious(result!.index);
      expect(result?.command).toBe('second');

      result = history.getPrevious(result!.index);
      expect(result?.command).toBe('first');

      result = history.getPrevious(result!.index);
      expect(result).toBeNull(); // Beginning of history
    });

    it('should navigate forward through history', () => {
      // Go to beginning
      let result = history.getPrevious(-1); // third
      result = history.getPrevious(result!.index); // second
      result = history.getPrevious(result!.index); // first

      // Now go forward
      result = history.getNext(result!.index);
      expect(result?.command).toBe('second');

      result = history.getNext(result!.index);
      expect(result?.command).toBe('third');

      result = history.getNext(result!.index);
      expect(result).toBeNull(); // End of history
    });

    it('should get command by index', () => {
      expect(history.getCommand(0)).toBe('first');
      expect(history.getCommand(1)).toBe('second');
      expect(history.getCommand(2)).toBe('third');
      expect(history.getCommand(-1)).toBeNull();
      expect(history.getCommand(999)).toBeNull();
    });
  });

  describe('search', () => {
    let history: CommandHistory;

    beforeEach(() => {
      history = new CommandHistory({ storagePath: historyPath });
      history.addCommand('echo hello world');
      history.addCommand('ls -la');
      history.addCommand('echo goodbye');
      history.addCommand('/help agent');
      history.addCommand('/config show');
      history.addCommand('echo test');
    });

    it('should search for matching commands', () => {
      const results = history.search('echo');
      expect(results).toEqual(['echo test', 'echo goodbye', 'echo hello world']);
    });

    it('should search case-insensitively', () => {
      const results = history.search('ECHO');
      expect(results.length).toBe(3);
    });

    it('should return most recent first', () => {
      const results = history.search('echo');
      expect(results[0]).toBe('echo test'); // Most recent
    });

    it('should respect limit', () => {
      const results = history.search('echo', 2);
      expect(results.length).toBe(2);
      expect(results).toEqual(['echo test', 'echo goodbye']);
    });

    it('should deduplicate results', () => {
      history.addCommand('echo hello world'); // Add duplicate
      const results = history.search('hello');
      // Should only return one instance
      expect(results.filter(cmd => cmd === 'echo hello world').length).toBe(1);
    });

    it('should return empty array for no matches', () => {
      const results = history.search('nonexistent');
      expect(results).toEqual([]);
    });

    it('should handle partial matches', () => {
      const results = history.search('/');
      expect(results).toEqual(['/config show', '/help agent']);
    });
  });

  describe('persistence', () => {
    it('should save history to file', async () => {
      const history = new CommandHistory({ storagePath: historyPath });
      history.addCommand('test command');

      await history.save();

      // Wait for debounce
      await new Promise(resolve => setTimeout(resolve, 150));

      // Verify file exists and content is correct
      const content = await fs.readFile(historyPath, 'utf-8');
      const parsed = JSON.parse(content);

      expect(parsed.length).toBe(1);
      expect(parsed[0].command).toBe('test command');
    });

    it('should create parent directory if needed', async () => {
      const nestedPath = join(tempDir, 'nested', 'dir', 'history.json');
      const history = new CommandHistory({ storagePath: nestedPath });

      await history.load();
      history.addCommand('test');
      await history.save();

      await new Promise(resolve => setTimeout(resolve, 150));

      const exists = await fs
        .access(nestedPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });

    it('should persist and reload history', async () => {
      // Create and save history
      const history1 = new CommandHistory({ storagePath: historyPath });
      history1.addCommand('command 1');
      history1.addCommand('command 2');
      await history1.save();

      await new Promise(resolve => setTimeout(resolve, 150));

      // Load in new instance
      const history2 = new CommandHistory({ storagePath: historyPath });
      await history2.load();

      expect(history2.size()).toBe(2);
      expect(history2.getCommands()).toEqual(['command 1', 'command 2']);
    });
  });

  describe('clear', () => {
    it('should clear all history', async () => {
      const history = new CommandHistory({ storagePath: historyPath });
      history.addCommand('test 1');
      history.addCommand('test 2');

      await history.clear();

      expect(history.isEmpty()).toBe(true);
      expect(history.size()).toBe(0);
    });

    it('should remove file when cleared', async () => {
      const history = new CommandHistory({ storagePath: historyPath });
      history.addCommand('test');
      await history.save();

      await new Promise(resolve => setTimeout(resolve, 150));

      await history.clear();

      const content = await fs.readFile(historyPath, 'utf-8');
      expect(JSON.parse(content)).toEqual([]);
    });
  });

  describe('import/export', () => {
    it('should export history as JSON', () => {
      const history = new CommandHistory({ storagePath: historyPath });
      history.addCommand('test 1');
      history.addCommand('test 2');

      const exported = history.export();
      const parsed = JSON.parse(exported);

      expect(parsed.length).toBe(2);
      expect(parsed[0].command).toBe('test 1');
    });

    it('should import history from JSON', () => {
      const testData = [
        { command: 'imported 1', timestamp: Date.now() },
        { command: 'imported 2', timestamp: Date.now() },
      ];

      const history = new CommandHistory({ storagePath: historyPath });
      history.import(JSON.stringify(testData));

      expect(history.size()).toBe(2);
      expect(history.getCommands()).toEqual(['imported 1', 'imported 2']);
    });

    it('should trim to max size on import', () => {
      const testData = Array.from({ length: 10 }, (_, i) => ({
        command: `command ${i}`,
        timestamp: Date.now(),
      }));

      const history = new CommandHistory({ storagePath: historyPath, maxSize: 5 });
      history.import(JSON.stringify(testData));

      expect(history.size()).toBe(5);
    });

    it('should throw on invalid JSON import', () => {
      const history = new CommandHistory({ storagePath: historyPath });
      expect(() => history.import('invalid json{')).toThrow();
    });
  });

  describe('getHistory', () => {
    it('should return full history entries', () => {
      const history = new CommandHistory({ storagePath: historyPath });
      history.addCommand('test 1');
      history.addCommand('test 2');

      const entries = history.getHistory();

      expect(entries.length).toBe(2);
      expect(entries[0].command).toBe('test 1');
      expect(entries[0].timestamp).toBeTypeOf('number');
      expect(entries[1].command).toBe('test 2');
    });

    it('should return a copy (not original)', () => {
      const history = new CommandHistory({ storagePath: historyPath });
      history.addCommand('test');

      const entries1 = history.getHistory();
      const entries2 = history.getHistory();

      expect(entries1).not.toBe(entries2); // Different references
      expect(entries1).toEqual(entries2); // Same content
    });
  });
});
