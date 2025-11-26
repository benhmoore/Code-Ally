/**
 * ChickAnimation - Custom animated chick character
 *
 * Displays a cute chick that randomly moves between different states
 */

import React, { useState, useEffect } from 'react';
import { Text } from 'ink';
import { ANIMATION_TIMING } from '@config/constants.js';

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
  '(^v^) ',  // Happy/smiling with both eyes closed
  '( ^)> ',  // Winking/smiling right
  '<( ^) ',  // Winking/smiling left
  '(°o°) ',  // Surprised/wide-eyed
  '(-v-) ',  // Sleepy/tired/resting
  '(òvó) ',  // Confident/proud
  '(~v~) ',  // Content/relaxed
];

// Probability thresholds for animation state transitions
const CHICK_STATE_PROBABILITIES = {
  FORWARD: 0.40,      // 40% chance forward-facing
  EATING: 0.52,       // 12% chance looking down/eating
  LEFT: 0.62,         // 10% chance looking left
  HAPPY: 0.74,        // 12% chance happy/smiling
  WINK_RIGHT: 0.82,   // 8% chance winking right
  WINK_LEFT: 0.88,    // 6% chance winking left
  SURPRISED: 0.91,    // 3% chance surprised
  SLEEPY: 0.94,       // 3% chance sleepy
  CONFIDENT: 0.97,    // 3% chance confident
  // Remaining 3% (0.97 to 1.0) is content/relaxed
};

export const ChickAnimation: React.FC<ChickAnimationProps> = ({
  color = 'yellow',
  speed = ANIMATION_TIMING.CHICK_ANIMATION_SPEED
}) => {
  const [currentState, setCurrentState] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      // Weighted random: forward-facing is most common, rare expressions add surprise
      const rand = Math.random();
      let newState;
      if (rand < CHICK_STATE_PROBABILITIES.FORWARD) {
        newState = 0; // Forward-facing
      } else if (rand < CHICK_STATE_PROBABILITIES.EATING) {
        newState = 1; // Looking down/eating
      } else if (rand < CHICK_STATE_PROBABILITIES.LEFT) {
        newState = 2; // Looking left
      } else if (rand < CHICK_STATE_PROBABILITIES.HAPPY) {
        newState = 3; // Happy/smiling
      } else if (rand < CHICK_STATE_PROBABILITIES.WINK_RIGHT) {
        newState = 4; // Winking right
      } else if (rand < CHICK_STATE_PROBABILITIES.WINK_LEFT) {
        newState = 5; // Winking left
      } else if (rand < CHICK_STATE_PROBABILITIES.SURPRISED) {
        newState = 6; // Surprised
      } else if (rand < CHICK_STATE_PROBABILITIES.SLEEPY) {
        newState = 7; // Sleepy
      } else if (rand < CHICK_STATE_PROBABILITIES.CONFIDENT) {
        newState = 8; // Confident
      } else {
        newState = 9; // Content/relaxed
      }
      setCurrentState(newState);
    }, speed);

    return () => clearInterval(interval);
  }, [speed]);

  return <Text color={color}>{CHICK_STATES[currentState]}</Text>;
};
