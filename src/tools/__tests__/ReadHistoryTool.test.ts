import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReadHistoryTool } from '../ReadHistoryTool.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { SessionManager } from '../../services/SessionManager.js';
import { tokenCounter } from '../../services/TokenCounter.js';
import { toModelToolResult } from '../../utils/toolResultContent.js';
import type { Message } from '../../types/index.js';

describe('ReadHistoryTool', () => {
  it('retrieves complete original user text across archived pages within a token allowance', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'ally-history-reader-'));
    try {
      const writer = new SessionManager({ sessionsDir: dir });
      await writer.initialize();
      await writer.createSession('history');
      const original = `  ${'😀 Exact case Foo foo\n'.repeat(180)}FINAL REQUIREMENT  `;
      const messages: Message[] = [
        { id: 'original', role: 'user', content: original, timestamp: 1 },
        ...Array.from({ length: 650 }, (_, i): Message => ({ id: `a${i}`, role: 'assistant', content: 'Progress', timestamp: i + 2 })),
        { id: 'latest', role: 'user', content: 'Keep previous requirements.', timestamp: 1000 },
      ];
      expect(await writer.saveSession('history', [], messages)).toBe(true);
      const reader = new SessionManager({ sessionsDir: dir });
      reader.setCurrentSession('history');
      const scope = { get(name: string) {
        if (name === 'session_manager') return reader;
        if (name === 'context_budget') return { get: () => ({ maxToolResultTokens: 300 }) };
        return null;
      } };
      const tool = new ReadHistoryTool(new ActivityStream());
      expect(tool.mainAgentOnly).toBe(true);
      let args: Record<string, unknown> = {};
      let recovered = '';
      let complete = false;
      let appended = false;
      for (let page = 0; page < 100; page++) {
        const result = await tool.execute(args, 'history-page', undefined, false, false, { registryScope: scope });
        expect(result.success).toBe(true);
        expect(tokenCounter.count(JSON.stringify(toModelToolResult(result)))).toBeLessThanOrEqual(300);
        if (result.message_id === 'original') recovered += result.content;
        if (!appended && result.message_id === 'original' && result.next_offset !== null) {
          // New input must not redirect a partially read older message.
          expect(await writer.saveSession('history', [], [...messages,
            { id: 'concurrent', role: 'user', content: 'New input during retrieval.', timestamp: 1001 },
          ])).toBe(true);
          appended = true;
        }
        if (result.next_before === null) { complete = true; break; }
        args = { session_id: result.session_id, before: result.next_before,
          ...(result.next_offset !== null ? { offset: result.next_offset, message_id: result.message_id } : {}) };
      }
      expect(complete).toBe(true);
      expect(recovered).toBe(original);
      expect(appended).toBe(true);
      const rejected = await tool.execute({ session_id: 'another-session', before: 1 }, 'stale', undefined, false, false, { registryScope: scope });
      expect(rejected.success).toBe(false);
      const tiny = await tool.execute({}, 'tiny', undefined, false, false, {
        registryScope: scope,
        outputBudget: { limitTokens: 1, maxResultTokensByCallId: new Map([['tiny', 1]]) },
      });
      expect(tiny.success).toBe(false);
      const staleMessage = await tool.execute({ session_id: 'history', before: 1, message_id: 'changed', offset: 1 },
        'changed', undefined, false, false, { registryScope: scope });
      expect(staleMessage.success).toBe(false);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('rejects results if the active session changes while loading an archive page', async () => {
    let active = 'first';
    const sessions = {
      getCurrentSession: () => active,
      getTranscriptPage: async () => {
        active = 'second';
        return { messages: [{ id: 'old', role: 'user', content: 'Old session request' }], nextCursor: null, totalMessages: 1 };
      },
    };
    const scope = { get: (name: string) => name === 'session_manager' ? sessions : null };
    const result = await new ReadHistoryTool(new ActivityStream()).execute({}, 'page', undefined, false, false, { registryScope: scope });
    expect(result.success).toBe(false);
    expect(result.error).toContain('session changed');
    expect(JSON.stringify(result)).not.toContain('Old session request');
  });
});
