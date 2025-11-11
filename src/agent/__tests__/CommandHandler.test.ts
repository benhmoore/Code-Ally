/**
 * CommandHandler tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CommandHandler } from '../CommandHandler.js';
import { ConfigManager } from '@services/ConfigManager.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { AgentManager } from '@services/AgentManager.js';
import { FocusManager } from '@services/FocusManager.js';
import { ProjectManager } from '@services/ProjectManager.js';
import type { Message } from '@shared/index.js';

describe('CommandHandler', () => {
  let commandHandler: CommandHandler;
  let configManager: ConfigManager;
  let serviceRegistry: ServiceRegistry;
  let mockAgent: any;

  beforeEach(async () => {
    // Create service registry
    serviceRegistry = new ServiceRegistry();

    // Create and register services
    configManager = new ConfigManager();
    await configManager.initialize();

    const agentManager = new AgentManager();

    const focusManager = new FocusManager();

    const projectManager = new ProjectManager();
    await projectManager.initialize();

    // Register services with snake_case keys that CommandHandler expects
    serviceRegistry.registerInstance('config_manager', configManager);
    serviceRegistry.registerInstance('agent_manager', agentManager);
    serviceRegistry.registerInstance('focus_manager', focusManager);
    serviceRegistry.registerInstance('project_manager', projectManager);

    // Mock agent
    mockAgent = {
      sendMessage: vi.fn(),
      getMessages: vi.fn(() => []),
    };

    // Create command handler
    commandHandler = new CommandHandler(mockAgent, configManager, serviceRegistry);
  });

  describe('parseCommand', () => {
    it('should parse simple commands', async () => {
      const result = await commandHandler.handleCommand('/help', []);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('Available Commands');
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
      expect(result.response).toContain('Core Commands');
      expect(result.response).toContain('Agent Commands');
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
      // In test environment, Ollama isn't running, so we get an error or model selector
      expect(result.response).toMatch(/Error fetching models|Current model|Failed to fetch/);
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
      const result = await commandHandler.handleCommand('/agent show general', []);
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
    it('should handle /project view', async () => {
      const result = await commandHandler.handleCommand('/project view', []);
      expect(result.handled).toBe(true);
    });

    it('should handle /project clear', async () => {
      const result = await commandHandler.handleCommand('/project clear', []);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('cleared');
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
});
