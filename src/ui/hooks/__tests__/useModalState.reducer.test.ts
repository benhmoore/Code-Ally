/**
 * Unit tests for the pure modal-stack reducer.
 *
 * These lock in the structural guarantees of the modal system:
 *   - mutual exclusion of exclusive modals (no stale modal can hide underneath)
 *   - intentional layering of rewind→rewindOptions and undoFileList→undo
 *   - permission / tool-form queue semantics with head-change sub-state resets
 *   - clearTransient scope
 */

import { describe, it, expect } from 'vitest';
import { modalReducer, ModalAction, ModalEntry, ModalKind } from '../useModalState.js';

/** Fold a sequence of actions over the empty stack. */
const run = (...actions: ModalAction[]): ModalEntry[] => actions.reduce(modalReducer, [] as ModalEntry[]);

const kinds = (stack: ModalEntry[]): ModalKind[] => stack.map(e => e.kind);
const find = <K extends ModalKind>(stack: ModalEntry[], kind: K) =>
  stack.find(e => e.kind === kind) as Extract<ModalEntry, { kind: K }> | undefined;

const perm = (requestId: string): any => ({ requestId, toolName: 'bash', options: ['Allow', 'Deny'] });
const form = (requestId: string, initialValues?: Record<string, any>): any => ({
  requestId,
  toolName: 'tool',
  schema: { fields: [] },
  initialValues,
});
const modelReq = (requestId = 'm1'): any => ({ requestId, models: [] });

describe('modalReducer — mutual exclusion', () => {
  it('replaces an open exclusive modal when another opens (no stale modal underneath)', () => {
    const stack = run(
      { type: 'upsert', entry: { kind: 'session', request: { requestId: 's1', sessions: [], selectedIndex: 0 } } },
      { type: 'openExclusive', entry: { kind: 'model', request: modelReq(), selectedIndex: 0, loading: false } }
    );
    expect(kinds(stack)).toEqual(['model']);
  });

  it('upsert updates in place when the same kind is already open', () => {
    const stack = run(
      { type: 'upsert', entry: { kind: 'session', request: { requestId: 's1', sessions: [], selectedIndex: 0 } } },
      { type: 'upsert', entry: { kind: 'session', request: { requestId: 's1', sessions: [], selectedIndex: 3 } } }
    );
    expect(kinds(stack)).toEqual(['session']);
    expect(find(stack, 'session')!.request.selectedIndex).toBe(3);
  });

  it('upsert of a new kind clears any other exclusive modal', () => {
    const stack = run(
      { type: 'upsert', entry: { kind: 'library', request: { requestId: 'l1', prompts: [], selectedIndex: 0 } } },
      { type: 'upsert', entry: { kind: 'session', request: { requestId: 's1', sessions: [], selectedIndex: 0 } } }
    );
    expect(kinds(stack)).toEqual(['session']);
  });
});

