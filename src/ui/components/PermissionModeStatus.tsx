/** Compact permission mode and active review status, independent of the editor. */
import React from 'react';
import { Box, Text } from 'ink';
import type { PermissionMode } from '../../security/PermissionMode.js';
import { usePermissionSnapshot } from '../hooks/usePermissionPolicy.js';
import { permissionModeLabel } from '../utils/permissionPresentation.js';
import { Clickable } from './Clickable.js';
import { UI_COLORS } from '../constants/colors.js';

export function PermissionModeStatus({
  requestedMode,
  onCycle,
}: {
  requestedMode: PermissionMode;
  onCycle: () => void;
}) {
  const snapshot = usePermissionSnapshot(requestedMode);
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Clickable onPress={onCycle}>
        <Text wrap="truncate-end" color={snapshot.effectiveMode === 'allow-all' ? UI_COLORS.ERROR : undefined}>
          {permissionModeLabel(snapshot.requestedMode)}
          {snapshot.requestedMode !== snapshot.effectiveMode && ` → ${permissionModeLabel(snapshot.effectiveMode)}`}
          <Text dimColor> · shift+tab</Text>
        </Text>
      </Clickable>
      {snapshot.fallbackReason && (
        <Text dimColor wrap="truncate-end">
          {snapshot.fallbackReason}
        </Text>
      )}
      {snapshot.reviewing && <Text dimColor>Reviewing operation…</Text>}
    </Box>
  );
}
