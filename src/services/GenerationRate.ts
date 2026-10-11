/** A bounded estimate from streamed text; request latency and tool time are excluded. */
export class GenerationRate {
  private startedAt?: number;
  private characters = 0;
  private active = false;
  private publishedAt = 0;
  private rate?: number;

  start(): void {
    this.startedAt = undefined;
    this.characters = 0;
    this.publishedAt = 0;
    this.rate = undefined;
    this.active = true;
  }

  add(chunk: string, timestamp: number): number | undefined {
    if (!this.active || !chunk || !Number.isFinite(timestamp)) return this.rate;
    if (this.startedAt === undefined) {
      // The first chunk establishes arrival time; counting its contents would
      // attribute time spent waiting for output to generation after that instant.
      this.startedAt = timestamp;
      return undefined;
    }
    if (timestamp < this.startedAt) return this.rate;
    this.characters += Array.from(chunk).length;
    const elapsed = timestamp - this.startedAt;
    if (elapsed >= 500 && timestamp - this.publishedAt >= 1000) {
      this.rate = this.characters / 4 / (elapsed / 1000);
      this.publishedAt = timestamp;
    }
    return this.rate;
  }

  stop(): void { this.active = false; }
  clear(): void { this.start(); this.stop(); }
}
