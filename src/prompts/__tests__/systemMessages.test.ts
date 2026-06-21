import { describe, expect, it } from 'vitest';
import { getMainSystemPrompt } from '../systemMessages.js';

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
    expect(prompt).not.toContain('Hello World');
    expect(prompt).not.toContain('alert()');
  });
});
