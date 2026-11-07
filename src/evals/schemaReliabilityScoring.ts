/** Score argument semantics only after real tool validators accept the call. */
import type { LLMResponse } from '../llm/ModelClient.js';
import type { Config, FunctionDefinition } from '../types/index.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { validateRuntimeToolCall } from './toolCallValidation.js';

export const SCHEMA_SCENARIOS = [
  'grep_options',
  'todo_shape',
  'relative_schedule',
  'background_server',
  'memory_save',
  'write_new_file',
  'batched_glob',
] as const;

export function scoreSchemaReliability(scenario: typeof SCHEMA_SCENARIOS[number], response: LLMResponse, config: Readonly<Config> = DEFAULT_CONFIG, definitions?: readonly FunctionDefinition[]) {
  const callNamed = (value: LLMResponse, name: string) => value.tool_calls?.find(call => call.function.name === name);
  const repositoryPath = (value: unknown) => typeof value === 'string' ? value.replaceAll('\\', '/').replace(/^.*\/Code-Ally\//, '').replace(/^\.\//, '') : undefined;
  const sameStrings = (actual: unknown, expected: string[]) => Array.isArray(actual) && actual.length === expected.length && expected.every(value => actual.includes(value));
  const calls = response.tool_calls ?? [];
  const efficiencyScore = Number(calls.length === 1);
  let functionalScore: number;
  let functionalMax: number;

  if (scenario === 'grep_options') {
    const call = callNamed(response, 'grep');
    const args = call?.function.arguments ?? {};
    functionalScore = Number(Boolean(call))
      + Number(args.pattern === 'TODO')
      + Number(args.type === 'ts' || (typeof args.glob === 'string' && /\bts\b|\.ts\b/i.test(args.glob)))
      + Number(args.case_insensitive === true)
      + Number(args.output_mode === 'content')
      + Number(args.context === 2 || (args.before_context === 2 && args.after_context === 2));
    functionalMax = 6;
  } else if (scenario === 'todo_shape') {
    const call = callNamed(response, 'todo-write');
    const todos = call?.function.arguments.todos;
    const validItems = Array.isArray(todos)
      && todos.length === 4
      && todos.every(item => typeof item?.content === 'string'
        && ['pending', 'in_progress', 'completed'].includes(item?.status));
    const oneActive = Array.isArray(todos)
      && todos.filter(item => item?.status === 'in_progress').length === 1;
    functionalScore = Number(Boolean(call)) + Number(validItems) + Number(oneActive);
    functionalMax = 3;
  } else if (scenario === 'relative_schedule') {
    const call = callNamed(response, 'scheduled-tasks');
    const args = call?.function.arguments ?? {};
    functionalScore = Number(Boolean(call))
      + Number(args.action === 'create')
      + Number(args.schedule?.type === 'once')
      + Number(args.schedule?.run_in_minutes === 30)
      + Number(args.policy_preset === 'none')
      + Number(typeof args.run_prompt === 'string' && args.run_prompt.includes('npm test'));
    functionalMax = 6;
  } else if (scenario === 'background_server') {
    const call = callNamed(response, 'bash');
    const args = call?.function.arguments ?? {};
    functionalScore = Number(Boolean(call))
      + Number(args.command === 'npm run dev')
      + Number(args.run_in_background === true)
      + Number(args.blocks_completion !== true);
    functionalMax = 4;
  } else if (scenario === 'memory_save') {
    const call = callNamed(response, 'memory');
    const args = call?.function.arguments ?? {};
    functionalScore = Number(Boolean(call))
      + Number(args.action === 'save' || args.action === 'update')
      + Number(typeof args.name === 'string' && args.name.length > 0)
      + Number(typeof args.body === 'string' && /pnpm/i.test(args.body))
      + Number(args.type === 'feedback' || args.type === 'user' || args.type === 'project');
    functionalMax = 5;
  } else if (scenario === 'write_new_file') {
    const call = callNamed(response, 'write');
    const args = call?.function.arguments ?? {};
    functionalScore = Number(Boolean(call))
      + Number(repositoryPath(args.file_path) === 'src/banner.ts')
      + Number(typeof args.content === 'string' && args.content.includes('BANNER') && args.content.includes('Code Ally'));
    functionalMax = 3;
  } else {
    const call = callNamed(response, 'glob');
    const patterns = call?.function.arguments.patterns;
    functionalScore = Number(Boolean(call))
      + Number(sameStrings(patterns, ['**/Dockerfile*', '**/*.yml', '**/*.yaml']));
    functionalMax = 2;
  }

  const failures = calls.map(call => definitions && !definitions.some(definition => definition.function.name === call.function.name)
    ? { valid: false, error: `Tool ${call.function.name} was not exposed in this request` }
    : validateRuntimeToolCall(call, config)).filter(result => !result.valid);
  if (failures.length) functionalScore = 0;
  return { score: functionalScore + efficiencyScore, maxScore: functionalMax + 1,
    dimensions: { functional: { score: functionalScore, maxScore: functionalMax }, efficiency: { score: efficiencyScore, maxScore: 1 } },
    notes: failures.map(failure => `Invalid tool arguments: ${failure.error}`),
  };
}
