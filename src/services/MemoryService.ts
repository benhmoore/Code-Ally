/**
 * MemoryService - Autonomous, project-scoped long-term memory
 *
 * The agent-managed counterpart to ALLY.md. Each fact is stored as a single
 * Markdown file with frontmatter; MEMORY.md is a derived index. Memory lives
 * globally under ~/.ally/projects/<key>/memory so it stays private and never
 * touches the working tree, which makes silent autonomous writes safe.
 *
 * Design notes:
 * - Files are the source of truth; MEMORY.md is always rebuilt from them, so
 *   the index can never drift out of sync with the underlying facts.
 * - Writes are atomic (temp + rename) and serialized per-path via a write
 *   queue, mirroring SessionManager, so concurrent saves never corrupt a file.
 * - Unparseable files are quarantined rather than crashing recall.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { IService } from '../types/index.js';
import { getProjectMemoryDir } from '../config/paths.js';
import { logger } from './Logger.js';

/** The four memory categories, mirroring the recall taxonomy. */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** Display order for grouping the index, most-personal first. */
const TYPE_ORDER: MemoryType[] = ['user', 'feedback', 'project', 'reference'];

/** A single stored memory. */
export interface MemoryRecord {
  /** Kebab-case slug; also the filename stem. */
  name: string;
  /** One-line summary used for relevance and the index. */
  description: string;
  type: MemoryType;
  /** The fact itself (Markdown). */
  body: string;
  /** ISO timestamps. */
  created: string;
  updated: string;
}

/** Input accepted by {@link MemoryService.save}. */
export interface MemorySaveInput {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

/** Compact, capped index for injection into the system prompt. */
export interface MemoryPromptContext {
  /** Grouped index lines (no file header/comment). */
  text: string;
  /** Total number of memories. */
  total: number;
  /** How many were included before the cap. */
  shown: number;
}

export interface MemoryServiceOptions {
  /** Override the storage directory (primarily for tests). */
  memoryDir?: string;
  /** Injectable clock for deterministic timestamps (primarily for tests). */
  now?: () => string;
}

/** Thrown when save input fails validation. Caught by callers for clean errors. */
export class MemoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryValidationError';
  }
}

const INDEX_FILENAME = 'MEMORY.md';
const MAX_DESCRIPTION_LENGTH = 200;
const MAX_NAME_LENGTH = 80;
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Automatic-recall caps. Deliberately conservative: this surfaces memory bodies
 * unprompted every matching turn, often against local models with small context
 * windows, so it must stay cheap. Tune here, not at call sites.
 */
const AUTO_RECALL_MAX_MEMORIES = 2;
const AUTO_RECALL_MAX_BODY_CHARS = 500;
/** Require at least one strong (name/description) token hit, not a lone body coincidence. */
const AUTO_RECALL_MIN_SCORE = 3;

export class MemoryService implements IService {
  private readonly memoryDir: string;
  private readonly quarantineDir: string;
  private readonly indexPath: string;
  private readonly now: () => string;

  /** Serializes writes per absolute path to prevent torn files. */
  private writeQueue: Map<string, Promise<void>> = new Map();

  /** Cached parsed records; null until first load, invalidated on every write. */
  private recordsCache: MemoryRecord[] | null = null;

