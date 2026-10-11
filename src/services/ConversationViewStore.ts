import { ThinkingClock } from './ThinkingClock.js';
import { ActivityEventType, type ActivityEvent, type Message, type ToolCallState } from '../types/index.js';
import type { ActivityStream } from './ActivityStream.js';
import { boundVisibleMessages, boundToolCalls } from './conversationBounds.js';
import { resolveDisplayContent } from '../utils/toolResultContent.js';
import { generateMessageId } from '../utils/id.js';

export interface ConversationViewSnapshot {
  messages: Message[];
  activeToolCalls: ToolCallState[];
  streamingContent?: string;
  isThinking: boolean;
  isCompacting: boolean;
  contextUsage: number;
  statusMessages: Array<{ id: string; timestamp: number; message: string }>;
  compactionNotices: Array<{ id: string; timestamp: number; oldContextUsage: number; threshold: number; parentId?: string }>;

}

/** A conversation's live projection survives UI subscriptions and foreground changes. */
export class ConversationViewStore {
  private snapshot: ConversationViewSnapshot = {
    messages: [], activeToolCalls: [], isThinking: false, isCompacting: false, contextUsage: 0, statusMessages: [], compactionNotices: [],
  };
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private displayMessages: Message[] = [];
  private notificationTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private readonly thinkingClock = new ThinkingClock();

  constructor(
    private readonly stream: ActivityStream,
    private readonly readMessages: () => readonly Message[],
    private readonly reconstruct: (messages: Message[]) => ToolCallState[],
    private readonly ownerId?: string,
  ) {
    this.unsubscribe = stream.subscribe('*', event => this.onEvent(event));
    this.refresh();
  }

