import { describe, expect, it } from 'vitest';
import { getRuntimeToolExclusions, needsTemporalContext } from '../runtimeToolSelection.js';

describe('runtime tool selection', () => {
  it('hides stateful and intent-specific tools on an ordinary first turn', () => {
    expect(getRuntimeToolExclusions({
      planModeActive: false,
      latestUserText: 'Fix the parser bug in src/parser.ts',
    })).toEqual([
      'write-plan',
      'exit-plan-mode',
      'agent-ask',
      'cleanup-call',
      'bash-output',
      'kill-shell',
      'cancel-agent',
      'wait',
      'scheduled-tasks',
      'watch',
      'manage-agents',
      'sessions',
    ]);
  });

  it('activates scheduler and watcher schemas from explicit user intent', () => {
    const exclusions = getRuntimeToolExclusions({
      planModeActive: false,
      latestUserText: 'Schedule this daily and notify me when the report is ready',
    });
    expect(exclusions).not.toContain('scheduled-tasks');
    expect(exclusions).not.toContain('watch');
  });

  it('activates specialized schemas only for matching requests', () => {
    const exclusions = getRuntimeToolExclusions({
      planModeActive: false,
      latestUserText: 'Review our previous conversation, configure an explore agent, then replace line 42',
    });
    expect(exclusions).not.toContain('sessions');
    expect(exclusions).not.toContain('manage-agents');
  });

  it('adds volatile clock context only for time-sensitive requests', () => {
    expect(needsTemporalContext('Fix the parser')).toBe(false);
    expect(needsTemporalContext('Schedule this daily')).toBe(true);
    expect(needsTemporalContext('Find the latest release')).toBe(true);
    expect(needsTemporalContext('Run this in 30 minutes')).toBe(true);
    expect(getRuntimeToolExclusions({
      planModeActive: false,
      latestUserText: 'Run the build at 3:30 PM',
    })).not.toContain('scheduled-tasks');
  });

  it('activates only controls supported by current background state', () => {
    const exclusions = getRuntimeToolExclusions({
      planModeActive: true,
      backgroundTasks: [
        { kind: 'shell', status: 'done' },
        { kind: 'agent', status: 'running' },
      ],
    });
    expect(exclusions).not.toContain('write-plan');
    expect(exclusions).not.toContain('exit-plan-mode');
    expect(exclusions).not.toContain('bash-output');
    expect(exclusions).toContain('kill-shell');
    expect(exclusions).not.toContain('cancel-agent');
    expect(exclusions).not.toContain('wait');
  });

  it('shows kill-shell only while a shell process is running', () => {
    const exclusions = getRuntimeToolExclusions({
      planModeActive: false,
      backgroundTasks: [{ kind: 'shell', status: 'running' }],
    });
    expect(exclusions).not.toContain('bash-output');
    expect(exclusions).not.toContain('kill-shell');
  });

  it('shows follow-up and cleanup tools only after their required state exists', () => {
    const exclusions = getRuntimeToolExclusions({
      planModeActive: false,
      hasPersistentAgent: true,
      hasToolResults: true,
    });
    expect(exclusions).not.toContain('agent-ask');
    expect(exclusions).not.toContain('cleanup-call');
  });
});
