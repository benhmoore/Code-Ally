/** Requested permission policy. Auto falls back to manual until a reviewer is ready. */
export const PERMISSION_MODES = ['manual', 'auto', 'allow-all'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Normalize the deprecated boolean before config layers are merged. Canonical mode wins. */
export function normalizePermissionConfig<T extends Record<string, unknown>>(input: T): Omit<T, 'auto_confirm'> & { permission_mode?: unknown } {
  const { auto_confirm, ...result } = input;
  if (!Object.hasOwn(input, 'permission_mode') && Object.hasOwn(input, 'auto_confirm')) {
    const enabled = auto_confirm === true || (typeof auto_confirm === 'string' && ['true', 'yes', 'y', '1'].includes(auto_confirm.toLowerCase()));
    return { ...result, permission_mode: enabled ? 'allow-all' : 'manual' };
  }
  return result;
}
