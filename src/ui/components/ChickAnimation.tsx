/**
 * ChickAnimation - Custom animated chick character
 *
 * Displays a cute chick that randomly moves between different states
 */

import React, { useState, useEffect } from 'react';
import { Text } from 'ink';
import { ANIMATION_TIMING, ANIMATION_PROBABILITIES } from '../../config/constants.js';

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
  speed = ANIMATION_TIMING.CHICK_ANIMATION_SPEED
}) => {
  const [currentState, setCurrentState] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      // Weighted random: forward-facing is most common, others less so
      const rand = Math.random();
      let newState;
      if (rand < ANIMATION_PROBABILITIES.CHICK_STATE_LOW) {
        newState = 0; // Forward-facing
      } else if (rand < ANIMATION_PROBABILITIES.CHICK_STATE_HIGH) {
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
