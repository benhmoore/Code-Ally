/**
 * Tests for RequirementValidator
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RequirementValidator } from '../RequirementTracker.js';
import type { AgentRequirements } from '../RequirementTracker.js';

describe('RequirementValidator', () => {
  let validator: RequirementValidator;

  beforeEach(() => {
    validator = new RequirementValidator('test-agent-123');
  });

  describe('initialization and configuration', () => {
    it('should initialize with no requirements', () => {
      expect(validator.hasRequirements()).toBe(false);
      expect(validator.checkRequirements().met).toBe(true);
    });

    it('should set requirements', () => {
      const requirements: AgentRequirements = {
        required_tools_one_of: ['tool1', 'tool2'],
        max_retries: 3,
      };
      validator.setRequirements(requirements);
      expect(validator.hasRequirements()).toBe(true);
    });

    it('should check requirements after setting them', () => {
      validator.setRequirements({
        required_tools_one_of: ['tool1', 'tool2'],
      });
      const result = validator.checkRequirements();
      expect(result.met).toBe(false);
      expect(result.reason).toContain('tool1, tool2');
    });
  });

  describe('required_tools_one_of', () => {
    beforeEach(() => {
      validator.setRequirements({
        required_tools_one_of: ['add', 'subtract', 'multiply'],
      });
    });

    it('should fail when none of the tools are called', () => {
      const result = validator.checkRequirements();
      expect(result.met).toBe(false);
      expect(result.reason).toContain('add, subtract, multiply');
    });

    it('should pass when one of the tools is called successfully', () => {
      validator.recordToolCall('add', true);
      const result = validator.checkRequirements();
      expect(result.met).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should pass when multiple tools are called', () => {
      validator.recordToolCall('add', true);
      validator.recordToolCall('multiply', true);
      const result = validator.checkRequirements();
      expect(result.met).toBe(true);
    });

    it('should fail when only unsuccessful calls are made', () => {
      validator.recordToolCall('add', false);
      validator.recordToolCall('subtract', false);
      const result = validator.checkRequirements();
      expect(result.met).toBe(false);
    });

    it('should fail when only non-required tools are called', () => {
      validator.recordToolCall('divide', true);
      const result = validator.checkRequirements();
      expect(result.met).toBe(false);
    });

    it('should handle empty tool list', () => {
      validator.setRequirements({
        required_tools_one_of: [],
      });
      const result = validator.checkRequirements();
      expect(result.met).toBe(true);
    });
  });

  describe('required_tools_all', () => {
    beforeEach(() => {
      validator.setRequirements({
        required_tools_all: ['read', 'write', 'execute'],
      });
    });

    it('should fail when none of the tools are called', () => {
      const result = validator.checkRequirements();
      expect(result.met).toBe(false);
      expect(result.reason).toContain('read, write, execute');
      expect(result.reason).toContain('Missing: read, write, execute');
    });

    it('should fail when only some tools are called', () => {
      validator.recordToolCall('read', true);
      validator.recordToolCall('write', true);
      const result = validator.checkRequirements();
      expect(result.met).toBe(false);
      expect(result.reason).toContain('Missing: execute');
    });

    it('should pass when all tools are called successfully', () => {
      validator.recordToolCall('read', true);
      validator.recordToolCall('write', true);
      validator.recordToolCall('execute', true);
      const result = validator.checkRequirements();
      expect(result.met).toBe(true);
    });

    it('should fail when some calls are unsuccessful', () => {
      validator.recordToolCall('read', true);
      validator.recordToolCall('write', false); // Failed
      validator.recordToolCall('execute', true);
      const result = validator.checkRequirements();
      expect(result.met).toBe(false);
      expect(result.reason).toContain('Missing: write');
    });

    it('should handle duplicate successful calls', () => {
      validator.recordToolCall('read', true);
      validator.recordToolCall('read', true); // Duplicate
      validator.recordToolCall('write', true);
      validator.recordToolCall('execute', true);
      const result = validator.checkRequirements();
      expect(result.met).toBe(true);
    });

    it('should handle empty tool list', () => {
      validator.setRequirements({
        required_tools_all: [],
      });
      const result = validator.checkRequirements();
      expect(result.met).toBe(true);
    });
  });

  describe('minimum_tool_calls', () => {
    beforeEach(() => {
      validator.setRequirements({
        minimum_tool_calls: 3,
      });
    });

    it('should fail when no tools are called', () => {
      const result = validator.checkRequirements();
      expect(result.met).toBe(false);
      expect(result.reason).toContain('at least 3');
      expect(result.reason).toContain('Current: 0');
    });

    it('should fail when fewer than minimum tools are called', () => {
      validator.recordToolCall('tool1', true);
      validator.recordToolCall('tool2', true);
      const result = validator.checkRequirements();
      expect(result.met).toBe(false);
      expect(result.reason).toContain('Current: 2');
    });

    it('should pass when exactly minimum tools are called', () => {
      validator.recordToolCall('tool1', true);
      validator.recordToolCall('tool2', true);
      validator.recordToolCall('tool3', true);
      const result = validator.checkRequirements();
      expect(result.met).toBe(true);
    });

    it('should pass when more than minimum tools are called', () => {
      validator.recordToolCall('tool1', true);
      validator.recordToolCall('tool2', true);
      validator.recordToolCall('tool3', true);
      validator.recordToolCall('tool4', true);
      const result = validator.checkRequirements();
      expect(result.met).toBe(true);
    });

    it('should only count successful calls', () => {
      validator.recordToolCall('tool1', true);
      validator.recordToolCall('tool2', false); // Failed
      validator.recordToolCall('tool3', true);
      validator.recordToolCall('tool4', false); // Failed
      const result = validator.checkRequirements();
      expect(result.met).toBe(false);
      expect(result.reason).toContain('Current: 2');
    });

    it('should count unique tools only once', () => {
      validator.recordToolCall('tool1', true);
      validator.recordToolCall('tool1', true); // Duplicate
      validator.recordToolCall('tool2', true);
      const result = validator.checkRequirements();
      expect(result.met).toBe(false);
      expect(result.reason).toContain('Current: 2');
    });

    it('should handle zero minimum', () => {
      validator.setRequirements({
        minimum_tool_calls: 0,
      });
      const result = validator.checkRequirements();
      expect(result.met).toBe(true);
    });
  });

  describe('require_tool_use', () => {
    beforeEach(() => {
      validator.setRequirements({
        require_tool_use: true,
      });
    });

    it('should fail when no tools are called', () => {
      const result = validator.checkRequirements();
      expect(result.met).toBe(false);
      expect(result.reason).toContain('at least one tool');
    });

    it('should pass when any tool is called successfully', () => {
      validator.recordToolCall('any_tool', true);
      const result = validator.checkRequirements();
      expect(result.met).toBe(true);
    });

    it('should fail when only unsuccessful calls are made', () => {
      validator.recordToolCall('tool1', false);
      validator.recordToolCall('tool2', false);
      const result = validator.checkRequirements();
      expect(result.met).toBe(false);
    });

    it('should not enforce requirement when set to false', () => {
      validator.setRequirements({
        require_tool_use: false,
      });
      const result = validator.checkRequirements();
      expect(result.met).toBe(true);
    });
  });

  describe('recording tool calls', () => {
    beforeEach(() => {
      validator.setRequirements({
        required_tools_one_of: ['tool1', 'tool2'],
      });
    });

    it('should only count successful calls', () => {
      validator.recordToolCall('tool1', false);
      expect(validator.getSuccessfulToolCalls()).toEqual([]);
    });

    it('should track successful calls', () => {
      validator.recordToolCall('tool1', true);
      expect(validator.getSuccessfulToolCalls()).toContain('tool1');
    });

    it('should ignore calls when no requirements are set', () => {
      const noReqValidator = new RequirementValidator('test-2');
      noReqValidator.recordToolCall('tool1', true);
      expect(noReqValidator.getSuccessfulToolCalls()).toEqual([]);
    });

    it('should handle null/undefined tool names gracefully', () => {
      validator.recordToolCall('', true);
      validator.recordToolCall('tool1', true);
      expect(validator.getSuccessfulToolCalls()).toHaveLength(2);
    });
  });

  describe('retry logic', () => {
    beforeEach(() => {
      validator.setRequirements({
        required_tools_one_of: ['tool1'],
      });
    });

    it('should initialize retry count to zero', () => {
      expect(validator.getRetryCount()).toBe(0);
    });

    it('should increment retry count', () => {
      validator.incrementRetryCount();
      expect(validator.getRetryCount()).toBe(1);
    });

    it('should increment multiple times', () => {
      validator.incrementRetryCount();
      validator.incrementRetryCount();
      validator.incrementRetryCount();
      expect(validator.getRetryCount()).toBe(3);
    });

    it('should return new count after increment', () => {
      const count = validator.incrementRetryCount();
      expect(count).toBe(1);
    });

    it('should support infinite retries', () => {
      // Increment many times to verify no max limit
      for (let i = 0; i < 100; i++) {
        validator.incrementRetryCount();
      }
      expect(validator.getRetryCount()).toBe(100);
    });

    it('should reset retry count on reset', () => {
      validator.incrementRetryCount();
      validator.incrementRetryCount();
      validator.reset();
      expect(validator.getRetryCount()).toBe(0);
    });
  });

  describe('reminder messages', () => {
    it('should use custom reminder message when provided', () => {
      validator.setRequirements({
        require_tool_use: true,
        reminder_message: 'Custom reminder: please use tools!',
      });
      const message = validator.getReminderMessage();
      expect(message).toBe('Custom reminder: please use tools!');
    });

    it('should generate message from requirement reason', () => {
      validator.setRequirements({
        required_tools_one_of: ['add', 'subtract'],
      });
      const message = validator.getReminderMessage();
      expect(message).toContain('add, subtract');
      expect(message).toContain('Please continue your work');
    });

    it('should generate message for require_tool_use', () => {
      validator.setRequirements({
        require_tool_use: true,
      });
      const message = validator.getReminderMessage();
      expect(message).toContain('at least one tool');
    });

    it('should generate message for minimum_tool_calls', () => {
      validator.setRequirements({
        minimum_tool_calls: 5,
      });
      validator.recordToolCall('tool1', true);
      validator.recordToolCall('tool2', true);
      const message = validator.getReminderMessage();
      expect(message).toContain('at least 5');
      expect(message).toContain('Current: 2');
    });

    it('should generate message for required_tools_all', () => {
      validator.setRequirements({
        required_tools_all: ['read', 'write'],
      });
      validator.recordToolCall('read', true);
      const message = validator.getReminderMessage();
      expect(message).toContain('Missing: write');
    });

    it('should handle no requirements gracefully', () => {
      const noReqValidator = new RequirementValidator('test-no-req');
      const message = noReqValidator.getReminderMessage();
      expect(message).toBe('Please complete the required actions before finishing.');
    });

    it('should handle met requirements gracefully', () => {
      validator.setRequirements({
        require_tool_use: true,
      });
      validator.recordToolCall('tool1', true);
      const message = validator.getReminderMessage();
      // When requirements are met, still returns a message but without specific reason
      expect(message).toBe('Please complete the required actions before finishing.');
    });
  });

  describe('state reset', () => {
    beforeEach(() => {
      validator.setRequirements({
        required_tools_all: ['tool1', 'tool2'],
        max_retries: 3,
      });
      validator.recordToolCall('tool1', true);
      validator.incrementRetryCount();
      validator.incrementRetryCount();
    });

    it('should clear successful tool calls', () => {
      expect(validator.getSuccessfulToolCalls()).toContain('tool1');
      validator.reset();
      expect(validator.getSuccessfulToolCalls()).toEqual([]);
    });

    it('should reset retry count', () => {
      expect(validator.getRetryCount()).toBe(2);
      validator.reset();
      expect(validator.getRetryCount()).toBe(0);
    });

    it('should preserve requirements', () => {
      validator.reset();
      expect(validator.hasRequirements()).toBe(true);
    });

    it('should allow new tracking after reset', () => {
      validator.reset();
      validator.recordToolCall('tool1', true);
      validator.recordToolCall('tool2', true);
      const result = validator.checkRequirements();
      expect(result.met).toBe(true);
    });
  });

  describe('complex requirement combinations', () => {
    it('should handle multiple requirement types together', () => {
      validator.setRequirements({
        require_tool_use: true,
        minimum_tool_calls: 2,
        required_tools_one_of: ['read', 'write'],
      });

      // No tools yet - should fail require_tool_use first
      let result = validator.checkRequirements();
      expect(result.met).toBe(false);
      expect(result.reason).toContain('at least one tool');

      // One non-required tool - fails minimum_tool_calls next (needs 2)
      validator.recordToolCall('other', true);
      result = validator.checkRequirements();
      expect(result.met).toBe(false);
      expect(result.reason).toContain('at least 2');

      // Two non-required tools - now fails required_tools_one_of
      validator.recordToolCall('other2', true);
      result = validator.checkRequirements();
      expect(result.met).toBe(false);
      expect(result.reason).toContain('read, write');

      // Add required tool from one_of list - now passes all (3 tools, including read)
      validator.recordToolCall('read', true);
      result = validator.checkRequirements();
      expect(result.met).toBe(true);
    });

    it('should check requirements in priority order', () => {
      validator.setRequirements({
        require_tool_use: true,
        minimum_tool_calls: 3,
        required_tools_one_of: ['tool1'],
        required_tools_all: ['tool2', 'tool3'],
      });

      // require_tool_use is checked first
      let result = validator.checkRequirements();
      expect(result.reason).toContain('at least one tool');

      // Then minimum_tool_calls
      validator.recordToolCall('other', true);
      result = validator.checkRequirements();
      expect(result.reason).toContain('at least 3');

      // Then required_tools_one_of
      validator.recordToolCall('other2', true);
      validator.recordToolCall('other3', true);
      result = validator.checkRequirements();
      expect(result.reason).toContain('tool1');

      // Then required_tools_all
      validator.recordToolCall('tool1', true);
      result = validator.checkRequirements();
      expect(result.reason).toContain('tool2, tool3');
      expect(result.reason).toContain('Missing: tool2, tool3');

      // Finally all pass
      validator.recordToolCall('tool2', true);
      validator.recordToolCall('tool3', true);
      result = validator.checkRequirements();
      expect(result.met).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle undefined requirements object', () => {
      const result = validator.checkRequirements();
      expect(result.met).toBe(true);
    });

    it('should handle empty requirements object', () => {
      validator.setRequirements({});
      const result = validator.checkRequirements();
      expect(result.met).toBe(true);
    });

    it('should handle all requirements undefined', () => {
      validator.setRequirements({
        required_tools_one_of: undefined,
        required_tools_all: undefined,
        minimum_tool_calls: undefined,
        require_tool_use: undefined,
      });
      const result = validator.checkRequirements();
      expect(result.met).toBe(true);
    });

    it('should handle empty string tool names', () => {
      validator.setRequirements({
        required_tools_one_of: [''],
      });
      validator.recordToolCall('', true);
      const result = validator.checkRequirements();
      expect(result.met).toBe(true);
    });

    it('should handle whitespace tool names', () => {
      validator.setRequirements({
        required_tools_one_of: ['  ', '\t'],
      });
      validator.recordToolCall('  ', true);
      const result = validator.checkRequirements();
      expect(result.met).toBe(true);
    });

    it('should handle special characters in tool names', () => {
      validator.setRequirements({
        required_tools_one_of: ['tool@#$%', 'tool-with-dashes'],
      });
      validator.recordToolCall('tool@#$%', true);
      const result = validator.checkRequirements();
      expect(result.met).toBe(true);
    });
  });

  describe('getSuccessfulToolCalls', () => {
    it('should return empty array initially', () => {
      validator.setRequirements({ require_tool_use: true });
      expect(validator.getSuccessfulToolCalls()).toEqual([]);
    });

    it('should return array of successful tools', () => {
      validator.setRequirements({ require_tool_use: true });
      validator.recordToolCall('tool1', true);
      validator.recordToolCall('tool2', true);
      validator.recordToolCall('tool3', false);
      const calls = validator.getSuccessfulToolCalls();
      expect(calls).toHaveLength(2);
      expect(calls).toContain('tool1');
      expect(calls).toContain('tool2');
      expect(calls).not.toContain('tool3');
    });

    it('should return unique tools only', () => {
      validator.setRequirements({ require_tool_use: true });
      validator.recordToolCall('tool1', true);
      validator.recordToolCall('tool1', true);
      validator.recordToolCall('tool1', true);
      const calls = validator.getSuccessfulToolCalls();
      expect(calls).toEqual(['tool1']);
    });
  });
});
