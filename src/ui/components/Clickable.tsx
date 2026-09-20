/**
 * Clickable - A Box that activates on a mouse click.
 *
 * Wrap a row or button in it and pass the same handler the keyboard would
 * run; without a handler it is an ordinary Box. Clicks only arrive while the
 * terminal reports them (see PointerProvider), so this never changes how a
 * surface behaves under keyboard control.
 */

import React, { useRef } from 'react';
import { Box, type DOMElement } from 'ink';
import { useClickable } from '../contexts/PointerContext.js';

export interface ClickableProps extends React.ComponentProps<typeof Box> {
  onPress?: () => void;
}

export const Clickable: React.FC<ClickableProps> = ({ onPress, children, ...boxProps }) => {
  const ref = useRef<DOMElement>(null);
  useClickable(ref, onPress);
  return (
    <Box ref={ref} {...boxProps}>
      {children}
    </Box>
  );
};