  constructor(options: MemoryServiceOptions = {}) {
    this.memoryDir = options.memoryDir ?? getProjectMemoryDir();
    this.quarantineDir = join(this.memoryDir, '.quarantine');
    this.indexPath = join(this.memoryDir, INDEX_FILENAME);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Absolute path to this project's memory directory. */
  getMemoryDir(): string {
    return this.memoryDir;
  }

  /**
   * Create the storage directories, clear stale temp files, and rebuild the
   * index from disk so MEMORY.md self-heals if it was edited or lost.
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.memoryDir, { recursive: true });
    await fs.mkdir(this.quarantineDir, { recursive: true });
    await this.cleanupTempFiles();
    await this.rebuildIndex();
  }

  async cleanup(): Promise<void> {
    // Writes are awaited at call sites, so there is nothing to flush.
    this.recordsCache = null;
  }

  /**
   * Create or update a memory (upsert by name). Returns whether a new file was
   * created. The index is rebuilt so it always reflects the files on disk.
   */
  async save(input: MemorySaveInput): Promise<{ name: string; created: boolean }> {
    const name = this.normalizeName(input.name);
    const description = this.normalizeDescription(input.description);
    const type = this.normalizeType(input.type);
    const body = (input.body ?? '').trim();

    if (!body) {
      throw new MemoryValidationError('Memory body cannot be empty.');
    }

    const records = await this.loadRecords();
    const existing = records.find(r => r.name === name);
    const timestamp = this.now();

    const record: MemoryRecord = {
      name,
      description,
      type,
      body,
      created: existing?.created ?? timestamp,
      updated: timestamp,
    };

    await this.writeFileAtomic(this.filePathFor(name), serializeMemory(record));
    this.recordsCache = null;
    await this.rebuildIndex();

    return { name, created: !existing };
  }

  /** Delete a memory by name. Returns false if it did not exist. */
  async delete(name: string): Promise<boolean> {
    const slug = this.normalizeName(name);
    try {
      await fs.unlink(this.filePathFor(slug));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
    this.recordsCache = null;
    await this.rebuildIndex();
    return true;
  }

  /** All memories, grouped by type order then name. */
  async list(): Promise<MemoryRecord[]> {
    return this.loadRecords();
  }

  /**
   * Recall a single memory by exact name, or the best matches for a free-text
   * query. Returns an empty array when nothing matches.
   */
  async recall(options: { name?: string; query?: string; limit?: number; minScore?: number }): Promise<MemoryRecord[]> {
    const records = await this.loadRecords();

    if (options.name) {
      const slug = slugify(options.name);
      const match = records.find(r => r.name === slug);
      return match ? [match] : [];
    }

    const query = (options.query ?? '').trim();
    if (!query) {
      return records;
    }

    const limit = options.limit ?? 5;
    const minScore = options.minScore ?? 1;
    return records
      .map(record => ({ record, score: scoreRelevance(query, record) }))
      .filter(({ score }) => score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ record }) => record);
  }

  /**
   * Build a compact, capped reminder for automatic recall against the current
   * user message, or null when nothing is relevant enough. Caps both the number
   * of memories and the body length so this stays affordable on small models.
   * The output is framed as background context, not instructions.
   */
  async getAutoRecallContext(query: string): Promise<string | null> {
    if (!query || !query.trim()) {
      return null;
    }

    const matches = await this.recall({
      query,
      limit: AUTO_RECALL_MAX_MEMORIES,
      minScore: AUTO_RECALL_MIN_SCORE,
    });
    if (matches.length === 0) {
      return null;
    }

    const blocks = matches.map(record => {
      const body = record.body.length > AUTO_RECALL_MAX_BODY_CHARS
        ? `${record.body.slice(0, AUTO_RECALL_MAX_BODY_CHARS).trimEnd()}…`
        : record.body;
      return `- ${record.name} (${record.type}): ${record.description}\n  ${body.replace(/\n/g, '\n  ')}`;
    });

    return (
      'Relevant project memory (background context — reflects what was true when saved; ' +
      'verify any named file or flag before relying on it):\n' +
      blocks.join('\n')
    );
  }

  /** The full MEMORY.md file content (with header), built from the files. */
  async getIndexMarkdown(): Promise<string> {
    return buildIndexMarkdown(await this.loadRecords());
  }

