import React, { useEffect } from 'react';
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityStream } from '@services/ActivityStream.js';
import { ActivityEventType, type ActivityEvent } from '@shared/index.js';
import { PermissionChoice } from '@agent/TrustManager.js';
import { isInstructOption, useModalActivation, type ModalActivation, type ModalActivationDeps } from '../useModalActivation.js';

class FakeStdout extends EventEmitter {
  columns = 100;
  rows = 30;
  isTTY = true;
  write = (): boolean => true;
}

const mounted: Array<{ unmount: () => void }> = [];

afterEach(() => {
  for (const instance of mounted.splice(0)) instance.unmount();
});

const emptyModal = (): ModalActivationDeps['modal'] => ({
  modelSelectRequest: undefined,
  sessionSelectRequest: undefined,
  messageSelectRequest: undefined,
  librarySelectRequest: undefined,
  rewindRequest: undefined,
  libraryClearConfirmRequest: undefined,
  undoFileListRequest: undefined,
  undoRequest: undefined,
  planApprovalRequest: undefined,
  planApprovalFeedbackText: '',
  permissionRequest: undefined,
  permissionInstructText: '',
});

/** Mount the hook and return its handlers plus the events it emits. */
async function mount(deps: Partial<ModalActivationDeps>) {
  const activityStream = new ActivityStream();
  const events: ActivityEvent[] = [];
  const types = [
    ActivityEventType.MODEL_SELECT_RESPONSE, ActivityEventType.SESSION_SELECT_RESPONSE,
    ActivityEventType.PROMPT_MESSAGE_SELECT_RESPONSE, ActivityEventType.LIBRARY_SELECT_RESPONSE,
    ActivityEventType.REWIND_RESPONSE, ActivityEventType.LIBRARY_CLEAR_CONFIRM_RESPONSE,
    ActivityEventType.UNDO_FILE_SELECTED, ActivityEventType.UNDO_CANCELLED, ActivityEventType.UNDO_CONFIRM,
    ActivityEventType.UNDO_FILE_BACK, ActivityEventType.PLAN_APPROVAL_RESPONSE, ActivityEventType.PERMISSION_RESPONSE,
  ];
  for (const type of types) activityStream.subscribe(type, (event) => { events.push(event); });

  let activation: ModalActivation | undefined;
  const Harness = () => {
    const value = useModalActivation({
      activityStream,
      modal: emptyModal(),
      onRewindSelect: vi.fn(),
      onPermissionInstruct: vi.fn(),
      ...deps,
    });
    useEffect(() => { activation = value; }, [value]);
    return null;
  };
  const instance = render(<Harness />, {
    stdout: new FakeStdout() as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  mounted.push(instance);
  await vi.waitFor(() => expect(activation).toBeDefined());
  return { activation: activation!, events };
}

describe('useModalActivation', () => {
  it('answers a model selection and cancels it once', async () => {
    const modal = { ...emptyModal(), modelSelectRequest: { requestId: 'm1', models: [{ name: 'a' }, { name: 'b' }], modelType: 'ally' as const } };
    const { activation, events } = await mount({ modal });

    activation.model.activate(1);
    expect(events.at(-1)).toMatchObject({ type: ActivityEventType.MODEL_SELECT_RESPONSE, data: { requestId: 'm1', modelName: 'b', modelType: 'ally' } });

    activation.model.cancel();
    activation.model.cancel();
    expect(events.filter((event) => event.id === 'response_m1_cancel')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ data: { requestId: 'm1', modelName: null } });
  });

  it('ignores an activation past the end of the options', async () => {
    const modal = { ...emptyModal(), sessionSelectRequest: { requestId: 's1', sessions: [{ session_id: 'one' }] as any, selectedIndex: 0 } };
    const { activation, events } = await mount({ modal });

    activation.session.activate(5);
    expect(events).toHaveLength(0);
    activation.session.activate(0);
    expect(events.at(-1)).toMatchObject({ data: { requestId: 's1', sessionId: 'one', cancelled: false } });
  });

  it('routes rewind Enter to the options step and cancels the request on Escape', async () => {
    const onRewindSelect = vi.fn();
    const modal = { ...emptyModal(), rewindRequest: { requestId: 'r1', targets: [], selectedIndex: 0 } as any };
    const { activation, events } = await mount({ modal, onRewindSelect });

    activation.rewind.activate(2);
    expect(onRewindSelect).toHaveBeenCalledWith(2);
    activation.rewind.cancel();
    expect(events.at(-1)).toMatchObject({ type: ActivityEventType.REWIND_RESPONSE, data: { requestId: 'r1', cancelled: true } });
  });

  it('treats undo option 1 and Escape as going back to the file list', async () => {
    const modal = { ...emptyModal(), undoRequest: { requestId: 'u1', count: 1, patches: [], previewData: [] } as any };
    const { activation, events } = await mount({ modal });

    activation.undo.activate(0);
    expect(events.at(-1)?.type).toBe(ActivityEventType.UNDO_CONFIRM);
    activation.undo.activate(1);
    expect(events.at(-1)?.type).toBe(ActivityEventType.UNDO_FILE_BACK);
  });

  it('submits plan feedback only when there is text', async () => {
    const request = { requestId: 'p1' } as any;
    const { activation, events } = await mount({ modal: { ...emptyModal(), planApprovalRequest: request, planApprovalFeedbackText: '  ' } });
    activation.planApproval.activate(2);
    expect(events).toHaveLength(0);

    const withText = await mount({ modal: { ...emptyModal(), planApprovalRequest: request, planApprovalFeedbackText: 'tighten scope' } });
    withText.activation.planApproval.activate(2);
    expect(withText.events.at(-1)).toMatchObject({ data: { choice: 'feedback', feedback: 'tighten scope' } });
    withText.activation.planApproval.activate(0);
    expect(withText.events.at(-1)).toMatchObject({ data: { choice: 'approve' } });
  });

  it('answers permissions, and turns an instruction into an interjection plus a denial', async () => {
    const onPermissionInstruct = vi.fn();
    const request = { requestId: 'perm1', toolName: 'bash', sensitivity: 'medium', options: [PermissionChoice.ALLOW, 'Tell Ally what to do instead...'] } as any;
    const { activation, events } = await mount({ modal: { ...emptyModal(), permissionRequest: request, permissionInstructText: '' }, onPermissionInstruct });

    activation.permission.activate(0);
    expect(events.at(-1)).toMatchObject({ type: ActivityEventType.PERMISSION_RESPONSE, data: { requestId: 'perm1', choice: PermissionChoice.ALLOW } });

    activation.permission.activate(1);
    expect(onPermissionInstruct).not.toHaveBeenCalled();

    const typed = await mount({ modal: { ...emptyModal(), permissionRequest: request, permissionInstructText: 'use rg' }, onPermissionInstruct });
    typed.activation.permission.activate(1);
    expect(onPermissionInstruct).toHaveBeenCalledWith('use rg');
    expect(typed.events.at(-1)).toMatchObject({ data: { requestId: 'perm1', choice: PermissionChoice.DENY } });
  });

  it('recognises instruct options', () => {
    expect(isInstructOption('Tell Ally what to do instead...')).toBe(true);
    expect(isInstructOption(PermissionChoice.ALLOW)).toBe(false);
  });
});
