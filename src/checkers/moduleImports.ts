/**
 * Module-graph validation for ES modules.
 *
 * Syntax checking cannot see across files, so a module that imports a name its
 * neighbour never exports passes every per-file check and fails only when the
 * program runs. That drift is the characteristic failure of a long task on a
 * small context window: by the time a module is written, the API it depends on
 * has been compacted out of the window and is being recalled from memory.
 *
 * Catching it at write time turns a runtime crash discovered much later (or
 * never) into an immediate, specific correction.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { CheckIssue } from './types.js';

const IMPORT_PATTERN = /import\s+(?:type\s+)?([^;'"]*?)\s+from\s+['"]([^'"]+)['"]/g;
const RESOLVE_EXTENSIONS = ['', '.js', '.mjs', '.jsx', '.ts', '.tsx'];
const MAX_TARGET_BYTES = 512 * 1024;

/** Resolve a relative specifier the way a browser/Node ESM loader would. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const extension of RESOLVE_EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  for (const indexFile of ['index.js', 'index.ts', 'index.mjs']) {
    const candidate = path.join(base, indexFile);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

interface ModuleExports {
  named: Set<string>;
  hasDefault: boolean;
  /** `export * from` makes the surface open-ended, so names cannot be refuted. */
  reExportsAll: boolean;
}

function collectExports(source: string): ModuleExports {
  const named = new Set<string>();
  for (const match of source.matchAll(/export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z0-9_$]+)/g)) {
    named.add(match[1]!);
  }
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const entry of match[1]!.split(',')) {
      const alias = entry.trim().split(/\s+as\s+/).pop()?.trim();
      if (alias) named.add(alias);
    }
  }
  return {
    named,
    hasDefault: /export\s+default\s/.test(source),
    reExportsAll: /export\s*\*\s*from/.test(source),
  };
}

/** Names a statement's import clause binds, split by kind. */
function parseClause(clause: string): { named: string[]; defaultName: string | null; namespace: boolean } {
  const namedMatch = clause.match(/\{([^}]*)\}/);
  const named = namedMatch
    ? namedMatch[1]!.split(',')
        .map(entry => entry.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim())
        .filter((name): name is string => Boolean(name))
    : [];
  const remainder = clause.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim();
  const namespace = /\*\s+as\s+/.test(remainder);
  const defaultName = !namespace && remainder.length > 0 ? remainder.split(/\s+/)[0]! : null;
  return { named, defaultName, namespace };
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/**
 * Validate the relative imports of `content` against the files on disk.
 * Only relative specifiers are checked: bare specifiers belong to the package
 * manager, and reporting on them would produce noise this cannot substantiate.
 */
export function collectImportIssues(filePath: string, content: string): CheckIssue[] {
  const issues: CheckIssue[] = [];

  for (const match of content.matchAll(IMPORT_PATTERN)) {
    const clause = match[1]!.trim();
    const specifier = match[2]!;
    if (!specifier.startsWith('.')) continue;

    const line = lineOf(content, match.index ?? 0);
    const resolved = resolveSpecifier(filePath, specifier);
    if (!resolved) {
      issues.push({
        line,
        message: `Cannot resolve import '${specifier}' — no such file relative to ${path.basename(filePath)}`,
        code: 'IMPORT_UNRESOLVED',
        severity: 'error',
      });
      continue;
    }

    let target: string;
    try {
      if (statSync(resolved).size > MAX_TARGET_BYTES) continue;
      target = readFileSync(resolved, 'utf8');
    } catch {
      continue;
    }

    const exports = collectExports(target);
    const { named, defaultName } = parseClause(clause);

    if (defaultName && !exports.hasDefault && !exports.reExportsAll) {
      issues.push({
        line,
        message: `'${specifier}' has no default export, but it is imported as '${defaultName}'`,
        code: 'IMPORT_NO_DEFAULT',
        severity: 'error',
      });
    }

    if (exports.reExportsAll) continue;
    for (const name of named) {
      if (exports.named.has(name)) continue;
      const available = [...exports.named].sort().slice(0, 12).join(', ');
      issues.push({
        line,
        message: `'${specifier}' does not export '${name}'`
          + (available ? `. It exports: ${available}` : ' (it has no named exports)'),
        code: 'IMPORT_MISSING_EXPORT',
        severity: 'error',
      });
    }
  }

  return issues;
}
