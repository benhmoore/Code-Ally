import { useStdout } from 'ink';
import { TEXT_LIMITS } from '@config/constants.js';
import { useTerminalContext } from '../contexts/TerminalContext.js';

/**
 * Return the current terminal height from the shared terminal measurement.
 * Components must derive vertical budgets from this hook rather than reading
 * process.stdout independently or reserving fixed heights.
 */
export function useTerminalRows(): number {
  const { stdout } = useStdout();
  try {
    return useTerminalContext().rows;
  } catch {
    return stdout?.rows || TEXT_LIMITS.TERMINAL_HEIGHT_FALLBACK;
  }
}
