/** Durable audit of the automatic permission check, separate from human consent. */
export interface PermissionDecision {
  toolName: string;
  verdict: 'allow' | 'ask' | 'deny';
  reason: string;
  source: 'policy' | 'reviewer' | 'shadow';
  timestamp: number;
  reviewerModel?: string;
}
