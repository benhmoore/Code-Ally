/**
 * ErrorBoundary Component
 *
 * Catches rendering errors in child components to prevent the entire
 * terminal session from crashing. Displays a fallback UI for the
 * failed subtree while keeping the rest of the app functional.
 *
 * Two usage patterns:
 * 1. Outer boundary (in App.tsx) — catches catastrophic errors
 * 2. Inner boundary (per message/tool) — isolates individual render failures
 */

import React from 'react';
import { Box, Text } from 'ink';
import { UI_COLORS } from '../constants/colors.js';
import { logger } from '@services/Logger.js';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** When this key changes, the error state resets and children re-render */
  resetKey?: string | number;
  /** Optional label for identifying which boundary caught the error */
  label?: string;
  /** Custom fallback renderer. If omitted, a default inline error message is shown. */
  fallback?: (error: Error) => React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    const label = this.props.label ?? 'unknown';
    logger.error(`[ErrorBoundary:${label}] Render error caught:`, error.message);
    logger.debug(`[ErrorBoundary:${label}] Component stack:`, errorInfo.componentStack ?? '');
  }

  override componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    // Reset error state when resetKey changes, allowing children to try rendering again
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  override render(): React.ReactNode {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error);
      }

      return (
        <Box paddingLeft={2}>
          <Text color={UI_COLORS.ERROR} dimColor>
            [Render error{this.props.label ? ` in ${this.props.label}` : ''}: {this.state.error.message}]
          </Text>
        </Box>
      );
    }

    return this.props.children;
  }
}
