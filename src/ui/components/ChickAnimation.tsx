/**
 * ChickAnimation - Custom animated chick character
 *
 * Displays a cute chick that randomly moves between different states
 */

import React, { useState, useEffect } from 'react';
import { Text } from 'ink';
import { ANIMATION_TIMING } from '../../config/constants.js';

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

// Probability thresholds for animation state transitions
const CHICK_STATE_PROBABILITIES = {
  LOW: 0.6,   // 60% chance forward-facing
  HIGH: 0.8,  // 20% chance looking down (0.6 to 0.8)
  // Remaining 20% (0.8 to 1.0) is looking left
};

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
      if (rand < CHICK_STATE_PROBABILITIES.LOW) {
        newState = 0; // Forward-facing
      } else if (rand < CHICK_STATE_PROBABILITIES.HIGH) {
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
