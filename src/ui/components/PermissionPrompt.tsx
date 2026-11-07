/** Inspect the complete proposed operation and its reason before answering. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { PermissionChoice, SensitivityTier } from '@agent/TrustManager.js';
import type { PermissionMode } from '../../security/PermissionMode.js';
import { SelectionIndicator } from './SelectionIndicator.js';
import { KeyboardHintFooter } from './KeyboardHintFooter.js';
import { UI_COLORS } from '../constants/colors.js';
import { UI_SYMBOLS } from '@config/uiSymbols.js';
import { TextInput } from './TextInput.js';
import { InteractiveSurface } from './InteractiveSurface.js';
import { Clickable } from './Clickable.js';
import { useContentWidth } from '../hooks/useContentWidth.js';
import { useTerminalRows } from '../hooks/useTerminalRows.js';
import { isInstructOption } from '../hooks/useModalActivation.js';
import { visiblePermissionText } from '../utils/permissionPresentation.js';
import { wrapAnsiText } from '@utils/terminalText.js';

export interface PermissionRequest {
  requestId?: string;
  toolName: string;
  path?: string;
  command?: string;
  arguments?: Record<string, unknown>;
  sensitivity: SensitivityTier;
  options: PermissionChoice[];
  decisionReason?: string;
}

export interface PermissionPromptProps {
  request: PermissionRequest;
  selectedIndex: number;
  visible?: boolean;
  permissionMode?: PermissionMode;
  requestedPermissionMode?: PermissionMode;
  instructText: string;
  onInstructTextChange: (text: string) => void;
  cursorPosition?: number;
  onCursorChange?: (position: number) => void;
  queueLength?: number;
  onOptionPress?: (index: number) => void;
}

function operationDetails(request: PermissionRequest): string {
  const args = request.arguments ?? {};
  const command = request.command ?? (typeof args.command === 'string' ? args.command : undefined);
  const details: string[] = [];
  if (command) details.push(`Run: ${visiblePermissionText(command)}`);
  if (typeof args.working_dir === 'string') details.push(`In: ${visiblePermissionText(args.working_dir)}`);
  if (request.path) details.push(`Target: ${visiblePermissionText(request.path)}`);
  for (const [key, value] of Object.entries(args)) {
    if ((key === 'command' && command) || (key === 'working_dir' && typeof value === 'string')) continue;
    if (key === 'file_path' && value === request.path) continue;
    const label = key.replace(/_/g, ' ').replace(/^./, character => character.toUpperCase());
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    details.push(`${visiblePermissionText(label)}: ${visiblePermissionText(text ?? String(value))}`);
  }
  return details.join('\n') || request.toolName;
}

export function PermissionPrompt({
  request,
  selectedIndex,
  visible = true,
  permissionMode = 'manual',
  requestedPermissionMode = permissionMode,
  instructText,
  onInstructTextChange,
  cursorPosition = 0,
  onCursorChange = () => {},
  queueLength,
  onOptionPress,
}: PermissionPromptProps) {
  const admission = useRef({ request, id: request.requestId, mode: requestedPermissionMode });
  if (request.requestId ? admission.current.id !== request.requestId : admission.current.request !== request) {
    admission.current = { request, id: request.requestId, mode: requestedPermissionMode };
  }
  const modeChanged = admission.current.mode !== requestedPermissionMode;
  const width = Math.max(1, useContentWidth() - 2);
  const rows = useTerminalRows();
  const lines = useMemo(
    () =>
      operationDetails(request)
        .split('\n')
        .flatMap(line => wrapAnsiText(line, width, { preserveWhitespace: true })),
    [request, width]
  );
  const [offset, setOffset] = useState(0);
  const previewRows = Math.max(1, Math.min(7, rows - request.options.length - 9));
  const maximum = Math.max(0, lines.length - previewRows);
  const start = Math.min(offset, maximum);
  useEffect(() => {
    setOffset(0);
  }, [request]);
  useInput((_input, key) => {
    if (!visible || key.eventType === 'release') return;
    if (key.pageUp) setOffset(current => Math.max(0, Math.min(current, maximum) - previewRows));
    if (key.pageDown) setOffset(current => Math.min(maximum, current + previewRows));
  });
  if (!visible) return null;
  const selected = Math.max(0, Math.min(request.options.length - 1, selectedIndex));
  return (
    <InteractiveSurface
      title={`Permission · ${request.toolName}`}
      tone={UI_COLORS.PRIMARY}
      meta={queueLength && queueLength > 1 ? `${queueLength} pending` : undefined}
      footer={<KeyboardHintFooter action="confirm" cancelText="deny" permissionMode={permissionMode} />}
    >
      <Text wrap="truncate-end">
        {visiblePermissionText(request.decisionReason || 'This operation needs your approval.').replace(/\s+/g, ' ')}
      </Text>
      {modeChanged && <Text dimColor>Approve or deny this request; the new mode applies next.</Text>}
      <Box flexDirection="column">
        <Text>{lines.slice(start, start + previewRows).join('\n')}</Text>
      </Box>
      {maximum > 0 && (
        <Text dimColor wrap="truncate-end">
          Details {start + 1}–{Math.min(lines.length, start + previewRows)}/{lines.length} · PgUp/PgDn inspect
        </Text>
      )}
      {request.options.map((option, index) => (
        <Clickable key={option} flexDirection="row" onPress={onOptionPress && (() => onOptionPress(index))}>
          {isInstructOption(option) && index === selected ? (
            <>
              <Text color={UI_COLORS.PRIMARY}>{UI_SYMBOLS.NAVIGATION.CHEVRON_RIGHT} </Text>
              <TextInput
                value={instructText}
                onValueChange={onInstructTextChange}
                cursorPosition={cursorPosition}
                onCursorChange={onCursorChange}
                onSubmit={() => {}}
                isActive
                bordered={false}
                maxVisibleRows={1}
                placeholder={option}
              />
            </>
          ) : (
            <SelectionIndicator isSelected={index === selected}>{option}</SelectionIndicator>
          )}
        </Clickable>
      ))}
    </InteractiveSurface>
  );
}
