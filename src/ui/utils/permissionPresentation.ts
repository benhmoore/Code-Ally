import { PERMISSION_MODES, type PermissionMode } from '../../security/PermissionMode.js';
import type { PermissionDecision } from '@shared/index.js';

export const permissionModeLabel = (mode: PermissionMode): string =>
  ({
    manual: 'Manual',
    auto: 'Auto',
    'allow-all': 'Allow-all',
  })[mode];

/** The shortcut follows requested mode so an Auto fallback is never a hidden toggle. */
export function nextPermissionMode(mode: PermissionMode): PermissionMode {
  return PERMISSION_MODES[(PERMISSION_MODES.indexOf(mode) + 1) % PERMISSION_MODES.length]!;
}

/** Commands stay inspectable even when they contain terminal control bytes. */
export function visiblePermissionText(text: string): string {
  return text.replace(
    /[\x00-\x08\x0b-\x1f\x7f]/g,
    character => `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`
  );
}

/** Routine read approvals use the tool's ordinary status; reviews stay visible in history. */
export function permissionDecisionText(decision: PermissionDecision | undefined): string | undefined {
  if (!decision || (decision.source === 'policy' && decision.verdict === 'allow')) return undefined;
  const verdict = { allow: 'approved', ask: 'needs approval', deny: 'denied' }[decision.verdict];
  const label = decision.source === 'shadow' ? `Shadow review: ${verdict}` : `Auto ${verdict}`;
  const model = decision.reviewerModel ? ` · ${decision.reviewerModel}` : '';
  const reason = decision.verdict !== 'allow' || decision.source === 'shadow' ? ` · ${decision.reason}` : '';
  return visiblePermissionText(`${label}${model}${reason}`).replace(/\s+/g, ' ');
}
