/**
 * WatchTool - Watch for a condition to become true, in the background
 *
 * Starts a non-blocking watcher that polls a condition on an interval and
 * completes when it's satisfied (or times out). Returns a watcher id
 * immediately. If `wake` is set, the idle main agent is auto-woken on
 * satisfaction (handled by the UI wake coordinator); otherwise the result is
 * delivered passively on the next turn / via `wait`.
 *
 * Conditions (arbitrary, extensible):
 *   - file_exists : a path exists on disk
 *   - http_ok     : an HTTP(S) GET returns a 2xx status
 *   - shell       : a shell command exits 0
 */

import { stat } from 'fs/promises';
import { BaseTool } from './BaseTool.js';
import { ToolCapability } from './ToolCapability.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { spawnBashCommand } from '../utils/bashProcess.js';

const DEFAULT_INTERVAL_SECONDS = 10;
const DEFAULT_TIMEOUT_SECONDS = 1800; // 30 minutes
const MAX_TIMEOUT_SECONDS = 30 * 24 * 60 * 60;

type Condition = 'file_exists' | 'http_ok' | 'shell';

export class WatchTool extends BaseTool {
  readonly name = 'watch';
  readonly description = 'Watch for a condition (file appears, HTTP 200, or shell command succeeds) and be notified when met';
  /**
   * The maximum set across all conditions; `capabilitiesFor` narrows it to what
   * a given invocation actually does. Watching for a file or a URL is harmless,
   * but the `shell` condition runs a model-supplied command line on a poll loop,
   * so it must be confirmed like any other shell execution.
   */
  readonly capabilities = [
    ToolCapability.FsRead,
    ToolCapability.Network,
    ToolCapability.ShellExec,
  ] as const;

  readonly hideOutput = false;
  readonly usageGuidance = `**When to use watch:**
To monitor something that doesn't emit its own completion — a file appearing, a
server coming up (http_ok), or any shell predicate succeeding. Returns a watcher
id immediately and polls in the background. Set wake=true to be auto-notified the
moment it's satisfied; otherwise check it with wait or on your next turn.`;

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  capabilitiesFor(args: Record<string, any>): readonly ToolCapability[] {
    switch (args.condition as Condition) {
      case 'file_exists':
        return [ToolCapability.FsRead];
      case 'http_ok':
        return [ToolCapability.Network];
      case 'shell':
        return [ToolCapability.ShellExec];
      default:
        // Unrecognized condition is rejected in executeImpl; until then assume
        // the most dangerous reading so an unknown value can never slip through
        // unconfirmed.
        return this.capabilities;
    }
  }

  /**
   * The shell command this invocation would run, or null. Lets the permission
   * layer classify it with the same rules it applies to `bash` instead of
   * treating it as an opaque `watch` argument.
   */
  getShellCommand(args: Record<string, any>): string | null {
    return args.condition === 'shell' && typeof args.command === 'string' ? args.command : null;
  }

