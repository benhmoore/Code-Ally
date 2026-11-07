import type { FunctionDefinition } from '../types/index.js';

/**
 * Tracks which deferred tools an agent has loaded.
 *
 * Activation is per agent instance (matching how read state and context
 * budgets are scoped) so a delegated agent loading a tool never alters its
 * parent's request surface. Order is least-recently-used first, so when the
 * schema budget cannot hold every activated tool, the ones the agent has
 * actually been using are the ones that survive.
 */
export class ToolActivationRegistry {
  private available = new Map<string, () => readonly FunctionDefinition[]>();
  private activations = new Map<string, string[]>();
  private requested = new Map<string, string[]>();

  /** Publish the owner's authorized, state-eligible discovery surface. */
  setAvailable(agentId: string, definitions: () => readonly FunctionDefinition[]): void {
    this.available.set(agentId, definitions);
  }

  getAvailable(agentId: string): readonly FunctionDefinition[] | undefined {
    return this.available.get(agentId)?.();
  }

  /** Explicitly load tools for this agent and keep that requested batch pinned. */
  activate(agentId: string, toolNames: readonly string[]): void {
    if (toolNames.length === 0) return;
    const unique = [...new Set(toolNames)];
    this.requested.set(agentId, unique);
    this.touch(agentId, unique);
  }

  /** Record actual use for LRU exposure without replacing the requested batch. */
  touch(agentId: string, toolNames: readonly string[]): void {
    if (toolNames.length === 0) return;
    const current = this.activations.get(agentId) ?? [];
    const retained = current.filter(name => !toolNames.includes(name));
    this.activations.set(agentId, [...retained, ...toolNames]);
  }

  /** Loaded tool names, least-recently-used first. */
  get(agentId: string): readonly string[] {
    return this.activations.get(agentId) ?? [];
  }

  /** Most recent batch explicitly requested through tool-search. */
  getRequested(agentId: string): readonly string[] {
    return this.requested.get(agentId) ?? [];
  }

  clear(agentId: string): void {
    this.available.delete(agentId);
    this.activations.delete(agentId);
    this.requested.delete(agentId);
  }
}
