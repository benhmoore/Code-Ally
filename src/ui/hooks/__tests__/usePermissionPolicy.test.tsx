import React from 'react';
import { EventEmitter } from 'node:events';
import { Box, render, Text } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { PermissionSnapshot } from '@services/PermissionPolicyService.js';
import { applyRuntimeConfigUpdates } from '@services/RuntimeConfigSync.js';
import { DEFAULT_CONFIG } from '@config/defaults.js';
import { usePermissionMode } from '../usePermissionPolicy.js';
import { PermissionModeStatus } from '../../components/PermissionModeStatus.js';

vi.mock('@services/RuntimeConfigSync.js', () => ({ applyRuntimeConfigUpdates: vi.fn() }));
class Output extends EventEmitter {
  columns = 100;
  rows = 24;
  frames: string[] = [];
  write = (frame: string) => {
    this.frames.push(frame);
    return true;
  };
}
const mounted: Array<{ unmount(): void }> = [];
afterEach(() => {
  mounted.splice(0).forEach(instance => instance.unmount());
  for (const key of ['permission_policy', 'config_manager']) ServiceRegistry.getInstance()['_services'].delete(key);
  vi.clearAllMocks();
});
function policy(initial: PermissionSnapshot) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish: (update: Partial<PermissionSnapshot>) => {
      snapshot = { ...snapshot, ...update };
      listeners.forEach(listener => listener());
    },
    listeners,
  };
}

describe('permission mode ownership', () => {
  it('persists each explicit three-way transition and does not rerender the editor for audit decisions', async () => {
    const source = policy({ requestedMode: 'manual', effectiveMode: 'manual', reviewing: false });
    const registry = ServiceRegistry.getInstance();
    registry.registerInstance('permission_policy', source as never);
    const setValue = vi.fn(async (_key: string, mode: string) => {
      source.publish({
        requestedMode: mode as PermissionSnapshot['requestedMode'],
        effectiveMode: mode as PermissionSnapshot['effectiveMode'],
      });
    });
    registry.registerInstance('config_manager', { setValue } as never);
    const updateConfig = vi.fn();
    const addMessage = vi.fn();
    let controls!: ReturnType<typeof usePermissionMode>;
    let renders = 0;
    function Editor() {
      renders++;
      controls = usePermissionMode(DEFAULT_CONFIG, { updateConfig, addMessage });
      return <Text>{controls.effectiveMode}</Text>;
    }
    const stdout = new Output();
    mounted.push(
      render(
        <>
          <Editor />
          <PermissionModeStatus requestedMode="manual" onCycle={() => controls.cycle()} />
          <Box paddingLeft={1}>
            <Text>model metadata</Text>
          </Box>
        </>,
        { stdout, debug: true, patchConsole: false, exitOnCtrlC: false }
      )
    );
    await vi.waitFor(() => expect(controls).toBeDefined());
    const before = renders;
    source.publish({ reviewing: true });
    await vi.waitFor(() => expect(stdout.frames.at(-1)).toContain(' Reviewing operation…'));
    expect(renders).toBe(before);
    expect(stdout.frames.at(-1)).toContain(' Manual · shift+tab');
    expect(stdout.frames.at(-1)).not.toContain('Mode:');
    const lines = stdout.frames.at(-1)!.split('\n');
    expect(lines.find(line => line.includes('Manual · shift+tab'))?.indexOf('Manual')).toBe(1);
    expect(lines.find(line => line.includes('Reviewing operation'))?.indexOf('Reviewing')).toBe(1);
    expect(lines.find(line => line.includes('model metadata'))?.indexOf('model')).toBe(1);
    source.publish({
      reviewing: false,
    });
    await vi.waitFor(() => expect(stdout.frames.at(-1)).not.toContain('Reviewing operation'));
    expect(stdout.frames.at(-1)).not.toContain('Within task');
    expect(stdout.frames.at(-1)).not.toContain('read');
    expect(renders).toBe(before);
    for (const mode of ['auto', 'allow-all', 'manual'] as const) {
      controls.cycle();
      await vi.waitFor(() => expect(updateConfig).toHaveBeenLastCalledWith({ permission_mode: mode }));
      expect(setValue).toHaveBeenLastCalledWith('permission_mode', mode);
      expect(applyRuntimeConfigUpdates).toHaveBeenLastCalledWith(registry, { permission_mode: mode });
    }
    expect(addMessage).not.toHaveBeenCalled();
  });

  it('keeps Auto fallback explicit and leaves mode unchanged on persistence failure', async () => {
    const source = policy({
      requestedMode: 'auto',
      effectiveMode: 'manual',
      reviewing: false,
      fallbackReason: 'Reviewer offline',
    });
    const registry = ServiceRegistry.getInstance();
    registry.registerInstance('permission_policy', source as never);
    registry.registerInstance('config_manager', {
      setValue: vi.fn().mockRejectedValue(new Error('Read-only config')),
    } as never);
    const updateConfig = vi.fn();
    const addMessage = vi.fn();
    let controls!: ReturnType<typeof usePermissionMode>;
    function Harness() {
      controls = usePermissionMode(DEFAULT_CONFIG, { updateConfig, addMessage });
      return <PermissionModeStatus requestedMode="auto" onCycle={controls.cycle} />;
    }
    const stdout = new Output();
    mounted.push(render(<Harness />, { stdout, debug: true, patchConsole: false, exitOnCtrlC: false }));
    await vi.waitFor(() => expect(stdout.frames.join('')).toContain('Reviewer offline'));
    expect(stdout.frames.join('')).toContain('Auto → Manual');
    controls.cycle();
    await vi.waitFor(() => expect(addMessage).toHaveBeenCalledOnce());
    expect(updateConfig).not.toHaveBeenCalled();
    expect(controls.effectiveMode).toBe('manual');
  });
});