  getFunctionDefinition(): FunctionDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            condition: {
              type: 'string',
              enum: ['file_exists', 'http_ok', 'shell'],
              description: "What to watch for: 'file_exists' | 'http_ok' | 'shell'",
            },
            // Split by condition rather than one polymorphic `target`: a single
            // parameter cannot be both a path to authorize and a command to
            // classify, so the schema could not describe what the value is.
            file_path: {
              type: 'string',
              format: 'local-path',
              description: 'Required for file_exists: the file to wait for.',
            },
            url: {
              type: 'string',
              description: 'Required for http_ok: the URL to poll until it returns 200.',
            },
            command: {
              type: 'string',
              description:
                'Required for shell: the command to run until it exits 0. Runs on every poll and requires confirmation.',
            },
            interval_seconds: {
              type: 'number',
              description: `Polling interval in seconds (default ${DEFAULT_INTERVAL_SECONDS}).`,
            },
            timeout_seconds: {
              type: 'number',
              description: `Give up after this many seconds (default ${DEFAULT_TIMEOUT_SECONDS}).`,
            },
            wake: {
              type: 'boolean',
              description: 'Auto-notify (wake) when the condition is satisfied, even if you are idle. Default false.',
            },
          },
          required: ['condition'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const condition = args.condition as Condition;

    if (!['file_exists', 'http_ok', 'shell'].includes(condition)) {
      return this.formatErrorResponse(
        `Invalid condition: ${condition}`,
        'validation_error',
        "condition must be 'file_exists', 'http_ok', or 'shell'"
      );
    }

    const TARGET_PARAM: Record<Condition, 'file_path' | 'url' | 'command'> = {
      file_exists: 'file_path',
      http_ok: 'url',
      shell: 'command',
    };
    const targetParam = TARGET_PARAM[condition];
    const target = args[targetParam];

    if (!target || typeof target !== 'string') {
      return this.formatErrorResponse(
        `${targetParam} is required for condition '${condition}'`,
        'validation_error',
        `Pass the value as '${targetParam}'.`
      );
    }

    const registry = ServiceRegistry.getInstance();
    const taskRegistry = registry.get('background_task_registry');
    if (!taskRegistry) {
      return this.formatErrorResponse('BackgroundTaskRegistry not available', 'system_error');
    }

    const intervalMs = Math.max(1, Number(args.interval_seconds) || DEFAULT_INTERVAL_SECONDS) * 1000;
    const timeoutMs = Math.min(MAX_TIMEOUT_SECONDS, Math.max(1, Number(args.timeout_seconds) || DEFAULT_TIMEOUT_SECONDS)) * 1000;
    const wake = args.wake === true;

    const check = this.buildCheck(condition, target);
    const description = `${condition}: ${target}`;

    const task = taskRegistry.createWatcher({ description, intervalMs, timeoutMs, watched: wake, check });

    return this.formatSuccessResponse({
      content:
        `Watching (${description}). Watcher id: ${task.id}. Polling every ${intervalMs / 1000}s, ` +
        `timeout ${timeoutMs / 1000}s.${wake ? ' You will be notified when it is satisfied.' : ' Use wait or check on your next turn.'}`,
      watcher_id: task.id,
      wake,
    });
  }

  /** Build the polled predicate for a condition. Returns true when satisfied. */
  private buildCheck(condition: Condition, target: string): (signal: AbortSignal) => Promise<boolean> {
    switch (condition) {
      case 'file_exists':
        return async () => {
          try { await stat(target); return true; } catch { return false; }
        };
      case 'http_ok':
        return async (signal) => {
          try {
            const res = await fetch(target, { method: 'GET', signal });
            await res.body?.cancel().catch(() => {});
            return res.ok;
          } catch { return false; }
        };
      case 'shell':
        return (signal) => new Promise<boolean>((resolve) => {
          const child = spawnBashCommand(target, {
            stdio: 'ignore',
            detached: process.platform !== 'win32',
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              LANG: process.env.LANG,
              CI: '1',
              GIT_TERMINAL_PROMPT: '0',
              GCM_INTERACTIVE: 'Never',
              SSH_ASKPASS_REQUIRE: 'never',
              PAGER: 'cat',
              GIT_PAGER: 'cat',
              EDITOR: 'false',
              VISUAL: 'false',
            },
          });
          let done = false;
          const finish = (value: boolean) => {
            if (done) return;
            done = true;
            signal.removeEventListener('abort', abort);
            resolve(value);
          };
          const abort = () => {
            if (child.pid && process.platform !== 'win32') {
              try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
            } else {
              child.kill('SIGTERM');
            }
            finish(false);
          };
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
          child.on('close', (code) => finish(code === 0));
          child.on('error', () => finish(false));
        });
    }
  }

  formatSubtext(args: Record<string, any>): string | null {
    const target = args.file_path ?? args.url ?? args.command;
    if (!args.condition || !target) return null;
    return `${args.condition}: ${target}`;
  }

  getSubtextParameters(): string[] {
    return ['condition', 'file_path', 'url', 'command', 'interval_seconds', 'wake'];
  }
}
