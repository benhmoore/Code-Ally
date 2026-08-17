/**
 * Persisted store schemas.
 *
 * One declaration per file Ally writes into the user's home directory. Reads go
 * through `migrateRecord(parsed, SCHEMA)`, writes through
 * `stampVersion(value, SCHEMA)`; see `src/utils/versionedStore.ts`.
 *
 * Files written before versioning existed carry no `schema_version` key, are
 * read as v0, and are upgraded sequentially. Identity migrations are declared
 * explicitly so `migrations.length === current` remains a hard invariant.
 */

import {
  defineStoreSchema,
  type StoreRecord,
  type StoreSchema,
} from '../utils/versionedStore.js';

/** v0 and v1 are structurally identical for this store. */
const identity = (data: StoreRecord): StoreRecord => data;

/** ~/.ally/projects/<key>/sessions/<name>.json */
export const SESSION_SCHEMA: StoreSchema = defineStoreSchema({
  kind: 'session',
  current: 3,
  migrations: [
    identity,
    (data: StoreRecord): StoreRecord => {
      const messages = Array.isArray(data.messages) ? data.messages : [];
      const persisted = messages.filter((message) => {
        if (!message || typeof message !== 'object') return false;
        return (message as { role?: unknown }).role !== 'system';
      });
      return {
        ...data,
        messages: persisted,
        transcript: Array.isArray(data.transcript) ? data.transcript : persisted,
      };
    },
    identity,
  ],
});

/** ~/.ally/profiles/<profile>/config.json */
export const CONFIG_SCHEMA: StoreSchema = defineStoreSchema({
  kind: 'config',
  current: 2,
  migrations: [
    identity,
    (data: StoreRecord): StoreRecord => {
      const { compact_threshold: _threshold, show_context_in_prompt: _showContext, ...rest } = data;
      return rest;
    },
  ],
});

/**
 * ~/.ally/projects/<key>/scheduled_tasks.json and the global task index.
 *
 * These two files already persisted a bespoke `version: 1` field. Rather than
 * carry two version fields, the v0 -> v1 migration drops the legacy `version`
 * key; `schema_version` is the only version field from here on. Existing files
 * (which have `version: 1` and no `schema_version`) read as v0 and convert
 * cleanly, with their task list preserved.
 */
export const SCHEDULED_TASK_SCHEMA: StoreSchema = defineStoreSchema({
  kind: 'scheduled task store',
  current: 1,
  migrations: [
    (data: StoreRecord): StoreRecord => {
      const { version: _legacyVersion, ...rest } = data as StoreRecord & { version?: unknown };
      return rest;
    },
  ],
});

/** ~/.ally/profiles/<profile>/prompts/library.json */
export const PROMPT_LIBRARY_SCHEMA: StoreSchema = defineStoreSchema({
  kind: 'prompt library',
  current: 1,
  migrations: [identity],
});
