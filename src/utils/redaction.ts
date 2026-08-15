const SECRET_FIELD_PATTERN = /(\b(?:api[_-]?key|search[_-]?api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|password|secret)\b\s*[=:]\s*)(["']?)([^\s,"'}]+)\2/gi;

/** Redact common credentials before text reaches logs or diagnostic exports. */
export function redactSensitiveText(input: string): string {
  return input
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(SECRET_FIELD_PATTERN, '$1[REDACTED]');
}
