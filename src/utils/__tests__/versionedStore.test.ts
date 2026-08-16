import { describe, it, expect } from 'vitest';
import {
  SCHEMA_VERSION_KEY,
  SchemaTooNewError,
  defineStoreSchema,
  migrateRecord,
  readSchemaVersion,
  stampVersion,
  type StoreRecord,
  type StoreSchema,
} from '../versionedStore.js';
import {
  SESSION_SCHEMA,
  CONFIG_SCHEMA,
  SCHEDULED_TASK_SCHEMA,
  PROMPT_LIBRARY_SCHEMA,
} from '../../config/schemas.js';

const v1Schema: StoreSchema = defineStoreSchema({
  kind: 'test store',
  current: 1,
  migrations: [(data: StoreRecord) => ({ ...data, migrated: true })],
});

describe('versionedStore', () => {
  describe('migrateRecord', () => {
    it('treats a file with no version key as v0 and migrates it without data loss', () => {
      const legacy = { tasks: [{ id: 'a' }, { id: 'b' }], label: 'legacy' };

      const result = migrateRecord<Record<string, unknown>>(legacy, v1Schema);

      expect(result.tasks).toEqual([{ id: 'a' }, { id: 'b' }]);
      expect(result.label).toBe('legacy');
      expect(result.migrated).toBe(true);
      expect(result[SCHEMA_VERSION_KEY]).toBe(1);
    });

    it.each([
      ['string', '1'],
      ['float', 1.5],
      ['null', null],
      ['negative', -1],
    ])('treats a %s version key as pre-versioning (v0)', (_label, value) => {
      const result = migrateRecord<Record<string, unknown>>(
        { [SCHEMA_VERSION_KEY]: value, kept: 'yes' },
        v1Schema
      );

      expect(result.migrated).toBe(true);
      expect(result.kept).toBe('yes');
      expect(result[SCHEMA_VERSION_KEY]).toBe(1);
    });

    it('does not re-run migrations for a record already at the current version', () => {
      const result = migrateRecord<Record<string, unknown>>(
        { [SCHEMA_VERSION_KEY]: 1, kept: 'yes' },
        v1Schema
      );

      expect(result.migrated).toBeUndefined();
      expect(result.kept).toBe('yes');
    });

    it('throws SchemaTooNewError for a version newer than the code supports', () => {
      let thrown: unknown;
      try {
        migrateRecord({ [SCHEMA_VERSION_KEY]: 7, kept: 'yes' }, v1Schema);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(SchemaTooNewError);
      const error = thrown as SchemaTooNewError;
      expect(error.kind).toBe('test store');
      expect(error.found).toBe(7);
      expect(error.supported).toBe(1);
      expect(error.message).toMatch(/newer version of Code-Ally/i);
      expect(error.message).toMatch(/Upgrade Code-Ally/i);
    });

    it('does not mutate the input record', () => {
      const input = { [SCHEMA_VERSION_KEY]: 0, tasks: [1, 2] };
      const snapshot = JSON.stringify(input);

      migrateRecord(input, v1Schema);

      expect(JSON.stringify(input)).toBe(snapshot);
    });

    it('rejects non-object payloads as corrupt rather than as a version problem', () => {
      expect(() => migrateRecord(null, v1Schema)).toThrow(/not a JSON object/);
      expect(() => migrateRecord([1, 2], v1Schema)).toThrow(/not a JSON object/);
      expect(() => migrateRecord(null, v1Schema)).not.toThrow(SchemaTooNewError);
    });

    it('runs every step in order when several versions behind', () => {
      const multi = defineStoreSchema({
        kind: 'multi',
        current: 3,
        migrations: [
          (data) => ({ ...data, steps: [...((data.steps as string[]) ?? []), 'a'] }),
          (data) => ({ ...data, steps: [...((data.steps as string[]) ?? []), 'b'] }),
          (data) => ({ ...data, steps: [...((data.steps as string[]) ?? []), 'c'] }),
        ],
      });

      expect(migrateRecord<{ steps: string[] }>({}, multi).steps).toEqual(['a', 'b', 'c']);
      expect(
        migrateRecord<{ steps: string[] }>({ [SCHEMA_VERSION_KEY]: 2 }, multi).steps
      ).toEqual(['c']);
    });
  });

  describe('readSchemaVersion', () => {
    it('reports 0 for unversioned records and the integer otherwise', () => {
      expect(readSchemaVersion({})).toBe(0);
      expect(readSchemaVersion({ [SCHEMA_VERSION_KEY]: 4 })).toBe(4);
      expect(readSchemaVersion('nonsense')).toBe(0);
    });
  });

  describe('stampVersion', () => {
    it('stamps the current version without mutating the input', () => {
      const value = { a: 1 };
      const stamped = stampVersion(value, v1Schema);

      expect(stamped).toEqual({ a: 1, [SCHEMA_VERSION_KEY]: 1 });
      expect(SCHEMA_VERSION_KEY in value).toBe(false);
    });

    it('round-trips through migrateRecord unchanged', () => {
      const data = { tasks: ['x'], nested: { deep: true } };
      const written = stampVersion(data, v1Schema);
      const read = migrateRecord<typeof written & { migrated?: boolean }>(
        JSON.parse(JSON.stringify(written)),
        v1Schema
      );

      expect(read).toEqual(written);
      expect(read.migrated).toBeUndefined();
    });
  });

  describe('defineStoreSchema', () => {
    it('rejects a schema whose migration count does not match its current version', () => {
      expect(() =>
        defineStoreSchema({ kind: 'bad', current: 2, migrations: [(d) => d] })
      ).toThrow(/migration/);
      expect(() => defineStoreSchema({ kind: 'bad', current: -1, migrations: [] })).toThrow();
    });
  });

  describe('declared store schemas', () => {
    it('all satisfy migrations.length === current', () => {
      for (const schema of [
        SESSION_SCHEMA,
        CONFIG_SCHEMA,
        SCHEDULED_TASK_SCHEMA,
        PROMPT_LIBRARY_SCHEMA,
      ]) {
        expect(schema.migrations.length).toBe(schema.current);
        expect(schema.current).toBe(1);
      }
    });

    it('scheduled-task v0 -> v1 replaces the legacy `version` field with schema_version', () => {
      const legacy = { version: 1, tasks: [{ id: 'one' }, { id: 'two' }] };

      const migrated = migrateRecord<Record<string, unknown>>(legacy, SCHEDULED_TASK_SCHEMA);

      expect(migrated.version).toBeUndefined();
      expect(migrated[SCHEMA_VERSION_KEY]).toBe(1);
      expect(migrated.tasks).toHaveLength(2);
    });
  });
});
