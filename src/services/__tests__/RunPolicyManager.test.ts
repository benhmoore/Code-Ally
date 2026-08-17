import { describe, expect, it } from 'vitest';
import { RunPolicyManager } from '../RunPolicyManager.js';

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
});
