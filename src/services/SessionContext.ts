/**
 * SessionContext - text contributed to the system prompt by the host
 * environment rather than the user or the model.
 *
 * SessionStart hooks are the first writer. Entries are rendered as one block
 * by the prompt builder, in the order they were added, and survive
 * compaction because they live outside the message history.
 */
export class SessionContext {
  private readonly entries: string[] = [];

  add(text: string): void {
    const trimmed = text.trim();
    if (trimmed) this.entries.push(trimmed);
  }

  isEmpty(): boolean {
    return this.entries.length === 0;
  }

  /** The entries joined for the prompt, or an empty string when nothing was added. */
  render(): string {
    return this.entries.join('\n\n');
  }
}
