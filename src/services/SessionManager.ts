/**
 * SessionManager - Manages conversation session persistence
 *
 * Handles creating, loading, saving, and cleaning up conversation sessions.
 * Sessions are stored as JSON files under ~/.ally/projects/<key>/sessions/, keyed by project path.
 *
 * Features:
 * - Session CRUD operations
 * - Auto-cleanup of old sessions
 * - Session info retrieval with display names
 * - Current session tracking
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { getProjectSessionsDir } from '../config/paths.js';
import { Session, SessionInfo, Message, IService, type TranscriptPage } from '../types/index.js';
import { generateShortId } from '../utils/id.js';
import type { TodoItem } from './TodoManager.js';
import { logger } from './Logger.js';
import { TEXT_LIMITS, BUFFER_SIZES } from '../config/constants.js';
import { atomicWriteFile } from '../utils/atomicFile.js';
import { migrateRecord, stampVersion, SchemaTooNewError } from '../utils/versionedStore.js';
import { SESSION_SCHEMA } from '../config/schemas.js';
import type { ConversationCheckpointV1, ProviderCheckpointState } from '../agent/compaction/types.js';
import { checkpointSourceDigest } from '../agent/compaction/CheckpointReducer.js';

/**
 * Configuration for SessionManager
 */
export interface SessionManagerConfig {
  /** Maximum number of sessions to keep before auto-cleanup */
  maxSessions?: number;
  /** Override the sessions storage directory (primarily for tests) */
  sessionsDir?: string;
}

/**
 * SessionManager handles all session persistence operations
 */
export class SessionManager implements IService {
  private static readonly TRANSCRIPT_SEGMENT_MESSAGES = 64;
  private currentSession: string | null = null;
  // In-flight implicit session creation, so concurrent auto-saves share one session
  private sessionCreationInFlight: Promise<string> | null = null;
  private sessionsDir: string;
  private maxSessions: number;

  // Write queue to serialize file operations and prevent race conditions
  // Uses pure promise chaining - each new write waits for the previous one to complete
  // This creates a serial queue without explicit locks or busy-wait loops
  private writeQueue: Map<string, Promise<void>> = new Map();

  // Debouncing for auto-save - reduces I/O by batching rapid saves
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingAutoSave: { sessionName: string; updates: Partial<Session> } | null = null;
  private readonly DEBOUNCE_DELAY_MS = 2000; // 2 seconds
  private isShuttingDown: boolean = false;

  // Session cache to avoid redundant disk reads
  // Maps session name -> { session data, timestamp when loaded }
  // Cache is invalidated after CACHE_TTL_MS or on operations that might change the file
  private sessionCache: Map<string, { session: Session; loadedAt: number }> = new Map();
  private readonly CACHE_TTL_MS = 1000; // 1 second - cache is fresh for this duration
  private readonly MAX_CACHE_ENTRIES = 4; // Hydrated sessions are potentially huge; keep only a tiny hot set.

  constructor(config: SessionManagerConfig = {}) {
    // Sessions are stored globally under ~/.ally/projects/<key>/sessions, keyed
    // by project path, so conversation history stays out of the working tree.
    this.sessionsDir = config.sessionsDir ?? getProjectSessionsDir();
    this.maxSessions = config.maxSessions ?? BUFFER_SIZES.MAX_SESSIONS_DEFAULT;
  }

  /**
   * Evict the oldest cache entry if the cache exceeds MAX_CACHE_ENTRIES.
   *
   * Note: This implements FIFO (First In, First Out) eviction, not LRU.
   * JavaScript Map preserves insertion order, but Map.set() on an existing key
   * does NOT move it to the end—it stays in its original position. True LRU
   * would require delete+re-insert on every access.
   *
   * FIFO is acceptable here because the cache has a short TTL (1 second),
   * so access patterns matter less than preventing unbounded growth.
   */
  private evictOldestCacheEntryIfNeeded(): void {
    if (this.sessionCache.size > this.MAX_CACHE_ENTRIES) {
      const oldestKey = this.sessionCache.keys().next().value;
      if (oldestKey) {
        this.sessionCache.delete(oldestKey);
        logger.debug(`[SESSION] Evicted oldest cache entry: ${oldestKey}`);
      }
    }
  }

  /**
   * Initialize the session manager (creates sessions directory)
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
    await fs.mkdir(join(this.sessionsDir, '.quarantine'), { recursive: true });

    // Clean up any stale temporary files from previous crashes
    await this.cleanupTempFiles();

    // Clean up orphaned patch directories from deleted sessions
    await this.cleanupOrphanedPatchDirectories();
  }

  /**
   * Clean up stale temporary files left over from crashes
   */
  private async cleanupTempFiles(): Promise<void> {
    try {
      const files = await fs.readdir(this.sessionsDir);
      const tempFiles = files.filter(file => file.includes('.tmp.'));

      for (const tempFile of tempFiles) {
        try {
          const tempPath = join(this.sessionsDir, tempFile);
          await fs.unlink(tempPath);
          logger.debug(`[SESSION] Cleaned up stale temp file: ${tempFile}`);
        } catch (error) {
          logger.debug(`[SESSION] Failed to clean up temp file ${tempFile}:`, error);
        }
      }

      if (tempFiles.length > 0) {
        logger.info(`[SESSION] Cleaned up ${tempFiles.length} stale temporary file(s)`);
      }
    } catch (error) {
      // Ignore errors during cleanup
      logger.debug('[SESSION] Error during temp file cleanup:', error);
    }
  }

