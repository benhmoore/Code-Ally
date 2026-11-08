import { createSystemReminder } from '../utils/messageUtils.js';
import type { Message, FunctionDefinition } from '../types/index.js';
import { matchesAnyToolGlob, normalizeToolName } from './toolNameAliases.js';

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
 * Keep the ordinary coding loop stable even on a roomy context window: extra
 * choices still cost attention for smaller models. Explicit searches and run
 * requirements load additional tools without removing capability.
 */

/** The tools the ordinary patch/inspect/run loop cannot proceed without. */
export const CORE_TOOL_NAMES: readonly string[] = [
  'bash',
  'read',
  'write',
  'apply-patch',
  'grep',
  'glob',
  'todo-write',
  'send-message',
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
  /** Most recent batch explicitly requested through tool-search. */
  requested?: readonly string[];
  /**
   * Tool names this run cannot end without, beyond the core loop. They are
   * exposed unconditionally: a tool the requirement loop demands must never be
   * deferred, or the model is reminded to call a schema it cannot see.
   */
  pinned?: readonly string[];
  /**
   * Tool name globs the run authorization policy forbids. These are dropped
   * from the surface entirely, catalogue included, so the model never sees a
   * tool whose call would only be refused.
   */
  disallowed?: readonly string[];
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
  const { schemaBudget, estimateTokens } = input;
  const disallowed = input.disallowed ?? [];
  const definitions = disallowed.length === 0
    ? input.definitions
    : input.definitions.filter(d => !matchesAnyToolGlob(d.function.name, disallowed));
  const byName = new Map(definitions.map(definition => [definition.function.name, definition]));
  const searchTool = byName.get(TOOL_SEARCH_TOOL_NAME);

  // Deferral requires a usable discovery tool. Without it, sending every
  // permitted schema is the only way to preserve access to the capabilities.
  const candidates = definitions.filter(d => d.function.name !== TOOL_SEARCH_TOOL_NAME);
  if (!searchTool) {
    const totalTokens = candidates.reduce((sum, d) => sum + definitionTokens(d, estimateTokens), 0);
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
  for (const name of [...CORE_TOOL_NAMES, ...(input.pinned ?? [])]) {
    const definition = byName.get(normalizeToolName(name));
    if (definition) include(definition);
  }
  include(searchTool);

  // An explicit tool-search is a capability request, not a preference. Keep
  // that entire batch exposed until another search replaces it, even when the
  // nominal schema share is already occupied by the core loop. Otherwise the
  // tool-search result claims success while the requested tools remain
  // impossible to call, trapping the model in a search loop.
  const requested = new Set(input.requested ?? []);
  for (const name of requested) {
    const definition = byName.get(name);
    if (definition) include(definition);
  }

  // Then previously loaded tools, most recently used first, while they fit.
  for (const name of [...(input.activated ?? [])].reverse()) {
    const definition = byName.get(name);
    if (!definition || exposedNames.has(name) || requested.has(name)) continue;
    if (used + definitionTokens(definition, estimateTokens) > schemaBudget) continue;
    include(definition);
  }

  const deferred = candidates
    .filter(definition => !exposedNames.has(definition.function.name))
    .map(definition => ({ name: definition.function.name, summary: summarize(definition) }));

  if (deferred.length === 0) {
    return {
      exposed: exposed.filter(definition => definition.function.name !== TOOL_SEARCH_TOOL_NAME),
      deferred,
      exposedTokens: used - definitionTokens(searchTool, estimateTokens),
    };
  }
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

/** Append only when the current catalogue has not already been published. */
export function deferredToolCatalogueMessage(messages: readonly Message[], catalogue: string): Message | undefined {
  if (!catalogue || messages.some(message => message.metadata?.deferredToolCatalogue
    && message.content.includes(catalogue))) return undefined;
  const reminder = createSystemReminder(catalogue, true);
  reminder.metadata = { ...reminder.metadata, deferredToolCatalogue: true };
  return reminder;
}
