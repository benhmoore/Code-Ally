/**
 * ChickAnimation - Custom animated chick character
 *
 * Displays a cute chick that randomly moves between different states
 */

import React, { useState, useEffect } from 'react';
import { Text } from 'ink';

interface ChickAnimationProps {
  /** Color of the chick */
  color?: string;
  /** Speed of animation (ms between state changes) */
  speed?: number;
}

const CHICK_STATES = [
  '( o)> ',  // Looking right (forward-facing)
  '(ovo) ',  // Looking down/eating
  '<(o ) ',  // Looking left
];

export const ChickAnimation: React.FC<ChickAnimationProps> = ({
  color = 'yellow',
  speed = 4000
}) => {
  const [currentState, setCurrentState] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      // Weighted random: 60% chance for forward-facing (state 0), 20% each for others
      const rand = Math.random();
      let newState;
      if (rand < 0.6) {
        newState = 0; // Forward-facing
      } else if (rand < 0.8) {
        newState = 1; // Looking down
      } else {
        newState = 2; // Looking left
      }
      setCurrentState(newState);
    }, speed);

    return () => clearInterval(interval);
  }, [speed]);

  return <Text color={color}>{CHICK_STATES[currentState]}</Text>;
};
