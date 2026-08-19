import { describe, expect, it } from 'vitest';
import { getDynamicContextBlock, getMainSystemPrompt } from '../systemMessages.js';

describe('systemMessages', () => {
  it('adds unattended scheduled run guidance without task-specific behavior', async () => {
    const prompt = await getMainSystemPrompt(
      undefined,
      undefined,
      true,
      undefined,
      [],
      true,
      'sched-123',
    );

    expect(prompt).toContain('Scheduled Task Run');
    expect(prompt).toContain('sched-123');
    expect(prompt).toContain('Do not ask follow-up questions');
    expect(prompt).toContain('scheduled_<task-id>_<timestamp>');
    expect(prompt).not.toContain('Single Response Run');
    expect(prompt).not.toContain('Hello World');
    expect(prompt).not.toContain('alert()');
  });

  it('uses the ablation-selected stable prompt prefix', async () => {
    const prompt = await getMainSystemPrompt(undefined, undefined, false, 'low');

    expect(prompt.startsWith(`You are Ally, a coding assistant. Complete the request with the fewest correct operations.

Tool rules:
- Choose the narrowest tool that directly matches the operation.
- Read a file before editing it.
- When scope is unknown, search or list first; when the target is known, read only the required ranges.
- Batch related reads only when their combined output will fit the available budget. Do not reread whole files merely to orient.
- After a checkpoint, trust its carried state and query only a specific missing fact needed by the next action.
- Once evidence supports the next edit or verification, act and use build/test feedback for narrow follow-up.
- Treat self-authored tests as hypotheses: before changing production behavior to satisfy one, confirm its expectation against the request and established contract; fix the test when its premise is wrong.
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
});
