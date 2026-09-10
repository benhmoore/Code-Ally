/**
 * StreamJsonInput - line-delimited JSON commands read from stdin.
 *
 * Two commands are accepted, matching the shape unattended callers already
 * send: a `user` message and a `control_request` asking for an interrupt.
 */

import readline from 'node:readline';

export type StreamJsonCommand =
  | { kind: 'user'; text: string }
  | { kind: 'interrupt'; requestId?: string };

export interface StreamJsonInputHandlers {
  /** A user message. The session decides between a new turn and an interjection. */
  onUser(text: string): void;
  onInterrupt(requestId?: string): void;
  /** A line that could not be parsed. Reported, never swallowed. */
  onError(error: Error): void;
  onClose(): void;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .filter((block): block is { type: string; text: string } =>
        typeof block === 'object' && block !== null
        && (block as { type?: unknown }).type === 'text'
        && typeof (block as { text?: unknown }).text === 'string')
      .map(block => block.text)
      .join('');
    if (text) return text;
  }
  throw new Error('User message content must be a string or a list of text blocks');
}

/** Parse one input line. Throws on anything the protocol does not define. */
export function parseStreamJsonLine(line: string): StreamJsonCommand {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Input line must be a JSON object');
  }

  const message = parsed as {
    type?: unknown;
    message?: { role?: unknown; content?: unknown };
    request?: { subtype?: unknown };
    request_id?: unknown;
  };

  if (message.type === 'user') {
    if (!message.message || message.message.role !== 'user') {
      throw new Error('A user line must carry message.role "user"');
    }
    return { kind: 'user', text: textFromContent(message.message.content) };
  }

  if (message.type === 'control_request') {
    if (message.request?.subtype !== 'interrupt') {
      throw new Error(`Unsupported control_request subtype '${String(message.request?.subtype)}'`);
    }
    return {
      kind: 'interrupt',
      requestId: typeof message.request_id === 'string' ? message.request_id : undefined,
    };
  }

  throw new Error(`Unsupported input type '${String(message.type)}'`);
}

export class StreamJsonInput {
  private reader?: readline.Interface;

  constructor(
    private readonly input: NodeJS.ReadableStream,
    private readonly handlers: StreamJsonInputHandlers
  ) {}

  start(): void {
    if (this.reader) return;
    this.reader = readline.createInterface({ input: this.input, crlfDelay: Infinity });

    this.reader.on('line', line => {
      if (!line.trim()) return;
      let command: StreamJsonCommand;
      try {
        command = parseStreamJsonLine(line);
      } catch (error) {
        this.handlers.onError(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (command.kind === 'user') this.handlers.onUser(command.text);
      else this.handlers.onInterrupt(command.requestId);
    });

    this.reader.on('close', () => this.handlers.onClose());
  }

  stop(): void {
    this.reader?.close();
    this.reader = undefined;
  }
}