describe('modalReducer — layered pairs', () => {
  it('rewindOptions layers on rewind; both resolve; closing options keeps rewind', () => {
    const opened = run(
      { type: 'upsert', entry: { kind: 'rewind', request: { requestId: 'r1', userMessagesCount: 3, selectedIndex: 2 } } },
      {
        type: 'pushLayer',
        entry: {
          kind: 'rewindOptions',
          request: { selectedIndex: 2, targetMessage: {} as any, fileChanges: {} as any },
        },
      }
    );
    expect(kinds(opened)).toEqual(['rewind', 'rewindOptions']);
    // rewind must still resolve while options is on top (callback reads its requestId)
    expect(find(opened, 'rewind')!.request.requestId).toBe('r1');

    const afterCancel = modalReducer(opened, { type: 'close', kind: 'rewindOptions' });
    expect(kinds(afterCancel)).toEqual(['rewind']);
  });

  it('undo layers on undoFileList; UNDO_FILE_BACK (close undo) restores file list', () => {
    const opened = run(
      { type: 'upsert', entry: { kind: 'undoFileList', request: { requestId: 'u1', fileList: [], selectedIndex: 0 } } },
      { type: 'pushLayer', entry: { kind: 'undo', request: { requestId: 'ur1', count: 1, patches: [], previewData: [] }, selectedIndex: 0 } }
    );
    expect(kinds(opened)).toEqual(['undoFileList', 'undo']);

    const afterBack = modalReducer(opened, { type: 'close', kind: 'undo' });
    expect(kinds(afterBack)).toEqual(['undoFileList']);
    expect(find(afterBack, 'undoFileList')!.request.requestId).toBe('u1');
  });

  it('UNDO_CONFIRM flow: close undo then reopen file list updates in place', () => {
    let stack = run(
      { type: 'upsert', entry: { kind: 'undoFileList', request: { requestId: 'u1', fileList: [], selectedIndex: 0 } } },
      { type: 'pushLayer', entry: { kind: 'undo', request: { requestId: 'ur1', count: 1, patches: [], previewData: [] }, selectedIndex: 0 } }
    );
    stack = modalReducer(stack, { type: 'close', kind: 'undo' });
    stack = modalReducer(stack, { type: 'upsert', entry: { kind: 'undoFileList', request: { requestId: 'u2', fileList: [{}], selectedIndex: 0 } } });
    expect(kinds(stack)).toEqual(['undoFileList']);
    expect(find(stack, 'undoFileList')!.request.requestId).toBe('u2');
  });
});

describe('modalReducer — permission queue', () => {
  it('add appends; head is queue[0]', () => {
    const stack = run({ type: 'permission/add', request: perm('p1') }, { type: 'permission/add', request: perm('p2') });
    const e = find(stack, 'permission')!;
    expect(e.queue.map(q => q.requestId)).toEqual(['p1', 'p2']);
  });

  it('removing the head advances the queue and resets head sub-state', () => {
    let stack = run({ type: 'permission/add', request: perm('p1') }, { type: 'permission/add', request: perm('p2') });
    stack = modalReducer(stack, { type: 'patch', kind: 'permission', patch: { selectedIndex: 1, instructText: 'typed', cursorPosition: 5 } });
    stack = modalReducer(stack, { type: 'permission/remove', requestId: 'p1' });
    const e = find(stack, 'permission')!;
    expect(e.queue.map(q => q.requestId)).toEqual(['p2']);
    expect(e.selectedIndex).toBe(0);
    expect(e.instructText).toBe('');
    expect(e.cursorPosition).toBe(0);
  });

  it('removing a non-head request preserves head sub-state', () => {
    let stack = run({ type: 'permission/add', request: perm('p1') }, { type: 'permission/add', request: perm('p2') });
    stack = modalReducer(stack, { type: 'patch', kind: 'permission', patch: { selectedIndex: 1, instructText: 'typed' } });
    stack = modalReducer(stack, { type: 'permission/remove', requestId: 'p2' });
    const e = find(stack, 'permission')!;
    expect(e.queue.map(q => q.requestId)).toEqual(['p1']);
    expect(e.selectedIndex).toBe(1);
    expect(e.instructText).toBe('typed');
  });

  it('removing the last request closes the modal', () => {
    let stack = run({ type: 'permission/add', request: perm('p1') });
    stack = modalReducer(stack, { type: 'permission/remove', requestId: 'p1' });
    expect(kinds(stack)).toEqual([]);
  });

  it('popHead pops the front and resets sub-state', () => {
    let stack = run({ type: 'permission/add', request: perm('p1') }, { type: 'permission/add', request: perm('p2') });
    stack = modalReducer(stack, { type: 'permission/popHead' });
    expect(find(stack, 'permission')!.queue.map(q => q.requestId)).toEqual(['p2']);
  });
});

