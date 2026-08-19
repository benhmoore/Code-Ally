import { describe, expect, it } from 'vitest';
import type { UndoPreview } from '@services/PatchManager.js';
import { buildFileRestoreDisplays } from '../RewindOptionsSelector.js';

function preview(overrides: Partial<UndoPreview>): UndoPreview {
  return {
    operation_type: 'apply-patch',
    file_path: '/project/a.ts',
    patch_number: 1,
    timestamp: new Date(1).toISOString(),
    current_content: 'one\n',
    predicted_content: 'zero\n',
    ...overrides,
  };
}

describe('buildFileRestoreDisplays', () => {
  it('collapses sequential edits into one net file restoration', () => {
    const displays = buildFileRestoreDisplays([
      preview({
        patch_number: 2,
        current_content: 'two\n',
        predicted_content: 'one\n',
      }),
      preview({
        patch_number: 1,
        current_content: 'one\n',
        predicted_content: 'zero\n',
      }),
    ]);

    expect(displays).toHaveLength(1);
    expect(displays?.[0]).toMatchObject({
      path: '/project/a.ts',
      operationLabel: '2 changes',
    });
    expect(displays?.[0]?.stats).toMatchObject({ additions: 1, deletions: 1 });
  });

  it('keeps distinct files and their operation labels separate', () => {
    const displays = buildFileRestoreDisplays([
      preview({ file_path: '/project/b.ts', operation_type: 'write' }),
      preview({ file_path: '/project/a.ts', operation_type: 'apply-patch' }),
    ]);

    expect(displays?.map(item => [item.path, item.operationLabel])).toEqual([
      ['/project/b.ts', 'write'],
      ['/project/a.ts', 'apply-patch'],
    ]);
  });

  it('returns null when no preview is available', () => {
    expect(buildFileRestoreDisplays()).toBeNull();
    expect(buildFileRestoreDisplays([])).toBeNull();
  });
});
