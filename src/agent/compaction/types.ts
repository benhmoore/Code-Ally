import type { Message } from '../../types/index.js';

export type CompactionTrigger = 'automatic' | 'manual' | 'recovery' | 'model-switch';
export type CompactionPhase = 'pre-turn' | 'mid-turn' | 'post-turn' | 'manual' | 'resume';
export type CompactionStrategy = 'local-structured' | 'local-extractive' | 'openai-native';
export type CheckpointPortability = 'model-validated' | 'extractive';

export interface SemanticFact {
  text: string;
  sourceMessageIds: string[];
}

export interface SemanticDecision extends SemanticFact {
  rationale?: string;
}

export interface SemanticBlocker extends SemanticFact {
  exactError?: string;
}

export interface ArtifactReference {
  path: string;
  reason: string;
  operation: 'read' | 'modified' | 'created' | 'referenced';
  sourceMessageIds: string[];
  contentHash?: string;
  symbol?: string;
  lineStart?: number;
  lineEnd?: number;
}

/** Portable, provider-neutral task state carried across context windows. */
export interface SemanticCheckpointStateV1 {
  schemaVersion: 1;
  objective: SemanticFact | null;
  currentRequest: SemanticFact | null;
  userConstraints: SemanticFact[];
  decisions: SemanticDecision[];
  completedWork: SemanticFact[];
  activeWork: SemanticFact[];
  blockers: SemanticBlocker[];
  nextActions: SemanticFact[];
  unresolvedQuestions: SemanticFact[];
  durableFacts: SemanticFact[];
  artifacts: ArtifactReference[];
}

export interface CompactionBudgetMetrics {
  contextWindow: number;
  estimatedBefore: number;
  exactBefore?: number;
  triggerBudget: number;
  targetBudget: number;
  outputReserve: number;
  safetyReserve: number;
  after: number;
}

export type ProviderCheckpointState =
  | { kind: 'chat' }
  | {
      kind: 'openai-responses';
      provider?: 'openai-responses';
      model?: string;
      items: unknown[];
      coveredMessageIds: string[];
      pendingAssistant?: { content: string; toolCallIds: string[] };
    };

/**
 * A committed handoff between context windows. This is persisted independently
 * from wire messages so regenerated system prompts can never erase it.
 */
export interface ConversationCheckpointV1 {
  schemaVersion: 1;
  id: string;
  parentId?: string;
  generation: number;
  createdAt: string;
  trigger: CompactionTrigger;
  phase: CompactionPhase;
  strategy: CompactionStrategy;
  portability: CheckpointPortability;
  provider: string;
  model: string;
  source: {
    firstMessageId: string;
    lastMessageId: string;
    messageIds: string[];
    digest: string;
  };
  retainedMessageIds: string[];
  semanticState: SemanticCheckpointStateV1;
  providerState: ProviderCheckpointState;
  replacementMessages: Message[];
  budget: CompactionBudgetMetrics;
  focus?: string;
  degradedReason?: string;
}

export function emptySemanticCheckpoint(): SemanticCheckpointStateV1 {
  return {
    schemaVersion: 1,
    objective: null,
    currentRequest: null,
    userConstraints: [],
    decisions: [],
    completedWork: [],
    activeWork: [],
    blockers: [],
    nextActions: [],
    unresolvedQuestions: [],
    durableFacts: [],
    artifacts: [],
  };
}
