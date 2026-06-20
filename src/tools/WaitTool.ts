/**
 * WaitTool - Block until background tasks complete
 *
 * Lets the model explicitly join on background work it spawned (agents, shell
 * processes, or watchers) before continuing. Blocks the current turn, polling
 * the unified BackgroundTaskRegistry until the targets settle, the timeout
 * elapses, or the user interrupts — then returns aggregated results inline.
 *
 * This is the explicit, synchronous counterpart to the passive result drain:
 * use it when your next step depends on those tasks finishing.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { BackgroundTaskRegistry, BackgroundTask } from '../services/BackgroundTaskRegistry.js';
import { formatDuration } from '../ui/utils/timeUtils.js';

const DEFAULT_TIMEOUT_SECONDS = 300; // 5 minutes
const MAX_TIMEOUT_SECONDS = 1800;    // 30 minutes

export class WaitTool extends BaseTool {
  readonly name = 'wait';
  readonly description = 'Block until background tasks (agents, shells, watchers) complete, then return their results';
  readonly requiresConfirmation = false;
  readonly hideOutput = false;
  readonly usageGuidance = `**When to use wait:**
After spawning background agents/processes, call wait when your NEXT step depends
on their results. Pass specific ids, or "all" to join everything still running.
Returns results inline once they finish (or partial state on timeout).`;

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
            task_ids: {
              type: 'array',
              description: 'Specific background task ids to wait for (agent-…, shell-…, watch-…). Omit with all=true to wait for everything running.',
              items: { type: 'string' },
            },
            all: {
              type: 'boolean',
              description: 'Wait for ALL currently-running background tasks. Ignored if task_ids is given.',
            },
            timeout_seconds: {
              type: 'number',
              description: `Max seconds to block before returning partial state (default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS}).`,
            },
          },
          required: [],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const registry = ServiceRegistry.getInstance();
    const taskRegistry = registry.get<BackgroundTaskRegistry>('background_task_registry');
    if (!taskRegistry) {
      return this.formatErrorResponse('BackgroundTaskRegistry not available', 'system_error');
    }

    const ids: string[] | undefined = Array.isArray(args.task_ids) && args.task_ids.length > 0
      ? args.task_ids.map((s: any) => String(s))
      : undefined;
    const all = args.all === true;

    if (!ids && !all) {
      return this.formatErrorResponse(
        'Specify task_ids or all=true',
        'validation_error',
        'Example: wait(all=true) or wait(task_ids=["agent-123-abc"])'
      );
    }

    const timeoutSeconds = Math.min(
      MAX_TIMEOUT_SECONDS,
      Math.max(1, Number(args.timeout_seconds) || DEFAULT_TIMEOUT_SECONDS)
    );

    const target: string[] | 'all' = ids ?? 'all';

    // Validate explicit ids exist.
    if (ids) {
      const missing = ids.filter((id) => !taskRegistry.get(id));
      if (missing.length === ids.length) {
        return this.formatErrorResponse(
          `No matching background tasks: ${missing.join(', ')}`,
          'user_error',
          'They may have already finished. Check the task ids from when you started them.'
        );
      }
    }

    const results = await taskRegistry.waitFor(target, {
      timeoutMs: timeoutSeconds * 1000,
      signal: this.currentAbortSignal,
    });

    const aborted = this.currentAbortSignal?.aborted ?? false;
    return this.formatSuccessResponse({
      content: this.renderResults(results, aborted, false),
      display_content: this.renderResults(results, aborted, true),
      waited_count: results.length,
      all_settled: results.every((t) => t.status !== 'running'),
    });
  }

  /**
   * Render the wait outcome. The model view (forDisplay=false) keeps the task
   * kind and id so the model can make follow-up bash-output/kill-shell calls;
   * the user view (forDisplay=true) drops that plumbing and omits empty bodies.
   */
  private renderResults(tasks: BackgroundTask[], aborted: boolean, forDisplay: boolean): string {
    if (tasks.length === 0) {
      return 'No matching background tasks were running.';
    }

    const lines = tasks.map((t) => {
      const elapsed = formatDuration((t.endTime ?? Date.now()) - t.startTime);
      const header = forDisplay
        ? `[${t.status}] ${t.label} (${elapsed})`
        : `${t.kind} ${t.id} [${t.status}] (${t.label}, ${elapsed})`;
      if (t.status === 'running') return `${header}: still running`;
      const body = t.result ?? t.error;
      if (!body) {
        // The model is told explicitly there was no output; the user just sees the header.
        return forDisplay ? header : `${header}:\n(no output)`;
      }
      return `${header}:\n${body}`;
    });

    const stillRunning = tasks.filter((t) => t.status === 'running').length;
    const prefix = aborted
      ? 'Wait interrupted by user.'
      : stillRunning > 0
        ? `Timed out with ${stillRunning} task(s) still running.`
        : 'All tasks completed.';

    return `${prefix}\n\n${lines.join('\n\n')}`;
  }

  formatSubtext(args: Record<string, any>): string | null {
    if (Array.isArray(args.task_ids) && args.task_ids.length) {
      return `${args.task_ids.length} task(s)`;
    }
    return args.all ? 'all tasks' : null;
  }

  getSubtextParameters(): string[] {
    return ['task_ids', 'all', 'timeout_seconds'];
  }
}
