/**
 * AnimationTicker - Global synchronized animation frame provider
 *
 * Prevents render thrashing by synchronizing all spinner animations
 * to a single interval. All spinners update on the same tick, ensuring
 * only one render per frame instead of N renders for N spinners.
 */

type TickCallback = () => void;

export class AnimationTicker {
  private static instance: AnimationTicker | null = null;
  private subscribers: Set<TickCallback> = new Set();
  private frame: number = 0;
  private interval: NodeJS.Timeout | null = null;
  private readonly frameRate: number = 80; // 80ms per frame (12.5 fps)

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
   */
  getFrame(): number {
    return this.frame;
  }

  private start(): void {
    this.interval = setInterval(() => {
      this.frame++;
      // Notify all subscribers in sync
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
