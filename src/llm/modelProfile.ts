/**
 * Static model capabilities that cannot yet be discovered reliably from every
 * supported backend. Rules are declarative and ordered from most specific to
 * least specific so adding a future family requires one entry, not client code.
 */

/** Request field used by a backend to control native reasoning. */
export type ReasoningField = 'reasoning_effort' | 'think';

/**
 * Shape accepted by the request field. `level` means low/medium/high; `boolean`
 * means the backend only supports enabling or disabling native reasoning.
 */
export type ReasoningValueKind = 'level' | 'boolean';

export interface ReasoningControl {
  field: ReasoningField;
  valueKind: ReasoningValueKind;
}

interface ModelProfileRule {
  patterns: readonly RegExp[];
  reasoning: ReasoningControl;
}

const MODEL_PROFILE_RULES: readonly ModelProfileRule[] = [
  {
    patterns: [/gpt-oss/],
    reasoning: { field: 'reasoning_effort', valueKind: 'level' },
  },
  {
    // These Ollama templates accept `think` as an effort string, not merely a
    // boolean. Registry prefixes and quantization suffixes are matched too.
    patterns: [/qwen3\.8/, /(?:^|[/:_-])(?:muse[-_.]?)?glimmer(?:$|[/:_-])/],
    reasoning: { field: 'think', valueKind: 'level' },
  },
  {
    patterns: [
      /glm-4\.6/,
      /glm-4\.5/,
      /deepseek-r1/,
      /\bqwq\b/,
      /magistral/,
      /phi-?4.*reasoning/,
    ],
    reasoning: { field: 'think', valueKind: 'boolean' },
  },
];

export interface ModelProfile {
  /** The original model name supplied by the caller. */
  modelName: string;
  /** True when the model emits a native reasoning trace. */
  supportsThinking: boolean;
  /** How to encode reasoning for this model, or null for a conventional model. */
  reasoningControl: ReasoningControl | null;
}

export interface ReasoningRequestFields {
  reasoning_effort?: string;
  think?: boolean | string;
}

/** Resolve a case-insensitive model name against the capability registry. */
export function resolveModelProfile(modelName: string | null | undefined): ModelProfile {
  const name = (modelName ?? '').toLowerCase();
  const rule = name === ''
    ? undefined
    : MODEL_PROFILE_RULES.find(candidate => candidate.patterns.some(pattern => pattern.test(name)));
  const reasoningControl = rule?.reasoning ?? null;

  return {
    modelName: modelName ?? '',
    supportsThinking: reasoningControl !== null,
    reasoningControl,
  };
}

/**
 * Encode the resolved capability into backend request fields. Ollama consumes
 * both fields; OpenAI-compatible callers may select only the field their wire
 * protocol supports.
 */
export function reasoningRequestFields(
  profile: ModelProfile,
  effort: string | undefined,
): ReasoningRequestFields {
  const control = profile.reasoningControl;
  if (!control) return {};

  if (control.field === 'reasoning_effort') {
    return effort ? { reasoning_effort: effort } : {};
  }

  return control.valueKind === 'level'
    ? { think: effort ?? true }
    : { think: true };
}