  /**
   * A compact, capped index for the system prompt. Returns null when empty so
   * callers can omit the section entirely.
   */
  async getPromptContext(maxEntries = 50): Promise<MemoryPromptContext | null> {
    const records = await this.loadRecords();
    if (records.length === 0) {
      return null;
    }

    const shown = records.slice(0, maxEntries);
    const lines: string[] = [];
    let currentType: MemoryType | null = null;

    for (const record of shown) {
      if (record.type !== currentType) {
        currentType = record.type;
        lines.push(`  ${capitalize(currentType)}:`);
      }
      lines.push(`    - ${record.name}: ${record.description}`);
    }

    if (records.length > shown.length) {
      lines.push(`  (+${records.length - shown.length} more — use the memory tool with action "list")`);
    }

    return { text: lines.join('\n'), total: records.length, shown: shown.length };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private filePathFor(name: string): string {
    return join(this.memoryDir, `${name}.md`);
  }

  private normalizeName(rawName: string): string {
    const name = slugify(rawName ?? '');
    if (!name) {
      throw new MemoryValidationError('Memory name must contain at least one alphanumeric character.');
    }
    if (name.length > MAX_NAME_LENGTH) {
      throw new MemoryValidationError(`Memory name must be ${MAX_NAME_LENGTH} characters or fewer.`);
    }
    if (!NAME_PATTERN.test(name)) {
      throw new MemoryValidationError(`Invalid memory name "${name}". Use kebab-case (e.g. "use-npm-not-yarn").`);
    }
    return name;
  }

  private normalizeDescription(rawDescription: string): string {
    const description = (rawDescription ?? '').replace(/\s+/g, ' ').trim();
    if (!description) {
      throw new MemoryValidationError('Memory description cannot be empty.');
    }
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      throw new MemoryValidationError(`Memory description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer.`);
    }
    return description;
  }

  private normalizeType(rawType: string): MemoryType {
    if (!MEMORY_TYPES.includes(rawType as MemoryType)) {
      throw new MemoryValidationError(`Invalid memory type "${rawType}". Expected one of: ${MEMORY_TYPES.join(', ')}.`);
    }
    return rawType as MemoryType;
  }

  /** Load and parse all memory files, using and refreshing the cache. */
  private async loadRecords(): Promise<MemoryRecord[]> {
    if (this.recordsCache) {
      return this.recordsCache;
    }

    let entries: string[];
    try {
      entries = await fs.readdir(this.memoryDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.recordsCache = [];
        return this.recordsCache;
      }
      throw error;
    }

    const records: MemoryRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.md') || entry === INDEX_FILENAME || entry.startsWith('.')) {
        continue;
      }

      const fullPath = join(this.memoryDir, entry);
      let raw: string;
      try {
        raw = await fs.readFile(fullPath, 'utf-8');
      } catch (error) {
        logger.warn(`[MEMORY] Failed to read ${entry}:`, error);
        continue;
      }

      const record = parseMemory(raw, entry.replace(/\.md$/, ''));
      if (record) {
        records.push(record);
      } else {
        await this.quarantine(entry, fullPath);
      }
    }

    records.sort(compareRecords);
    this.recordsCache = records;
    return records;
  }

  /** Rebuild MEMORY.md from the current files. Never throws. */
  private async rebuildIndex(): Promise<void> {
    try {
      const markdown = buildIndexMarkdown(await this.loadRecords());
      await this.writeFileAtomic(this.indexPath, markdown);
    } catch (error) {
      logger.warn('[MEMORY] Failed to rebuild index:', error);
    }
  }

  /** Move an unparseable file aside so it stops breaking recall. */
  private async quarantine(entry: string, fullPath: string): Promise<void> {
    try {
      await fs.rename(fullPath, join(this.quarantineDir, `${entry}.${randomUUID().slice(0, 8)}`));
      logger.warn(`[MEMORY] Quarantined unparseable memory file: ${entry}`);
    } catch (error) {
      logger.warn(`[MEMORY] Failed to quarantine ${entry}:`, error);
    }
  }

  /** Remove stale temp files from a previous crash. */
  private async cleanupTempFiles(): Promise<void> {
    try {
      const files = await fs.readdir(this.memoryDir);
      await Promise.all(
        files
          .filter(file => file.includes('.tmp.'))
          .map(file => fs.unlink(join(this.memoryDir, file)).catch(() => {})),
      );
    } catch (error) {
      logger.debug('[MEMORY] Error during temp file cleanup:', error);
    }
  }

  /**
   * Atomically write a file, serializing concurrent writes to the same path via
   * a promise-chained queue (no locks, no busy-wait). Mirrors SessionManager.
   */
  private async writeFileAtomic(filePath: string, content: string): Promise<void> {
    const previous = this.writeQueue.get(filePath);

    const writePromise = (async () => {
      if (previous) {
        await previous.catch(() => {});
      }

      const tempPath = `${filePath}.tmp.${randomUUID()}`;
      try {
        await fs.writeFile(tempPath, content, 'utf-8');
        await fs.rename(tempPath, filePath);
      } catch (error) {
        await fs.unlink(tempPath).catch(() => {});
        throw error;
      }
    })();

    this.writeQueue.set(filePath, writePromise);
    try {
      await writePromise;
    } finally {
      if (this.writeQueue.get(filePath) === writePromise) {
        this.writeQueue.delete(filePath);
      }
    }
  }
}

