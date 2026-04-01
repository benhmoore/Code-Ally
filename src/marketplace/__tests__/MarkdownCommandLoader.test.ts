/**
 * Tests for MarkdownCommandLoader - loading dynamic commands from plugin directories
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { MarkdownCommandLoader, DynamicPluginCommand } from '@marketplace/MarkdownCommandLoader.js';
import type { PluginManager } from '@marketplace/PluginManager.js';

describe('MarkdownCommandLoader', () => {
  let loader: MarkdownCommandLoader;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join('/tmp', `cmd-loader-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });
    loader = new MarkdownCommandLoader();
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  describe('loadCommandsFromPlugin', () => {
    it('loads a simple command from a .md file', async () => {
      const pluginDir = join(tempDir, 'my-plugin');
      await createCommandFile(pluginDir, 'hello.md', `---
allowed-tools:
  - "mcp-test-*"
---

Say hello. Query: $ARGUMENTS`);

      const commands = await loader.loadCommandsFromPlugin(pluginDir, 'my-plugin');

      expect(commands).toHaveLength(1);
      expect(commands[0].name).toBe('/hello');
      expect(commands[0].pluginName).toBe('my-plugin');
    });

    it('parses allowed-tools from frontmatter', async () => {
      const pluginDir = join(tempDir, 'my-plugin');
      await createCommandFile(pluginDir, 'search.md', `---
allowed-tools:
  - "mcp-rt-*"
  - "mcp-wiki-*"
---

Search things. $ARGUMENTS`);

      const commands = await loader.loadCommandsFromPlugin(pluginDir, 'my-plugin');
      const cmd = commands[0] as DynamicPluginCommand;

      // Execute to verify allowed-tools are passed through
      const result = await cmd.execute(['test', 'query'], [], {} as any);
      expect(result.handled).toBe(true);
      expect((result.metadata as any)?.allowedTools).toEqual(['mcp-rt-*', 'mcp-wiki-*']);
    });

    it('replaces $ARGUMENTS in body', async () => {
      const pluginDir = join(tempDir, 'my-plugin');
      await createCommandFile(pluginDir, 'greet.md', `---
allowed-tools: []
---

The user said: $ARGUMENTS. Please respond.`);

      const commands = await loader.loadCommandsFromPlugin(pluginDir, 'my-plugin');
      const result = await commands[0].execute(['hello', 'world'], [], {} as any);

      expect(result.response).toContain('The user said: hello world. Please respond.');
    });

    it('returns empty array when no commands/ directory exists', async () => {
      const pluginDir = join(tempDir, 'empty-plugin');
      await fs.mkdir(pluginDir, { recursive: true });

      const commands = await loader.loadCommandsFromPlugin(pluginDir, 'empty-plugin');
      expect(commands).toEqual([]);
    });

    it('ignores non-.md files', async () => {
      const pluginDir = join(tempDir, 'my-plugin');
      const cmdDir = join(pluginDir, 'commands');
      await fs.mkdir(cmdDir, { recursive: true });
      await fs.writeFile(join(cmdDir, 'README.txt'), 'not a command');
      await fs.writeFile(join(cmdDir, 'actual.md'), '---\nallowed-tools: []\n---\nBody');

      const commands = await loader.loadCommandsFromPlugin(pluginDir, 'my-plugin');
      expect(commands).toHaveLength(1);
      expect(commands[0].name).toBe('/actual');
    });

    it('handles markdown without frontmatter', async () => {
      const pluginDir = join(tempDir, 'my-plugin');
      await createCommandFile(pluginDir, 'plain.md', 'Just plain markdown, no frontmatter. $ARGUMENTS');

      const commands = await loader.loadCommandsFromPlugin(pluginDir, 'my-plugin');
      expect(commands).toHaveLength(1);

      const result = await commands[0].execute(['test'], [], {} as any);
      expect(result.response).toContain('Just plain markdown');
    });

    it('loads multiple commands from one plugin', async () => {
      const pluginDir = join(tempDir, 'my-plugin');
      await createCommandFile(pluginDir, 'cmd1.md', '---\nallowed-tools: []\n---\nFirst');
      await createCommandFile(pluginDir, 'cmd2.md', '---\nallowed-tools: []\n---\nSecond');
      await createCommandFile(pluginDir, 'cmd3.md', '---\nallowed-tools: []\n---\nThird');

      const commands = await loader.loadCommandsFromPlugin(pluginDir, 'my-plugin');
      expect(commands).toHaveLength(3);
    });
  });

  describe('loadAllPluginCommands', () => {
    it('loads commands from all enabled plugins', async () => {
      // Create two fake plugin dirs with commands
      const plugin1 = join(tempDir, 'plugin-1');
      await createCommandFile(plugin1, 'alpha.md', '---\nallowed-tools: []\n---\nAlpha');

      const plugin2 = join(tempDir, 'plugin-2');
      await createCommandFile(plugin2, 'beta.md', '---\nallowed-tools: []\n---\nBeta');

      const mockPluginManager = {
        getEnabledPlugins: vi.fn().mockReturnValue([
          { pluginName: 'plugin-1', installPath: plugin1, pluginKey: 'plugin-1@mkt', enabled: true },
          { pluginName: 'plugin-2', installPath: plugin2, pluginKey: 'plugin-2@mkt', enabled: true },
        ]),
      } as unknown as PluginManager;

      const commands = await loader.loadAllPluginCommands(mockPluginManager);
      expect(commands).toHaveLength(2);
      expect(commands.map(c => c.name).sort()).toEqual(['/alpha', '/beta']);
    });
  });

  describe('DynamicPluginCommand', () => {
    it('has correct command metadata', () => {
      const cmd = new DynamicPluginCommand('test', 'my-plugin', 'A test command', 'Body', []);
      expect(cmd.name).toBe('/test');
      expect(cmd.description).toBe('A test command');
      expect(cmd.pluginName).toBe('my-plugin');
    });

    it('returns handled=true from execute', async () => {
      const cmd = new DynamicPluginCommand('test', 'my-plugin', '', 'Body: $ARGUMENTS', ['tool-*']);
      const result = await cmd.execute(['arg1'], [], {} as any);

      expect(result.handled).toBe(true);
      expect(result.response).toBe('Body: arg1');
    });
  });

  // Helper to create a commands/*.md file
  async function createCommandFile(pluginDir: string, filename: string, content: string): Promise<void> {
    const cmdDir = join(pluginDir, 'commands');
    await fs.mkdir(cmdDir, { recursive: true });
    await fs.writeFile(join(cmdDir, filename), content);
  }
});
