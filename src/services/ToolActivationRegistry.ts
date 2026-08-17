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
  private activations = new Map<string, string[]>();

  /** Mark tools as loaded for this agent, moving them to most-recently-used. */
  activate(agentId: string, toolNames: readonly string[]): void {
    if (toolNames.length === 0) return;
    const current = this.activations.get(agentId) ?? [];
    const retained = current.filter(name => !toolNames.includes(name));
    this.activations.set(agentId, [...retained, ...toolNames]);
  }

  /** Loaded tool names, least-recently-used first. */
  get(agentId: string): readonly string[] {
    return this.activations.get(agentId) ?? [];
  }

  clear(agentId: string): void {
    this.activations.delete(agentId);
  }
}
