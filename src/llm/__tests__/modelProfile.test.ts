/**
 * Tests for model profile resolution (reasoning-control detection).
 */

import { describe, it, expect } from 'vitest';
import { resolveModelProfile } from '../modelProfile.js';

describe('resolveModelProfile', () => {
  it('maps gpt-oss models to the reasoning_effort control', () => {
    for (const name of ['gpt-oss:20b', 'gpt-oss:120b', 'GPT-OSS:120B', 'registry.io/library/gpt-oss:20b']) {
      const p = resolveModelProfile(name);
      expect(p.reasoningControl).toBe('reasoning_effort');
      expect(p.supportsThinking).toBe(true);
    }
  });

  it('maps GLM-4.6 / DeepSeek-R1 / QwQ / Magistral to the think control', () => {
    for (const name of ['glm-4.6:cloud', 'glm-4.5', 'deepseek-r1:32b', 'qwq', 'magistral:24b']) {
      const p = resolveModelProfile(name);
      expect(p.reasoningControl).toBe('think');
      expect(p.supportsThinking).toBe(true);
    }
  });

  it('treats plain chat/instruct models as non-reasoning', () => {
    for (const name of ['llama3.2', 'qwen2.5-coder:32b', 'mistral', 'gemma2:9b', 'codellama:13b']) {
      const p = resolveModelProfile(name);
      expect(p.reasoningControl).toBe('none');
      expect(p.supportsThinking).toBe(false);
    }
  });

  it('handles empty / null / undefined names as non-reasoning', () => {
    for (const name of ['', null, undefined]) {
      const p = resolveModelProfile(name);
      expect(p.reasoningControl).toBe('none');
      expect(p.supportsThinking).toBe(false);
    }
  });

  it('does not misclassify qwen2.5 (non-thinking) as a qwq/think model', () => {
    expect(resolveModelProfile('qwen2.5-coder:7b').reasoningControl).toBe('none');
  });
});
