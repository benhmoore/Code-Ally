import { describe, expect, it } from 'vitest';
import { reasoningRequestFields, resolveModelProfile } from '../modelProfile.js';

describe('resolveModelProfile', () => {
  it('maps gpt-oss to graded reasoning_effort', () => {
    for (const name of ['gpt-oss:20b', 'GPT-OSS:120B', 'registry.io/library/gpt-oss:20b']) {
      const profile = resolveModelProfile(name);
      expect(profile.reasoningControl).toEqual({ field: 'reasoning_effort', valueKind: 'level' });
      expect(reasoningRequestFields(profile, 'high')).toEqual({ reasoning_effort: 'high' });
    }
  });

  it('maps Qwen3.8 and Glimmer variants to graded Ollama think', () => {
    for (const name of [
      'qwen3.8:27b-mlx',
      'registry.example/models/QWEN3.8:35b-q4',
      'muse-glimmer:30b-mlx',
      'registry.example/meta/glimmer:30b',
    ]) {
      const profile = resolveModelProfile(name);
      expect(profile.reasoningControl).toEqual({ field: 'think', valueKind: 'level', disabledValue: false });
      expect(reasoningRequestFields(profile, 'medium')).toEqual({ think: 'medium' });
    }
  });

  it('maps older thinking families to boolean Ollama think', () => {
    for (const name of ['glm-4.6:cloud', 'deepseek-r1:32b', 'qwq', 'magistral:24b']) {
      const profile = resolveModelProfile(name);
      expect(profile.reasoningControl).toEqual({ field: 'think', valueKind: 'boolean', disabledValue: false });
      expect(reasoningRequestFields(profile, 'high')).toEqual({ think: true });
    }
  });

  it('treats conventional and empty names as non-reasoning', () => {
    for (const name of ['llama3.2', 'qwen2.5-coder:32b', 'mistral', '', null, undefined]) {
      const profile = resolveModelProfile(name);
      expect(profile.reasoningControl).toBeNull();
      expect(profile.supportsThinking).toBe(false);
      expect(reasoningRequestFields(profile, 'high')).toEqual({});
    }
  });

  it('enables graded think with the model default when effort is unset', () => {
    expect(reasoningRequestFields(resolveModelProfile('qwen3.8:27b'), undefined)).toEqual({ think: true });
  });

  it('uses the model-declared disabled value for constrained output', () => {
    expect(reasoningRequestFields(resolveModelProfile('qwen3.8:27b'), 'high', false)).toEqual({ think: false });
    expect(reasoningRequestFields(resolveModelProfile('deepseek-r1:32b'), 'high', false)).toEqual({ think: false });
    expect(reasoningRequestFields(resolveModelProfile('gpt-oss:20b'), 'high', false)).toEqual({});
  });
});
