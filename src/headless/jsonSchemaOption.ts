/**
 * `--json-schema` resolution.
 *
 * The caller's schema becomes the structured-output tool's parameter schema,
 * so it is read and checked once at startup. A schema that cannot be used is a
 * startup error: a run that silently dropped it would report success while
 * producing nothing the caller can parse.
 */

import { readFileSync } from 'node:fs';
import { formatError } from '../utils/errorUtils.js';
import type { CLIOptions } from '../cli/ArgumentParser.js';
import type { ParameterSchema } from '../types/index.js';
import { isHeadlessRun } from './HeadlessSession.js';

/** Read the flag's value, either inline JSON or `@path`. */
export function parseJsonSchemaOption(value: string): ParameterSchema {
  const text = value.startsWith('@') ? readSchemaFile(value.slice(1)) : value;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`--json-schema is not valid JSON: ${formatError(error)}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('--json-schema must be a JSON object');
  }

  const schema = parsed as ParameterSchema;
  if (schema.type !== 'object' || !schema.properties) {
    throw new Error("--json-schema must declare type 'object' and properties");
  }
  return schema;
}

/** The schema this run must produce, or undefined when the flag was not given. */
export function resolveStructuredOutputSchema(options: CLIOptions): ParameterSchema | undefined {
  if (!options.jsonSchema) return undefined;

  if (options.outputFormat !== 'json' && options.outputFormat !== 'stream-json') {
    throw new Error('--json-schema requires --output-format json or stream-json');
  }
  // The sink that receives the payload belongs to the headless session. An
  // interactive run would require the tool with nothing behind it, so every
  // call would fail and the turn could never end.
  if (!isHeadlessRun(options)) {
    throw new Error('--json-schema requires --once or --input-format stream-json');
  }
  return parseJsonSchemaOption(options.jsonSchema);
}

function readSchemaFile(path: string): string {
  if (path.length === 0) {
    throw new Error('--json-schema @ needs a file path');
  }
  try {
    return readFileSync(path, 'utf-8');
  } catch (error) {
    throw new Error(`--json-schema cannot read ${path}: ${formatError(error)}`);
  }
}
