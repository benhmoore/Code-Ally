/**
 * Time utilities unit tests
 */

import { describe, it, expect } from 'vitest';
import { formatDuration, formatElapsed, formatRelativeTime } from '../timeUtils.js';

describe('timeUtils', () => {
  describe('formatDuration', () => {
    it('should format milliseconds', () => {
      expect(formatDuration(500)).toBe('500ms');
      expect(formatDuration(999)).toBe('999ms');
    });

    it('should format seconds', () => {
      expect(formatDuration(1000)).toBe('1s');
      expect(formatDuration(5000)).toBe('5s');
    });

    it('should format minutes and seconds', () => {
      expect(formatDuration(60000)).toBe('1m 0s');
      expect(formatDuration(83000)).toBe('1m 23s');
    });
  });

  describe('formatElapsed', () => {
    it('should format seconds', () => {
      expect(formatElapsed(5)).toBe('5s');
      expect(formatElapsed(59)).toBe('59s');
    });

    it('should format minutes and seconds', () => {
      expect(formatElapsed(60)).toBe('1m 0s');
      expect(formatElapsed(83)).toBe('1m 23s');
      expect(formatElapsed(125)).toBe('2m 5s');
    });

    it('should format hours, minutes, and seconds', () => {
      expect(formatElapsed(3600)).toBe('1h 0m 0s');
      expect(formatElapsed(3661)).toBe('1h 1m 1s');
      expect(formatElapsed(3757)).toBe('1h 2m 37s');
      expect(formatElapsed(7200)).toBe('2h 0m 0s');
      expect(formatElapsed(7323)).toBe('2h 2m 3s');
    });
  });

  describe('formatRelativeTime', () => {
    it('should handle "just now" for recent timestamps', () => {
      const now = new Date();
      expect(formatRelativeTime(now)).toBe('just now');

      const thirtySecondsAgo = new Date(now.getTime() - 30 * 1000);
      expect(formatRelativeTime(thirtySecondsAgo)).toBe('just now');
    });

    it('should format minutes ago', () => {
      const now = new Date();
      const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
      expect(formatRelativeTime(fiveMinutesAgo)).toBe('5m ago');

      const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000);
      expect(formatRelativeTime(thirtyMinutesAgo)).toBe('30m ago');
    });

    it('should format hours ago', () => {
      const now = new Date();
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
      expect(formatRelativeTime(twoHoursAgo)).toBe('2h ago');

      const twelveHoursAgo = new Date(now.getTime() - 12 * 60 * 60 * 1000);
      expect(formatRelativeTime(twelveHoursAgo)).toBe('12h ago');
    });

    it('should format days ago', () => {
      const now = new Date();
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
      expect(formatRelativeTime(threeDaysAgo)).toBe('3d ago');

      const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
      expect(formatRelativeTime(tenDaysAgo)).toBe('10d ago');
    });

    it('should format months ago', () => {
      const now = new Date();
      const twoMonthsAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
      expect(formatRelativeTime(twoMonthsAgo)).toBe('2mo ago');

      const sixMonthsAgo = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
      expect(formatRelativeTime(sixMonthsAgo)).toBe('6mo ago');
    });

    it('should format years ago', () => {
      const now = new Date();
      const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
      expect(formatRelativeTime(oneYearAgo)).toBe('1y ago');

      const twoYearsAgo = new Date(now.getTime() - 730 * 24 * 60 * 60 * 1000);
      expect(formatRelativeTime(twoYearsAgo)).toBe('2y ago');
    });

    it('should accept Date object', () => {
      const now = new Date();
      const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
      expect(formatRelativeTime(fiveMinutesAgo)).toBe('5m ago');
    });

    it('should accept ISO string', () => {
      const now = new Date();
      const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
      expect(formatRelativeTime(fiveMinutesAgo.toISOString())).toBe('5m ago');
    });

    it('should accept Unix timestamp in milliseconds', () => {
      const now = Date.now();
      const fiveMinutesAgo = now - 5 * 60 * 1000;
      expect(formatRelativeTime(fiveMinutesAgo)).toBe('5m ago');
    });
  });
});
