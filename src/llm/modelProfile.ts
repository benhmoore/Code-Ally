/**
 * Model profile — static, name-based capability hints for the served model.
 *
 * Open backends (Ollama, llama.cpp, vLLM) do not reliably advertise whether a
 * model emits a native reasoning trace, nor which request field controls it.
 * We infer that from the model name using a conservative allowlist: a model is
 * only treated as a reasoning model when its family is known, and the *kind* of
 * reasoning control differs by family:
 *
 *   - gpt-oss exposes the OpenAI-style top-level `reasoning_effort` knob.
 *   - GLM-4.5/4.6, DeepSeek-R1, QwQ, Magistral, Phi-4-reasoning use Ollama's
 *     generic `think` boolean.
 *
 * Everything else is treated as a plain chat/instruct model, so reasoning-only
 * request fields are omitted entirely (sending them to a non-reasoning model is
 * at best ignored and at worst rejected by the backend).
 *
 * This is the single source of truth for reasoning-model detection — keep the
 * patterns here rather than scattering name checks across the client.
 */

/** Which request field, if any, controls reasoning for a model family. */
export type ReasoningControl = 'reasoning_effort' | 'think' | 'none';

/** Families that use the OpenAI-style `reasoning_effort` field. */
const REASONING_EFFORT_PATTERNS: RegExp[] = [/gpt-oss/];

/** Families that use Ollama's generic `think` boolean. */
const THINK_PATTERNS: RegExp[] = [
  /glm-4\.6/,
  /glm-4\.5/,
  /deepseek-r1/,
  /\bqwq\b/,
  /magistral/,
  /phi-?4.*reasoning/,
];

export interface ModelProfile {
  /** The model name this profile was resolved from (lowercased originals preserved). */
  modelName: string;
  /** True when the model emits a native reasoning trace. */
  supportsThinking: boolean;
  /** The request field used to control reasoning for this model, or 'none'. */
  reasoningControl: ReasoningControl;
}

/**
 * Resolve the static profile for a model name. Matching is case-insensitive and
 * substring-based (so `gpt-oss:120b`, `gpt-oss:20b`, and registry-prefixed names
 * all resolve identically).
 */
export function resolveModelProfile(modelName: string | null | undefined): ModelProfile {
  const name = (modelName ?? '').toLowerCase();

  let reasoningControl: ReasoningControl = 'none';
  if (name !== '') {
    if (REASONING_EFFORT_PATTERNS.some(re => re.test(name))) {
      reasoningControl = 'reasoning_effort';
    } else if (THINK_PATTERNS.some(re => re.test(name))) {
      reasoningControl = 'think';
    }
  }

  return {
    modelName: modelName ?? '',
    supportsThinking: reasoningControl !== 'none',
    reasoningControl,
  };
}
