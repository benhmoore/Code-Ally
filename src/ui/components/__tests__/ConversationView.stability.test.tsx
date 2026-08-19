import React from 'react';
import { EventEmitter } from 'events';
import { render } from 'ink';
import { afterEach, describe, expect, test } from 'vitest';
import type { Message, ToolCallState } from '@shared/index.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ActivityProvider } from '../../contexts/ActivityContext.js';
import { ConversationView } from '../ConversationView.js';
import { MessageDisplay } from '../MessageDisplay.js';

class FakeStdout extends EventEmitter {
  public readonly frames: string[] = [];
  public columns = 80;
  public rows = 8;
  public isTTY = true;

  write = (frame: string): boolean => {
    this.frames.push(frame);
    return true;
  };
}

const mounted: Array<{ unmount: () => void }> = [];
const waitForInk = () => new Promise(resolve => setTimeout(resolve, 80));

afterEach(() => {
  for (const instance of mounted.splice(0)) instance.unmount();
});

describe('ConversationView terminal stability', () => {
  test('streaming updates do not clear and repaint committed scrollback', async () => {
    const messages: Message[] = Array.from({ length: 20 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `completed line ${index}`,
      timestamp: index + 1,
    }));
    const stdout = new FakeStdout();
    const baseProps = {
      messages,
      activeToolCalls: [],
      compactionNotices: [],
      rewindNotices: [],
      statusMessages: [],
      staticRemountKey: 0,
      config: { show_thinking_in_chat: false },
    };
    const instance = render(<ConversationView {...baseProps} />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: false,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    mounted.push(instance);
    await waitForInk();

    const frameCount = stdout.frames.length;
    instance.rerender(<ConversationView {...baseProps} streamingContent="working" />);
    await waitForInk();

    const updateOutput = stdout.frames.slice(frameCount).join('');
    expect(updateOutput).not.toContain('\x1B[2J\x1B[3J\x1B[H');
    expect(updateOutput).not.toContain('completed line 0');
  });

  test('completed tool output retains the conversation width inside Static', async () => {
    const stdout = new FakeStdout();
    stdout.columns = 120;
    stdout.rows = 24;
    const toolCall: ToolCallState = {
      id: 'wide-output',
      status: 'success',
      toolName: 'bash',
      arguments: { command: 'inspect' },
      output: 'abcdefghijklmnopqrstuvwxyz 0123456789 this output should remain on one physical line',
      startTime: 1,
      endTime: 2,
    };
    const instance = render(
      <ActivityProvider activityStream={new ActivityStream()}>
        <ConversationView
          messages={[]}
          activeToolCalls={[toolCall]}
          compactionNotices={[]}
          rewindNotices={[]}
          statusMessages={[]}
          staticRemountKey={0}
          config={{ show_thinking_in_chat: false }}
        />
      </ActivityProvider>,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    mounted.push(instance);
    await waitForInk();

    const output = stdout.frames.join('');
    expect(output).toContain('abcdefghijklmnopqrstuvwxyz 0123456789 this output should remain on one physical line');
  });
});

describe('MessageDisplay thinking visibility', () => {
  const message: Message = {
    id: 'thinking-message',
    role: 'assistant',
    content: 'Final answer',
    thinking: 'private reasoning content',
    thinkingStartTime: 1,
    thinkingEndTime: 1001,
  };

  test('shows only a collapsed thinking indicator when the setting is false', () => {
    const stdout = new FakeStdout();
    const instance = render(
      <MessageDisplay message={message} config={{ show_thinking_in_chat: false }} />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    mounted.push(instance);
    const output = stdout.frames.join('');
    expect(output).toContain('Final answer');
    expect(output).not.toContain('private reasoning content');
    expect(output).toContain('∴ Thought for 1s');
  });

  test('shows thinking when explicitly enabled', () => {
    const stdout = new FakeStdout();
    const instance = render(
      <MessageDisplay message={message} config={{ show_thinking_in_chat: true }} />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    mounted.push(instance);
    expect(stdout.frames.join('')).toContain('private reasoning content');
  });
});
