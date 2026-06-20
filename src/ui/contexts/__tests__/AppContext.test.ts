import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../config/defaults.js';
import {
  reconcileCurrentAgentModelAfterConfigUpdate,
  resolveCurrentAgentModelOverride,
} from '../AppContext.js';
import type { Config } from '../../../types/index.js';

describe('AppContext model display state', () => {
  it('does not cache the configured model as an agent override', () => {
    expect(resolveCurrentAgentModelOverride('qwen2.5-coder', 'qwen2.5-coder')).toBe('');
  });

  it('keeps a real agent-specific model override', () => {
    expect(resolveCurrentAgentModelOverride('glm-5.2:cloud', 'qwen2.5-coder')).toBe('glm-5.2:cloud');
  });

  it('clears a stale cached configured model when config.model changes', () => {
    const previousConfig: Config = {
      ...DEFAULT_CONFIG,
      model: 'qwen2.5-coder',
    };

    expect(
      reconcileCurrentAgentModelAfterConfigUpdate(
        'qwen2.5-coder',
        previousConfig,
        { model: 'qwen3.5:35b' }
      )
    ).toBe('');
  });

  it('does not clear an independent agent model when config.model changes', () => {
    const previousConfig: Config = {
      ...DEFAULT_CONFIG,
      model: 'qwen2.5-coder',
    };

    expect(
      reconcileCurrentAgentModelAfterConfigUpdate(
        'glm-5.2:cloud',
        previousConfig,
        { model: 'qwen3.5:35b' }
      )
    ).toBe('glm-5.2:cloud');
  });
});
