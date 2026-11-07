/** Evaluate optional-tool discovery without executing the discovered capability. */
import type { LLMResponse } from '../llm/ModelClient.js';
import type { Config, FunctionDefinition, Message } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ToolActivationRegistry } from '../services/ToolActivationRegistry.js';
import { tokenCounter } from '../services/TokenCounter.js';
import { ToolManager } from '../tools/ToolManager.js';
import { ToolSearchTool } from '../tools/ToolSearchTool.js';
import { deferredToolCatalogueMessage, renderDeferredToolCatalogue } from '../tools/ToolExposurePolicy.js';
import { selectRuntimeToolSurface } from '../tools/runtimeToolSelection.js';
import { validateRuntimeToolCall } from './toolCallValidation.js';
import { toolSchemaBudget } from '../agent/context/ContextBudget.js';
import { createRuntimeAvailableToolDefinitions } from './runtimeToolProfiles.js';

export interface DiscoveryResult {
  score: number;
  maxScore: number;
  responses: LLMResponse[];
  notes: string[];
}

/** Send two real policy-selected requests, executing only the read-only search tool. */
export async function evaluateToolDiscovery(
  send: (messages: Message[], functions: FunctionDefinition[]) => Promise<LLMResponse>,
  system: string,
  config: Readonly<Config>,
): Promise<DiscoveryResult> {
  const available = createRuntimeAvailableToolDefinitions({ planModeActive: false }, config);
  const activations = new ToolActivationRegistry();
  const agentId = 'discovery-eval';
  const select = () => selectRuntimeToolSurface({
    context: { planModeActive: false },
    definitions: available,
    schemaBudget: toolSchemaBudget(config.context_size, config.max_tokens),
    requested: activations.getRequested(agentId),
    activated: activations.get(agentId),
    estimateTokens: text => tokenCounter.count(text),
  });
  const initial = select();
  const messages: Message[] = [
    { role: 'system', content: system },
    { role: 'user', content: 'Remember this preference across sessions: use pnpm instead of npm because this project uses pnpm workspaces.' },
  ];
  const initialCatalogue = deferredToolCatalogueMessage(messages, renderDeferredToolCatalogue(initial.deferred));
  if (initialCatalogue) messages.push(initialCatalogue);
  activations.setAvailable(agentId, () => select().eligible);
  const first = await send(messages, initial.exposed);
  const search = first.tool_calls?.find(call => call.function.name === 'tool-search');
  if (!search) return { score: 0, maxScore: 7, responses: [first], notes: ['No discovery call before the deferred capability'] };

  // This registry exposes metadata and activation state only. No memory service
  // is installed, and the target memory call is inspected rather than executed.
  const manager = new ToolManager([new ToolSearchTool(new ActivityStream())]);
  const result = await manager.executeTool('tool-search', search.function.arguments, search.id, false, undefined, false, false, 'ally', {
    agentId,
    agentName: 'ally',
    registryScope: {
      get: (key: string) => key === 'tool_manager'
        ? { getFunctionDefinitions: () => available }
        : key === 'tool_activation_registry' ? activations : undefined,
    },
  });
  const discoveryScore = Number(result.success) + Number(activations.getRequested(agentId).includes('memory'));
  messages.push({ role: 'assistant', content: first.content, tool_calls: first.tool_calls });
  for (const call of first.tool_calls ?? []) {
    messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(call === search ? result : { success: false, error: 'Only tool-search executes in this discovery probe.' }) });
  }
  const next = select();
  const nextCatalogue = deferredToolCatalogueMessage(messages, renderDeferredToolCatalogue(next.deferred));
  if (nextCatalogue) messages.push(nextCatalogue);
  const second = await send(messages, next.exposed);
  const memory = next.exposed.some(definition => definition.function.name === 'memory')
    ? second.tool_calls?.find(call => call.function.name === 'memory') : undefined;
  const args = memory?.function.arguments;
  const validation = memory ? validateRuntimeToolCall(memory, config) : null;
  const argumentScore = !validation?.valid ? 0 : Number(Boolean(memory))
    + Number(args?.action === 'save' || args?.action === 'update')
    + Number(typeof args?.name === 'string' && args.name.length > 0)
    + Number(typeof args?.body === 'string' && /pnpm/i.test(args.body))
    + Number(args?.type === 'feedback' || args?.type === 'user' || args?.type === 'project');
  return {
    score: discoveryScore + argumentScore,
    maxScore: 7,
    responses: [first, second],
    notes: [`loaded=${activations.getRequested(agentId).join(',')}`, `discovery=${discoveryScore}/2`, `arguments=${argumentScore}/5`, 'Target capability inspected only; no memory write executed', ...(validation && !validation.valid ? [`Invalid target arguments: ${validation.error}`] : [])],
  };
}
