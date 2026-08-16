/**
 * What a tool can do to the machine it runs on.
 *
 * This is the single declaration from which the framework computes whether an
 * invocation must be confirmed. It replaces the former per-tool
 * `requiresConfirmation` boolean, which let each tool author set its own
 * security posture — and which two tools got wrong, reaching unprompted
 * arbitrary command execution.
 *
 * Declare what the tool actually does; the gate is derived, never declared.
 */
export enum ToolCapability {
  /** Reads paths on the local filesystem. */
  FsRead = 'fs_read',
  /** Creates, modifies, or deletes files in the user's workspace. */
  FsWrite = 'fs_write',
  /**
   * Writes Code-Ally's own state — todos, plans, memory, agent definitions,
   * scratch files under the system temp dir. Distinct from `FsWrite` because
   * the harness's bookkeeping is not the user's source tree; confirming every
   * todo update would train users to click through prompts.
   */
  AppStateWrite = 'app_state_write',
  /** Executes a model-supplied command line through a shell. */
  ShellExec = 'shell_exec',
  /** Issues an outbound request to a model-supplied endpoint. */
  Network = 'network',
  /** Terminates or cancels in-flight work (processes, delegated agents). */
  ProcessControl = 'process_control',
  /** Causes a side effect on a system outside this machine (MCP servers). */
  RemoteEffect = 'remote_effect',
}

/**
 * Capabilities that require user confirmation before an invocation proceeds.
 *
 * `FsRead` and `Network` are deliberately absent: reads are bounded by
 * `assertPathWithinAllowedDirectories` (see `BaseTool.validateFilesystemArgs`),
 * and fetches are already scoped by the tools that perform them. Confirmation is
 * reserved for capabilities that mutate state or run code.
 */
export const CONFIRMED_CAPABILITIES: ReadonlySet<ToolCapability> = new Set([
  ToolCapability.FsWrite,
  ToolCapability.ShellExec,
  ToolCapability.ProcessControl,
  ToolCapability.RemoteEffect,
]);

/** Whether any of `capabilities` requires confirmation. */
export function capabilitiesRequireConfirmation(
  capabilities: readonly ToolCapability[]
): boolean {
  return capabilities.some(capability => CONFIRMED_CAPABILITIES.has(capability));
}
