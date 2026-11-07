import type { ToolCapability } from '../tools/ToolCapability.js';

/** Host-owned invocation effects and paths, derived from the tool's declared schema. */
export interface ToolPermissionMetadata {
  capabilities: readonly ToolCapability[];
  localPaths: readonly string[];
}
