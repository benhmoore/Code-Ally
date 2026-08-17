/**
 * FreshnessLabel - status text whose brightness tracks how recently the model
 * produced output.
 *
 * A turn that has quietly died looks exactly like a turn that is working, until
 * the watchdog eventually gives up minutes later. Tying the label's brightness
 * to time-since-last-output makes that visible immediately: text stays solid
 * while output flows, dims as the silence grows, and breathes once the silence
 * is long enough to be worth doubting.
 *
 * Silence is read from a getter on the shared animation tick rather than passed
 * as a prop, so per-chunk updates never re-render the surrounding row.
 */

import React, { useEffect, useState } from 'react';
import { Text } from 'ink';
import { AnimationTicker } from '@services/AnimationTicker.js';
import { UI_COLORS } from '../constants/colors.js';

/** Output within this window reads as live; the label stays at full strength. */
const FRESH_MS = 4_000;
/** Past this, the silence is long enough to show as a dimmed label. */
const SLOWING_MS = 15_000;
/** Past this, the label breathes - something may well be wrong. */
const STALE_MS = 45_000;
/** Ticks per breath phase at the shared 5fps cadence (~1.6s in, ~1.6s out). */
const BREATH_FRAMES = 8;

export type FreshnessTone = 'fresh' | 'slowing' | 'stale-in' | 'stale-out';

/** Exported for tests: the tone this silence and animation frame produce. */
export function freshnessTone(silenceMs: number | null, frame: number): FreshnessTone {
  if (silenceMs === null || silenceMs < FRESH_MS) return 'fresh';
  if (silenceMs < SLOWING_MS) return 'slowing';
  if (silenceMs < STALE_MS) return 'stale-in';
  return Math.floor(frame / BREATH_FRAMES) % 2 === 0 ? 'stale-in' : 'stale-out';
}

export interface FreshnessLabelProps {
  /** The status text itself. */
  text: string;
  /** Milliseconds since the last model output, or null when not applicable. */
  getSilenceMs: () => number | null;
  /** Overrides the ramp entirely (e.g. the error color while cancelling). */
  color?: string;
}

export const FreshnessLabel: React.FC<FreshnessLabelProps> = ({ text, getSilenceMs, color }) => {
  const ticker = AnimationTicker.getInstance();
  const [tone, setTone] = useState<FreshnessTone>('fresh');

  useEffect(() => {
    const sample = () => {
      const next = freshnessTone(getSilenceMs(), ticker.getFrame());
      // Only a tone change re-renders; the tick itself is not a render trigger.
      setTone(prev => (prev === next ? prev : next));
    };
    sample();
    return ticker.subscribe(sample);
  }, [ticker, getSilenceMs]);

  if (color) {
    return <Text color={color}> {text}</Text>;
  }

  // Named colors plus dimColor rather than a hex ramp: this has to degrade
  // sanely on 16-color terminals, where a grey ramp collapses into one shade.
  // Three levels, and the breath swings between the lower two.
  if (tone === 'fresh') return <Text> {text}</Text>;
  return <Text color={UI_COLORS.TEXT_DIM} dimColor={tone === 'stale-out'}> {text}</Text>;
};
