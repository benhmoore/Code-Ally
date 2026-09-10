/**
 * HeadlessSession - the non-interactive session type.
 *
 * Owns the agent for the process lifetime so text, json and stream-json are
 * three writers over one loop rather than three code paths.
 */

import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { formatError } from '../utils/errorUtils.js';
import { generateShortId } from '../utils/id.js';
import type { Agent } from '../agent/Agent.js';
import type { SessionManager } from '../services/SessionManager.js';
import type { RunOutcome } from '../services/RunSupervisor.js';
import type { CLIOptions } from '../cli/ArgumentParser.js';
import { JsonlEventWriter } from './JsonlEventWriter.js';
import { StreamJsonInput } from './StreamJsonInput.js';
import { resultSubtype } from './wire.js';

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A session id becomes a file name, so it must be a single safe path component. */
export function assertSafeSessionId(id: string): void {
  if (!SAFE_SESSION_ID.test(id) || id === '.' || id === '..') {
    throw new Error(`Invalid --session-id '${id}'; use letters, digits, dot, dash or underscore`);
  }
}

/** True when this process runs without a terminal user driving it. */
export function isHeadlessRun(options: CLIOptions): boolean {
  return Boolean(options.once) || options.inputFormat === 'stream-json';
}

/** The session a run writes to, and whether it already held messages. */
export interface HeadlessSessionHandle {
  name: string;
  existed: boolean;
}

/** The session name this run writes to, or null when it keeps no session. */
export function resolveHeadlessSessionName(options: CLIOptions): string | null {
  if (options.noSession) return null;
  if (options.sessionId) {
    assertSafeSessionId(options.sessionId);
    return options.sessionId;
  }
  return options.session ?? null;
}

/**
 * Create or select the run's session and make it current.
 *
 * The composition root calls this before the first hook, so SessionStart and
 * every wire event report the same session id.
 */
export async function openHeadlessSession(
  options: CLIOptions,
  sessionManager: SessionManager,
): Promise<HeadlessSessionHandle | null> {
  const name = resolveHeadlessSessionName(options);
  if (!name) return null;

  const existed = await sessionManager.sessionExists(name);
  if (!existed) await sessionManager.createSession(name);
  sessionManager.setCurrentSession(name);

  const patchManager = ServiceRegistry.getInstance().get('patch_manager');
  if (patchManager && typeof (patchManager as any).onSessionChange === 'function') {
    await (patchManager as any).onSessionChange();
  }

  return { name, existed };
}

export interface HeadlessSessionDeps {
  agent: Agent;
  sessionManager: SessionManager;
  options: CLIOptions;
  /** The session opened for this run, from `openHeadlessSession`. */
  session: HeadlessSessionHandle | null;
  /** Model name reported by the init event. */
  model: string;
  /** Tool names reported by the init event. */
  toolNames: string[];
  cwd?: string;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  /** Typed outcome of the run. Defaults to the registered run supervisor. */
  getOutcome?: () => RunOutcome | undefined;
}

const UNTYPED_OUTCOME: RunOutcome = {
  kind: 'failed',
  error: 'Automatic run ended without a typed outcome',
};

export class HeadlessSession {
  private readonly deps: HeadlessSessionDeps;
  private readonly options: CLIOptions;
  private readonly writer?: JsonlEventWriter;
  private sessionName: string | null = null;
  private sessionId = '';
  private structuredOutput?: unknown;
  private turnCount = 0;
  private interruptedTurn = false;

  constructor(deps: HeadlessSessionDeps) {
    this.deps = deps;
    this.options = deps.options;
    const format = this.options.outputFormat ?? 'text';
    this.writer = format === 'text'
      ? undefined
      : new JsonlEventWriter({ format, stream: deps.stdout ?? process.stdout });
  }

  /** Slot the structured-output tool fills before the turn's result is written. */
  setStructuredOutput(value: unknown): void {
    this.structuredOutput = value;
  }

  /** Run the session to completion and return the outcome its exit code comes from. */
  async run(): Promise<RunOutcome> {
    const streamedInput = this.options.inputFormat === 'stream-json';
    if (!streamedInput && !this.options.once) {
      throw new Error('Headless mode needs --once <message> unless --input-format stream-json');
    }

    const opened = this.deps.session;
    this.sessionName = opened?.name ?? null;
    if (opened?.existed) {
      this.deps.agent.setMessages(await this.deps.sessionManager.getSessionMessages(opened.name));
    }
    this.sessionId = this.sessionName
      ?? this.deps.sessionManager.getCurrentSession()
      ?? `headless-${generateShortId()}`;

    if (this.writer) {
      this.writer.attach(this.deps.agent.getActivityStream(), this.sessionId);
      this.writer.write({
        type: 'system',
        subtype: 'init',
        session_id: this.sessionId,
        model: this.deps.model,
        tools: this.deps.toolNames,
        cwd: this.deps.cwd ?? process.cwd(),
      });
    }

    try {
      return streamedInput ? await this.runStreamed() : await this.runTurn(this.options.once!);
    } finally {
      this.writer?.detach();
    }
  }