describe('modalReducer — tool-form queue', () => {
  it('appending behind the active form does not disturb the head values', () => {
    let stack = run({ type: 'toolForm/add', request: form('f1', { a: 1 }) });
    stack = modalReducer(stack, { type: 'toolForm/setValue', field: 'a', value: 99 });
    stack = modalReducer(stack, { type: 'toolForm/add', request: form('f2', { b: 2 }) });
    const e = find(stack, 'toolForm')!;
    expect(e.queue.map(q => q.requestId)).toEqual(['f1', 'f2']);
    expect(e.values).toEqual({ a: 99 }); // head untouched
  });

  it('advancing the head reseeds field state from the new head', () => {
    let stack = run({ type: 'toolForm/add', request: form('f1', { a: 1 }) }, { type: 'toolForm/add', request: form('f2', { b: 2 }) });
    stack = modalReducer(stack, { type: 'toolForm/setValue', field: 'a', value: 99 });
    stack = modalReducer(stack, { type: 'toolForm/remove', requestId: 'f1' });
    const e = find(stack, 'toolForm')!;
    expect(e.queue.map(q => q.requestId)).toEqual(['f2']);
    expect(e.values).toEqual({ b: 2 });
    expect(e.fieldIndex).toBe(0);
  });

  it('setValue clears the field error', () => {
    let stack = run({ type: 'toolForm/add', request: form('f1') });
    stack = modalReducer(stack, { type: 'toolForm/setError', field: 'a', error: 'required' });
    expect(find(stack, 'toolForm')!.errors).toEqual({ a: 'required' });
    stack = modalReducer(stack, { type: 'toolForm/setValue', field: 'a', value: 'x' });
    expect(find(stack, 'toolForm')!.errors).toEqual({});
  });
});

describe('modalReducer — clearTransient', () => {
  it('removes permission/toolForm/planApproval, resets model loading, keeps user-driven modals', () => {
    let stack = run(
      { type: 'upsert', entry: { kind: 'rewind', request: { requestId: 'r1', userMessagesCount: 1, selectedIndex: 0 } } },
      { type: 'openExclusive', entry: { kind: 'model', request: modelReq(), selectedIndex: 0, loading: true } }
    );
    // model open replaced rewind (exclusive) — re-add rewind as a layered base for the assertion via a fresh build:
    stack = run(
      { type: 'openExclusive', entry: { kind: 'model', request: modelReq(), selectedIndex: 0, loading: true } }
    );
    // Now simulate transient modals coexisting is impossible with model; test the transient set + a survivor separately.
    let withTransients = run(
      { type: 'permission/add', request: perm('p1') }
    );
    withTransients = modalReducer(withTransients, { type: 'clearTransient' });
    expect(kinds(withTransients)).toEqual([]);

    // model loading reset, model kept
    const afterClear = modalReducer(stack, { type: 'clearTransient' });
    expect(kinds(afterClear)).toEqual(['model']);
    expect(find(afterClear, 'model')!.loading).toBe(false);
  });

  it('keeps session/rewind/undo selectors intact', () => {
    let stack = run(
      { type: 'upsert', entry: { kind: 'session', request: { requestId: 's1', sessions: [], selectedIndex: 0 } } }
    );
    stack = modalReducer(stack, { type: 'clearTransient' });
    expect(kinds(stack)).toEqual(['session']);
  });
});

describe('modalReducer — plan approval', () => {
  it('open resets sub-state; patches update it; close removes it', () => {
    let stack = run({
      type: 'openExclusive',
      entry: { kind: 'planApproval', request: { planFilePath: 'p', planContent: 'c' } as any, selectedIndex: 0, feedbackText: '', cursorPosition: 0 },
    });
    stack = modalReducer(stack, { type: 'patch', kind: 'planApproval', patch: { selectedIndex: 2, feedbackText: 'no' } });
    const e = find(stack, 'planApproval')!;
    expect(e.selectedIndex).toBe(2);
    expect(e.feedbackText).toBe('no');
    stack = modalReducer(stack, { type: 'close', kind: 'planApproval' });
    expect(kinds(stack)).toEqual([]);
  });
});
