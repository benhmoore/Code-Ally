import { useEffect, useRef } from 'react';
import { useApp, useInput } from 'ink';
import { UI_DELAYS } from '@config/constants.js';

/** Shared emergency exit gesture for the currently mounted interaction surface. */
export function useForceQuit(isActive = true): void {
  const { exit } = useApp();
  const count = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useInput((input, key) => {
    if (key.eventType === 'release' || !key.ctrl || input !== 'c') return;
    count.current++;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { count.current = 0; }, UI_DELAYS.CTRL_C_RESET);
    if (count.current >= 3) exit();
  }, { isActive });
}
