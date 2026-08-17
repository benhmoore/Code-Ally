import { describe, expect, it } from 'vitest';
import {
  CORE_TOOL_NAMES,
  TOOL_SEARCH_TOOL_NAME,
  renderDeferredToolCatalogue,
  selectExposedTools,
} from '@tools/ToolExposurePolicy.js';
import type { FunctionDefinition } from '../../types/index.js';

const estimate = (text: string) => Math.ceil(text.length / 4);

function definition(name: string, descriptionSize = 200): FunctionDefinition {
  return {
    type: 'function',
    function: {
      name,
      description: `Does ${name}. ${'detail '.repeat(descriptionSize / 7)}`,
      parameters: { type: 'object', properties: {} },
    },
  } as FunctionDefinition;
}

const coreDefs = CORE_TOOL_NAMES.map(name => definition(name));
const mcpDefs = Array.from({ length: 25 }, (_, index) => definition(`chrome_action_${index}`, 400));

describe('selectExposedTools', () => {
  it('sends every tool and no catalogue when the surface fits', () => {
    const definitions = [...coreDefs, definition('web-fetch'), definition(TOOL_SEARCH_TOOL_NAME)];

    const result = selectExposedTools({
      definitions, schemaBudget: 1_000_000, estimateTokens: estimate,
    });

    expect(result.deferred).toEqual([]);
    // The search tool is pointless when nothing is withheld, so it is not sent.
    expect(result.exposed.map(d => d.function.name)).not.toContain(TOOL_SEARCH_TOOL_NAME);
    expect(result.exposed).toHaveLength(definitions.length - 1);
  });

  it('keeps the core loop and defers the rest when the surface does not fit', () => {
    const definitions = [...coreDefs, ...mcpDefs, definition(TOOL_SEARCH_TOOL_NAME)];
    const budget = estimate(JSON.stringify(coreDefs)) + 400;

    const result = selectExposedTools({
      definitions, schemaBudget: budget, estimateTokens: estimate,
    });

    const exposedNames = result.exposed.map(d => d.function.name);
    for (const core of CORE_TOOL_NAMES) expect(exposedNames).toContain(core);
    // The escape hatch must always ship when tools are withheld.
    expect(exposedNames).toContain(TOOL_SEARCH_TOOL_NAME);
    expect(result.deferred.length).toBeGreaterThan(0);
    expect(result.deferred.map(t => t.name)).toContain('chrome_action_0');
    // No capability vanishes silently: everything withheld is advertised.
    expect(exposedNames.length + result.deferred.length).toBe(definitions.length);
  });

  it('includes loaded tools, most recently used first, within the budget', () => {
    const definitions = [...coreDefs, ...mcpDefs, definition(TOOL_SEARCH_TOOL_NAME)];
    const coreTokens = estimate(JSON.stringify(coreDefs));
    const oneMcp = estimate(JSON.stringify(mcpDefs[0]));
    const searchTokens = estimate(JSON.stringify(definition(TOOL_SEARCH_TOOL_NAME)));

    const result = selectExposedTools({
      definitions,
      // Room for the core loop, the search tool, and exactly two loaded tools.
      schemaBudget: coreTokens + searchTokens + oneMcp * 2 + 10,
      activated: ['chrome_action_1', 'chrome_action_2', 'chrome_action_3'],
      estimateTokens: estimate,
    });

    const exposedNames = result.exposed.map(d => d.function.name);
    expect(exposedNames).toContain('chrome_action_3');
    expect(exposedNames).toContain('chrome_action_2');
    expect(exposedNames).not.toContain('chrome_action_1');
    expect(result.exposedTokens).toBeLessThanOrEqual(coreTokens + searchTokens + oneMcp * 2 + 10);
  });

  it('never drops the core loop, even when the budget cannot hold it', () => {
    const definitions = [...coreDefs, ...mcpDefs, definition(TOOL_SEARCH_TOOL_NAME)];

    const result = selectExposedTools({
      definitions, schemaBudget: 10, estimateTokens: estimate,
    });

    const exposedNames = result.exposed.map(d => d.function.name);
    for (const core of CORE_TOOL_NAMES) expect(exposedNames).toContain(core);
  });
});

describe('renderDeferredToolCatalogue', () => {
  it('advertises withheld tools compactly with loading instructions', () => {
    const catalogue = renderDeferredToolCatalogue([
      { name: 'web-fetch', summary: 'Fetch and extract content from a URL' },
      { name: 'chrome_navigate_page', summary: 'Navigate the browser to a URL' },
    ]);

    expect(catalogue).toContain('web-fetch: Fetch and extract content from a URL');
    expect(catalogue).toContain(TOOL_SEARCH_TOOL_NAME);
    expect(catalogue).toContain('select:web-fetch');
    // Advertising must stay far cheaper than the schemas it replaces.
    expect(estimate(catalogue)).toBeLessThan(120);
  });

  it('is empty when nothing is deferred', () => {
    expect(renderDeferredToolCatalogue([])).toBe('');
  });

  it('bounds its own size when very many tools are deferred', () => {
    const many = Array.from({ length: 300 }, (_, index) => ({
      name: `tool_${index}`, summary: 'Does a thing with several words of description',
    }));

    const catalogue = renderDeferredToolCatalogue(many);

    expect(catalogue).toContain('and 220 more');
    expect(estimate(catalogue)).toBeLessThan(1_600);
  });
});
