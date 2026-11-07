import { useTerminalDimensions } from '../contexts/TerminalContext.js';

/** Return the shared terminal rows measurement. */
export function useTerminalRows(): number {
  return useTerminalDimensions().rows;
}
