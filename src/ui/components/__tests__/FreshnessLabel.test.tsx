/**
 * The status label's brightness is the only signal that distinguishes a turn
 * that is working from one that has quietly died, well before the watchdog
 * would notice. These pin the ramp and the breathing cycle.
 */

import { describe, expect, test } from 'vitest';
import { freshnessTone } from '../FreshnessLabel.js';

describe('freshnessTone', () => {
  test('stays fresh when freshness does not apply', () => {
    // null = no request in flight (between turns, or tools running, where long
    // silence is normal and must not fade the row).
    expect(freshnessTone(null, 0)).toBe('fresh');
    expect(freshnessTone(null, 500)).toBe('fresh');
  });

  test('stays fresh while output is arriving', () => {
    expect(freshnessTone(0, 0)).toBe('fresh');
    expect(freshnessTone(3_999, 0)).toBe('fresh');
  });

  test('dims as the silence grows', () => {
    expect(freshnessTone(4_000, 0)).toBe('slowing');
    expect(freshnessTone(14_999, 0)).toBe('slowing');
    expect(freshnessTone(15_000, 0)).toBe('stale-in');
  });

  test('breathes once the silence is long enough to doubt', () => {
    const tones = [0, 8, 16, 24].map(frame => freshnessTone(60_000, frame));
    expect(tones).toEqual(['stale-in', 'stale-out', 'stale-in', 'stale-out']);
  });

  test('never reads as fresh while nothing has come back', () => {
    // The waiting phase: no output produced, so full strength would overstate it.
    expect(freshnessTone(0, 0, true)).toBe('slowing');
    expect(freshnessTone(null, 0, true)).toBe('slowing');
    // Past the first threshold the ramp is unchanged.
    expect(freshnessTone(20_000, 0, true)).toBe('stale-in');
    expect(freshnessTone(60_000, 8, true)).toBe('stale-out');
  });

  test('holds a steady tone within one breath phase', () => {
    const phase = [0, 3, 7].map(frame => freshnessTone(60_000, frame));
    expect(new Set(phase).size).toBe(1);
  });
});
