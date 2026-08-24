import { describe, expect, it } from 'vitest';
import { DEFAULT_INTERACTIVE_RUN_POLICY, RunPolicyManager } from '../RunPolicyManager.js';

describe('RunPolicyManager', () => {
  it('increments its epoch only when policy changes', () => {
    const manager = new RunPolicyManager();
    expect(manager.getEpoch()).toBe(0);
    manager.setInteraction('human');
    expect(manager.getEpoch()).toBe(0);
    manager.setInteraction('none');
    expect(manager.getEpoch()).toBe(1);
    expect(manager.isInteractionAvailable()).toBe(false);
  });

  it('preserves an explicit durable completion contract across UI auto-allow toggles', () => {
    const manager = new RunPolicyManager({
      interaction: 'human',
      execution: 'terminal',
      completion: 'durable_objective',
      authorizationPresetId: 'auto-confirm',
    });

    manager.setTerminalAutoAllow(true);
    expect(manager.getPolicy()).toMatchObject({
      interaction: 'none',
      completion: 'durable_objective',
      authorizationPresetId: 'ui-auto',
    });

    manager.setTerminalAutoAllow(false);
    expect(manager.getPolicy()).toEqual({
      interaction: 'human',
      execution: 'terminal',
      completion: 'durable_objective',
      authorizationPresetId: 'auto-confirm',
    });
  });

  it('restores ordinary chat after temporary auto-allow in a chat session', () => {
    const manager = new RunPolicyManager();
    manager.setTerminalAutoAllow(true);
    expect(manager.getPolicy()).toMatchObject({
      interaction: 'none',
      completion: 'chat',
      authorizationPresetId: 'ui-auto',
    });
    manager.setTerminalAutoAllow(false);
    expect(manager.getPolicy()).toEqual(DEFAULT_INTERACTIVE_RUN_POLICY);
  });

  it('preserves base-policy changes made while the overlay is active', () => {
    const manager = new RunPolicyManager();
    manager.setTerminalAutoAllow(true);
    manager.updatePolicy({
      interaction: 'human',
      execution: 'headless',
      completion: 'durable_objective',
      authorizationPresetId: 'auto-confirm',
    });

    expect(manager.getPolicy()).toMatchObject({
      interaction: 'none',
      execution: 'headless',
      completion: 'durable_objective',
      authorizationPresetId: 'ui-auto',
    });
    manager.setTerminalAutoAllow(false);
    expect(manager.getPolicy()).toEqual({
      interaction: 'human',
      execution: 'headless',
      completion: 'durable_objective',
      authorizationPresetId: 'auto-confirm',
    });
  });
});
