/**
 * useAnimation - Animation timing and state management
 *
 * This hook provides utilities for managing animation state, including
 * elapsed time tracking, frame updates, and animation lifecycle.
 */

import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Animation state and controls
 */
export interface AnimationState {
  /** Whether the animation is currently running */
  isRunning: boolean;

  /** Elapsed time in milliseconds */
  elapsedMs: number;

  /** Elapsed time in seconds */
  elapsedSeconds: number;

  /** Start the animation */
  start: () => void;

  /** Stop the animation */
  stop: () => void;

  /** Reset the animation */
  reset: () => void;
}

/**
 * Options for animation hook
 */
export interface UseAnimationOptions {
  /** Auto-start the animation on mount (default: false) */
  autoStart?: boolean;

  /** Update interval in milliseconds (default: 1000) */
  interval?: number;
}

/**
 * Hook for managing animation timing and state
 *
 * Provides utilities for tracking elapsed time and controlling animation lifecycle.
 * Useful for spinners, progress indicators, and elapsed time displays.
 *
 * @param options - Animation options
 * @returns Animation state and controls
 *
 * @example
 * ```tsx
 * // Basic elapsed time tracking
 * const animation = useAnimation({ autoStart: true });
 *
 * return (
 *   <Box>
 *     <Text>Elapsed: {animation.elapsedSeconds}s</Text>
 *   </Box>
 * );
 * ```
 *
 * @example
 * ```tsx
 * // Manual control
 * const animation = useAnimation();
 *
 * const handleStart = () => {
 *   animation.start();
 * };
 *
 * const handleStop = () => {
 *   animation.stop();
 * };
 *
 * return (
 *   <Box>
 *     <Text>Time: {animation.elapsedSeconds}s</Text>
 *     <Text>Status: {animation.isRunning ? 'Running' : 'Stopped'}</Text>
 *   </Box>
 * );
 * ```
 */
export const useAnimation = (
  options: UseAnimationOptions = {}
): AnimationState => {
  const { autoStart = false, interval = 1000 } = options;

  const [isRunning, setIsRunning] = useState(autoStart);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startTimeRef = useRef<number | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  // Start animation
  const start = useCallback(() => {
    if (!isRunning) {
      startTimeRef.current = Date.now() - elapsedMs;
      setIsRunning(true);
    }
  }, [isRunning, elapsedMs]);

  // Stop animation
  const stop = useCallback(() => {
    if (isRunning) {
      setIsRunning(false);
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }
  }, [isRunning]);

  // Reset animation
  const reset = useCallback(() => {
    setElapsedMs(0);
    startTimeRef.current = null;
    if (isRunning) {
      startTimeRef.current = Date.now();
    }
  }, [isRunning]);

  // Update elapsed time
  useEffect(() => {
    if (!isRunning) {
      return undefined;
    }

    // Set up interval to update elapsed time
    intervalRef.current = setInterval(() => {
      if (startTimeRef.current !== null) {
        const now = Date.now();
        setElapsedMs(now - startTimeRef.current);
      }
    }, interval);

    // Cleanup on stop or unmount
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isRunning, interval]);

  // Auto-start on mount if requested
  useEffect(() => {
    if (autoStart && !isRunning) {
      start();
    }
  }, [autoStart]); // Only run on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps

  return {
    isRunning,
    elapsedMs,
    elapsedSeconds: Math.floor(elapsedMs / 1000),
    start,
    stop,
    reset,
  };
};

/**
 * Frame-based animation hook for smoother animations
 *
 * Uses setInterval for consistent updates in Node environment.
 * Ink doesn't support requestAnimationFrame since it runs in Node.js.
 *
 * @param callback - Function to call on each frame
 * @param isActive - Whether the animation should be running
 * @param fps - Frames per second (default: 30)
 *
 * @example
 * ```tsx
 * const [rotation, setRotation] = useState(0);
 *
 * useFrameAnimation(() => {
 *   setRotation(prev => (prev + 1) % 360);
 * }, isSpinning, 60);
 * ```
 */
export const useFrameAnimation = (
  callback: (deltaTime: number) => void,
  isActive: boolean,
  fps: number = 30
): void => {
  const callbackRef = useRef(callback);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastTimeRef = useRef<number>(Date.now());

  // Update callback ref when it changes
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!isActive) {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    // Animation loop using setInterval
    const intervalMs = 1000 / fps;
    intervalRef.current = setInterval(() => {
      const now = Date.now();
      const deltaTime = now - lastTimeRef.current;
      lastTimeRef.current = now;

      callbackRef.current(deltaTime);
    }, intervalMs);

    // Initialize last time
    lastTimeRef.current = Date.now();

    // Cleanup
    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isActive, fps]);
};
