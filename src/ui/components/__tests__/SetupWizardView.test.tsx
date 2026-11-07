import React from 'react';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetupWizardView } from '../SetupWizardView.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { DEFAULT_CONFIG } from '@config/defaults.js';
import type { Config } from '@shared/index.js';

class Stdout extends EventEmitter {
  columns = 100;
  rows = 35;
  frames: string[] = [];
  write = (frame: string) => {
    this.frames.push(frame);
    return true;
  };
}
class Stdin extends PassThrough {
  isTTY = true;
  setRawMode() {
    return this;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}
const mounted: Array<{ unmount: () => void }> = [];
afterEach(() => {
  mounted.splice(0).forEach(item => item.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function setup(overrides: Partial<Config> = {}, geometry = { columns: 100, rows: 35 }) {
  const config = {
    ...DEFAULT_CONFIG,
    provider: 'rapid-mlx' as const,
    endpoint: 'http://fixture:8888',
    model: 'saved-model',
    setup_completed: true,
    permission_mode: 'manual' as const,
    ...overrides,
  };
  const setValues = vi.fn(async (patch: Partial<Config>) => {
    Object.assign(config, patch);
  });
  const manager = { getConfig: () => ({ ...config }), setValues };
  vi.spyOn(ServiceRegistry.getInstance(), 'getRequired').mockReturnValue(manager as any);
  vi.spyOn(ServiceRegistry.getInstance(), 'get').mockImplementation(name =>
    name === 'config_manager' ? (manager as any) : null
  );
  const stdout = new Stdout();
  Object.assign(stdout, geometry);
  const stdin = new Stdin();
  const onComplete = vi.fn();
  const onSkip = vi.fn();
  const instance = render(<SetupWizardView onComplete={onComplete} onSkip={onSkip} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  mounted.push(instance);
  const frame = () => stdout.frames.at(-1) ?? '';
  const see = async (text: string) => vi.waitFor(() => expect(frame()).toContain(text));
  const press = (key: string) => {
    stdin.write(key);
  };
  return { config, setValues, manager, onComplete, onSkip, instance, see, frame, press };
}
const models = () => Response.json({ data: [{ id: 'saved-model', capabilities: ['tools'] }] });
async function selectConnection(ui: ReturnType<typeof setup>) {
  await ui.see('Model provider');
  ui.press('\r');
  await ui.see('Server endpoint');
  ui.press('\r');
  await ui.see('API key');
  ui.press('\r');
}

describe('essential setup keyboard flow', () => {
  it('reports a committed save separately from activation failure and retries activation without another write', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => models())
    );
    const ui = setup();
    const client = {
      setEndpoint: vi.fn().mockImplementationOnce(() => {
        throw new Error('client unavailable');
      }),
    };
    vi.mocked(ServiceRegistry.getInstance().get).mockImplementation(name =>
      name === 'config_manager' ? (ui.manager as any) : name === 'model_client' ? (client as any) : null
    );
    await selectConnection(ui);
    await ui.see('3 / 6 · Model');
    ui.press('\r');
    await ui.see('Context window');
    ui.press('\r');
    await ui.see('Permissions');
    ui.press('\r');
    await ui.see('Review settings');
    ui.press('\r');
    await ui.see('Settings saved, but activation failed');
    expect(ui.setValues).toHaveBeenCalledOnce();
    ui.press('\r');
    await ui.see('Ready to code');
    expect(ui.setValues).toHaveBeenCalledOnce();
    expect(client.setEndpoint).toHaveBeenCalledTimes(2);
  });

  it('keeps model navigation and save controls visible in a 40 by 12 terminal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          data: Array.from({ length: 30 }, (_, index) => ({
            id: `model-${index}-${'long-model-name'.repeat(5)}`,
            capabilities: ['tools'],
          })),
        })
      )
    );
    const ui = setup({ setup_completed: false }, { columns: 40, rows: 12 });
    await selectConnection(ui);
    await ui.see('3 / 6 · Model');
    expect(ui.frame()).toContain('enter continue');
    expect(ui.frame().split('\n').length).toBeLessThanOrEqual(12);
    expect(ui.frame()).not.toContain('long-model-name'.repeat(5));
    ui.press('\r');
    await ui.see('Context window');
    expect(ui.frame()).toContain('32K');
    expect(ui.frame()).toContain('enter continue');
    expect(ui.frame().split('\n').length).toBeLessThanOrEqual(12);
    ui.press('\r');
    await ui.see('Permissions');
    ui.press('\r');
    await ui.see('Review settings');
    expect(ui.frame()).toContain('enter save');
    expect(ui.frame().split('\n').length).toBeLessThanOrEqual(12);
  });

  it('finishes activation once on Ctrl+C after save and does not cancel an admitted save', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => models())
    );
    const ui = setup();
    await selectConnection(ui);
    await ui.see('3 / 6 · Model');
    ui.press('\r');
    await ui.see('Context window');
    ui.press('\r');
    await ui.see('Permissions');
    ui.press('\r');
    await ui.see('Review settings');
    let finish!: () => void;
    ui.setValues.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        })
    );
    ui.press('\r');
    await ui.see('Saving settings');
    ui.press('\u0003');
    ui.press('\u001b');
    expect(ui.onSkip).not.toHaveBeenCalled();
    expect(ui.onComplete).not.toHaveBeenCalled();
    finish();
    await ui.see('Ready to code');
    ui.press('\u0003');
    await vi.waitFor(() => expect(ui.onComplete).toHaveBeenCalledOnce());
    ui.press('\u0003');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(ui.onComplete).toHaveBeenCalledOnce();
    expect(ui.onSkip).not.toHaveBeenCalled();
  });

  it('reviews and saves essentials while retaining existing preferences and secrets on rerun', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => models())
    );
    const ui = setup({
      api_key: 'saved-secret',
      temperature: 0.8,
      context_size: 65536,
      service_model: 'titles-model',
      permission_mode: 'allow-all',
      enable_idle_messages: false,
    });
    await selectConnection(ui);
    await ui.see('3 / 6 · Model');
    ui.press('\r');
    await ui.see('Context window');
    ui.press('\r');
    await ui.see('Permissions');
    ui.press('\r');
    await ui.see('Review settings');
    expect(ui.frame()).toContain('65,536');
    expect(ui.frame()).not.toContain('saved-secret');
    expect(ui.setValues).not.toHaveBeenCalled();
    ui.press('\r');
    await ui.see('Ready to code');
    expect(ui.setValues).toHaveBeenCalledOnce();
    expect(ui.config).toMatchObject({
      endpoint: 'http://fixture:8888',
      api_key: 'saved-secret',
      model: 'saved-model',
      context_size: 65536,
      temperature: 0.8,
      service_model: 'titles-model',
      permission_mode: 'allow-all',
      enable_idle_messages: false,
      setup_completed: true,
    });
    expect(ui.onComplete).not.toHaveBeenCalled();
    ui.press('\r');
    await vi.waitFor(() => expect(ui.onComplete).toHaveBeenCalledOnce());
  });

  it('configures Auto with inherited reviewer settings, reports Manual fallback, and preserves secrets', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async url => (String(url).endsWith('/v1/models') ? models() : Response.json({ models: [] })))
    );
    const ui = setup({
      permission_mode: 'auto',
      reviewer_model: null,
      reviewer_endpoint: null,
      reviewer_api_key: 'review-secret',
    });
    await selectConnection(ui);
    await ui.see('3 / 6 · Model');
    ui.press('\r');
    await ui.see('Context window');
    ui.press('\r');
    await ui.see('Permissions');
    expect(ui.frame()).toContain('Fall back to Manual');
    ui.press('\r');
    await ui.see('Auto reviewer');
    const optionsFrame = ui.frame();
    ui.press('\u001b[B');
    await vi.waitFor(() => expect(ui.frame()).not.toBe(optionsFrame));
    ui.press('\r');
    await ui.see('Reviewer model');
    ui.press('\r');
    await ui.see('Reviewer endpoint');
    ui.press('\r');
    await ui.see('Reviewer API key');
    expect(ui.frame()).not.toContain('review-secret');
    ui.press('\r');
    await ui.see('Effective mode: Manual');
    expect(ui.setValues).not.toHaveBeenCalled();
    ui.press('\r');
    await ui.see('Review settings');
    expect(ui.frame()).toContain('Permissions: Auto → Manual');
    expect(ui.frame()).not.toContain('review-secret');
    ui.press('\r');
    await ui.see('Ready to code');
    expect(ui.config).toMatchObject({
      permission_mode: 'auto',
      reviewer_model: null,
      reviewer_endpoint: null,
      reviewer_api_key: 'review-secret',
    });
  });

  it('uses saved Auto defaults directly and shows successful reviewer readiness', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async url => {
        if (String(url).endsWith('/v1/models')) return models();
        if (String(url).endsWith('/api/tags'))
          return Response.json({ models: [{ name: 'tev1:4b', capabilities: ['decision'] }] });
        return Response.json({
          answers: {
            permission: { type: 'choice', choice: 'deny', probabilities: { allow: 0.01, ask: 0.01, deny: 0.98 } },
          },
        });
      })
    );
    const ui = setup({ permission_mode: 'auto' });
    await selectConnection(ui);
    await ui.see('3 / 6 · Model');
    ui.press('\r');
    await ui.see('Context window');
    ui.press('\r');
    await ui.see('Permissions');
    ui.press('\r');
    await ui.see('Auto reviewer');
    ui.press('\r');
    await ui.see('Effective mode: Auto');
    expect(ui.frame()).toContain('tev1:4b');
    expect(ui.setValues).not.toHaveBeenCalled();
    ui.press('\r');
    await ui.see('Review settings');
    expect(ui.frame()).toContain('Permissions: Auto → Auto');
  });

  it('checks default Auto directly and cancels its isolated probe on Back in a narrow terminal', async () => {
    let signal!: AbortSignal;
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn((url, options) => {
        if (String(url).endsWith('/v1/models')) return Promise.resolve(models());
        signal = options.signal;
        return new Promise<Response>(resolve => {
          finish = resolve;
        });
      })
    );
    const ui = setup({ permission_mode: 'auto' }, { columns: 40, rows: 12 });
    await selectConnection(ui);
    await ui.see('3 / 6 · Model');
    ui.press('\r');
    await ui.see('Context window');
    ui.press('\r');
    await ui.see('Permissions');
    expect(ui.frame().split('\n').length).toBeLessThanOrEqual(12);
    ui.press('\r');
    await ui.see('Auto reviewer');
    expect(ui.frame()).toContain('Check reviewer');
    expect(ui.frame().split('\n').length).toBeLessThanOrEqual(12);
    ui.press('\r');
    await ui.see('Checking reviewer');
    ui.press('\u001b');
    await ui.see('Auto reviewer');
    expect(signal.aborted).toBe(true);
    finish(Response.json({ models: [] }));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(ui.frame()).toContain('Auto reviewer');
    expect(ui.setValues).not.toHaveBeenCalled();
  });

  it('aborts discovery on Back and ignores a late result', async () => {
    let finish!: (response: Response) => void;
    let signal!: AbortSignal;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url, options) => {
        signal = options.signal;
        return new Promise<Response>(resolve => {
          finish = resolve;
        });
      })
    );
    const ui = setup();
    await selectConnection(ui);
    await ui.see('Connecting');
    ui.press('\u001b');
    await ui.see('Server endpoint');
    expect(signal.aborted).toBe(true);
    finish(models());
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(ui.frame()).toContain('Server endpoint');
    expect(ui.setValues).not.toHaveBeenCalled();
  });

  it('offers retry after connection failure and after save failure without losing choices', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(models()));
    const ui = setup();
    await selectConnection(ui);
    await ui.see('Connection needs attention');
    ui.press('\r');
    await ui.see('3 / 6 · Model');
    ui.press('\r');
    await ui.see('Context window');
    ui.press('\r');
    await ui.see('Permissions');
    ui.press('\r');
    await ui.see('Review settings');
    ui.setValues.mockRejectedValueOnce(new Error('disk full'));
    ui.press('\r');
    await ui.see('Settings were not saved: disk full');
    expect(ui.frame()).toContain('Review settings');
    ui.press('\r');
    await ui.see('Ready to code');
    expect(ui.setValues).toHaveBeenCalledTimes(2);
  });

  it('cancels model metadata validation and supports Ctrl+C once from a filled editor', async () => {
    let signal!: AbortSignal;
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn((url, options) => {
        if (String(url).endsWith('/api/tags'))
          return Promise.resolve(Response.json({ models: [{ name: 'saved-model' }] }));
        signal = options.signal;
        return new Promise<Response>(resolve => {
          finish = resolve;
        });
      })
    );
    const ui = setup({ provider: 'ollama' });
    await selectConnection(ui);
    await ui.see('3 / 6 · Model');
    ui.press('\r');
    await ui.see('Checking tool support');
    ui.press('\u001b');
    await ui.see('3 / 6 · Model');
    expect(signal.aborted).toBe(true);
    finish(Response.json({ capabilities: ['tools'] }));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(ui.frame()).toContain('3 / 6 · Model');
    ui.press('\u001b');
    await ui.see('Server endpoint');
    ui.press('\u0003');
    await vi.waitFor(() => expect(ui.onSkip).toHaveBeenCalledOnce());
    expect(ui.setValues).not.toHaveBeenCalled();
  });
});
