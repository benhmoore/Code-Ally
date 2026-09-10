import type { RunSnapshot } from './RunSupervisor.js';
import type { RunPolicy } from './RunPolicyManager.js';
import { validateRunJournalEvent, type RunJournalEvent } from './RunJournal.js';

export interface RunState {
  snapshot: RunSnapshot;
  sequence: number;
  unknownEffects: Set<string>;
  runningEffects: Set<string>;
}

function text(data: Record<string, unknown>, key: string): string {
  if (typeof data[key] !== 'string' || !data[key]) throw new Error(`Invalid run event ${key}`);
  return data[key];
}

/** The single transition function used before commit and during recovery. */
export function reduceRunEvent(previous: RunState | undefined, event: RunJournalEvent): RunState {
  validateRunJournalEvent(event, previous?.snapshot.runId ?? event.runId, (previous?.sequence ?? 0) + 1);
  const data = event.data ?? {};
  if (!previous) {
    if (event.type !== 'run_started') throw new Error('Journal must begin with run_started');
    const policy = data.policy as RunPolicy | undefined;
    if (!policy || !['human', 'none'].includes(policy.interaction)
      || !['terminal', 'headless'].includes(policy.execution)
      || !['chat', 'durable_objective'].includes(policy.completion)
      || typeof policy.authorizationPresetId !== 'string') {
      throw new Error('Run journal lacks a valid initial policy');
    }
    return {
      sequence: event.sequence,
      snapshot: {
        version: 1, runId: event.runId, objective: text(data, 'objective'), policy: { ...policy },
        status: 'running', epoch: 0, startedAt: event.timestamp, updatedAt: event.timestamp,
      },
      unknownEffects: new Set(), runningEffects: new Set(),
    };
  }
  const state = structuredClone(previous);
  const snapshot = state.snapshot;
  const running = snapshot.status === 'running' || snapshot.status === 'waiting_retry';
  const requireRunning = () => { if (!running) throw new Error(`Run is ${snapshot.status}`); };
  switch (event.type) {
    case 'run_resumed':
      if (snapshot.status !== 'interrupted') throw new Error(`Run is ${snapshot.status}, not interrupted`);
      snapshot.status = 'running';
      snapshot.outcome = undefined;
      break;
    case 'epoch_rolled_over':
      requireRunning();
      if (data.epoch !== snapshot.epoch + 1) throw new Error('Invalid run epoch');
      snapshot.epoch++;
      break;
    case 'assistant_progress':
      requireRunning();
      text(data, 'summary');
      snapshot.nextAction = 'Continue the objective or submit complete-objective when all work is verified.';
      break;
    case 'run_completed':
      requireRunning();
      if (state.unknownEffects.size || state.runningEffects.size) throw new Error('Unsettled effects prevent completion');
      snapshot.status = 'completed';
      snapshot.outcome = { kind: 'completed', summary: text(data, 'summary') };
      snapshot.nextAction = undefined;
      break;
    case 'run_blocked':
    case 'run_cancelled':
    case 'run_interrupted': {
      requireRunning();
      snapshot.status = event.type === 'run_blocked' ? 'blocked' : event.type === 'run_cancelled' ? 'cancelled' : 'interrupted';
      snapshot.outcome = { kind: event.type === 'run_blocked' ? 'blocked' : 'cancelled', reason: text(data, 'reason') };
      for (const id of state.runningEffects) state.unknownEffects.add(id);
      state.runningEffects.clear();
      break;
    }
    case 'run_failed':
      requireRunning();
      snapshot.status = 'failed';
      snapshot.outcome = { kind: 'failed', error: text(data, 'error') };
      break;
    case 'tool_running':
      requireRunning();
      if (data.effect === 'non_idempotent') state.runningEffects.add(data.callId as string);
      break;
    case 'tool_unknown':
      state.runningEffects.delete(data.callId as string);
      state.unknownEffects.add(data.callId as string);
      break;
    case 'tool_succeeded':
    case 'tool_failed':
      state.runningEffects.delete(data.callId as string);
      state.unknownEffects.delete(data.callId as string);
      break;
    case 'tool_reconciled':
      if (!state.unknownEffects.has(data.callId as string)) throw new Error('No unknown effect to reconcile');
      state.unknownEffects.delete(data.callId as string);
      break;
    case 'tool_prepared':
    case 'completion_rejected':
      requireRunning();
      break;
    default:
      throw new Error(`Unsupported run event: ${event.type}`);
  }
  state.sequence = event.sequence;
  snapshot.updatedAt = event.timestamp;
  return state;
}
