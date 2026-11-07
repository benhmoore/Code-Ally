import { describe, expect, it } from 'vitest';
import { validateConfigValue } from '../defaults.js';
import type { Config } from '../../types/index.js';

describe('setting numeric validation', () => {
  it.each<[keyof Config, unknown]>([
    ['context_size', 0],
    ['context_size', 1.5],
    ['max_tokens', -1],
    ['top_p', 1.1],
    ['min_p', -0.1],
    ['tool_call_max_retries', 0.5],
    ['bash_timeout', 0],
    ['read_max_tokens', Infinity],
  ])('rejects invalid %s=%s', (key, value) => {
    expect(validateConfigValue(key, value).valid).toBe(false);
  });
  it('keeps explicit smaller stress windows and disabled activity timeouts valid', () => {
    expect(validateConfigValue('context_size', 16384).valid).toBe(true);
    expect(validateConfigValue('tool_call_activity_timeout', 0).valid).toBe(true);
    expect(validateConfigValue('context_size', '32768').coercedValue).toBe(32768);
  });
});
