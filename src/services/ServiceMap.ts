/**
 * ServiceMap - The registry's key/type contract
 *
 * Every service that lives in the ServiceRegistry is declared here exactly
 * once, mapping its registration key (the snake_case string used in the
 * composition root, src/cli.ts) to its concrete type. `ServiceRegistry.get()`
 * and `registerInstance()` are keyed off this map, so a typo or a lookup of a
 * key nothing registers is a compile error rather than a silent `null`.
 *
 * Adding a service means adding it here AND registering it in src/cli.ts (or
 * another composition site). Do NOT add a key here to silence an error for
 * something that is never registered - that reintroduces the silent-null class
 * of bug this map exists to prevent.
 *
 * All imports are type-only so this module contributes no runtime edges and
 * cannot create an import cycle.
 */

import type { Agent } from '../agent/Agent.js';
import type { Command } from '../agent/commands/Command.js';
import type { TokenManager } from '../agent/TokenManager.js';
import type { TrustManager } from '../agent/TrustManager.js';
import type { MessageHistory } from '../llm/MessageHistory.js';
import type { ModelClient } from '../llm/ModelClient.js';
import type { MarketplaceManager } from '../marketplace/MarketplaceManager.js';
import type { PluginManager } from '../marketplace/PluginManager.js';
import type { MCPServerManager } from '../mcp/MCPServerManager.js';
import type { PermissionManager } from '../security/PermissionManager.js';
import type { ToolManager } from '../tools/ToolManager.js';
import type { ActivityStream } from './ActivityStream.js';
import type { AdditionalDirectoriesManager } from './AdditionalDirectoriesManager.js';
import type { AgentGenerationService } from './AgentGenerationService.js';
import type { AgentManager } from './AgentManager.js';
import type { AgentPoolService } from './AgentPoolService.js';
import type { AutoToolCleanupService } from './AutoToolCleanupService.js';
import type { BackgroundAgentManager } from './BackgroundAgentManager.js';
import type { BackgroundTaskRegistry } from './BackgroundTaskRegistry.js';
import type { BashProcessManager } from './BashProcessManager.js';
import type { ConfigManager } from './ConfigManager.js';
import type { FileInteractionTracker } from './FileInteractionTracker.js';
import type { FocusManager } from './FocusManager.js';
import type { FormManager } from './FormManager.js';
import type { IdleMessageGenerator } from './IdleMessageGenerator.js';
import type { IdleTaskCoordinator } from './IdleTaskCoordinator.js';
import type { IntegrationStore } from './IntegrationStore.js';
import type { MemoryService } from './MemoryService.js';
import type { PatchManager } from './PatchManager.js';
import type { PathResolver } from './PathResolver.js';
import type { PlanModeManager } from './PlanModeManager.js';
import type { ProjectContextDetector } from './ProjectContextDetector.js';
import type { PromptLibraryManager } from './PromptLibraryManager.js';
import type { ReadCache } from './ReadCache.js';
import type { ReadStateManager } from './ReadStateManager.js';
import type { RunPolicyManager } from './RunPolicyManager.js';
import type { RunSupervisor } from './RunSupervisor.js';
import type { ScheduledTaskManager } from './ScheduledTaskManager.js';
import type { SessionManager } from './SessionManager.js';
import type { SessionTitleGenerator } from './SessionTitleGenerator.js';
import type { SkillManager } from './SkillManager.js';
import type { ToolCallHistory } from './ToolCallHistory.js';
import type { ToolResultPersistence } from './ToolResultPersistence.js';
import type { TodoManager } from './TodoManager.js';

export interface ServiceMap {
  // --- Conversation / agent core ---
  /** The foreground Agent. Swapped by AgentSwitcher/ForegroundSwitcher and overridden per sub-agent scope. */
  agent: Agent;
  /** Token accounting for whichever Agent is currently foreground. */
  token_manager: TokenManager;
  agent_manager: AgentManager;
  agent_pool: AgentPoolService;
  agent_generation_service: AgentGenerationService;
  background_agent_manager: BackgroundAgentManager;
  background_task_registry: BackgroundTaskRegistry;

  // --- Model clients ---
  /** Main conversation model. */
  model_client: ModelClient;
  /** Cheaper/background model for titles, idle messages, cleanup. */
  service_model_client: ModelClient;
  message_history: MessageHistory;

  // --- Configuration & profiles ---
  config_manager: ConfigManager;
  integration_store: IntegrationStore;

  // --- Sessions & persistence ---
  session_manager: SessionManager;
  session_title_generator: SessionTitleGenerator;
  patch_manager: PatchManager;
  tool_result_persistence: ToolResultPersistence;
  memory_service: MemoryService;

  // --- UI / event plumbing ---
  activity_stream: ActivityStream;
  form_manager: FormManager;
  run_policy_manager: RunPolicyManager;
  run_supervisor: RunSupervisor;

  // --- Workspace state ---
  path_resolver: PathResolver;
  focus_manager: FocusManager;
  additional_dirs_manager: AdditionalDirectoriesManager;
  read_state_manager: ReadStateManager;
  read_cache: ReadCache;
  file_interaction_tracker: FileInteractionTracker;
  project_context_detector: ProjectContextDetector;

  // --- Task & plan state ---
  todo_manager: TodoManager;
  plan_mode_manager: PlanModeManager;
  scheduled_task_manager: ScheduledTaskManager;
  bash_process_manager: BashProcessManager;

  // --- Idle-time work ---
  /** Null when idle messages are disabled in config; RuntimeConfigSync re-registers on toggle. */
  idle_message_generator: IdleMessageGenerator | null;
  idle_task_coordinator: IdleTaskCoordinator;
  auto_tool_cleanup: AutoToolCleanupService;

  // --- Tools, permissions, security ---
  tool_manager: ToolManager;
  tool_call_history: ToolCallHistory;
  trust_manager: TrustManager;
  permission_manager: PermissionManager;

  // --- Extensions ---
  marketplace_manager: MarketplaceManager;
  plugin_manager: PluginManager;
  /** Slash commands loaded from plugin markdown files. */
  plugin_commands: Command[];
  mcp_server_manager: MCPServerManager;
  skill_manager: SkillManager;
  prompt_library_manager: PromptLibraryManager;
}

/** Every valid registry key. */
export type ServiceName = keyof ServiceMap;
