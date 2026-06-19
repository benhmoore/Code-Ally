import { describe, it, expect } from 'vitest';
import { serializeAgent, parseAgentContent } from '../agentContentUtils.js';
import type { AgentData } from '../../types/agents.js';

describe('agentContentUtils', () => {
  describe('serializeAgent / parseAgentContent round-trip', () => {
    it('round-trips a minimal agent', () => {
      const agent: AgentData = {
        name: 'minimal',
        description: 'A minimal agent',
        system_prompt: 'You are minimal.',
      };

      const parsed = parseAgentContent(serializeAgent(agent, '2025-01-01T00:00:00Z'));

      expect(parsed.name).toBe('minimal');
      expect(parsed.description).toBe('A minimal agent');
      expect(parsed.system_prompt).toBe('You are minimal.');
      expect(parsed.created_at).toBe('2025-01-01T00:00:00Z');
      expect(parsed.updated_at).toBe('2025-01-01T00:00:00Z');
    });

    it('round-trips a fully-populated agent including requirements', () => {
      const agent: AgentData = {
        name: 'full-agent',
        description: 'Full configuration',
        system_prompt: 'Multi-line\nsystem prompt.',
        model: 'qwen2.5-coder:32b',
        temperature: 0.7,
        reasoning_effort: 'high',
        tools: ['read', 'grep'],
        usage_guidelines: 'Line one\nLine two',
        requirements: {
          required_tools_one_of: ['read', 'grep'],
          required_tools_all: ['read'],
          minimum_tool_calls: 2,
          require_tool_use: true,
          reminder_message: 'Use your tools',
        },
        visible_from_agents: ['explore', 'plan'],
        can_delegate_to_agents: false,
        can_see_agents: true,
        created_at: '2024-01-01T00:00:00Z',
      };

      const parsed = parseAgentContent(serializeAgent(agent, '2025-06-18T00:00:00Z'));

      expect(parsed.model).toBe('qwen2.5-coder:32b');
      expect(parsed.temperature).toBe(0.7);
      expect(parsed.reasoning_effort).toBe('high');
      expect(parsed.tools).toEqual(['read', 'grep']);
      expect(parsed.usage_guidelines).toBe('Line one\nLine two');
      expect(parsed.requirements).toEqual(agent.requirements);
      expect(parsed.visible_from_agents).toEqual(['explore', 'plan']);
      expect(parsed.can_delegate_to_agents).toBe(false);
      expect(parsed.can_see_agents).toBe(true);
      expect(parsed.system_prompt).toBe('Multi-line\nsystem prompt.');
    });

    it('preserves created_at while refreshing updated_at on edit', () => {
      const agent: AgentData = {
        name: 'edited',
        description: 'desc',
        system_prompt: 'prompt',
        created_at: '2020-01-01T00:00:00Z',
      };

      const parsed = parseAgentContent(serializeAgent(agent, '2025-12-31T23:59:59Z'));

      expect(parsed.created_at).toBe('2020-01-01T00:00:00Z');
      expect(parsed.updated_at).toBe('2025-12-31T23:59:59Z');
    });

    it('escapes special characters in quoted scalars', () => {
      const agent: AgentData = {
        name: 'quoter',
        description: 'Has "quotes" and a \\ backslash',
        system_prompt: 'prompt',
      };

      const parsed = parseAgentContent(serializeAgent(agent, '2025-01-01T00:00:00Z'));

      expect(parsed.description).toBe('Has "quotes" and a \\ backslash');
    });

    it('falls back to the provided name when frontmatter omits it', () => {
      const content = '---\ndescription: "no name field"\n---\n\nBody text.';
      const parsed = parseAgentContent(content, 'from-filename');
      expect(parsed.name).toBe('from-filename');
    });
  });

  describe('parseAgentContent validation', () => {
    it('throws on missing frontmatter', () => {
      expect(() => parseAgentContent('just a body, no frontmatter')).toThrow(/frontmatter/);
    });

    it('throws on a non-numeric temperature', () => {
      const content = '---\nname: "bad"\ntemperature: "hot"\n---\n\nBody.';
      expect(() => parseAgentContent(content)).toThrow(/temperature/);
    });

    it('throws on an empty body', () => {
      const content = '---\nname: "bad"\ndescription: "x"\n---\n\n   ';
      expect(() => parseAgentContent(content)).toThrow(/system prompt/);
    });
  });
});