  /**
   * Clean up orphaned patch directories from deleted sessions
   *
   * Scans the sessions directory for patch directories that don't have a corresponding
   * session JSON file. This handles cases where:
   * - Session JSON was deleted but patches directory remained
   * - Session creation failed after creating patches directory
   * - Manual file system operations left orphaned directories
   */
  private async cleanupOrphanedPatchDirectories(): Promise<void> {
    try {
      const entries = await fs.readdir(this.sessionsDir, { withFileTypes: true });
      const orphanedDirs: string[] = [];

      // Iterate through all entries in the sessions directory
      for (const entry of entries) {
        // Skip files, .quarantine, and other non-session directories
        if (!entry.isDirectory() || entry.name.startsWith('.')) {
          continue;
        }

        // Check if this is a session directory (has a corresponding .json file)
        // Format: session_<timestamp>_<id>/ should have session_<timestamp>_<id>.json
        const sessionJsonPath = join(this.sessionsDir, `${entry.name}.json`);

        try {
          await fs.access(sessionJsonPath);
          // Session JSON exists, this directory is not orphaned
        } catch (error) {
          // Session JSON does not exist - this is an orphaned directory
          const dirPath = join(this.sessionsDir, entry.name);

          // Verify it has a patches subdirectory before marking as orphaned
          // This prevents false positives from other directories
          try {
            const patchesPath = join(dirPath, 'patches');
            const patchesStat = await fs.stat(patchesPath);

            if (patchesStat.isDirectory()) {
              orphanedDirs.push(entry.name);
              logger.debug(`[SESSION] Found orphaned patch directory: ${entry.name}`);
            }
          } catch {
            // No patches subdirectory, not an orphaned session directory
            // Could be some other directory structure
          }
        }
      }

      // Delete orphaned directories
      for (const dirName of orphanedDirs) {
        try {
          const dirPath = join(this.sessionsDir, dirName);
          await fs.rm(dirPath, { recursive: true, force: true });
          logger.debug(`[SESSION] Deleted orphaned patch directory: ${dirName}`);
        } catch (error) {
          logger.error(`[SESSION] Failed to delete orphaned directory ${dirName}:`, error);
          // Continue with other directories even if one fails
        }
      }

      if (orphanedDirs.length > 0) {
        logger.debug(`[SESSION] Cleaned up ${orphanedDirs.length} orphaned patch director${orphanedDirs.length === 1 ? 'y' : 'ies'}`);
      }
    } catch (error) {
      // Ignore errors during cleanup - don't fail startup
      logger.debug('[SESSION] Error during orphaned patch directory cleanup:', error);
    }
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    // Prevent new auto-saves during shutdown
    this.isShuttingDown = true;

    // Flush any pending debounced save before cleanup
    await this.flushDebouncedSave();
  }

  /**
   * Generate a unique session name with timestamp and short UUID
   */
  generateSessionName(): string {
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
    const shortUuid = generateShortId();
    return `session_${timestamp}_${shortUuid}`;
  }

  /**
   * Get the file path for a session
   */
  private getSessionPath(sessionName: string): string {
    return join(this.sessionsDir, `${sessionName}.json`);
  }

  private createEmptySession(sessionName: string): Session {
    const now = new Date().toISOString();
    return {
      id: sessionName,
      name: sessionName,
      created_at: now,
      updated_at: now,
      working_dir: process.cwd(),
      messages: [],
      transcript: [],
      metadata: {},
      active_plugins: [],
    };
  }

  private transcriptHash(messages: readonly Message[]): string {
    return createHash('sha256').update(JSON.stringify(messages)).digest('hex');
  }

  private async hydrateTranscript(sessionName: string, session: Session): Promise<Session> {
    const refs = session.transcript_segments ?? [];
    if (refs.length === 0) {
      if (!session.transcript && session.transcript_tail) {
        session.transcript = structuredClone(session.transcript_tail);
      }
      return session;
    }

    const segmentDir = join(this.sessionsDir, sessionName, 'transcript-segments');
    const chunks = await Promise.all(refs.map(async (ref) => {
      const raw = await fs.readFile(join(segmentDir, `${ref.hash}.json`), 'utf-8');
      const parsed = JSON.parse(raw) as { hash?: string; messages?: Message[] };
      if (parsed.hash !== ref.hash || !Array.isArray(parsed.messages)
        || parsed.messages.length !== ref.message_count
        || this.transcriptHash(parsed.messages) !== ref.hash) {
        throw new Error(`Transcript segment failed integrity validation: ${ref.hash}`);
      }
      return parsed.messages;
    }));
    session.transcript = [
      ...chunks.flat(),
      ...structuredClone(session.transcript_tail ?? []),
    ];
    return session;
  }

  /** Write immutable full chunks before the manifest that references them. */
  private async externalizeTranscript(sessionName: string, session: Session): Promise<Session> {
    const transcript = session.transcript ?? session.messages;
    const chunkSize = SessionManager.TRANSCRIPT_SEGMENT_MESSAGES;
    const fullChunkCount = Math.floor(transcript.length / chunkSize);
    const refs: NonNullable<Session['transcript_segments']> = [];
    const segmentDir = join(this.sessionsDir, sessionName, 'transcript-segments');

    if (fullChunkCount > 0) await fs.mkdir(segmentDir, { recursive: true });
    for (let index = 0; index < fullChunkCount; index++) {
      const messages = transcript.slice(index * chunkSize, (index + 1) * chunkSize);
      const hash = this.transcriptHash(messages);
      const segmentPath = join(segmentDir, `${hash}.json`);
      refs.push({ hash, message_count: messages.length });
      try {
        await fs.access(segmentPath);
      } catch {
        await atomicWriteFile(segmentPath, JSON.stringify({ schema_version: 1, hash, messages }));
      }
    }

    const { transcript: _transcript, ...manifest } = session;
    return {
      ...manifest,
      transcript_segments: refs,
      transcript_tail: structuredClone(transcript.slice(fullChunkCount * chunkSize)),
    };
  }