// =============================================================================
// Pure helpers (exported for testing)
// =============================================================================

/** Convert arbitrary text to a kebab-case slug. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Serialize a record to frontmatter + body. */
export function serializeMemory(record: MemoryRecord): string {
  return [
    '---',
    `name: ${record.name}`,
    `description: ${record.description}`,
    'metadata:',
    `  type: ${record.type}`,
    `  created: ${record.created}`,
    `  updated: ${record.updated}`,
    '---',
    '',
    record.body.trim(),
    '',
  ].join('\n');
}

/**
 * Parse a memory file. Returns null if the frontmatter is missing or invalid so
 * the caller can quarantine it. Tolerant of both top-level and nested metadata.
 */
export function parseMemory(raw: string, fallbackName: string): MemoryRecord | null {
  if (!raw.startsWith('---')) {
    return null;
  }

  const lines = raw.split('\n');
  const top: Record<string, string> = {};
  const meta: Record<string, string> = {};
  let inMetadata = false;
  let bodyStart = lines.length;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }
    if (line.trim() === '---') {
      bodyStart = i + 1;
      break;
    }

    if (line.trim() === 'metadata:') {
      inMetadata = true;
      continue;
    }

    const match = line.match(/^(\s*)([A-Za-z0-9_]+):\s?(.*)$/);
    if (!match) {
      continue;
    }
    const indent = match[1] ?? '';
    const key = match[2];
    const value = (match[3] ?? '').trim();
    if (key === undefined) {
      continue;
    }
    if (inMetadata && indent.length > 0) {
      meta[key] = value;
    } else {
      inMetadata = false;
      top[key] = value;
    }
  }

  const name = slugify(top.name || fallbackName);
  const description = (top.description || '').trim();
  const type = (meta.type || top.type || '').trim();
  const body = lines.slice(bodyStart).join('\n').trim();

  if (!name || !description || !MEMORY_TYPES.includes(type as MemoryType) || !body) {
    return null;
  }

  return {
    name,
    description,
    type: type as MemoryType,
    body,
    created: (meta.created || top.created || '').trim(),
    updated: (meta.updated || top.updated || '').trim(),
  };
}

/** Build the MEMORY.md index content, grouped by type. */
export function buildIndexMarkdown(records: MemoryRecord[]): string {
  const header =
    '# Memory Index\n\n' +
    '<!-- Auto-generated by Ally from the memory/ folder. ' +
    'Manage entries with the `memory` tool or /memory, not by editing this file. -->\n';

  if (records.length === 0) {
    return `${header}\n_No memories yet._\n`;
  }

  const sections: string[] = [];
  for (const type of TYPE_ORDER) {
    const ofType = records.filter(r => r.type === type);
    if (ofType.length === 0) {
      continue;
    }
    const lines = ofType.map(r => `- [${r.name}](${r.name}.md) — ${r.description}`);
    sections.push(`## ${capitalize(type)}\n${lines.join('\n')}`);
  }

  return `${header}\n${sections.join('\n\n')}\n`;
}

/** Score a record against a free-text query (name/description weighted higher). */
function scoreRelevance(query: string, record: MemoryRecord): number {
  const tokens = Array.from(new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? [])).filter(t => t.length >= 2);
  if (tokens.length === 0) {
    return 0;
  }

  const strongText = `${record.name.replace(/-/g, ' ')} ${record.description}`.toLowerCase();
  const bodyText = record.body.toLowerCase();

  let score = 0;
  for (const token of tokens) {
    if (strongText.includes(token)) {
      score += 3;
    } else if (bodyText.includes(token)) {
      score += 1;
    }
  }
  return score;
}

/** Stable ordering: by type order, then alphabetically by name. */
function compareRecords(a: MemoryRecord, b: MemoryRecord): number {
  const typeDelta = TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type);
  return typeDelta !== 0 ? typeDelta : a.name.localeCompare(b.name);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
