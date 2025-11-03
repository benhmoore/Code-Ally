/**
 * Tests for RequiredToolTracker
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RequiredToolTracker } from '../RequiredToolTracker.js';

describe('RequiredToolTracker', () => {
  let tracker: RequiredToolTracker;

  beforeEach(() => {
    tracker = new RequiredToolTracker('test-agent-123');
  });

  describe('initialization and configuration', () => {
    it('should initialize with no required tools', () => {
      expect(tracker.hasRequiredTools()).toBe(false);
      expect(tracker.areAllCalled()).toBe(true);
      expect(tracker.getRequiredTools()).toEqual([]);
      expect(tracker.getCalledTools()).toEqual([]);
    });

    it('should set required tools', () => {
      tracker.setRequired(['tool1', 'tool2', 'tool3']);
      expect(tracker.hasRequiredTools()).toBe(true);
      expect(tracker.getRequiredTools()).toEqual(['tool1', 'tool2', 'tool3']);
      expect(tracker.areAllCalled()).toBe(false);
    });

    it('should reset state when setting new required tools', () => {
      tracker.setRequired(['tool1']);
      tracker.markCalled('tool1');
      expect(tracker.areAllCalled()).toBe(true);

      tracker.setRequired(['tool2', 'tool3']);
      expect(tracker.areAllCalled()).toBe(false);
      expect(tracker.getCalledTools()).toEqual([]);
    });
  });

  describe('tracking tool calls', () => {
    beforeEach(() => {
      tracker.setRequired(['tool1', 'tool2', 'tool3']);
    });

    it('should mark required tools as called', () => {
      const result = tracker.markCalled('tool1');
      expect(result).toBe(true);
      expect(tracker.getCalledTools()).toEqual(['tool1']);
    });

    it('should return false for non-required tools', () => {
      const result = tracker.markCalled('tool4');
      expect(result).toBe(false);
      expect(tracker.getCalledTools()).toEqual([]);
    });

    it('should track multiple tool calls', () => {
      tracker.markCalled('tool1');
      tracker.markCalled('tool2');
      expect(tracker.getCalledTools()).toEqual(['tool1', 'tool2']);
      expect(tracker.areAllCalled()).toBe(false);
    });

    it('should detect when all tools are called', () => {
      tracker.markCalled('tool1');
      tracker.markCalled('tool2');
      tracker.markCalled('tool3');
      expect(tracker.areAllCalled()).toBe(true);
    });

    it('should handle duplicate calls', () => {
      tracker.markCalled('tool1');
      tracker.markCalled('tool1');
      expect(tracker.getCalledTools()).toEqual(['tool1']);
    });
  });

  describe('missing tools', () => {
    beforeEach(() => {
      tracker.setRequired(['tool1', 'tool2', 'tool3']);
    });

    it('should return all missing tools when none called', () => {
      expect(tracker.getMissingTools()).toEqual(['tool1', 'tool2', 'tool3']);
    });

    it('should return remaining missing tools', () => {
      tracker.markCalled('tool1');
      expect(tracker.getMissingTools()).toEqual(['tool2', 'tool3']);
    });

    it('should return empty array when all called', () => {
      tracker.markCalled('tool1');
      tracker.markCalled('tool2');
      tracker.markCalled('tool3');
      expect(tracker.getMissingTools()).toEqual([]);
    });
  });

  describe('warning management', () => {
    beforeEach(() => {
      tracker.setRequired(['tool1', 'tool2']);
    });

    it('should not warn when all tools called', () => {
      tracker.markCalled('tool1');
      tracker.markCalled('tool2');
      const result = tracker.checkAndWarn();
      expect(result.shouldWarn).toBe(false);
      expect(result.shouldFail).toBe(false);
      expect(result.missingTools).toEqual([]);
    });

    it('should issue warning on first check', () => {
      const result = tracker.checkAndWarn();
      expect(result.shouldWarn).toBe(true);
      expect(result.shouldFail).toBe(false);
      expect(result.warningCount).toBe(1);
      expect(result.missingTools).toEqual(['tool1', 'tool2']);
    });

    it('should increment warning count', () => {
      const result1 = tracker.checkAndWarn();
      expect(result1.warningCount).toBe(1);

      const result2 = tracker.checkAndWarn();
      expect(result2.warningCount).toBe(2);
    });

    it('should fail after max warnings', () => {
      // First two warnings
      tracker.checkAndWarn();
      tracker.checkAndWarn();

      // Third check should fail
      const result = tracker.checkAndWarn();
      expect(result.shouldWarn).toBe(false);
      expect(result.shouldFail).toBe(true);
      expect(result.warningCount).toBe(2);
    });

    it('should track warning message index', () => {
      expect(tracker.getWarningMessageIndex()).toBe(-1);
      tracker.setWarningMessageIndex(5);
      expect(tracker.getWarningMessageIndex()).toBe(5);
      tracker.clearWarningMessageIndex();
      expect(tracker.getWarningMessageIndex()).toBe(-1);
    });
  });

  describe('message creation', () => {
    it('should create warning message for single tool', () => {
      const message = tracker.createWarningMessage(['tool1']);
      expect(message.role).toBe('system');
      expect(message.content).toContain('tool1');
      expect(message.content).toContain('this tool');
      expect(message.content).toContain('<system-reminder>');
      expect(message.timestamp).toBeGreaterThan(0);
    });

    it('should create warning message for multiple tools', () => {
      const message = tracker.createWarningMessage(['tool1', 'tool2']);
      expect(message.content).toContain('tool1, tool2');
      expect(message.content).toContain('these tools');
    });

    it('should create failure message', () => {
      const message = tracker.createFailureMessage(['tool1', 'tool2']);
      expect(message).toContain('failed to call required tools');
      expect(message).toContain('tool1, tool2');
      expect(message).toContain('2 warnings');
    });
  });

  describe('reset', () => {
    beforeEach(() => {
      tracker.setRequired(['tool1', 'tool2']);
      tracker.markCalled('tool1');
      tracker.checkAndWarn();
      tracker.setWarningMessageIndex(5);
    });

    it('should reset tracking state', () => {
      tracker.reset();
      expect(tracker.getCalledTools()).toEqual([]);
      expect(tracker.getWarningCount()).toBe(0);
      expect(tracker.getWarningMessageIndex()).toBe(-1);
      expect(tracker.areAllCalled()).toBe(false);
    });

    it('should keep required tools after reset', () => {
      tracker.reset();
      expect(tracker.getRequiredTools()).toEqual(['tool1', 'tool2']);
      expect(tracker.hasRequiredTools()).toBe(true);
    });
  });
});
