/**
 * KeyboardHintFooter Component
 *
 * Standardizes keyboard navigation hints across all modal components.
 *
 * Purpose:
 * - Provides consistent footer layout with keyboard shortcuts
 * - Shows navigation hints (↑↓), action hint (Enter), and cancel hint (Esc/Ctrl+C)
 * - Keeps shortcut grammar and spacing consistent
 *
 * Usage:
 * ```tsx
 * <KeyboardHintFooter action="select" />
 * <KeyboardHintFooter action="continue" cancelText="skip" />
 * ```
 */

import type { PermissionMode } from '../../security/PermissionMode.js';
import { permissionModeLabel } from '../utils/permissionPresentation.js';
import React from 'react';
import { Box, Text } from 'ink';
import { UI_SYMBOLS } from '@config/uiSymbols.js';

export interface KeyboardHintFooterProps {
  /** Action verb to display after "Enter" (e.g., "select", "continue", "confirm") */
  action?: string;
  /** Cancel action text (default: "cancel") */
  cancelText?: string;
  /** Effective permission mode (for permission prompts) */
  permissionMode?: PermissionMode;
  /** Fully custom hints. Prefer this for non-standard workflows. */
  hints?: Array<{ key: string; label: string }>;
}

/**
 * KeyboardHintFooter Component
 *
 * Displays standardized keyboard navigation hints at the bottom of modal dialogs.
 * Format: "↑↓ move · enter {action} · esc {cancelText}"
 */
const KeyboardHintFooterComponent: React.FC<KeyboardHintFooterProps> = ({
  action = 'confirm',
  cancelText = 'cancel',
  permissionMode,
  hints,
}) => {
  const resolvedHints = hints ?? [
    { key: `${UI_SYMBOLS.NAVIGATION.ARROW_UP}${UI_SYMBOLS.NAVIGATION.ARROW_DOWN}`, label: 'move' },
    { key: 'enter', label: action },
    { key: 'esc', label: cancelText },
  ];

  return (
    <Box marginTop={1}>
      <Text dimColor>
        {resolvedHints.map((hint, index) => (
          <React.Fragment key={`${hint.key}-${hint.label}`}>
            {index > 0 && ` ${UI_SYMBOLS.SEPARATOR.MIDDLE_DOT} `}
            {hint.key}
            {hint.label ? ` ${hint.label}` : ''}
          </React.Fragment>
        ))}
        {permissionMode !== undefined
          ? ` ${UI_SYMBOLS.SEPARATOR.MIDDLE_DOT} shift+tab ${permissionModeLabel(permissionMode)}`
          : ''}
      </Text>
    </Box>
  );
};

/**
 * Memoized KeyboardHintFooter
 *
 * Prevents unnecessary re-renders when props haven't changed.
 * Footer content is typically static, making memoization highly effective.
 */
export const KeyboardHintFooter = React.memo(KeyboardHintFooterComponent);
