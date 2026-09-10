import { describe, expect, it } from 'vitest';
import { decodeRunJournal, type RunJournalEvent } from '../RunJournal.js';

async function* chunks(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.slice(offset, offset + size);
}

async function decode(text: string | Uint8Array, size = 7): Promise<RunJournalEvent[]> {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  const result = [];
  for await (const event of decodeRunJournal(chunks(bytes, size), 'run')) result.push(event);
  return result;
}

const event = { runId: 'run', sequence: 1, timestamp: 1, type: 'assistant_progress', data: { summary: '完成 🦉' } };

describe('run journal decoding', () => {
  it.each([1, 2, 7, 65536])('preserves records and UTF-8 across %i-byte chunks', async size => {
    const events = [event, { ...event, sequence: 2 }];
    expect(await decode(events.map(value => JSON.stringify(value)).join('\n') + '\n', size)).toEqual(events);
  });

  it.each(['', JSON.stringify(event), JSON.stringify(event) + '\n{', '\n'])('rejects incomplete or empty records', async text => {
    await expect(decode(text)).rejects.toThrow();
  });

  it('rejects invalid and incomplete UTF-8 rather than replacing bytes', async () => {
    for (const suffix of [[0xff, 10], [0xf0, 0x9f]]) {
      const prefix = new TextEncoder().encode(JSON.stringify(event) + '\n');
      await expect(decode(new Uint8Array([...prefix, ...suffix]), 1)).rejects.toThrow();
    }
  });

  it.each([
    { ...event, runId: 'foreign' },
    { ...event, sequence: 2 },
    { ...event, type: 'tool_running', data: { callId: 'c', tool: 'bash' } },
    { ...event, type: 'tool_running', data: { callId: 'c', tool: 'bash', effect: 'typo' } },
    { ...event, type: 'tool_reconciled', data: { callId: 'c', resolution: 'applied' } },
  ])('rejects invalid recovery evidence: %j', async invalid => {
    await expect(decode(JSON.stringify(invalid) + '\n')).rejects.toThrow();
  });

  it('yields a record before requesting more input and closes input on early exit', async () => {
    let consumed = 0;
    let closed = false;
    async function* source() {
      try {
        for (let sequence = 1; sequence <= 10000; sequence++) {
          consumed++;
          yield new TextEncoder().encode(JSON.stringify({ ...event, sequence }) + '\n');
        }
      } finally { closed = true; }
    }
    const iterator = decodeRunJournal(source(), 'run');
    expect((await iterator.next()).value).toEqual(event);
    expect(consumed).toBe(1);
    await iterator.return(undefined);
    expect(closed).toBe(true);
  });
});
