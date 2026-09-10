import type { SemanticCheckpointStateV1 } from '../compaction/types.js';

/** Model proposals contain evidence changes, never authoritative requests. */
export function proposalFromState(state: SemanticCheckpointStateV1) {
  const { userConstraints, decisions, completedWork, durableFacts, artifacts,
    activeWork, blockers, nextActions, unresolvedQuestions } = state;
  return {
    additions: { userConstraints, decisions, completedWork, durableFacts, artifacts },
    frontier: { activeWork, blockers, nextActions, unresolvedQuestions },
  };
}
