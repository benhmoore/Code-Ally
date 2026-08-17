import { describe, expect, it } from 'vitest';
import {
  createRuntimeCoreToolDefinitions,
  createRuntimeCoreToolDefinitionsForContext,
  describeToolProfile,
  normalizeProviderToolDefinitions,
} from '../runtimeToolProfiles.js';

describe('runtime tool profiles', () => {
  it('captures the real interactive Ally core surface with stable metadata', () => {
    const definitions = createRuntimeCoreToolDefinitions();
    const profile = describeToolProfile(definitions);

    expect(profile.count).toBe(21);
    expect(profile.names).toContain('read');
    expect(profile.names).toContain('tool-search');
    expect(profile.names).toContain('ask-user-question');
    expect(profile.names).not.toContain('write-agent');
    expect(profile.names).not.toContain('scheduled-tasks');
    expect(profile.names).not.toContain('bash-output');
    expect(profile.names).not.toContain('line-edit');
    expect(profile.names).not.toContain('agent-ask');
    expect(profile.names).not.toContain('cleanup-call');
    expect(profile.characters).toBeGreaterThan(12_000);
    expect(profile.estimatedTokens).toBeGreaterThan(2_500);
    expect(profile.estimatedTokens).toBeLessThan(4_000);
    expect(profile.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('normalizes chat and Responses tool shapes from captured requests', () => {
    const parameters = { type: 'object', properties: {} };
    const definitions = normalizeProviderToolDefinitions([
      { type: 'function', function: { name: 'chat-tool', description: 'Chat', parameters } },
      { type: 'function', name: 'responses-tool', description: 'Responses', parameters },
    ]);

    expect(definitions.map(item => item.function.name)).toEqual(['chat-tool', 'responses-tool']);
    expect(definitions[1]?.function.parameters).toEqual(parameters);
  });

  it('activates intent-specific schemas without changing the canonical catalog', () => {
    const definitions = createRuntimeCoreToolDefinitionsForContext({
      planModeActive: false,
      latestUserText: 'Schedule the test suite daily at 9 AM',
    });
    expect(definitions.map(item => item.function.name)).toContain('scheduled-tasks');
    expect(definitions).toHaveLength(22);
  });
});