  getSnapshot = (): ConversationViewSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(update: Partial<ConversationViewSnapshot>, streamed = false): void {
    this.snapshot = { ...this.snapshot, ...update };
    if (streamed) {
      this.notificationTimer ??= setTimeout(() => {
        this.notificationTimer = undefined;
        this.notify();
      }, 50);
    } else {
      if (this.notificationTimer) clearTimeout(this.notificationTimer);
      this.notificationTimer = undefined;
      this.notify();
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  addDisplayMessage = (message: Message): void => {
    const next = { ...message, id: message.id || generateMessageId(), timestamp: message.timestamp ?? Date.now() };
    if (this.displayMessages.some(item => item.id === next.id)) return;
    this.displayMessages = boundVisibleMessages([...this.displayMessages, next]);
    this.refresh();
  };

  /** Replace views only when history changes; compaction retains the visible transcript. */
  refresh = (replace = false): void => {
    if (this.closed) return;
    if (replace) this.displayMessages = [];
    const transcript = [...this.readMessages()];
    const recordedIds = new Set(transcript.filter(m => m.role === 'tool').map(m => m.tool_call_id));
    const calls = new Map((replace ? [] : this.snapshot.activeToolCalls).map(call => [call.id, call]));
    for (const entry of this.reconstruct(transcript)) {
      const recorded = entry.parentId === this.stream.getParentId() ? { ...entry, parentId: undefined } : entry;
      const live = calls.get(recorded.id);
      // Results prove terminal state. Preserve live-only display flags and diffs.
      calls.set(recorded.id, recordedIds.has(recorded.id)
        ? { ...live, ...recorded }
        : live ?? recorded);
    }
    const ids = new Set(transcript.map(message => message.id).filter(Boolean));
    const messages = [...transcript, ...this.displayMessages.filter(message => !ids.has(message.id))]
      .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    this.publish({ messages: boundVisibleMessages(messages.map(message =>
      message.role === 'assistant' && message.content && this.displayMessages.some(display => display.thinking === message.thinking && display.thinking)
        ? { ...message, thinking: undefined } : message)), activeToolCalls: boundToolCalls([...calls.values()]),
      ...(replace ? { streamingContent: undefined, isCompacting: false, statusMessages: [], compactionNotices: [] } : {}) });
  };

  private updateTool(id: string, update: Partial<ToolCallState>, streamed = false): void {
    this.publish({ activeToolCalls: boundToolCalls(this.snapshot.activeToolCalls.map(call =>
      call.id === id ? { ...call, ...update } : call)) }, streamed);
  }

  private onEvent(event: ActivityEvent): void {
    const data = event.data;
    const own = !event.parentId || event.parentId === this.stream.getParentId();
    const ownLifecycle = this.ownerId ? data.instanceId === this.ownerId
      : own && (!data.isSpecializedAgent || !!this.stream.getParentId());
    switch (event.type) {
      case ActivityEventType.CONVERSATION_MESSAGE_ADDED:
        this.refresh();
        break;
      case ActivityEventType.CONVERSATION_DISPLAY_MESSAGE:
        if (data.message) this.addDisplayMessage(data.message);
        break;
      case ActivityEventType.CONVERSATION_CLEAR:
        this.displayMessages = [];
        this.publish({ messages: [], activeToolCalls: [], streamingContent: undefined, isThinking: false, isCompacting: false, statusMessages: [], compactionNotices: [], contextUsage: 0 });
        break;
      case ActivityEventType.THOUGHT_CHUNK: {
        const key = event.parentId || 'root';
        if (data.thinking === true) this.thinkingClock.markRequestSent(key, event.timestamp);
        else if (data.chunk) this.thinkingClock.markReasoningToken(key, event.timestamp);
        break;
      }
      case ActivityEventType.THOUGHT_COMPLETE: {
        const key = event.parentId || 'root';
        const timing = { thinking: data.thinking, thinkingStartTime: this.thinkingClock.resolveStart(key), thinkingEndTime: event.timestamp };
        if (data.thinking) {
          if (own) this.addDisplayMessage({ id: event.id, role: 'assistant', content: '', timestamp: event.timestamp, ...timing });
          else if (event.parentId) this.updateTool(event.parentId, timing);
        }
        this.thinkingClock.clear(key);
        break;
      }
      case ActivityEventType.MODEL_REQUEST_START:
        if (own) this.publish({ isThinking: true });
        break;
      case ActivityEventType.ASSISTANT_CHUNK:
        if (own && data.chunk) this.publish({
          streamingContent: ((this.snapshot.streamingContent ?? '') + data.chunk).slice(-4 * 1024 * 1024),
          isThinking: true,
        }, true);
        break;
      case ActivityEventType.MODEL_STREAM_RESET:
        this.thinkingClock.clear(event.parentId || 'root');
        if (own) this.publish({ streamingContent: undefined });
        break;
      case ActivityEventType.ASSISTANT_MESSAGE_COMPLETE:
        if (own) {
          this.refresh();
          this.publish({ streamingContent: undefined });
        }
        break;
      case ActivityEventType.AGENT_START:
        if (ownLifecycle) this.publish({ isThinking: true, streamingContent: undefined });
        if (data.model) this.updateTool(event.id, { agentModel: data.model });
        break;
      case ActivityEventType.AGENT_END:
        if (ownLifecycle) {
          this.refresh();
          this.publish({ isThinking: false, isCompacting: false, streamingContent: undefined,
            activeToolCalls: this.snapshot.activeToolCalls.map(call =>
              ['success', 'error', 'cancelled'].includes(call.status) ? call : {
                ...call, status: data.interrupted ? 'cancelled' : 'error', endTime: event.timestamp,
                error: call.error ?? 'Tool did not report completion',
              }),
          });
        }
        this.updateTool(event.id, {
          ...(typeof data.contextUsage === 'number' ? { contextUsage: data.contextUsage } : {}),
          ...(typeof data.toolUseCount === 'number' ? { toolUseCount: data.toolUseCount } : {}),
        });
        break;
      case ActivityEventType.STATUS_MESSAGE:
        if (own && data.message) this.publish({ statusMessages: [
          ...this.snapshot.statusMessages.filter(message => message.id !== event.id),
          { id: event.id, timestamp: event.timestamp, message: data.message },
        ].slice(-50) });
        break;
      case ActivityEventType.COMPACTION_START:
      case ActivityEventType.COMPACTION_COMPLETE:
        if (own) this.publish({ isCompacting: event.type === ActivityEventType.COMPACTION_START });
        if (data.parentId) this.updateTool(data.parentId, { isCompacting: event.type === ActivityEventType.COMPACTION_START });
        if (event.type === ActivityEventType.COMPACTION_COMPLETE && !data.error && !data.interrupted) {
          this.publish({
            ...(own && typeof data.newContextUsage === 'number' ? { contextUsage: data.newContextUsage } : {}),
            compactionNotices: [...this.snapshot.compactionNotices, {
              id: event.id, timestamp: event.timestamp, oldContextUsage: data.oldContextUsage,
              threshold: data.threshold, parentId: own ? undefined : data.parentId,
            }].slice(-100),
          });
        }
        break;
      case ActivityEventType.CONTEXT_USAGE_UPDATE:
        if (own && typeof data.contextUsage === 'number') this.publish({ contextUsage: data.contextUsage });
        if (data.parentCallId) this.updateTool(data.parentCallId, { contextUsage: data.contextUsage });
        break;
      case ActivityEventType.TOOL_CALL_START: {
        if (data.groupExecution || !data.toolName) break;
        const call: ToolCallState = {
          ...data, id: event.id, toolName: data.toolName, arguments: data.arguments ?? {},
          startTime: event.timestamp, status: 'pending', parentId: own ? undefined : event.parentId,
        };
        const previous = this.snapshot.activeToolCalls.filter(item => item.id !== call.id);
        this.publish({ activeToolCalls: boundToolCalls([...previous, call]) });
        break;
      }
      case ActivityEventType.TOOL_EXECUTION_START:
        this.updateTool(event.id, { status: 'executing', executionStartTime: event.timestamp });
        break;
      case ActivityEventType.TOOL_OUTPUT_CHUNK: {
        const call = this.snapshot.activeToolCalls.find(item => item.id === event.id);
        if (call && data.chunk) this.updateTool(event.id, {
          output: ((call.output ?? '') + data.chunk).slice(-256 * 1024),
        }, true);
        break;
      }
      case ActivityEventType.TOOL_CALL_END: {
        if (data.groupExecution) break;
        const call = this.snapshot.activeToolCalls.find(item => item.id === event.id);
        this.updateTool(event.id, {
          status: data.success ? 'success' : 'error', endTime: event.timestamp,
          executionStartTime: data.executionStartTime ?? call?.executionStartTime,
          result: data.result, output: resolveDisplayContent(data.result) || data.output || call?.output,
          error: data.error, error_type: data.result?.error_type, agentId: data.result?.agent_id,
          ...(data.success ? {} : { diffPreview: undefined }),
          ...((data.shouldCollapse || call?.shouldCollapse) && !data.result?._isLinkedPluginAgent && !call?.isLinkedPlugin
            ? { collapsed: true } : data.collapsed !== undefined ? { collapsed: data.collapsed } : {}),
        });
        break;
      }
      case ActivityEventType.DIFF_PREVIEW:
        this.updateTool(event.id, { diffPreview: {
          oldContent: (data.oldContent ?? '').slice(0, 64 * 1024), newContent: (data.newContent ?? '').slice(0, 64 * 1024),
          filePath: data.filePath, operationType: data.operationType, editsCount: data.editsCount,
        } });
        break;
      case ActivityEventType.ERROR:
        if (!data.groupExecution) this.updateTool(event.id, {
          status: 'error', error: data.error || data.message, endTime: event.timestamp, diffPreview: undefined,
        });
        break;
    }
  }

  /** Retain the final snapshot for inspection; release event and timer ownership. */
  close(): void {
    this.closed = true;
    this.unsubscribe();
    if (this.notificationTimer) clearTimeout(this.notificationTimer);
    this.notificationTimer = undefined;
    this.notify();
    this.listeners.clear();
  }
}
