/** Static brand mark. Motion is reserved for work that is actually in progress. */
import React from 'react';
import { Text } from 'ink';

interface ChickAnimationProps {
  color?: string;
  /** Retained for source compatibility with older call sites. */
  speed?: number;
}

export const ChickAnimation: React.FC<ChickAnimationProps> = ({
  color = 'yellow',
  speed: _speed,
}) => <Text color={color}>( o)&gt; </Text>;
