export const BEHAVIOR_PROTOCOL_VERSION = 4;
export function assertBehaviorProtocol(version: unknown): void {
  if (version !== BEHAVIOR_PROTOCOL_VERSION) throw new Error('Resume rejected: behavior protocol changed');
}
/** Protocol 4: unified production default and an explicit exact-edit candidate. */
export type EditSurface = 'unified' | 'exact';
export type PromptVariant = 'baseline' | 'outcome';
export type CampaignVariant = 'baseline' | 'outcome' | 'exact-edit';
export interface BehaviorFactors {
  editSurface: EditSurface;
  promptVariant: PromptVariant;
}
export function resolveBehaviorFactors(variants: readonly CampaignVariant[]): Record<string, BehaviorFactors> {
  if (
    !variants.length ||
    new Set(variants).size !== variants.length ||
    variants.length > 2 ||
    variants.some(variant => !['baseline', 'outcome', 'exact-edit'].includes(variant)) ||
    (variants.length === 2 && !variants.includes('baseline'))
  )
    throw new Error('Compare current baseline with one candidate at a time.');
  return Object.fromEntries(
    variants.map(variant => [
      variant,
      {
        editSurface: variant === 'exact-edit' ? 'exact' : 'unified',
        promptVariant: variant === 'outcome' ? 'outcome' : 'baseline',
      },
    ])
  );
}
