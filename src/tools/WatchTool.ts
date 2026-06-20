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

import { spawn } from 'child_process';
import { stat } from 'fs/promises';
import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { BackgroundTaskRegistry } from '../services/BackgroundTaskRegistry.js';

const DEFAULT_INTERVAL_SECONDS = 10;
const DEFAULT_TIMEOUT_SECONDS = 1800; // 30 minutes
const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;

type Condition = 'file_exists' | 'http_ok' | 'shell';

export class WatchTool extends BaseTool {
  readonly name = 'watch';
  readonly description = 'Watch for a condition (file appears, HTTP 200, or shell command succeeds) and be notified when met';
  readonly requiresConfirmation = false;
  readonly hideOutput = false;
  readonly usageGuidance = `**When to use watch:**
To monitor something that doesn't emit its own completion — a file appearing, a
server coming up (http_ok), or any shell predicate succeeding. Returns a watcher
id immediately and polls in the background. Set wake=true to be auto-notified the
moment it's satisfied; otherwise check it with wait or on your next turn.`;

  constructor(activityStream: ActivityStream) {
    super(activityStream);
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
              description: "What to watch for: 'file_exists' | 'http_ok' | 'shell'",
            },
            target: {
              type: 'string',
              description: "The thing to check: a file path (file_exists), a URL (http_ok), or a shell command (shell).",
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
          required: ['condition', 'target'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const condition = args.condition as Condition;
    const target = args.target as string;

    if (!['file_exists', 'http_ok', 'shell'].includes(condition)) {
      return this.formatErrorResponse(
        `Invalid condition: ${condition}`,
        'validation_error',
        "condition must be 'file_exists', 'http_ok', or 'shell'"
      );
    }
    if (!target || typeof target !== 'string') {
      return this.formatErrorResponse('target is required', 'validation_error');
    }

    const registry = ServiceRegistry.getInstance();
    const taskRegistry = registry.get<BackgroundTaskRegistry>('background_task_registry');
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
  private buildCheck(condition: Condition, target: string): () => Promise<boolean> {
    switch (condition) {
      case 'file_exists':
        return async () => {
          try { await stat(target); return true; } catch { return false; }
        };
      case 'http_ok':
        return async () => {
          try {
            const res = await fetch(target, { method: 'GET' });
            return res.ok;
          } catch { return false; }
        };
      case 'shell':
        return () => new Promise<boolean>((resolve) => {
          const child = spawn(target, { shell: true, stdio: 'ignore' });
          child.on('close', (code) => resolve(code === 0));
          child.on('error', () => resolve(false));
        });
    }
  }

  formatSubtext(args: Record<string, any>): string | null {
    if (!args.condition || !args.target) return null;
    return `${args.condition}: ${args.target}`;
  }

  getSubtextParameters(): string[] {
    return ['condition', 'target', 'interval_seconds', 'wake'];
  }
}
