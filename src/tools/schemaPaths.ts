import type { ParameterSchema } from '../types/index.js';

type SchemaNode = ParameterSchema | { type: 'object'; properties: Record<string, ParameterSchema>; required?: string[] };

/**
 * Collect every argument value the schema marks as `format: 'local-path'`.
 *
 * Walks arrays via `items` and objects via `properties`, so a path nested in a
 * structured parameter is authorized just like a top-level one. Values that are
 * absent, blank, or not strings are skipped — validation of shape belongs to
 * ToolValidator, not to path authorization.
 */
export function collectLocalPaths(value: unknown, schema: SchemaNode | undefined): string[] {
  const found: string[] = [];
  walk(value, schema, found);
  return found;
}

function walk(value: unknown, schema: SchemaNode | undefined, found: string[]): void {
  if (!schema || value === undefined || value === null) return;

  const marked = (schema as ParameterSchema).format === 'local-path';

  if (Array.isArray(value)) {
    const items = (schema as ParameterSchema).items;
    for (const entry of value) {
      // Marking the array authorizes its string entries whether or not `items`
      // is declared. Depending on `items` alone would make the mark a silent
      // no-op for the common `{ type: 'array', items: { type: 'string' } }`
      // shape — a trap that fails open, so the array's own mark always counts.
      if (marked && typeof entry === 'string' && entry.trim()) found.push(entry);
      if (items) walk(entry, items, found);
    }
    return;
  }

  if (marked) {
    if (typeof value === 'string' && value.trim()) found.push(value);
    return;
  }

  if (typeof value === 'object') {
    const properties = (schema as ParameterSchema).properties;
    if (!properties) return;
    for (const [key, childSchema] of Object.entries(properties)) {
      walk((value as Record<string, unknown>)[key], childSchema, found);
    }
  }
}
