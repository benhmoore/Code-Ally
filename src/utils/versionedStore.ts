/**
 * versionedStore - schema versioning and forward migration for persisted user data.
 *
 * Every persisted store Ally owns (sessions, config, scheduled tasks, prompt
 * library) carries an integer `schema_version` key. Reads run through
 * {@link migrateRecord}, writes run through {@link stampVersion}.
 *
 * Two rules matter more than anything else here:
 *
 * 1. A file with NO version key (or a non-integer one) is a *pre-versioning*
 *    file, not a corrupt one. Every existing user has such files on disk right
 *    now. It is treated as v0 and migrated forward. It is never rejected.
 *
 * 2. A file whose version is NEWER than this build understands is refused with
 *    {@link SchemaTooNewError}. It is never emptied, truncated, quarantined or
 *    overwritten. Downgrading Ally must not destroy data written by a newer
 *    build.
 */

/** The single key under which the integer schema version is persisted. */
export const SCHEMA_VERSION_KEY = 'schema_version';

/** A plain JSON object as read off disk. */
export type StoreRecord = Record<string, unknown>;

/**
 * Upgrades a record one version forward. `migrations[i]` upgrades a record at
 * version `i` to version `i + 1`.
 */
export type Migration = (data: StoreRecord) => StoreRecord;

export interface StoreSchema {
  /** Human-readable store name, used in error messages. */
  kind: string;
  /** The version this build reads and writes. */
  current: number;
  /** Ordered upgrade steps; `migrations.length` must equal `current`. */
  migrations: Migration[];
}

/**
 * Raised when a store on disk was written by a newer build of Code-Ally.
 * The caller must surface this and leave the file untouched.
 */
export class SchemaTooNewError extends Error {
  readonly kind: string;
  readonly found: number;
  readonly supported: number;

  constructor(kind: string, found: number, supported: number) {
    super(
      `The ${kind} file was written by a newer version of Code-Ally ` +
        `(schema v${found}; this build understands up to v${supported}). ` +
        `The file was left untouched. Upgrade Code-Ally to read it.`
    );
    this.name = 'SchemaTooNewError';
    this.kind = kind;
    this.found = found;
    this.supported = supported;
  }
}

/**
 * Validate and freeze a schema declaration.
 *
 * Enforces the `migrations.length === current` invariant so a version bump can
 * never ship without the upgrade step that goes with it.
 */
export function defineStoreSchema(schema: StoreSchema): StoreSchema {
  assertSchema(schema);
  return Object.freeze({ ...schema, migrations: Object.freeze([...schema.migrations]) as Migration[] });
}

function assertSchema(schema: StoreSchema): void {
  if (!Number.isInteger(schema.current) || schema.current < 0) {
    throw new Error(`Schema '${schema.kind}' has an invalid current version: ${schema.current}`);
  }
  if (schema.migrations.length !== schema.current) {
    throw new Error(
      `Schema '${schema.kind}' declares current=${schema.current} but ` +
        `${schema.migrations.length} migration(s); migrations[i] must upgrade v(i) -> v(i+1).`
    );
  }
}

function isPlainObject(value: unknown): value is StoreRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the persisted version of a parsed record.
 *
 * An absent or non-integer key means the file predates versioning: v0.
 */
export function readSchemaVersion(parsed: unknown): number {
  if (!isPlainObject(parsed)) return 0;
  const raw = parsed[SCHEMA_VERSION_KEY];
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

/**
 * Migrate a parsed record forward to `schema.current` and stamp it.
 *
 * @throws SchemaTooNewError when the record is newer than this build supports.
 * @throws Error when `parsed` is not a JSON object (a genuinely corrupt file).
 */
export function migrateRecord<T>(parsed: unknown, schema: StoreSchema): T {
  assertSchema(schema);

  if (!isPlainObject(parsed)) {
    throw new Error(`The ${schema.kind} file is not a JSON object and cannot be read.`);
  }

  const found = readSchemaVersion(parsed);
  if (found > schema.current) {
    throw new SchemaTooNewError(schema.kind, found, schema.current);
  }

  let data: StoreRecord = parsed;
  for (let version = found; version < schema.current; version++) {
    const migration = schema.migrations[version];
    if (!migration) {
      throw new Error(`Schema '${schema.kind}' is missing the migration from v${version} to v${version + 1}.`);
    }
    const next = migration(data);
    if (!isPlainObject(next)) {
      throw new Error(`Migration v${version} -> v${version + 1} for '${schema.kind}' did not return an object.`);
    }
    data = next;
  }

  return { ...data, [SCHEMA_VERSION_KEY]: schema.current } as T;
}

/** Stamp the current schema version onto a value about to be written. */
export function stampVersion<T extends object>(value: T, schema: StoreSchema): T {
  assertSchema(schema);
  return { ...value, [SCHEMA_VERSION_KEY]: schema.current };
}
