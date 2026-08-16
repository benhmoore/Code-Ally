/**
 * Persisted store schemas.
 *
 * One declaration per file Ally writes into the user's home directory. Reads go
 * through `migrateRecord(parsed, SCHEMA)`, writes through
 * `stampVersion(value, SCHEMA)`; see `src/utils/versionedStore.ts`.
 *
 * Every store is at v1. Files written before versioning existed carry no
 * `schema_version` key, are read as v0, and are upgraded by `migrations[0]`.
 * For the stores whose v0 and v1 shapes are identical that step is the identity
 * function -- it is declared explicitly rather than left out so the
 * `migrations.length === current` invariant keeps holding on the next bump.
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
  current: 1,
  migrations: [identity],
});

/** ~/.ally/profiles/<profile>/config.json */
export const CONFIG_SCHEMA: StoreSchema = defineStoreSchema({
  kind: 'config',
  current: 1,
  migrations: [identity],
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
