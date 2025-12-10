/**
 * ActivityStream unit tests
 *
 * Tests event emission, subscription, unsubscribe, cleanup, and scoped streams.
 * Verifies the core event system that enables React components to subscribe to
 * tool execution events without tight coupling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ActivityStream } from '../ActivityStream.js';
import { ActivityEventType } from '@shared/index.js';
import type { ActivityEvent } from '@shared/index.js';

describe('ActivityStream', () => {
  let stream: ActivityStream;

  beforeEach(() => {
    stream = new ActivityStream();
  });

  afterEach(() => {
    stream.cleanup();
  });

  describe('emit', () => {
    it('should call subscribed listeners for matching event type', () => {
      const mockCallback = vi.fn();
      stream.subscribe(ActivityEventType.TOOL_CALL_START, mockCallback);

      const event: ActivityEvent = {
        id: '123',
        type: ActivityEventType.TOOL_CALL_START,
        timestamp: Date.now(),
        data: { toolName: 'test' },
      };

      stream.emit(event);
      expect(mockCallback).toHaveBeenCalledWith(event);
      expect(mockCallback).toHaveBeenCalledTimes(1);
    });

    it('should call wildcard listeners for any event type', () => {
      const wildcardCallback = vi.fn();
      stream.subscribe('*', wildcardCallback);

      const event1: ActivityEvent = {
        id: '1',
        type: ActivityEventType.TOOL_CALL_START,
        timestamp: Date.now(),
        data: { toolName: 'test' },
      };

      const event2: ActivityEvent = {
        id: '2',
        type: ActivityEventType.AGENT_START,
        timestamp: Date.now(),
        data: { agentId: 'agent-1' },
      };

      stream.emit(event1);
      stream.emit(event2);

      expect(wildcardCallback).toHaveBeenCalledTimes(2);
      expect(wildcardCallback).toHaveBeenCalledWith(event1);
      expect(wildcardCallback).toHaveBeenCalledWith(event2);
    });

    it('should not call listeners for different event types', () => {
      const toolCallback = vi.fn();
      const agentCallback = vi.fn();

      stream.subscribe(ActivityEventType.TOOL_CALL_START, toolCallback);
      stream.subscribe(ActivityEventType.AGENT_START, agentCallback);

      const toolEvent: ActivityEvent = {
        id: '1',
        type: ActivityEventType.TOOL_CALL_START,
        timestamp: Date.now(),
        data: { toolName: 'test' },
      };

      stream.emit(toolEvent);

      expect(toolCallback).toHaveBeenCalledWith(toolEvent);
      expect(agentCallback).not.toHaveBeenCalled();
    });

    it('should handle errors in listeners gracefully', () => {
      const errorCallback = vi.fn(() => {
        throw new Error('Listener error');
      });
      const normalCallback = vi.fn();

      // Spy on console.error to verify error handling
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      stream.subscribe(ActivityEventType.TOOL_CALL_START, errorCallback);
      stream.subscribe(ActivityEventType.TOOL_CALL_START, normalCallback);

      const event: ActivityEvent = {
        id: '1',
        type: ActivityEventType.TOOL_CALL_START,
        timestamp: Date.now(),
        data: { toolName: 'test' },
      };

      // Should not throw
      expect(() => stream.emit(event)).not.toThrow();

      // Both callbacks should have been called despite error
      expect(errorCallback).toHaveBeenCalledWith(event);
      expect(normalCallback).toHaveBeenCalledWith(event);
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    it('should call multiple listeners for the same event type', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      const callback3 = vi.fn();

      stream.subscribe(ActivityEventType.TOOL_CALL_START, callback1);
      stream.subscribe(ActivityEventType.TOOL_CALL_START, callback2);
      stream.subscribe(ActivityEventType.TOOL_CALL_START, callback3);

      const event: ActivityEvent = {
        id: '1',
        type: ActivityEventType.TOOL_CALL_START,
        timestamp: Date.now(),
        data: { toolName: 'test' },
      };

      stream.emit(event);

      expect(callback1).toHaveBeenCalledWith(event);
      expect(callback2).toHaveBeenCalledWith(event);
      expect(callback3).toHaveBeenCalledWith(event);
    });

    it('should call both specific and wildcard listeners', () => {
      const specificCallback = vi.fn();
      const wildcardCallback = vi.fn();

      stream.subscribe(ActivityEventType.TOOL_CALL_START, specificCallback);
      stream.subscribe('*', wildcardCallback);

      const event: ActivityEvent = {
        id: '1',
        type: ActivityEventType.TOOL_CALL_START,
        timestamp: Date.now(),
        data: { toolName: 'test' },
      };

      stream.emit(event);

      expect(specificCallback).toHaveBeenCalledWith(event);
      expect(wildcardCallback).toHaveBeenCalledWith(event);
    });

    it('should add parentId to events when stream is scoped', () => {
      const scopedStream = stream.createScoped('parent-123');
      const callback = vi.fn();
      scopedStream.subscribe(ActivityEventType.TOOL_CALL_START, callback);

      const event: ActivityEvent = {
        id: '1',
        type: ActivityEventType.TOOL_CALL_START,
        timestamp: Date.now(),
        data: { toolName: 'test' },
      };

      scopedStream.emit(event);

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          parentId: 'parent-123',
        })
      );
    });

    it('should not override existing parentId in events', () => {
      const scopedStream = stream.createScoped('parent-123');
      const callback = vi.fn();
      scopedStream.subscribe(ActivityEventType.TOOL_CALL_START, callback);

      const event: ActivityEvent = {
        id: '1',
        type: ActivityEventType.TOOL_CALL_START,
        timestamp: Date.now(),
        data: { toolName: 'test' },
        parentId: 'existing-parent',
      };

      scopedStream.emit(event);

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          parentId: 'existing-parent',
        })
      );
    });
  });

  describe('subscribe', () => {
    it('should add listener to callbacks set', () => {
      const mockCallback = vi.fn();
      stream.subscribe(ActivityEventType.TOOL_CALL_START, mockCallback);

      const stats = stream.getListenerStats();
      expect(stats).toContainEqual({
        eventType: ActivityEventType.TOOL_CALL_START,
        count: 1,
      });
    });

    it('should return unsubscribe function', () => {
      const mockCallback = vi.fn();
      const unsubscribe = stream.subscribe(ActivityEventType.TOOL_CALL_START, mockCallback);

      expect(typeof unsubscribe).toBe('function');
    });

    it('should warn when listener count exceeds MAX_LISTENERS_PER_TYPE', async () => {
      // Mock logger.warn
      const { logger } = await import('../Logger.js');
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      // Add 51 listeners (MAX_LISTENERS_PER_TYPE is 50)
      for (let i = 0; i <= 50; i++) {
        stream.subscribe(ActivityEventType.TOOL_CALL_START, vi.fn());
      }

      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0]?.[0]).toContain('High listener count');
      expect(warnSpy.mock.calls[0]?.[0]).toContain('memory leak');

      warnSpy.mockRestore();
    });

    it('should support wildcard subscriptions', () => {
      const mockCallback = vi.fn();
      stream.subscribe('*', mockCallback);

      const stats = stream.getListenerStats();
      expect(stats).toContainEqual({
        eventType: '*',
        count: 1,
      });
    });

    it('should allow same callback to be subscribed multiple times', () => {
      const mockCallback = vi.fn();
      stream.subscribe(ActivityEventType.TOOL_CALL_START, mockCallback);
      stream.subscribe(ActivityEventType.TOOL_CALL_START, mockCallback);

      // Sets prevent duplicates, so count should be 1
      const stats = stream.getListenerStats();
      const toolCallStat = stats.find(s => s.eventType === ActivityEventType.TOOL_CALL_START);
      expect(toolCallStat?.count).toBe(1);
    });
  });

  describe('unsubscribe', () => {
    it('should remove specific listener', () => {
      const mockCallback = vi.fn();
      const unsubscribe = stream.subscribe(ActivityEventType.TOOL_CALL_START, mockCallback);

      unsubscribe();

      const event: ActivityEvent = {
        id: '1',
        type: ActivityEventType.TOOL_CALL_START,
        timestamp: Date.now(),
        data: { toolName: 'test' },
      };

      stream.emit(event);
      expect(mockCallback).not.toHaveBeenCalled();
    });

    it('should not affect other listeners', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      const callback3 = vi.fn();

      const unsubscribe1 = stream.subscribe(ActivityEventType.TOOL_CALL_START, callback1);
      stream.subscribe(ActivityEventType.TOOL_CALL_START, callback2);
      stream.subscribe(ActivityEventType.TOOL_CALL_START, callback3);

      unsubscribe1();

      const event: ActivityEvent = {
        id: '1',
        type: ActivityEventType.TOOL_CALL_START,
        timestamp: Date.now(),
        data: { toolName: 'test' },
      };

      stream.emit(event);

      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalledWith(event);
      expect(callback3).toHaveBeenCalledWith(event);
    });

    it('should delete event type from map when last listener removed', () => {
      const mockCallback = vi.fn();
      const unsubscribe = stream.subscribe(ActivityEventType.TOOL_CALL_START, mockCallback);

      expect(stream.getListenerStats()).toHaveLength(1);

      unsubscribe();

      expect(stream.getListenerStats()).toHaveLength(0);
    });

    it('should be safe to call unsubscribe multiple times', () => {
      const mockCallback = vi.fn();
      const unsubscribe = stream.subscribe(ActivityEventType.TOOL_CALL_START, mockCallback);

      unsubscribe();
      expect(() => unsubscribe()).not.toThrow();
      expect(() => unsubscribe()).not.toThrow();
    });
  });

  describe('cleanup', () => {
    it('should clear all listeners', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      const cb3 = vi.fn();

      stream.subscribe(ActivityEventType.TOOL_CALL_START, cb1);
      stream.subscribe(ActivityEventType.TOOL_CALL_END, cb2);
      stream.subscribe('*', cb3);

      expect(stream.getListenerStats().length).toBeGreaterThan(0);

      stream.cleanup();

      const stats = stream.getListenerStats();
      expect(stats).toHaveLength(0);
    });

    it('should log correct count of removed listeners', async () => {
      const { logger } = await import('../Logger.js');
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

      stream.subscribe(ActivityEventType.TOOL_CALL_START, vi.fn());
      stream.subscribe(ActivityEventType.TOOL_CALL_START, vi.fn());
      stream.subscribe(ActivityEventType.TOOL_CALL_END, vi.fn());

      stream.cleanup();

      expect(debugSpy).toHaveBeenCalled();
      const logMessage = debugSpy.mock.calls.find(call =>
        typeof call[0] === 'string' && call[0].includes('removing 3 listeners')
      );
      expect(logMessage).toBeTruthy();

      debugSpy.mockRestore();
    });

    it('should be safe to call multiple times', () => {
      stream.subscribe(ActivityEventType.TOOL_CALL_START, vi.fn());

      stream.cleanup();
      expect(() => stream.cleanup()).not.toThrow();
      expect(() => stream.cleanup()).not.toThrow();

      expect(stream.getListenerStats()).toHaveLength(0);
    });

    it('should allow new subscriptions after cleanup', () => {
      stream.subscribe(ActivityEventType.TOOL_CALL_START, vi.fn());
      stream.cleanup();

      const newCallback = vi.fn();
      stream.subscribe(ActivityEventType.TOOL_CALL_START, newCallback);

      const event: ActivityEvent = {
        id: '1',
        type: ActivityEventType.TOOL_CALL_START,
        timestamp: Date.now(),
        data: { toolName: 'test' },
      };

      stream.emit(event);
      expect(newCallback).toHaveBeenCalledWith(event);
    });

    it('should not log when cleaning up empty stream', async () => {
      const { logger } = await import('../Logger.js');
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

      stream.cleanup();

      const cleanupCalls = debugSpy.mock.calls.filter(call =>
        typeof call[0] === 'string' && call[0].includes('removing')
      );
      expect(cleanupCalls).toHaveLength(0);

      debugSpy.mockRestore();
    });
  });

  describe('createScoped', () => {
    it('should create new ActivityStream instance', () => {
      const scopedStream = stream.createScoped('parent-123');
      expect(scopedStream).toBeInstanceOf(ActivityStream);
      expect(scopedStream).not.toBe(stream);
    });

    it('should maintain parent ID', () => {
      const scopedStream = stream.createScoped('parent-123');
      expect(scopedStream.getParentId()).toBe('parent-123');
    });

    it('should not share listeners with parent stream', () => {
      const parentCallback = vi.fn();
      const scopedCallback = vi.fn();

      stream.subscribe(ActivityEventType.TOOL_CALL_START, parentCallback);

      const scopedStream = stream.createScoped('parent-123');
      scopedStream.subscribe(ActivityEventType.TOOL_CALL_START, scopedCallback);

      const event: ActivityEvent = {
        id: '1',
        type: ActivityEventType.TOOL_CALL_START,
        timestamp: Date.now(),
        data: { toolName: 'test' },
      };

      scopedStream.emit(event);

      // Only scoped callback should be called
      expect(scopedCallback).toHaveBeenCalledWith(event);
      expect(parentCallback).not.toHaveBeenCalled();
    });

    it('should pass EventSubscriptionManager to scoped streams', () => {
      const mockManager = {
        dispatch: vi.fn(),
      } as unknown as EventSubscriptionManager;

      const rootStream = new ActivityStream(undefined, mockManager);
      const scopedStream = rootStream.createScoped('parent-123');

      // Scoped streams should NOT forward to EventSubscriptionManager
      // (only root stream forwards)
      const callback = vi.fn();
      scopedStream.subscribe(ActivityEventType.TOOL_CALL_START, callback);

      const event: ActivityEvent = {
        id: '1',
        type: ActivityEventType.TOOL_CALL_START,
        timestamp: Date.now(),
        data: { toolName: 'test' },
      };

      scopedStream.emit(event);

      // EventSubscriptionManager should NOT be called for scoped streams
      expect(mockManager.dispatch).not.toHaveBeenCalled();
    });
  });

  describe('getListenerStats', () => {
    it('should return accurate count per event type', () => {
      stream.subscribe(ActivityEventType.TOOL_CALL_START, vi.fn());
      stream.subscribe(ActivityEventType.TOOL_CALL_START, vi.fn());
      stream.subscribe(ActivityEventType.TOOL_CALL_END, vi.fn());
      stream.subscribe('*', vi.fn());

      const stats = stream.getListenerStats();

      expect(stats).toContainEqual({
        eventType: ActivityEventType.TOOL_CALL_START,
        count: 2,
      });
      expect(stats).toContainEqual({
        eventType: ActivityEventType.TOOL_CALL_END,
        count: 1,
      });
      expect(stats).toContainEqual({
        eventType: '*',
        count: 1,
      });
    });

    it('should return empty array after cleanup', () => {
      stream.subscribe(ActivityEventType.TOOL_CALL_START, vi.fn());
      stream.subscribe(ActivityEventType.TOOL_CALL_END, vi.fn());

      stream.cleanup();

      const stats = stream.getListenerStats();
      expect(stats).toEqual([]);
    });

    it('should sort by count descending', () => {
      // Add 3 listeners to TOOL_CALL_START
      stream.subscribe(ActivityEventType.TOOL_CALL_START, vi.fn());
      stream.subscribe(ActivityEventType.TOOL_CALL_START, vi.fn());
      stream.subscribe(ActivityEventType.TOOL_CALL_START, vi.fn());

      // Add 1 listener to TOOL_CALL_END
      stream.subscribe(ActivityEventType.TOOL_CALL_END, vi.fn());

      // Add 2 listeners to AGENT_START
      stream.subscribe(ActivityEventType.AGENT_START, vi.fn());
      stream.subscribe(ActivityEventType.AGENT_START, vi.fn());

      const stats = stream.getListenerStats();

      expect(stats[0]?.count).toBe(3); // TOOL_CALL_START
      expect(stats[1]?.count).toBe(2); // AGENT_START
      expect(stats[2]?.count).toBe(1); // TOOL_CALL_END
    });

    it('should return empty array for new stream', () => {
      const newStream = new ActivityStream();
      expect(newStream.getListenerStats()).toEqual([]);
    });
  });

  describe('getListenerCount', () => {
    it('should return total count across all event types', () => {
      stream.subscribe(ActivityEventType.TOOL_CALL_START, vi.fn());
      stream.subscribe(ActivityEventType.TOOL_CALL_START, vi.fn());
      stream.subscribe(ActivityEventType.TOOL_CALL_END, vi.fn());
      stream.subscribe('*', vi.fn());

      expect(stream.getListenerCount()).toBe(4);
    });

    it('should return 0 for new stream', () => {
      expect(stream.getListenerCount()).toBe(0);
    });

    it('should return 0 after cleanup', () => {
      stream.subscribe(ActivityEventType.TOOL_CALL_START, vi.fn());
      stream.cleanup();

      expect(stream.getListenerCount()).toBe(0);
    });
  });

  describe('deprecated clear method', () => {
    it('should clear all listeners like cleanup', () => {
      stream.subscribe(ActivityEventType.TOOL_CALL_START, vi.fn());
      stream.subscribe(ActivityEventType.TOOL_CALL_END, vi.fn());

      stream.clear();

      expect(stream.getListenerStats()).toHaveLength(0);
    });
  });
});
