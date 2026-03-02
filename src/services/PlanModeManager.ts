/**
 * PlanModeManager - Central authority for plan mode state
 *
 * Manages the plan mode lifecycle: entering read-only exploration mode,
 * writing plans, requesting user approval, and transitioning back to
 * implementation mode.
 *
 * Follows existing service patterns (TodoManager, FocusManager).
 */

import { ActivityStream } from './ActivityStream.js';
import { ActivityEventType } from '../types/index.js';
import { logger } from './Logger.js';

/**
 * Plan approval options
 */
export type PlanApprovalChoice = 'approve' | 'approve_clear_context' | 'feedback';

/**
 * Plan approval response from user
 */
export interface PlanApprovalResponse {
  choice: PlanApprovalChoice;
  feedback?: string;
}

/**
 * Plan mode state
 */
export interface PlanModeState {
  active: boolean;
  planFilePath: string | null;
  planContent: string | null;
  enteredAt: number | null;
}

/**
 * Allowed tools during plan mode (read-only + plan-specific)
 */
export const PLAN_MODE_ALLOWED_TOOLS = new Set([
  'read',
  'glob',
  'grep',
  'ls',
  'tree',
  'batch',
  'explore',
  'ask-user-question',
  'write-plan',
  'exit-plan-mode',
]);

export class PlanModeManager {
  private state: PlanModeState;
  private activityStream: ActivityStream;
  private pendingApproval: {
    resolve: (response: PlanApprovalResponse) => void;
    reject: (error: Error) => void;
  } | null = null;

  constructor(activityStream: ActivityStream) {
    this.activityStream = activityStream;
    this.state = {
      active: false,
      planFilePath: null,
      planContent: null,
      enteredAt: null,
    };

    // Listen for approval responses from the UI
    this.activityStream.subscribe(ActivityEventType.PLAN_APPROVAL_RESPONSE, (event) => {
      if (this.pendingApproval) {
        const { choice, feedback } = event.data;
        this.pendingApproval.resolve({ choice, feedback });
        this.pendingApproval = null;
      }
    });
  }

  /**
   * Enter plan mode - restricts tools to read-only set
   */
  enterPlanMode(): void {
    if (this.state.active) {
      logger.warn('[PlanModeManager] Already in plan mode');
      return;
    }

    this.state = {
      active: true,
      planFilePath: null,
      planContent: null,
      enteredAt: Date.now(),
    };

    this.activityStream.emit({
      id: `plan_mode_${Date.now()}`,
      type: ActivityEventType.PLAN_MODE_ENTERED,
      timestamp: Date.now(),
      data: {},
    });

    logger.debug('[PlanModeManager] Plan mode entered');
  }

  /**
   * Exit plan mode - resets state
   */
  exitPlanMode(): void {
    this.state = {
      active: false,
      planFilePath: null,
      planContent: null,
      enteredAt: null,
    };

    logger.debug('[PlanModeManager] Plan mode exited');
  }

  /**
   * Check if plan mode is active
   */
  isActive(): boolean {
    return this.state.active;
  }

  /**
   * Get the current plan mode state
   */
  getState(): Readonly<PlanModeState> {
    return { ...this.state };
  }

  /**
   * Store the plan content and file path
   */
  setPlan(filePath: string, content: string): void {
    this.state.planFilePath = filePath;
    this.state.planContent = content;
    logger.debug(`[PlanModeManager] Plan set: ${filePath}`);
  }

  /**
   * Check if a plan has been written
   */
  hasPlan(): boolean {
    return this.state.planContent !== null && this.state.planFilePath !== null;
  }

  /**
   * Request user approval of the plan
   * Emits PLAN_APPROVAL_REQUEST and blocks until PLAN_APPROVAL_RESPONSE received
   */
  async requestApproval(): Promise<PlanApprovalResponse> {
    if (!this.state.planContent || !this.state.planFilePath) {
      throw new Error('No plan to approve - write a plan first with write-plan');
    }

    // Emit approval request to UI
    this.activityStream.emit({
      id: `plan_approval_${Date.now()}`,
      type: ActivityEventType.PLAN_APPROVAL_REQUEST,
      timestamp: Date.now(),
      data: {
        planFilePath: this.state.planFilePath,
        planContent: this.state.planContent,
      },
    });

    logger.debug('[PlanModeManager] Approval requested, waiting for response...');

    // Wait for response from UI
    return new Promise<PlanApprovalResponse>((resolve, reject) => {
      this.pendingApproval = { resolve, reject };
    });
  }

  /**
   * Reset plan mode state completely
   */
  reset(): void {
    if (this.pendingApproval) {
      this.pendingApproval.reject(new Error('Plan mode reset'));
      this.pendingApproval = null;
    }
    this.exitPlanMode();
  }

  /**
   * Check if a tool is allowed during plan mode
   */
  isToolAllowed(toolName: string): boolean {
    if (!this.state.active) return true;
    return PLAN_MODE_ALLOWED_TOOLS.has(toolName);
  }
}
