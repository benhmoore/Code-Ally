import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandMetadata } from './types.js';

export class RunCommand extends Command {
  static readonly metadata: CommandMetadata = {
    name: '/run',
    description: 'Inspect or explicitly resume durable objectives',
    helpCategory: 'Tasks',
    subcommands: [
      { name: 'list', description: 'List interrupted durable objectives' },
      { name: 'resume', args: '<run-id>', description: 'Explicitly resume an interrupted objective' },
    ],
  };
  static { CommandRegistry.register(RunCommand.metadata); }
  readonly name = RunCommand.metadata.name;
  readonly description = RunCommand.metadata.description;

  async execute(args: string[], _messages: Message[], registry: ServiceRegistry): Promise<CommandResult> {
    const supervisor = registry.get('run_supervisor');
    if (!supervisor) return this.createError('Durable run supervisor is unavailable');
    const action = args[0]?.toLowerCase() ?? 'list';
    if (action === 'list') {
      const runs = await supervisor.listInterruptedRuns();
      if (!runs.length) return this.createResponse('No interrupted durable objectives.');
      return this.createResponse(runs.map((run) =>
        `\`${run.runId}\` — ${run.objective.slice(0, 160)} (${new Date(run.updatedAt).toLocaleString()})`
      ).join('\n'));
    }
    if (action === 'resume' && args[1]) {
      const run = await supervisor.resumeRun(args[1]);
      return this.createResponse(
        `Resumed durable objective \`${run.runId}\`. Send a continuation message to restart model execution; no work starts merely by opening Code-Ally.`
      );
    }
    return this.createError('Usage: /run list | /run resume <run-id>');
  }
}
