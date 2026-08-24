/**
 * CommandHandler tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CommandHandler } from '../CommandHandler.js';
import { ConfigManager } from '@services/ConfigManager.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { AgentManager } from '@services/AgentManager.js';
import { FocusManager } from '@services/FocusManager.js';
import type { Message } from '@shared/index.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ActivityStream } from '@services/ActivityStream.js';
import type { CommandExecutionContext } from '../commands/types.js';

class TestCommandHandler extends CommandHandler {
  constructor(agent: any, registry: ServiceRegistry, private readonly context: CommandExecutionContext) {
    super(agent, registry);
  }

  override handleCommand(input: string, messages: Message[]) {
    return super.handleCommand(input, messages, this.context);
  }
}

describe('CommandHandler', () => {
  let commandHandler: CommandHandler;
  let configManager: ConfigManager;
  let serviceRegistry: ServiceRegistry;
  let mockAgent: any;
  let tempDir: string;

  beforeEach(async () => {
    // Create service registry
    serviceRegistry = new ServiceRegistry();

    // Create and register services
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'ally-command-handler-'));
    configManager = new ConfigManager(path.join(tempDir, 'config.json'));
    await configManager.initialize();

    const agentManager = new AgentManager();

    const focusManager = new FocusManager();

    // Register services with snake_case keys that CommandHandler expects
    serviceRegistry.registerInstance('config_manager', configManager);
    serviceRegistry.registerInstance('agent_manager', agentManager);
    serviceRegistry.registerInstance('focus_manager', focusManager);

    // Mock agent
    mockAgent = {
      sendMessage: vi.fn(),
      getMessages: vi.fn(() => []),
    };

    // Create command handler
    const activityStream = new ActivityStream();
    commandHandler = new TestCommandHandler(mockAgent, serviceRegistry, {
      route: { id: 'main', kind: 'primary', agent: mockAgent, activityStream, isAvailable: () => true },
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('parseCommand', () => {
    it('should parse simple commands', async () => {
      const result = await commandHandler.handleCommand('/help', []);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('/help');
    });

    it('should parse commands with arguments', async () => {
      const result = await commandHandler.handleCommand('/model test-model', []);
      expect(result.handled).toBe(true);
    });

    it('should ignore non-commands', async () => {
      const result = await commandHandler.handleCommand('not a command', []);
      expect(result.handled).toBe(false);
    });
  });

  describe('Core Commands', () => {
    it('should handle /help', async () => {
      const result = await commandHandler.handleCommand('/help', []);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('**Core**');
      expect(result.response).toContain('/agent');
    });

    it('should handle /config-show', async () => {
      const result = await commandHandler.handleCommand('/config', []);
      expect(result.handled).toBe(true);
      // /config without args triggers UI viewer, no response text
    });

    it('should handle /config set', async () => {
      const result = await commandHandler.handleCommand('/config set temperature=0.5', []);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('Configuration updated');
    });

    it('should handle /config-reset', async () => {
      // First change a value
      await commandHandler.handleCommand('/config set temperature=0.9', []);

      // Then reset
      const result = await commandHandler.handleCommand('/config reset', []);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('reset');
    });

    it('should handle /model', async () => {
      const result = await commandHandler.handleCommand('/model', []);
      expect(result.handled).toBe(true);
      expect(result.response).toMatch(/Error fetching models|Current model|Failed to fetch|No models were reported/);
    });

    it('should handle /model <name>', async () => {
      const result = await commandHandler.handleCommand('/model qwen2.5-coder', []);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('Model changed');
    });

    it('should handle /debug', async () => {
      const result = await commandHandler.handleCommand('/debug', []);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('Debug Commands');
    });
  });

  describe('Agent Commands', () => {
    it('should handle /agent list', async () => {
      const result = await commandHandler.handleCommand('/agent list', []);
      expect(result.handled).toBe(true);
      expect(result.response).toMatch(/No agents|Available Agents/);
    });

    it('should handle /agent show', async () => {
      const result = await commandHandler.handleCommand('/agent show task', []);
      expect(result.handled).toBe(true);
    });

    it('should handle /agent delete', async () => {
      const result = await commandHandler.handleCommand('/agent delete test-agent', []);
      expect(result.handled).toBe(true);
    });
  });

  describe('Focus Commands', () => {
    it('should handle /focus without args', async () => {
      const result = await commandHandler.handleCommand('/focus', []);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('focus');
    });

    it('should handle /focus <path>', async () => {
      const result = await commandHandler.handleCommand('/focus .', []);
      expect(result.handled).toBe(true);
    });

    it('should handle /defocus', async () => {
      const result = await commandHandler.handleCommand('/defocus', []);
      expect(result.handled).toBe(true);
    });

    it('should handle /focus-show', async () => {
      const result = await commandHandler.handleCommand('/focus-show', []);
      expect(result.handled).toBe(true);
    });
  });

  describe('Project Commands', () => {
    // /project view and /project clear operate on ALLY.md in the cwd, so run
    // them against the temp dir rather than the repo checkout.
    let originalCwd: string;

    beforeEach(() => {
      originalCwd = process.cwd();
      process.chdir(tempDir);
    });

    afterEach(() => {
      process.chdir(originalCwd);
    });

    it('should report a missing ALLY.md for /project view', async () => {
      const result = await commandHandler.handleCommand('/project view', []);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('No ALLY.md found');
    });

    it('should show ALLY.md contents for /project view', async () => {
      await writeFile(path.join(tempDir, 'ALLY.md'), '# ALLY.md\n\nhello project\n');
      const result = await commandHandler.handleCommand('/project view', []);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('hello project');
    });

    it('should delete ALLY.md for /project clear', async () => {
      const allyPath = path.join(tempDir, 'ALLY.md');
      await writeFile(allyPath, '# ALLY.md\n');
      const result = await commandHandler.handleCommand('/project clear', []);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('Removed');
      expect(existsSync(allyPath)).toBe(false);
    });

    it('should be a no-op for /project clear without ALLY.md', async () => {
      const result = await commandHandler.handleCommand('/project clear', []);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('No ALLY.md to clear');
    });
  });


  describe('Error Handling', () => {
    it('should handle unknown commands', async () => {
      const result = await commandHandler.handleCommand('/unknown', []);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('Unknown command');
    });

    it('should handle invalid config values', async () => {
      const result = await commandHandler.handleCommand('/config invalid', []);
      expect(result.handled).toBe(true);
      expect(result.response).toMatch(/Invalid|format/);
    });
  });

  describe('conversation scopes', () => {
    it('rejects primary-only commands from a child route while allowing application commands', async () => {
      const raw = new CommandHandler(mockAgent, serviceRegistry);
      const childContext: CommandExecutionContext = {
        route: {
          id: 'child',
          kind: 'child',
          isAvailable: () => true,
          agent: mockAgent,
          activityStream: new ActivityStream('child'),
        },
      };

      await expect(raw.handleCommand('/debug', [], childContext)).resolves.toMatchObject({
        handled: true,
        response: expect.stringContaining('primary conversation'),
      });
      await expect(raw.handleCommand('/help', [], childContext)).resolves.toMatchObject({
        handled: true,
        response: expect.stringContaining('/help'),
      });
    });
  });
});
