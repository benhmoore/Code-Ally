import React from 'react';
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useProviderDiagnostics } from '../useProviderDiagnostics.js';
import { ActivityStream } from '../../../services/ActivityStream.js';
import { DEFAULT_CONFIG } from '../../../config/defaults.js';
import type { Config } from '../../../types/index.js';

class Stdout extends EventEmitter {
  columns = 80;
  rows = 24;
  write = () => true;
}
const mounted: Array<{ unmount: () => void }> = [];
afterEach(() => { mounted.splice(0).forEach(item => item.unmount()); vi.unstubAllGlobals(); });
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const config = { ...DEFAULT_CONFIG, endpoint: 'http://fixture.invalid', model: 'fixture' };
function setup(enabled = true) {
  const stream = new ActivityStream();
  const emit = vi.spyOn(stream, 'emit');
  function Harness({ value }: { value: Config }) { useProviderDiagnostics(enabled, value, stream); return null; }
  const instance = render(<Harness value={config}/>, { stdout: new Stdout() as unknown as NodeJS.WriteStream,
    debug: true, exitOnCtrlC: false, patchConsole: false });
  mounted.push(instance);
  return { emit, instance, Harness };
}

describe('advisory provider diagnostics', () => {
  it('does not block rendering or take focus when discovery eventually reports a missing model', async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    const { emit } = setup();
    await settle();
    expect(fetch).toHaveBeenCalledOnce();
    expect(emit).not.toHaveBeenCalled();
    resolve(Response.json({ models: [] }));
    await settle();
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'status_message', data: {
      message: expect.stringContaining('Use /model'),
    } }));
  });

  it('aborts and ignores stale discovery on configuration changes and unmount', async () => {
    const requests: Array<{ signal: AbortSignal; resolve: (response: Response) => void }> = [];
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise<Response>(resolve => {
      requests.push({ signal: options.signal, resolve });
    })));
    const { emit, instance, Harness } = setup();
    await settle();
    instance.rerender(<Harness value={{ ...config, model: 'new-model' }}/>);
    await settle();
    expect(requests[0]!.signal.aborted).toBe(true);
    requests[0]!.resolve(Response.json({ models: [] }));
    await settle();
    expect(emit).not.toHaveBeenCalled();
    instance.unmount();
    await settle();
    expect(requests[1]!.signal.aborted).toBe(true);
    requests[1]!.resolve(Response.json({ models: [] }));
    await settle();
    expect(emit).not.toHaveBeenCalled();
  });

  it('reports unavailable endpoints without a selector and skips disabled diagnostics', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    setup(false);
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    const { emit } = setup();
    await settle();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'status_message', data: {
      message: expect.stringContaining('Cannot connect'),
    } }));
  });
});
