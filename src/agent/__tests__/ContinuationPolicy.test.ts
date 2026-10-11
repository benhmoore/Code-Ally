import { expect, it } from 'vitest';
import { decideContinuation } from '../ContinuationPolicy.js';

it('gives terminal outcomes priority over every reason to continue', () => {
  expect(decideContinuation({ terminal: true, hasToolCalls: true, missingRequiredTools: true, unmetRequirements: true, durableObjective: true, unfinishedWork: true })).toBe('terminal');
});

it('executes available tools before requesting missing requirements, and requirements before durable continuation', () => {
  expect(decideContinuation({ hasToolCalls: true, missingRequiredTools: true })).toBe('tools');
  expect(decideContinuation({ missingRequiredTools: true, unmetRequirements: true, durableObjective: true })).toBe('required_tools');
  expect(decideContinuation({ unmetRequirements: true, durableObjective: true })).toBe('requirements');
  expect(decideContinuation({ durableObjective: true, unfinishedWork: true })).toBe('objective');
  expect(decideContinuation({ unfinishedWork: true })).toBe('unfinished_work');
  expect(decideContinuation({})).toBe('complete');
});
