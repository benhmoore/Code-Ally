import React from 'react';
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import { useRewindPreview } from '../useRewindPreview.js';
import type { RewindRequest } from '../useModalState.js';
import type { PatchMetadata, UndoPreview } from '@services/PatchManager.js';
class Output extends EventEmitter { columns = 80; rows = 24; write = () => true; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  return { promise: new Promise<T>((accept, fail) => { resolve = accept; reject = fail; }), resolve: (value: T) => resolve(value), reject: (error: Error) => reject(error) };
};
const request = (requestId: string): RewindRequest => ({ requestId, selectedIndex: 0, targets: [{ id: requestId, role: 'user', content: requestId, timestamp: 5 }] });

describe('rewind preview ownership', () => {
  it('does not reopen cancelled or superseded requests and catches read failures', async () => {
    const previews = [deferred<UndoPreview[] | null>(), deferred<UndoPreview[] | null>()];
    const reader = { getPatchesSinceTimestamp: vi.fn(async () => [] as PatchMetadata[]),
      previewUndoSinceTimestamp: vi.fn().mockReturnValueOnce(previews[0]!.promise).mockReturnValueOnce(previews[1]!.promise) };
    const publish = vi.fn(); const errors = vi.fn();
    let select!: (index: number) => void;
    function Harness({ value }: { value?: RewindRequest }) {
      select = useRewindPreview(value, reader, publish, errors).select;
      return null;
    }
    const instance = render(<Harness value={request('first')}/>, { stdout: new Output(), debug: true, patchConsole: false, exitOnCtrlC: false });
    try {
      await tick(); select(0); await tick();
      instance.rerender(<Harness value={request('second')}/>); await tick();
      previews[0]!.resolve([]); await tick();
      expect(publish).not.toHaveBeenCalled();
      select(0); await tick();
      previews[1]!.reject(new Error('disk failed')); await tick();
      expect(errors).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('disk failed'));
      expect(publish).not.toHaveBeenCalled();
    } finally { instance.unmount(); }
  });

  it('deduplicates changed paths and publishes only the latest selection', async () => {
    const publish = vi.fn(); const errors = vi.fn();
    const first = deferred<PatchMetadata[]>();
    let reads = 0;
    const reader = { getPatchesSinceTimestamp: vi.fn((timestamp: number) => timestamp === 0 ? Promise.resolve([])
      : ++reads === 1 ? first.promise : Promise.resolve([{ file_path: 'a.ts' }, { file_path: 'a.ts' }] as PatchMetadata[])),
      previewUndoSinceTimestamp: vi.fn(async () => [] as UndoPreview[]) };
    let select!: (index: number) => void;
    const value = request('one');
    function Harness() { select = useRewindPreview(value, reader, publish, errors).select; return null; }
    const instance = render(<Harness/>, { stdout: new Output(), debug: true, patchConsole: false, exitOnCtrlC: false });
    try {
      await tick(); select(0); select(0); await tick();
      expect(publish).toHaveBeenCalledOnce();
      expect(publish.mock.calls[0]![0]).toMatchObject({ fileChanges: { fileCount: 1, files: [{ path: 'a.ts' }] } });
      first.resolve([]); await tick();
      expect(publish).toHaveBeenCalledOnce();
      expect(errors).not.toHaveBeenCalled();
    } finally { instance.unmount(); }
  });

  it('ignores pending patch reads and selections after unmount', async () => {
    const patches = deferred<PatchMetadata[]>();
    const reader = { getPatchesSinceTimestamp: vi.fn(() => patches.promise), previewUndoSinceTimestamp: vi.fn(async () => []) };
    const publish = vi.fn(); const errors = vi.fn();
    let select!: (index: number) => void;
    const value = request('one');
    function Harness() { select = useRewindPreview(value, reader, publish, errors).select; return null; }
    const instance = render(<Harness/>, { stdout: new Output(), debug: true, patchConsole: false, exitOnCtrlC: false });
    await tick(); select(0); instance.unmount();
    patches.resolve([]); await tick();
    expect(publish).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    expect(reader.previewUndoSinceTimestamp).not.toHaveBeenCalled();
  });
});
