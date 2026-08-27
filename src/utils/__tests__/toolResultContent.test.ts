import { describe, it, expect } from 'vitest';
import {
  resolveDisplayContent,
  toModelToolResult,
  DISPLAY_ONLY_RESULT_FIELDS,
} from '../toolResultContent.js';
import { createToolResultMessage } from '../../llm/FunctionCalling.js';

describe('toolResultContent — the display/model split', () => {
  describe('resolveDisplayContent (user-facing gateway)', () => {
    it('prefers display_content when present', () => {
      expect(
        resolveDisplayContent({ content: 'model view', display_content: 'user view' })
      ).toBe('user view');
    });

    it('falls back to content when display_content is absent', () => {
      expect(resolveDisplayContent({ content: 'model view' })).toBe('model view');
    });

    it('prefers an empty-string display_content over content (explicit suppression)', () => {
      expect(resolveDisplayContent({ content: 'model view', display_content: '' })).toBe('');
    });

    it('returns empty string for null/undefined results', () => {
      expect(resolveDisplayContent(undefined)).toBe('');
      expect(resolveDisplayContent(null)).toBe('');
      expect(resolveDisplayContent({})).toBe('');
    });
  });

  describe('toModelToolResult (model-facing gateway)', () => {
    it('removes every registered display-only field', () => {
      const result: Record<string, any> = { success: true, content: 'keep' };
      for (const field of DISPLAY_ONLY_RESULT_FIELDS) {
        result[field] = 'drop';
      }
      const stripped = toModelToolResult(result);
      for (const field of DISPLAY_ONLY_RESULT_FIELDS) {
        expect(stripped[field]).toBeUndefined();
      }
      expect(stripped.content).toBe('keep');
      expect(stripped.success).toBe(true);
    });

    it('removes runtime control metadata', () => {
      expect(toModelToolResult({
        success: true,
        content: 'keep',
        _executionStartTime: 123,
        _non_truncatable: true,
      })).toEqual({ success: true, content: 'keep' });
    });

    it('does not mutate the original result', () => {
      const result = { success: true, content: 'keep', display_content: 'drop' };
      toModelToolResult(result);
      expect(result.display_content).toBe('drop');
    });
  });

  describe('createToolResultMessage (model wire builder)', () => {
    it('never serializes display_content into the model-facing message', () => {
      const msg = createToolResultMessage('call-1', 'wait', {
        success: true,
        content: 'shell-123 [done]: full output',
        display_content: '[done] npm test (5s)',
      });
      expect(msg.content).toContain('shell-123');
      expect(msg.content).not.toContain('[done] npm test (5s)');
      expect(msg.content).not.toContain('display_content');
    });
  });
});