  /** Read line-delimited commands from stdin until it closes and the last turn ends. */
  private async runStreamed(): Promise<RunOutcome> {
    const { agent } = this.deps;
    let lastOutcome: RunOutcome | undefined;
    let active: Promise<void> | null = null;
    const pending: string[] = [];
    let closed = false;
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });

    const drain = (): void => {
      if (active) return;
      const message = pending.shift();
      if (message === undefined) {
        if (closed) finish();
        return;
      }
      active = this.runTurn(message)
        .then(outcome => { lastOutcome = outcome; })
        .finally(() => {
          active = null;
          drain();
        });
    };

    const input = new StreamJsonInput(this.deps.stdin ?? process.stdin, {
      onUser: text => {
        // A headless turn also owns persistence and result publication, after
        // the agent has stopped accepting interjections. Keep that finalization
        // serial, but queue new work rather than appending it to a finished turn.
        if (active && agent.isProcessing()) {
          agent.addUserInterjection(text);
          agent.interrupt({ kind: 'user_interjection' });
          return;
        }
        pending.push(text);
        drain();
      },
      onInterrupt: requestId => {
        if (active && agent.isProcessing()) {
          this.interruptedTurn = true;
          agent.interrupt();
        }
        this.writer?.write({
          type: 'control_response',
          session_id: this.sessionId,
          response: { subtype: 'success', request_id: requestId },
        });
      },
      onError: error => { console.error('Error:', error.message); },
      onClose: () => {
        closed = true;
        drain();
      },
    });

    // Admit the initial prompt before attaching input: a buffered stream must
    // not start a competing turn ahead of --once.
    if (this.options.once) pending.push(this.options.once);
    drain();
    input.start();
    try {
      await finished;
    } finally {
      input.stop();
    }

    return lastOutcome ?? this.readOutcome();
  }

  /** One user message through to its terminal result event. */
  private async runTurn(message: string): Promise<RunOutcome> {
    const startedAt = Date.now();
    this.turnCount += 1;
    // The payload belongs to the turn that recorded it. Left in place, a turn
    // that records nothing would report the previous turn's answer as its own.
    this.structuredOutput = undefined;
    let response = '';
    let outcome: RunOutcome;

    try {
      response = await this.deps.agent.sendMessage(message);
      if (!this.writer) console.log(response);
      await this.persistSession();
      // A refused prompt runs no turn, so the supervisor holds no outcome for
      // it. Report the refusal rather than a neighbouring run's result.
      const blocked = this.deps.agent.takePromptBlockReason();
      outcome = blocked ? { kind: 'blocked', reason: blocked } : this.readOutcome();
    } catch (error) {
      console.error('Error:', error);
      outcome = { kind: 'failed', error: formatError(error) };
    }

    this.emitResult(response, outcome, Date.now() - startedAt);
    this.interruptedTurn = false;
    return outcome;
  }

  private async persistSession(): Promise<void> {
    if (!this.sessionName) return;
    const { sessionManager, agent } = this.deps;
    await sessionManager.saveSession(this.sessionName, agent.getContextMessages(), agent.getMessages());
    if (!this.writer) console.log(`\n[Session: ${this.sessionName}]`);
  }

  private emitResult(result: string, outcome: RunOutcome, durationMs: number): void {
    if (!this.writer) return;
    const subtype = resultSubtype(outcome, this.interruptedTurn);
    this.writer.write({
      type: 'result',
      subtype,
      session_id: this.sessionId,
      result,
      ...(this.structuredOutput === undefined ? {} : { structured_output: this.structuredOutput }),
      outcome,
      duration_ms: durationMs,
      num_turns: this.turnCount,
      is_error: subtype !== 'success',
    });
  }

  private readOutcome(): RunOutcome {
    const read = this.deps.getOutcome
      ?? (() => ServiceRegistry.getInstance().get('run_supervisor')?.getOutcome());
    return read() ?? UNTYPED_OUTCOME;
  }
}
