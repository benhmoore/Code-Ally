import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from '../utils/atomicFile.js';
import { createDurableDirectory, syncDirectory } from '../utils/durableDirectory.js';
import { readRunJournal, InvalidRunJournalError, type RunJournalEvent } from './RunJournal.js';
import { reduceRunEvent, type RunState } from './RunState.js';
import { logger } from './Logger.js';

/** Journal storage has explicit run identity and no notion of an active conversation.
 * Callers must hold exclusive ownership for append and checkpoint operations.
 */
export class RunJournalStore {
  constructor(readonly root: string) {}

  directory(runId: string): string {
    if (!runId || runId === '.' || runId === '..' || /[/\\]/.test(runId)) throw new Error('Invalid run identifier');
    return path.join(this.root, runId);
  }

  async ensureDirectory(runId: string): Promise<void> {
    await createDurableDirectory(this.root);
    await createDurableDirectory(this.directory(runId));
  }

  async append(event: RunJournalEvent): Promise<void> {
    // Only initial creation may create a journal. Missing history is not a new run.
    const flags = event.sequence === 1 ? 'ax' : constants.O_WRONLY | constants.O_APPEND;
    const handle = await fs.open(path.join(this.directory(event.runId), 'journal.jsonl'), flags, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    if (event.sequence === 1) await syncDirectory(this.directory(event.runId));
  }

  async checkpoint(state: RunState): Promise<void> {
    try {
      await atomicWriteFile(path.join(this.directory(state.snapshot.runId), 'state.json'),
        `${JSON.stringify({ ...state.snapshot, journalSequence: state.sequence }, null, 2)}\n`);
    } catch (error) { logger.warn('Run journal committed, but checkpoint refresh failed:', state.snapshot.runId, error); }
  }

  async replay(runId: string): Promise<RunState> {
    let state: RunState | undefined;
    for await (const event of readRunJournal(path.join(this.directory(runId), 'journal.jsonl'), runId)) {
      try { state = reduceRunEvent(state, event); }
      catch (cause) { throw new InvalidRunJournalError(`Invalid run transition at sequence ${event.sequence}`, cause); }
    }
    if (!state) throw new InvalidRunJournalError('Empty run journal');
    return state;
  }
}
