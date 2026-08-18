import type { ToolCall } from '../../types/index.js';
import { parseToolCallArguments } from '../../llm/FunctionCalling.js';

/**
 * Argument keys whose values duplicate durable mutation payloads. These names
 * describe data shape rather than particular tools, so plugin mutation tools
 * receive the same bounded-history behavior as built-ins.
 */
const DURABLE_PAYLOAD_KEYS = new Set([
  'content',
  'old_string',
  'new_string',
  'patch',
  'diff',
]);

const MAX_OUTLINE_ENTRIES = 16;
const MAX_OUTLINE_CHARS = 600;

/** A compact, cross-language declaration outline suitable for a checkpoint. */
export function extractSourceOutline(value: unknown): string {
  const texts: string[] = [];
  const visit = (candidate: unknown) => {
    if (typeof candidate === 'string') texts.push(candidate);
    else if (Array.isArray(candidate)) candidate.forEach(visit);
    else if (candidate && typeof candidate === 'object') Object.values(candidate).forEach(visit);
  };
  visit(value);

  // Compacted calls already carry their outline inside the stub. Reuse it on
  // later checkpoint generations rather than trying to parse the stub as code.
  for (const text of texts) {
    const embedded = text.match(/outline:\s*([^\]]+)/)?.[1];
    if (embedded) return embedded.slice(0, MAX_OUTLINE_CHARS);
  }

  const signatures: Array<{ text: string; rank: number; order: number }> = [];
  const seen = new Set<string>();
  const patterns = [
    // JavaScript / TypeScript declarations.
    /^\s*(?:export\s+(?:default\s+)?)?(?:(?:async\s+)?function|class|interface|type|enum|const|let|var)\s+[A-Za-z_$][\w$]*/,
    // Rust declarations.
    /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|type)\s+[A-Za-z_][\w]*/,
    // Python declarations.
    /^\s*(?:async\s+def|def|class)\s+[A-Za-z_][\w]*/,
    // Go declarations.
    /^\s*(?:func|type)\s+(?:\([^)]*\)\s*)?[A-Za-z_][\w]*/,
    // Indented class/object methods in brace-delimited languages.
    /^\s+(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(?:get\s+|set\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*(?::[^={]+)?\s*\{/,
  ];
  for (const text of texts) {
    for (const rawLine of text.split(/\\n|\r?\n/)) {
      const line = rawLine.trim().replace(/\\n/g, ' ').replace(/\s+/g, ' ');
      if (!line || line.length > 240 || !patterns.some(pattern => pattern.test(rawLine))) continue;
      const signature = line.replace(/\s*\{\s*$/, '').slice(0, 160);
      if (seen.has(signature)) continue;
      seen.add(signature);
      const exportedCallable = /^export\s+(?:default\s+)?(?:(?:async\s+)?function|class|interface|type|enum)\b/.test(line)
        || /^pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type)\b/.test(line)
        || /^(?:async\s+def|def|class)\b/.test(line);
      const exportedValue = /^export\s+(?:const|let|var)\b/.test(line);
      const callable = /^(?:(?:async\s+)?function|class|interface|type|enum|(?:async\s+)?def|fn|struct|trait|func)\b/.test(line)
        || /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(?:get\s+|set\s+)?[A-Za-z_$][\w$]*\s*\(/.test(rawLine);
      signatures.push({
        text: signature,
        rank: exportedCallable ? 0 : exportedValue ? 1 : callable ? 2 : 3,
        order: signatures.length,
      });
    }
  }
  return signatures
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, MAX_OUTLINE_ENTRIES)
    .map(item => item.text)
    .join('; ')
    .slice(0, MAX_OUTLINE_CHARS);
}

function compactValue(value: unknown, key: string | null, outline: string): unknown {
  if (key && DURABLE_PAYLOAD_KEYS.has(key) && typeof value === 'string') {
    return `[payload evicted after successful tool call: ${value.length} chars`
      + `${outline ? `; outline: ${outline}` : ''}]`;
  }
  if (Array.isArray(value)) return value.map(item => compactValue(item, null, outline));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([childKey, child]) => [childKey, compactValue(child, childKey, outline)]));
  }
  return value;
}

export function toolCallHasDurablePayload(call: ToolCall): boolean {
  const args = parseToolCallArguments(call.function.arguments as any);
  const search = (value: unknown, key: string | null): boolean => {
    if (key && DURABLE_PAYLOAD_KEYS.has(key) && typeof value === 'string' && value.length > 0) return true;
    if (Array.isArray(value)) return value.some(item => search(item, null));
    if (value && typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>).some(([childKey, child]) => search(child, childKey));
    }
    return false;
  };
  return search(args, null);
}

/** Preserve argument shape and control fields while stubbing durable bulk. */
export function compactCompletedToolCall(call: ToolCall): ToolCall {
  const args = parseToolCallArguments(call.function.arguments as any);
  const outline = extractSourceOutline(args);
  return {
    ...call,
    function: {
      ...call.function,
      arguments: compactValue(args, null, outline) as Record<string, unknown>,
    },
  };
}
