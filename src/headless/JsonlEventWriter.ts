/**
 * JsonlEventWriter - one JSON object per line on the headless output stream.
 */

import type { ActivityStream } from '../services/ActivityStream.js';
import type { OutputFormat } from '../cli/ArgumentParser.js';
import { mapActivityEvent, type WireEvent } from './wire.js';

export interface JsonlEventWriterOptions {
  /** Where lines are written. Defaults to process.stdout. */
  stream?: NodeJS.WritableStream;
  /**
   * `stream-json` writes every wire event; `json` writes the final result only.
   * `text` never reaches this writer.
   */
  format: OutputFormat;
}

export class JsonlEventWriter {
  private readonly stream: NodeJS.WritableStream;
  private readonly format: OutputFormat;
  private unsubscribe?: () => void;

  constructor(options: JsonlEventWriterOptions) {
    this.stream = options.stream ?? process.stdout;
    this.format = options.format;
  }

  /** Write one wire event. In `json` mode only the terminal result is written. */
  write(event: WireEvent): void {
    if (this.format === 'json' && event.type !== 'result') return;
    this.stream.write(`${JSON.stringify(event)}\n`);
  }

  /** Mirror the activity stream onto the wire for the life of the session. */
  attach(activityStream: ActivityStream, sessionId: string): void {
    this.detach();
    this.unsubscribe = activityStream.subscribe('*', event => {
      const wireEvent = mapActivityEvent(event, sessionId);
      if (wireEvent) this.write(wireEvent);
    });
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
