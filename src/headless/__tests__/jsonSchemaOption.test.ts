import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CLIOptions } from '@cli/ArgumentParser.js';
import { parseJsonSchemaOption, resolveStructuredOutputSchema } from '../jsonSchemaOption.js';

const SCHEMA = { type: 'object', properties: { verdict: { type: 'string' } } };

describe('jsonSchemaOption', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ally-json-schema-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads an inline schema', () => {
    expect(parseJsonSchemaOption(JSON.stringify(SCHEMA))).toEqual(SCHEMA);
  });

  it('reads a schema from @file', () => {
    const path = join(dir, 'verdict.json');
    writeFileSync(path, JSON.stringify(SCHEMA));

    expect(parseJsonSchemaOption(`@${path}`)).toEqual(SCHEMA);
  });

  it('rejects a file it cannot read', () => {
    expect(() => parseJsonSchemaOption(`@${join(dir, 'absent.json')}`))
      .toThrow('--json-schema cannot read');
  });

  it('rejects malformed JSON', () => {
    expect(() => parseJsonSchemaOption('{"type":')).toThrow('--json-schema is not valid JSON');
  });

  it('rejects a schema that is not an object schema', () => {
    expect(() => parseJsonSchemaOption('{"type":"string"}'))
      .toThrow("--json-schema must declare type 'object' and properties");
    expect(() => parseJsonSchemaOption('[]')).toThrow('--json-schema must be a JSON object');
  });

  it('returns nothing when the flag was not given', () => {
    expect(resolveStructuredOutputSchema({ once: 'go' } as CLIOptions)).toBeUndefined();
  });

  it('requires a headless output format', () => {
    const options = { once: 'go', jsonSchema: JSON.stringify(SCHEMA) } as CLIOptions;

    expect(() => resolveStructuredOutputSchema(options))
      .toThrow('--json-schema requires --output-format json or stream-json');
  });

  it('resolves under json and stream-json output', () => {
    for (const outputFormat of ['json', 'stream-json'] as const) {
      const options = { once: 'go', outputFormat, jsonSchema: JSON.stringify(SCHEMA) } as CLIOptions;
      expect(resolveStructuredOutputSchema(options)).toEqual(SCHEMA);
    }
  });
});
