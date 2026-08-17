import type { Config } from '../types/index.js';
import type { ActivityStream } from '../services/ActivityStream.js';
import type { BaseTool } from './BaseTool.js';
import { AgentAskTool } from './AgentAskTool.js';
import { AgentTool } from './AgentTool.js';
import { AskUserQuestionTool } from './AskUserQuestionTool.js';
import { BashOutputTool } from './BashOutputTool.js';
import { BashTool } from './BashTool.js';
import { BlockObjectiveTool } from './BlockObjectiveTool.js';
import { CancelAgentTool } from './CancelAgentTool.js';
import { CleanupCallTool } from './CleanupCallTool.js';
import { CompleteObjectiveTool } from './CompleteObjectiveTool.js';
import { DeleteAgentTool } from './DeleteAgentTool.js';
import { EditAgentTool } from './EditAgentTool.js';
import { EditTool } from './EditTool.js';
import { EnterPlanModeTool } from './EnterPlanModeTool.js';
import { ExitPlanModeTool } from './ExitPlanModeTool.js';
import { ExploreTool } from './ExploreTool.js';
import { FormatTool } from './FormatTool.js';
import { GlobTool } from './GlobTool.js';
import { GrepTool } from './GrepTool.js';
import { KillShellTool } from './KillShellTool.js';
import { LineEditTool } from './LineEditTool.js';
import { LintTool } from './LintTool.js';
import { ListAgentsTool } from './ListAgentsTool.js';
import { LsTool } from './LsTool.js';
import { ManageAgentsTool } from './ManageAgentsTool.js';
import { MemoryTool } from './MemoryTool.js';
import { PlanTool } from './PlanTool.js';
import { ReadTool } from './ReadTool.js';
import { ReconcileEffectTool } from './ReconcileEffectTool.js';
import { ResearchTool } from './ResearchTool.js';
import { ScheduledTasksTool } from './ScheduledTasksTool.js';
import { SessionsTool } from './SessionsTool.js';
import { SkillTool } from './SkillTool.js';
import { TodoWriteTool } from './TodoWriteTool.js';
import { TreeTool } from './TreeTool.js';
import { WaitTool } from './WaitTool.js';
import { WatchTool } from './WatchTool.js';
import { WebFetchTool } from './WebFetchTool.js';
import { WebSearchTool } from './WebSearchTool.js';
import { WriteAgentTool } from './WriteAgentTool.js';
import { WritePlanTool } from './WritePlanTool.js';
import { WriteTempTool } from './WriteTempTool.js';
import { WriteTool } from './WriteTool.js';

/**
 * Construct the canonical built-in tool catalog in provider-visible order.
 *
 * Keep construction here so CLI startup, request snapshots, and model
 * evaluations exercise exactly the same schemas. Contextual MCP/plugin tools
 * are appended by their respective managers after this catalog is created.
 */
export function createBuiltInTools(
  activityStream: ActivityStream,
  config: Readonly<Config>,
): BaseTool[] {
  return [
    new BashTool(activityStream, config),
    new BashOutputTool(activityStream),
    new KillShellTool(activityStream),
    new CancelAgentTool(activityStream),
    new WaitTool(activityStream),
    new WatchTool(activityStream),
    new CompleteObjectiveTool(activityStream),
    new BlockObjectiveTool(activityStream),
    new ReconcileEffectTool(activityStream),
    new ReadTool(activityStream),
    new WriteTool(activityStream),
    new WriteAgentTool(activityStream),
    new EditAgentTool(activityStream),
    new DeleteAgentTool(activityStream),
    new ListAgentsTool(activityStream),
    new WriteTempTool(activityStream),
    new EditTool(activityStream),
    new LineEditTool(activityStream),
    new GlobTool(activityStream),
    new GrepTool(activityStream),
    new LsTool(activityStream),
    new TreeTool(activityStream),
    new AgentTool(activityStream),
    new ManageAgentsTool(activityStream),
    new ExploreTool(activityStream),
    new PlanTool(activityStream),
    new AgentAskTool(activityStream),
    new CleanupCallTool(activityStream),
    new TodoWriteTool(activityStream),
    new SessionsTool(activityStream),
    new LintTool(activityStream),
    new FormatTool(activityStream),
    new AskUserQuestionTool(activityStream),
    new WebFetchTool(activityStream),
    new WebSearchTool(activityStream),
    new ResearchTool(activityStream),
    new SkillTool(activityStream),
    new MemoryTool(activityStream),
    new ScheduledTasksTool(activityStream),
    new EnterPlanModeTool(activityStream),
    new ExitPlanModeTool(activityStream),
    new WritePlanTool(activityStream),
  ];
}
