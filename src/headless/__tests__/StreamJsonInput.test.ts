import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { StreamJsonInput, parseStreamJsonLine } from '../StreamJsonInput.js';

describe('parseStreamJsonLine', () => {
  it('reads a user message from block content and from a plain string', () => {
    expect(parseStreamJsonLine(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    }))).toEqual({ kind: 'user', text: 'hello' });

    expect(parseStreamJsonLine(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'hello' },
    }))).toEqual({ kind: 'user', text: 'hello' });
  });

  it('reads an interrupt control request with its id', () => {
    expect(parseStreamJsonLine(JSON.stringify({
      type: 'control_request',
      request_id: 'req-1',
      request: { subtype: 'interrupt' },
    }))).toEqual({ kind: 'interrupt', requestId: 'req-1' });
  });

  it.each([
    ['{', 'malformed json'],
    [JSON.stringify({ type: 'assistant' }), 'unknown type'],
    [JSON.stringify({ type: 'user', message: { role: 'assistant', content: 'x' } }), 'wrong role'],
    [JSON.stringify({ type: 'control_request', request: { subtype: 'pause' } }), 'unknown subtype'],
  ])('rejects %s', line => {
    expect(() => parseStreamJsonLine(line)).toThrow();
  });
});

describe('StreamJsonInput', () => {
  it('dispatches each line and reports parse failures without stopping', async () => {
    const input = new PassThrough();
    const onUser = vi.fn();
    const onInterrupt = vi.fn();
    const onError = vi.fn();
    const onClose = vi.fn();
    new StreamJsonInput(input, { onUser, onInterrupt, onError, onClose }).start();

    input.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'one' } })}\n`);
    input.write('not json\n');
    input.write('\n');
    input.write(`${JSON.stringify({ type: 'control_request', request: { subtype: 'interrupt' } })}\n`);
    input.end();

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onUser).toHaveBeenCalledExactlyOnceWith('one');
    expect(onInterrupt).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(onError).toHaveBeenCalledOnce();
  });
});
