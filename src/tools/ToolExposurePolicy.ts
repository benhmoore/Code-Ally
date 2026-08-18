import type { FunctionDefinition } from '../types/index.js';

/**
 * Decides which tool schemas are sent with a request.
 *
 * Tool schemas are paid on every request and can never be reclaimed by
 * compaction, so on a small context window they compete directly with the
 * conversation — a full tool surface can consume more than half the input
 * budget, leaving too little room for the model to hold its own work.
 *
 * Rather than removing capability, the surface is split: a core set that
 * nearly every turn needs stays loaded, and everything else is advertised by
 * name in a compact catalogue and loaded on demand via `tool-search`. Deferred
 * tools remain fully registered and executable — deferral only affects which
 * schemas are transmitted.
 *
 * When the complete surface already fits the budget (any roomy context window)
 * nothing is deferred and behaviour is identical to sending every tool.
 */

/** The tools the ordinary patch/inspect/run loop cannot proceed without. */
export const CORE_TOOL_NAMES: readonly string[] = [
  'bash',
  'read',
  'write',
  'apply-patch',
  'ls',
  'grep',
  'glob',
  'tree',
  'todo-write',
  // Sub-agent protocol tools: excluded at runtime for root agents, but never
  // deferred when present, since a delegated agent must be able to report.
  'complete-objective',
  'block-objective',
];

export const TOOL_SEARCH_TOOL_NAME = 'tool-search';

/** Upper bound on catalogue entries, so advertising cannot itself get costly. */
const MAX_CATALOGUE_ENTRIES = 80;

export interface DeferredToolInfo {
  name: string;
  summary: string;
}

export interface ToolExposureInput {
  definitions: readonly FunctionDefinition[];
  /** Token ceiling for the transmitted schemas. */
  schemaBudget: number;
  /** Tool names already loaded this session, most recently used last. */
  activated?: readonly string[];
  estimateTokens: (text: string) => number;
}

export interface ToolExposureResult {
  /** Schemas to send with the request. */
  exposed: FunctionDefinition[];
  /** Tools that exist but whose schemas were not sent. */
  deferred: DeferredToolInfo[];
  exposedTokens: number;
}

function definitionTokens(
  definition: FunctionDefinition,
  estimateTokens: (text: string) => number,
): number {
  return estimateTokens(JSON.stringify(definition));
}

/** First sentence of a tool description, trimmed for the catalogue. */
function summarize(definition: FunctionDefinition): string {
  const description = definition.function.description ?? '';
  const firstSentence = description.split(/(?<=[.!?])\s/)[0] ?? description;
  const collapsed = firstSentence.replace(/\s+/g, ' ').trim();
  return collapsed.length > 96 ? `${collapsed.slice(0, 93)}...` : collapsed;
}

export function selectExposedTools(input: ToolExposureInput): ToolExposureResult {
  const { definitions, schemaBudget, estimateTokens } = input;
  const byName = new Map(definitions.map(definition => [definition.function.name, definition]));
  const searchTool = byName.get(TOOL_SEARCH_TOOL_NAME);

  // Without deferral the search tool is dead weight, so price the surface
  // without it when deciding whether deferral is needed at all.
  const candidates = definitions.filter(d => d.function.name !== TOOL_SEARCH_TOOL_NAME);
  const totalTokens = candidates.reduce((sum, d) => sum + definitionTokens(d, estimateTokens), 0);
  if (totalTokens <= schemaBudget) {
    return { exposed: [...candidates], deferred: [], exposedTokens: totalTokens };
  }

  const exposed: FunctionDefinition[] = [];
  const exposedNames = new Set<string>();
  let used = 0;
  const include = (definition: FunctionDefinition): void => {
    if (exposedNames.has(definition.function.name)) return;
    exposed.push(definition);
    exposedNames.add(definition.function.name);
    used += definitionTokens(definition, estimateTokens);
  };

  // Core first, unconditionally: a budget too small for the core loop is a
  // configuration problem, and silently dropping `read` would be worse than
  // overrunning the schema share.
  for (const name of CORE_TOOL_NAMES) {
    const definition = byName.get(name);
    if (definition) include(definition);
  }
  if (searchTool) include(searchTool);

  // Then previously loaded tools, most recently used first, while they fit.
  for (const name of [...(input.activated ?? [])].reverse()) {
    const definition = byName.get(name);
    if (!definition || exposedNames.has(name)) continue;
    if (used + definitionTokens(definition, estimateTokens) > schemaBudget) continue;
    include(definition);
  }

  const deferred = candidates
    .filter(definition => !exposedNames.has(definition.function.name))
    .map(definition => ({ name: definition.function.name, summary: summarize(definition) }));

  return { exposed, deferred, exposedTokens: used };
}

/**
 * Compact advertisement of the deferred surface. The model needs to know these
 * tools exist and how to obtain them; without this it cannot know what it is
 * missing, and would fall back to worse strategies believing it has no option.
 */
export function renderDeferredToolCatalogue(deferred: readonly DeferredToolInfo[]): string {
  if (deferred.length === 0) return '';
  const listed = deferred.slice(0, MAX_CATALOGUE_ENTRIES);
  const omitted = deferred.length - listed.length;
  const lines = listed.map(tool => `- ${tool.name}: ${tool.summary}`);
  if (omitted > 0) lines.push(`- ...and ${omitted} more (search by keyword to find them)`);
  return [
    'These tools exist but their full definitions are not loaded, to keep the context window free for your work.',
    `Load one with ${TOOL_SEARCH_TOOL_NAME} before calling it, e.g. ${TOOL_SEARCH_TOOL_NAME}(query="select:${listed[0]!.name}") for an exact tool, or a keyword query to find one.`,
    'Available on demand:',
    ...lines,
  ].join('\n');
}
