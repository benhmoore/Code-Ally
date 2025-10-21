/**
 * AnimationTicker - Single global heartbeat for all UI updates
 *
 * Fundamental Architecture:
 * - ONE interval for the entire application (no component-level timers)
 * - Provides both animation frames AND current timestamp
 * - Components pull time from this singleton instead of Date.now()
 * - Prevents render thrashing by coordinating all updates to one tick
 *
 * Performance Benefits:
 * - N spinners + M timers = 1 render per tick (not N+M renders)
 * - Completed content never subscribes (zero re-renders)
 * - Predictable, coordinated update rhythm
 */

type TickCallback = () => void;

export class AnimationTicker {
  private static instance: AnimationTicker | null = null;
  private subscribers: Set<TickCallback> = new Set();
  private frame: number = 0;
  private currentTime: number = Date.now();
  private interval: NodeJS.Timeout | null = null;
  private readonly frameRate: number = 83; // ~12 fps (1000/12 ≈ 83ms) - matches Ink render FPS

  private constructor() {}

  static getInstance(): AnimationTicker {
    if (!AnimationTicker.instance) {
      AnimationTicker.instance = new AnimationTicker();
    }
    return AnimationTicker.instance;
  }

  /**
   * Subscribe to animation ticks
   * Returns unsubscribe function
   */
  subscribe(callback: TickCallback): () => void {
    this.subscribers.add(callback);

    // Start interval if this is the first subscriber
    if (this.subscribers.size === 1 && !this.interval) {
      this.start();
    }

    // Return unsubscribe function
    return () => {
      this.subscribers.delete(callback);

      // Stop interval if no more subscribers
      if (this.subscribers.size === 0 && this.interval) {
        this.stop();
      }
    };
  }

  /**
   * Get current frame number (for calculating spinner position)
   * Advances at ~12 fps for smooth animations synchronized with Ink rendering
   */
  getFrame(): number {
    // Frame advances on each tick (12 fps)
    return this.frame;
  }

  /**
   * Get current time from global ticker
   * USE THIS instead of Date.now() to prevent unnecessary re-renders
   */
  getCurrentTime(): number {
    return this.currentTime;
  }

  private start(): void {
    this.interval = setInterval(() => {
      this.currentTime = Date.now();
      this.frame++;
      // Notify all subscribers in sync - ONE coordinated update
      this.subscribers.forEach(callback => callback());
    }, this.frameRate);
  }

  private stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Reset for testing
   */
  static reset(): void {
    if (AnimationTicker.instance?.interval) {
      AnimationTicker.instance.stop();
    }
    AnimationTicker.instance = null;
  }
}