  private async pruneTranscriptSegments(
    sessionName: string,
    refs: readonly { hash: string }[],
  ): Promise<void> {
    const segmentDir = join(this.sessionsDir, sessionName, 'transcript-segments');
    let files: string[];
    try {
      files = await fs.readdir(segmentDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const retained = new Set(refs.map(ref => `${ref.hash}.json`));
    await Promise.all(files
      .filter(file => file.endsWith('.json') && !retained.has(file))
      .map(file => fs.unlink(join(segmentDir, file))));
  }

  /**
   * Filter messages for persistence:
   * - Remove system messages (regenerated on resume)
   * - Preserve prepared tool-call messages so crash recovery can reconcile them
   */
  private filterMessagesForPersistence(messages: readonly Message[]): Message[] {
    return messages.filter(msg => {
      if (msg.role === 'system') return false;
      return true;
    });
  }

  /**
   * Quarantine a corrupted session file instead of deleting it
   */
  private async quarantineSession(sessionName: string, reason: string): Promise<void> {
    const sessionPath = this.getSessionPath(sessionName);
    const quarantinePath = join(this.sessionsDir, '.quarantine', `${sessionName}_${Date.now()}.json`);

    try {
      await fs.rename(sessionPath, quarantinePath);
      // Invalidate cache since session is no longer valid
      this.sessionCache.delete(sessionName);
      logger.warn(`Session ${sessionName} quarantined (${reason}): ${quarantinePath}`);
    } catch (error) {
      logger.error(`Failed to quarantine session ${sessionName}:`, error);
      // Only delete if quarantine fails
      try {
        await fs.unlink(sessionPath);
        // Invalidate cache
        this.sessionCache.delete(sessionName);
        logger.warn(`Deleted corrupted session file after quarantine failure: ${sessionName}`);
      } catch (deleteError) {
        logger.error(`Failed to delete session ${sessionName} after quarantine failure:`, deleteError);
      }
    }
  }

  /**
   * Create a new session
   *
   * @param sessionName - Optional session name. If omitted, auto-generates one
   * @returns The session name (provided or generated)
   */
  async createSession(sessionName?: string): Promise<string> {
    const name = sessionName ?? this.generateSessionName();

    const session: Session = {
      id: name,
      name,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      working_dir: process.cwd(),
      messages: [],
      transcript: [],
      metadata: {},
      active_plugins: [], // Initialize with empty array
    };

    await this.saveSessionData(name, session);

    // Set as current session BEFORE cleanup to protect it from deletion
    // This prevents a race condition where cleanup could delete the newly created session
    // if maxSessions limit is reached during the save->cleanup window
    this.currentSession = name;

    await this.cleanupOldSessions();

    return name;
  }

  /**
   * Return the current session, creating one only if there is none.
   *
   * Auto-save runs fire-and-forget from several places at once (every appended
   * message, plus the awaited turn-start commit), so a plain
   * `getCurrentSession() ?? createSession()` lets two callers in the same tick
   * both observe null and each mint a session. The loser is orphaned on disk
   * holding just the opening prompt, which is what filled the resume list with
   * duplicates of the first message. Creation is single-flighted here so every
   * concurrent caller lands on the same session.
   *
   * `created` is true only for the caller that actually performed the creation,
   * so one-shot follow-up work (patch-manager rebinding) does not run per caller.
   */
  async ensureCurrentSession(): Promise<{ sessionName: string; created: boolean }> {
    if (this.currentSession) {
      return { sessionName: this.currentSession, created: false };
    }

    if (this.sessionCreationInFlight) {
      return { sessionName: await this.sessionCreationInFlight, created: false };
    }

    const inFlight = this.createSession().finally(() => {
      this.sessionCreationInFlight = null;
    });
    this.sessionCreationInFlight = inFlight;

    return { sessionName: await inFlight, created: true };
  }

  /**
   * Load an existing session
   *
   * Uses in-memory cache to avoid redundant disk reads when called multiple times
   * in quick succession (within CACHE_TTL_MS). Cache is invalidated on writes.
   *
   * @param sessionName - Name of the session to load
   * @returns Session data or null if not found
   */
  async loadSession(sessionName: string): Promise<Session | null> {
    // Check cache first
    const cached = this.sessionCache.get(sessionName);
    if (cached) {
      const age = Date.now() - cached.loadedAt;
      if (age < this.CACHE_TTL_MS) {
        logger.debug(`[SESSION] Cache hit for ${sessionName} (age: ${age}ms)`);
        // Return a deep copy to prevent external modifications from affecting cache
        return structuredClone(cached.session);
      } else {
        // Cache expired, remove it
        this.sessionCache.delete(sessionName);
        logger.debug(`[SESSION] Cache expired for ${sessionName} (age: ${age}ms)`);
      }
    }

    // Cache miss or expired - load from disk
    const sessionPath = this.getSessionPath(sessionName);

    try {
      const content = await fs.readFile(sessionPath, 'utf-8');

      // Handle empty or corrupted files
      if (!content || content.trim().length === 0) {
        await this.quarantineSession(sessionName, 'empty file');
        return null;
      }

      // Pre-versioning session files carry no schema_version and read as v0.
      // A file from a NEWER build throws SchemaTooNewError below and is left
      // exactly where it is - never quarantined, never rewritten.
      const migrated = migrateRecord<Session>(JSON.parse(content), SESSION_SCHEMA);
      const session = await this.hydrateTranscript(sessionName, migrated);

      // Update cache with loaded session
      this.sessionCache.set(sessionName, {
        session: structuredClone(session), // Store a copy in cache
        loadedAt: Date.now(),
      });
      this.evictOldestCacheEntryIfNeeded();
      logger.debug(`[SESSION] Loaded from disk and cached: ${sessionName}`);

      return session;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }

      // A session written by a newer build is refused, not quarantined and not
      // overwritten: the file stays byte-for-byte as it is on disk.
      if (error instanceof SchemaTooNewError) {
        logger.error(`Refusing to read session ${sessionName}: ${error.message}`);
        throw error;
      }

      // If JSON parse fails, the file is corrupted - quarantine it
      if (error instanceof SyntaxError) {
        await this.quarantineSession(sessionName, 'invalid JSON');
        return null;
      }

      logger.error(`Failed to load session ${sessionName}:`, error);
      return null;
    }
  }

  /** Read a manifest without hydrating immutable transcript segments. */
  private async loadSessionManifest(sessionName: string): Promise<Session | null> {
    try {
      const raw = await fs.readFile(this.getSessionPath(sessionName), 'utf8');
      if (!raw.trim()) return null;
      return migrateRecord<Session>(JSON.parse(raw), SESSION_SCHEMA);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (error instanceof SchemaTooNewError) throw error;
      logger.warn(`[SESSION] Could not read manifest for ${sessionName}:`, error);
      return null;
    }
  }

  /**
   * Load an older transcript page without hydrating the complete conversation.
   * Cursor is an exclusive absolute index; omitted means "from the end".
   */
  async getTranscriptPage(
    sessionName: string,
    beforeCursor?: number,
    count: number = 200,
    byteBudget: number = 1024 * 1024,
  ): Promise<TranscriptPage> {
    const manifest = await this.loadSessionManifest(sessionName);
    if (!manifest) return { messages: [], nextCursor: null, totalMessages: 0 };
    const refs = manifest.transcript_segments ?? [];
    const tail = manifest.transcript_tail ?? manifest.transcript ?? manifest.messages ?? [];
    const segmentCount = refs.reduce((sum, ref) => sum + ref.message_count, 0);
    const totalMessages = segmentCount + tail.length;
    const end = Math.max(0, Math.min(beforeCursor ?? totalMessages, totalMessages));
    const start = Math.max(0, end - Math.max(1, count));
    const selected: Array<{ index: number; message: Message }> = [];
    let usedBytes = 0;
    let limitReached = false;

    // Traverse newest-to-oldest so a byte ceiling never skips unseen newer
    // messages. Reverse once at the end for chronological rendering.
    if (end > segmentCount) {
      const from = Math.max(0, start - segmentCount);
      const to = Math.min(tail.length, end - segmentCount);
      for (let i = to - 1; i >= from; i -= 1) {
        const message = tail[i]!;
        const bytes = Buffer.byteLength(JSON.stringify(message));
        if (selected.length > 0 && usedBytes + bytes > byteBudget) {
          limitReached = true;
          break;
        }
        selected.push({ index: segmentCount + i, message: structuredClone(message) });
        usedBytes += bytes;
      }
    }

    const offsets: number[] = [];
    let offset = 0;
    for (const ref of refs) {
      offsets.push(offset);
      offset += ref.message_count;
    }
    for (let refIndex = refs.length - 1; refIndex >= 0 && usedBytes < byteBudget && !limitReached; refIndex -= 1) {
      const ref = refs[refIndex]!;
      const segmentStart = offsets[refIndex]!;
      const segmentEnd = segmentStart + ref.message_count;
      if (segmentEnd <= start || segmentStart >= end) continue;
      const raw = await fs.readFile(join(this.sessionsDir, sessionName, 'transcript-segments', `${ref.hash}.json`), 'utf8');
      const parsed = JSON.parse(raw) as { hash?: string; messages?: Message[] };
      if (parsed.hash !== ref.hash || !Array.isArray(parsed.messages)
        || this.transcriptHash(parsed.messages) !== ref.hash) {
        throw new Error(`Transcript segment failed integrity validation: ${ref.hash}`);
      }
      const from = Math.max(0, start - segmentStart);
      const to = Math.min(ref.message_count, end - segmentStart);
      for (let i = to - 1; i >= from; i -= 1) {
        const message = parsed.messages[i]!;
        const bytes = Buffer.byteLength(JSON.stringify(message));
        if (selected.length > 0 && usedBytes + bytes > byteBudget) {
          limitReached = true;
          break;
        }
        selected.push({ index: segmentStart + i, message });
        usedBytes += bytes;
      }
    }

    selected.reverse();
    const messages = selected.map(({ message }) => message);
    const earliestIndex = selected[0]?.index ?? end;

    return {
      messages,
      nextCursor: earliestIndex > 0 ? earliestIndex : null,
      totalMessages,
    };
  }

  private async validateCheckpointSource(
    sessionName: string,
    checkpoint: ConversationCheckpointV1,
  ): Promise<boolean> {
    const wanted = new Set(checkpoint.source.messageIds);
    const found = new Map<string, Message>();
    let cursor: number | undefined;
    do {
      const page = await this.getTranscriptPage(sessionName, cursor, 200, 2 * 1024 * 1024);
      for (const message of page.messages) {
        if (message.id && wanted.has(message.id)) found.set(message.id, message);
      }
      if (found.size === wanted.size) break;
      cursor = page.nextCursor ?? undefined;
      if (page.nextCursor === null) break;
    } while (true);
    const source = checkpoint.source.messageIds
      .map((id) => found.get(id))
      .filter((message): message is Message => Boolean(message));
    return source.length === checkpoint.source.messageIds.length
      && checkpointSourceDigest(source) === checkpoint.source.digest;
  }

  /**
   * Save session data to disk atomically with write serialization
   *
   * Uses atomic write (temp file + rename) and pure promise chaining to serialize writes.
   * This approach is truly atomic because:
   * 1. We capture the existing write promise synchronously (no race window)
   * 2. We chain our write to complete AFTER the previous one
   * 3. We update the queue with our promise before any async operations begin
   *
   * No locks or busy-wait loops needed - just pure promise chaining.
   *
   * @param sessionName - Name of the session
   * @param session - Complete session object
   */
  private async saveSessionData(sessionName: string, session: Session): Promise<void> {
    await this.enqueueSessionOperation(sessionName, () => this.writeSessionFile(sessionName, session));
  }

  /** Serialize an entire read-modify-write operation for one session. */
  private async mutateSession(
    sessionName: string,
    createIfMissing: boolean,
    update: (session: Session) => void
  ): Promise<boolean> {
    return this.enqueueSessionOperation(sessionName, async () => {
      const session = await this.loadSession(sessionName) ??
        (createIfMissing ? this.createEmptySession(sessionName) : null);
      if (!session) return false;

      update(session);
      session.updated_at = new Date().toISOString();
      await this.writeSessionFile(sessionName, session);
      return true;
    });
  }

  /** Update a manifest and append a bounded live tail without hydrating history. */
  private async mutateSessionIncremental(
    sessionName: string,
    createIfMissing: boolean,
    updates: Partial<Session>,
    transcriptTail: readonly Message[],
  ): Promise<boolean> {
    return this.enqueueSessionOperation(sessionName, async () => {
      let manifest = await this.loadSessionManifest(sessionName) ??
        (createIfMissing ? this.createEmptySession(sessionName) : null);
      if (!manifest) return false;
      if (manifest.transcript && !manifest.transcript_segments) {
        manifest = await this.externalizeTranscript(sessionName, manifest);
      }

      const { transcript: _ignoredTranscript, transcript_segments: _ignoredSegments,
        transcript_tail: _ignoredTail, ...safeUpdates } = updates;
      Object.assign(manifest, safeUpdates);
      const incoming = this.filterMessagesForPersistence(transcriptTail);
      const existingTail = structuredClone(manifest.transcript_tail ?? []);
      let recent = existingTail;
      const refs = [...(manifest.transcript_segments ?? [])];
      if (refs.length > 0) {
        const last = refs[refs.length - 1]!;
        try {
          const raw = await fs.readFile(join(this.sessionsDir, sessionName, 'transcript-segments', `${last.hash}.json`), 'utf8');
          const parsed = JSON.parse(raw) as { hash?: string; messages?: Message[] };
          if (parsed.hash === last.hash && Array.isArray(parsed.messages)
            && this.transcriptHash(parsed.messages) === last.hash) {
            recent = [...parsed.messages, ...existingTail];
          }
        } catch {
          // Page reads perform strict integrity validation. If overlap cannot be
          // inspected here, append conservatively rather than hydrating history.
        }
      }
      const recentIds = new Set(recent.map((message) => message.id).filter(Boolean));
      let overlap = -1;
      for (let index = incoming.length - 1; index >= 0; index -= 1) {
        const id = incoming[index]?.id;
        if (id && recentIds.has(id)) {
          overlap = index;
          break;
        }
      }
      const combinedTail = [...existingTail, ...incoming.slice(overlap + 1)];
      const chunkSize = SessionManager.TRANSCRIPT_SEGMENT_MESSAGES;
      const segmentDir = join(this.sessionsDir, sessionName, 'transcript-segments');
      while (combinedTail.length >= chunkSize) {
        const messages = combinedTail.splice(0, chunkSize);
        const hash = this.transcriptHash(messages);
        await fs.mkdir(segmentDir, { recursive: true });
        const segmentPath = join(segmentDir, `${hash}.json`);
        try { await fs.access(segmentPath); }
        catch { await atomicWriteFile(segmentPath, JSON.stringify({ schema_version: 1, hash, messages })); }
        refs.push({ hash, message_count: messages.length });
      }

      const { transcript: _legacy, ...withoutTranscript } = manifest;
      const next = stampVersion({
        ...withoutTranscript,
        transcript_segments: refs,
        transcript_tail: combinedTail,
        updated_at: new Date().toISOString(),
      }, SESSION_SCHEMA);
      await atomicWriteFile(this.getSessionPath(sessionName), JSON.stringify(next, null, 2));
      this.sessionCache.delete(sessionName);
      return true;
    });
  }

  private async enqueueSessionOperation<T>(
    sessionName: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.writeQueue.get(sessionName);
    let resolveResult!: (value: T) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    const queued = (async () => {
      await previous?.catch(() => undefined);
      try {
        resolveResult(await operation());
      } catch (error) {
        rejectResult(error);
        throw error;
      }
    })();

    // The queue tracks a non-rejecting tail so one failed write cannot create an
    // unhandled rejection or prevent later writes from running.
    const tail = queued.catch(() => undefined);
    this.writeQueue.set(sessionName, tail);
    try {
      return await result;
    } finally {
      if (this.writeQueue.get(sessionName) === tail) {
        this.writeQueue.delete(sessionName);
      }
    }
  }

  private async writeSessionFile(sessionName: string, session: Session): Promise<void> {
    const sessionPath = this.getSessionPath(sessionName);
    const manifest = await this.externalizeTranscript(sessionName, session);
    const versionedManifest = stampVersion(manifest, SESSION_SCHEMA);
    await atomicWriteFile(sessionPath, JSON.stringify(versionedManifest, null, 2));
    // Only collect old chunks after the new manifest is durable.
    try {
      await this.pruneTranscriptSegments(sessionName, manifest.transcript_segments ?? []);
    } catch (error) {
      // Garbage collection is never part of the commit's success condition.
      logger.warn(`[SESSION] Could not prune old transcript segments for ${sessionName}:`, error);
    }
    // Callers always see the hydrated shape, regardless of cache vs disk path.
    const versioned = stampVersion({
      ...manifest,
      transcript: structuredClone(session.transcript ?? session.messages),
    }, SESSION_SCHEMA);
    this.sessionCache.set(sessionName, {
      session: structuredClone(versioned),
      loadedAt: Date.now(),
    });
    this.evictOldestCacheEntryIfNeeded();
    logger.debug(`[SESSION] Saved session ${sessionName} atomically and updated cache`);
  }

  /**
   * Save messages to a session
   *
   * @param sessionName - Name of the session
   * @param messages - Messages to save
   * @returns True if saved successfully
   */
  async saveSession(
    sessionName: string,
    messages: readonly Message[],
    transcript: readonly Message[] = messages,
    checkpoint?: ConversationCheckpointV1,
  ): Promise<boolean> {
    try {
      await this.flushPendingAutoSave(sessionName);
      await this.mutateSession(sessionName, true, (session) => {
        session.messages = this.filterMessagesForPersistence(messages);
        session.transcript = this.filterMessagesForPersistence(transcript);
        if (checkpoint) session.conversation_checkpoint = structuredClone(checkpoint);
      });
      await this.cleanupOldSessions();

      return true;
    } catch (error) {
      logger.error(`Failed to save session ${sessionName}:`, error);
      return false;
    }
  }

  /**
   * Check if a session exists
   *
   * @param sessionName - Name of the session to check
   * @returns True if session exists
   */
  async sessionExists(sessionName: string): Promise<boolean> {
    const sessionPath = this.getSessionPath(sessionName);
    try {
      await fs.access(sessionPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all available session names
   *
   * @returns Array of session names (without .json extension)
   */
  async listSessions(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.sessionsDir);
      return files
        .filter(file => file.endsWith('.json'))
        .map(file => file.slice(0, -5)) // Remove .json extension
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /**
   * Delete a session
   *
   * @param sessionName - Name of the session to delete
   * @returns True if deleted successfully
   */
  async deleteSession(sessionName: string): Promise<boolean> {
    const sessionPath = this.getSessionPath(sessionName);
    const sessionDir = sessionPath.replace('.json', ''); // Directory for session data (e.g., patches)

    try {
      // Delete session file
      await fs.unlink(sessionPath);

      // Invalidate cache
      this.sessionCache.delete(sessionName);

      // Delete session directory (if it exists) - includes patches and other session data
      try {
        await fs.rm(sessionDir, { recursive: true, force: true });
        logger.info(`Deleted session directory: ${sessionDir}`);
      } catch (dirError) {
        // Directory might not exist, that's okay
        logger.debug(`No session directory to delete: ${sessionDir}`);
      }

      if (this.currentSession === sessionName) {
        this.currentSession = null;
      }

      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false; // Already deleted
      }
      logger.error(`Failed to delete session ${sessionName}:`, error);
      return false;
    }
  }

  /**
   * Get the current active session name
   *
   * @returns Current session name or null
   */
  getCurrentSession(): string | null {
    return this.currentSession;
  }

  /**
   * Set the current active session
   *
   * @param sessionName - Session name or null to clear
   */
  setCurrentSession(sessionName: string | null): void {
    this.currentSession = sessionName;
  }

  /**
   * Get messages from a session
   *
   * @param sessionName - Name of the session
   * @returns Array of messages or empty array if not found
   */
  async getSessionMessages(sessionName: string): Promise<Message[]> {
    const session = await this.loadSessionManifest(sessionName);
    return session?.messages ?? [];
  }

  /**
   * Get all session data in a single read (optimized for session resume)
   *
   * This method loads the session file once and returns all commonly needed data,
   * avoiding multiple file reads during session resume.
   *
   * @param sessionName - Name of the session
   * @returns Object containing messages, todos, idle messages, project context, and additional directories
   */
  async getSessionData(sessionName: string): Promise<{
    messages: Message[];
    transcript: Message[];
    checkpoint: ConversationCheckpointV1 | null;
    providerState: ProviderCheckpointState;
    todos: TodoItem[];
    idleMessages: string[];
    projectContext: Session['project_context'] | null;
    metadata: Session['metadata'] | null;
    additional_directories: string[];
  }> {
    const session = await this.loadSessionManifest(sessionName);

    if (!session) {
      return {
        messages: [],
        transcript: [],
        checkpoint: null,
        providerState: { kind: 'chat' },
        todos: [],
        idleMessages: [],
        projectContext: null,
        metadata: null,
        additional_directories: [],
      };
    }

    const recent = await this.getTranscriptPage(sessionName, undefined, 500, 4 * 1024 * 1024);
    let checkpoint = session.conversation_checkpoint ?? null;
    if (checkpoint && !(await this.validateCheckpointSource(sessionName, checkpoint))) {
      logger.error(`[SESSION] Checkpoint ${checkpoint.id} failed source integrity validation; falling back to portable active messages`);
      checkpoint = null;
    }
    return {
      messages: session.messages ?? [],
      transcript: recent.messages,
      checkpoint,
      providerState: checkpoint
        ? session.provider_state ?? checkpoint.providerState
        : { kind: 'chat' },
      todos: session.todos ?? [],
      idleMessages: session.idle_messages ?? [],
      projectContext: session.project_context ?? null,
      metadata: session.metadata ?? null,
      additional_directories: session.additional_directories ?? [],
    };
  }

  /**
   * Get information about all sessions for display
   *
   * @returns Array of SessionInfo objects sorted by modification time (newest first)
   */
  async getSessionsInfo(): Promise<SessionInfo[]> {
    const sessionNames = await this.listSessions();

    // Read only manifests plus a bounded recent page. Session selection must
    // not hydrate every immutable transcript segment in every session.
    const sessions = await Promise.all(
      // A session written by a newer build cannot be summarized; it is skipped
      // (and left untouched on disk) rather than failing the whole listing.
      sessionNames.map(async name => {
        try {
          const session = await this.loadSessionManifest(name);
          const recent = session ? await this.getTranscriptPage(name, undefined, 20, 64 * 1024) : null;
          return session ? { session, recent } : null;
        } catch (error) {
        if (error instanceof SchemaTooNewError) {
          logger.warn(`Skipping session ${name} in listing: ${error.message}`);
          return null;
        }
        throw error;
        }
      })
    );

    // Filter out null results and process sessions
    const infos: Array<SessionInfo & { timestamp: number }> = [];

    for (const entry of sessions) {
      if (!entry) continue;
      const { session, recent } = entry;

      // Session lists describe what the user sees, not the compacted wire window.
      const messages = recent?.messages ?? session.transcript_tail ?? session.messages ?? [];

      // Find the last user message for preview
      let lastUserMessage: string | undefined;
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message && message.role === 'user' && message.content) {
          const content = message.content.trim();
          const cleanContent = content.replace(/\s+/g, ' ');
          // Truncate to ~60 characters for preview
          lastUserMessage = cleanContent.length > 60
            ? cleanContent.slice(0, 60) + '...'
            : cleanContent;
          break;
        }
      }

      // Determine display name - prefer title, fallback to first message snippet
      let displayName = session.metadata?.title;
      if (!displayName) {
        const firstUserMessage = messages.find(msg => msg.role === 'user');
        if (firstUserMessage) {
          const content = firstUserMessage.content.trim();
          const cleanContent = content.replace(/\s+/g, ' ');
          displayName = cleanContent.length > TEXT_LIMITS.COMMAND_DISPLAY_MAX
            ? cleanContent.slice(0, TEXT_LIMITS.COMMAND_DISPLAY_MAX) + '...'
            : cleanContent;
        } else {
          displayName = recent?.totalMessages ? '(conversation)' : '(no messages)';
        }
      }

      const updatedAt = new Date(session.updated_at);

      infos.push({
        session_id: session.id,
        display_name: displayName,
        last_modified_timestamp: updatedAt.getTime(),
        message_count: recent?.totalMessages ?? messages.length,
        working_dir: session.working_dir,
        lastUserMessage,
        timestamp: updatedAt.getTime(),
      });
    }

    // Sort by actual timestamp (newest first)
    infos.sort((a, b) => b.timestamp - a.timestamp);

    // Remove internal sorting timestamp from final result
    return infos.map(({ timestamp, ...info }) => info);
  }

  /**
   * Get information about sessions filtered by working directory
   *
   * @param workingDir - The working directory to filter by (defaults to current directory)
   * @returns Array of SessionInfo objects for sessions in the specified directory, sorted by modification time (newest first)
   */
  async getSessionsInfoByDirectory(workingDir?: string): Promise<SessionInfo[]> {
    const targetDir = workingDir ?? process.cwd();
    const allSessions = await this.getSessionsInfo();
    return allSessions.filter(session => session.working_dir === targetDir);
  }

  /**
   * Clean up old sessions beyond the maximum limit
   *
   * Keeps only the most recently modified sessions up to maxSessions count.
   *
   * IMPORTANT: This method excludes currentSession from cleanup to prevent deletion
   * in race conditions (e.g., multiple instances or createSession flow). The exclusion
   * means we must slice at (maxSessions - 1) to ensure total sessions don't exceed limit.
   *
   * Example: maxSessions=3
   *   - Have 5 total sessions: [current, s1, s2, s3, s4]
   *   - Eligible for cleanup: [s1, s2, s3, s4] (4 sessions)
   *   - Keep newest (maxSessions - 1) = 2: [s1, s2]
   *   - Delete: [s3, s4]
   *   - Result: 3 total sessions (1 current + 2 eligible)
   */
  private async cleanupOldSessions(): Promise<void> {
    try {
      const files = await fs.readdir(this.sessionsDir);
      const jsonFiles = files.filter(file => file.endsWith('.json'));

      // Early return if we haven't exceeded the limit yet
      // Note: This check uses total count, but deletion logic accounts for currentSession exclusion
      if (jsonFiles.length <= this.maxSessions) {
        return;
      }

      // Get file stats with modification times
      const fileStats = await Promise.all(
        jsonFiles.map(async file => {
          const filePath = join(this.sessionsDir, file);
          const stats = await fs.stat(filePath);
          // Extract session name (without .json extension) for comparison
          const sessionName = file.slice(0, -5);
          return { name: sessionName, file, mtime: stats.mtime.getTime(), path: filePath };
        })
      );

      // Exclude current session to prevent deletion if multiple instances hit the limit simultaneously
      const eligibleForCleanup = fileStats.filter(f => f.name !== this.currentSession);

      // Sort by modification time (newest first)
      eligibleForCleanup.sort((a, b) => b.mtime - a.mtime);

      // Delete old sessions beyond the limit
      // Since we excluded currentSession from eligible list, we need to keep maxSessions - 1
      // to ensure total sessions (including current) don't exceed maxSessions
      // Example: maxSessions=3, have 5 sessions (1 current + 4 eligible)
      //   Keep 2 eligible + 1 current = 3 total
      const toDelete = eligibleForCleanup.slice(this.maxSessions - 1);
      for (const { path } of toDelete) {
        try {
          await fs.unlink(path);
        } catch (error) {
          logger.error(`Failed to delete old session ${path}:`, error);
        }
      }
    } catch (error) {
      logger.error('Failed to cleanup old sessions:', error);
    }
  }

  /**
   * Update session metadata
   *
   * @param sessionName - Name of the session
   * @param metadata - Partial metadata to merge
   * @returns True if updated successfully
   */
  async updateMetadata(
    sessionName: string,
    metadata: Partial<Session['metadata']>
  ): Promise<boolean> {
    try {
      await this.flushPendingAutoSave(sessionName);
      return await this.mutateSession(sessionName, false, (session) => {
        session.metadata = { ...session.metadata, ...metadata };
      });
    } catch (error) {
      logger.error(`Failed to update metadata for ${sessionName}:`, error);
      return false;
    }
  }

  /**
   * Update session fields
   *
   * Allows updating arbitrary session fields while maintaining atomic writes.
   * Use this for updating session properties like active_plugins, todos, etc.
   *
   * @param sessionName - Name of the session to update
   * @param updates - Partial session object with fields to update
   * @returns True if update succeeded, false otherwise
   */
  async updateSession(
    sessionName: string,
    updates: Partial<Omit<Session, 'id' | 'name' | 'created_at'>>
  ): Promise<boolean> {
    try {
      await this.flushPendingAutoSave(sessionName);
      return await this.mutateSession(sessionName, false, (session) => {
        Object.assign(session, updates);
      });
    } catch (error) {
      logger.error(`Failed to update session ${sessionName}:`, error);
      return false;
    }
  }

  /**
   * Get todos from a session
   *
   * @param sessionName - Name of the session (defaults to current session)
   * @returns Array of todos or empty array if not found
   */
  async getTodos(sessionName?: string): Promise<TodoItem[]> {
    const name = sessionName ?? this.currentSession;
    if (!name) return [];

    const session = await this.loadSession(name);
    return session?.todos ?? [];
  }

  /**
   * Get idle messages from a session
   *
   * @param sessionName - Name of the session (defaults to current session)
   * @returns Array of idle messages
   */
  async getIdleMessages(sessionName?: string): Promise<string[]> {
    const name = sessionName ?? this.currentSession;
    if (!name) return [];

    const session = await this.loadSession(name);
    const messages = session?.idle_messages ?? [];
    logger.debug(`[SESSION] getIdleMessages for ${name}: ${messages.length} messages - ${JSON.stringify(messages.slice(0, 3))}...`);
    return messages;
  }

  /**
   * Get project context from a session
   *
   * @param sessionName - Name of the session (defaults to current session)
   * @returns Project context or null if not found
   */
  async getProjectContext(sessionName?: string): Promise<Session['project_context'] | null> {
    const name = sessionName ?? this.currentSession;
    if (!name) return null;

    const session = await this.loadSession(name);
    return session?.project_context ?? null;
  }

  /**
   * Save todos to a session
   *
   * @param todos - Array of todos to save
   * @param sessionName - Name of the session (defaults to current session)
   * @returns True if saved successfully
   */
  async setTodos(
    todos: TodoItem[],
    sessionName?: string
  ): Promise<boolean> {
    const name = sessionName ?? this.currentSession;
    if (!name) return false;

    try {
      await this.flushPendingAutoSave(name);
      return await this.mutateSession(name, true, (session) => {
        session.todos = todos;
      });
    } catch (error) {
      logger.error(`Failed to save todos for ${name}:`, error);
      return false;
    }
  }

  /**
   * Flush any pending debounced save immediately
   * Used on cleanup to ensure no data loss
   */
  private async flushDebouncedSave(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    await this.flushPendingAutoSave();
  }

  /** Flush the pending message snapshot, optionally only for one session. */
  private async flushPendingAutoSave(sessionName?: string): Promise<void> {
    const pending = this.pendingAutoSave;
    if (!pending || (sessionName && pending.sessionName !== sessionName)) return;

    this.pendingAutoSave = null;
    logger.debug('[SESSION] Flushing pending debounced save');
    const transcript = pending.updates.transcript ?? pending.updates.messages ?? [];
    await this.mutateSessionIncremental(
      pending.sessionName,
      true,
      { ...pending.updates, active_plugins: pending.updates.active_plugins ?? [] },
      transcript,
    );
  }

  /**
   * Force immediate save of current session, bypassing debounce
   * Use for critical operations that require guaranteed persistence
   *
   * @returns True if saved successfully
   */
  async forceSave(): Promise<boolean> {
    await this.flushDebouncedSave();
    return true;
  }

  /**
   * Durably commit a new model window and its checkpoint before the agent
   * installs either in memory. Unlike ordinary autosave this is never debounced.
   */
  async commitConversationCheckpoint(
    messages: readonly Message[],
    transcript: readonly Message[],
    checkpoint: ConversationCheckpointV1,
  ): Promise<boolean> {
    const name = this.currentSession;
    if (!name || this.isShuttingDown) return false;

    try {
      await this.flushPendingAutoSave(name);
      return await this.mutateSessionIncremental(name, true, {
        messages: this.filterMessagesForPersistence(messages),
        conversation_checkpoint: structuredClone(checkpoint),
        provider_state: structuredClone(checkpoint.providerState),
      }, transcript);
    } catch (error) {
      logger.error(`[SESSION] Failed to commit conversation checkpoint ${checkpoint.id}:`, error);
      return false;
    }
  }

  /**
   * Auto-save current session (messages and todos)
   *
   * Now debounced to reduce I/O - batches rapid saves with 2-second delay.
   * Saves are cached in memory and written after debounce window.
   * On cleanup/shutdown, pending saves are flushed immediately.
   *
   * @param messages - Current conversation messages
   * @param todos - Current todos
   * @param idleMessages - Idle message queue
   * @param projectContext - Project context
   * @param additionalDirectories - Additional directories added to accessible scope
   * @returns True if save was queued/completed successfully
   */
  async autoSave(
    messages: readonly Message[],
    todos?: TodoItem[],
    idleMessages?: string[],
    projectContext?: Session['project_context'],
    additionalDirectories?: string[],
    transcript: readonly Message[] = messages,
    checkpoint?: ConversationCheckpointV1,
    providerState?: ProviderCheckpointState,
  ): Promise<boolean> {
    const name = this.currentSession;
    if (!name || this.isShuttingDown) {
      return false;
    }

    const filteredMessages = this.filterMessagesForPersistence(messages);

    if (filteredMessages.length === 0 && (!todos || todos.length === 0)) {
      return false; // Nothing to save
    }

    try {
      // Session switches are rare, but a pending save for the previous session
      // must be durable before the single debounce slot is reused.
      if (this.pendingAutoSave && this.pendingAutoSave.sessionName !== name) {
        await this.flushDebouncedSave();
      }

      const updates: Partial<Session> = {
        ...(this.pendingAutoSave?.sessionName === name ? this.pendingAutoSave.updates : {}),
        messages: filteredMessages,
        transcript: this.filterMessagesForPersistence(transcript),
      };
      if (checkpoint !== undefined) {
        updates.conversation_checkpoint = structuredClone(checkpoint);
      }
      if (providerState !== undefined) {
        updates.provider_state = structuredClone(providerState);
      }
      if (todos !== undefined) {
        updates.todos = todos;
      }
      if (idleMessages !== undefined && idleMessages.length > 0) {
        logger.debug(`[SESSION] Saving ${idleMessages.length} idle messages: ${JSON.stringify(idleMessages.slice(0, 3))}...`);
        updates.idle_messages = idleMessages;
      }
      if (projectContext !== undefined) {
        updates.project_context = projectContext;
      }
      if (additionalDirectories !== undefined) {
        updates.additional_directories = additionalDirectories;
      }
      this.pendingAutoSave = { sessionName: name, updates };

      // Cancel existing timer
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }

      // Set new debounce timer
      this.debounceTimer = setTimeout(async () => {
        this.debounceTimer = null;

        try {
          await this.flushPendingAutoSave(name);
          logger.debug('[SESSION] Debounced save completed');
        } catch (error) {
          logger.error(`[SESSION] Failed to save debounced session ${name}:`, error);
        }
      }, this.DEBOUNCE_DELAY_MS);

      logger.debug('[SESSION] Auto-save debounced (will save in 2s)');
      return true;
    } catch (error) {
      logger.error(`Failed to prepare auto-save for session ${name}:`, error);
      return false;
    }
  }
}
