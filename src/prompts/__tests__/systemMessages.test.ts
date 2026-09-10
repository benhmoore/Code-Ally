import { describe, expect, it, vi } from 'vitest';
import { getAgentSystemPrompt, getDynamicContextBlock, getMainSystemPrompt } from '../systemMessages.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';

describe('systemMessages', () => {
  it('keeps interactive and unattended guidance distinct through named options', async () => {
    const interactive = await getMainSystemPrompt();
    const unattended = await getMainSystemPrompt({ isOnceMode: true, reasoningEffort: 'high' });
    expect(interactive).not.toContain('Single Response Run');
    expect(unattended).toContain('Single Response Run');
    expect(unattended).not.toContain('Scheduled Task Run');
    expect(unattended).toContain('- Reasoning: high');
  });

  it('keeps specialized identity, task, and reasoning in their own fields', async () => {
    const prompt = await getAgentSystemPrompt({
      agentSystemPrompt: 'Review correctness without editing.',
      taskPrompt: 'Inspect transaction isolation.',
      reasoningEffort: 'medium',
      agentDepth: 1,
    });
    expect(prompt).toContain('**Primary Identity:**\nReview correctness without editing.');
    expect(prompt).toContain('**Current Task:**\nInspect transaction isolation.');
    expect(prompt).toContain('- Reasoning: medium');
    expect(prompt).toContain('**Return to parent**');
  });

  it('adds unattended scheduled run guidance without task-specific behavior', async () => {
    const prompt = await getMainSystemPrompt({
      isOnceMode: true,
      isScheduledRun: true,
      scheduledTaskId: 'sched-123',
    });

    expect(prompt).toContain('Scheduled Task Run');
    expect(prompt).toContain('sched-123');
    expect(prompt).toContain('Do not ask follow-up questions');
    expect(prompt).toContain('scheduled_<task-id>_<timestamp>');
    expect(prompt).not.toContain('Single Response Run');
    expect(prompt).not.toContain('Hello World');
    expect(prompt).not.toContain('alert()');
  });

  it('uses the ablation-selected stable prompt prefix', async () => {
    const prompt = await getMainSystemPrompt({ reasoningEffort: 'low' });

    expect(prompt.startsWith(`You are Ally, a coding assistant. Complete the request with the fewest correct operations.

Tool rules:
- Choose the narrowest tool that directly matches the operation.
- Read a file before editing it.
- When scope is unknown, search or list first; when the target is known, read only the required ranges.
- Batch related reads only when their combined output will fit the available budget. Do not reread whole files merely to orient.
- After a checkpoint, trust its carried state and query only a specific missing fact needed by the next action.
- Once evidence supports the next edit or verification, act and use build/test feedback for narrow follow-up.
- Treat self-authored plans, contracts, and tests as fallible interpretations of the original request. Resolve conflicts against the user's requirements, correcting generated documents and tests together with the implementation. Passing tests alone does not prove the request is satisfied.
- Delegate self-contained work or synthesis, not raw context transport. Ask for compact conclusions, exact symbols or locations, or an independently verifiable change.
- Never ask a delegate to dump whole files or large tool outputs. Create scratch notes only to preserve durable synthesized conclusions across a long investigation.
- For different independent operations, emit separate native tool calls in one response.
- Do not call unrelated tools or describe a tool call instead of making it.`)).toBe(true);
  });

  it('renders volatile context deterministically with an injected clock and zone', async () => {
    const context = await getDynamicContextBlock({
      now: new Date('2026-08-17T14:08:36.000Z'),
      timeZone: 'America/Chicago',
    });

    expect(context).toBe(`**Current Context:**
- Current Local Time: Monday, August 17, 2026 at 9:08:36 AM CDT
- Current Time Zone: America/Chicago
- Current UTC Time: 2026-08-17 14:08:36Z`);
  });

  it('omits an otherwise-empty volatile block on ordinary coding turns', async () => {
    await expect(getDynamicContextBlock({ includeTime: false })).resolves.toBe('');
  });

  it('renders only the current todo state in volatile context', async () => {
    let todoContext: string | null = null;
    const registrySpy = vi.spyOn(ServiceRegistry, 'getInstance').mockReturnValue({
      hasService: (name: string) => name === 'todo_manager',
      get: (name: string) => name === 'todo_manager'
        ? {
            generateActiveContext: () => todoContext,
            logTodosIfChanged: vi.fn(),
          }
        : null,
    } as any);

    try {
      const empty = await getDynamicContextBlock({ includeTodos: true, includeTime: false });
      expect(empty).toContain('Todo list empty');

      todoContext = 'Current task: Build parser (1/3 completed)';
      const active = await getDynamicContextBlock({ includeTodos: true, includeTime: false });
      expect(active).toContain(todoContext);
      expect(active).not.toContain('Todo list empty');
    } finally {
      registrySpy.mockRestore();
    }
  });
});
