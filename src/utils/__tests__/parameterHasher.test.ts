/**
 * Tests for parameter hashing utility
 */

import { describe, it, expect } from 'vitest';
import { createParameterSignature } from '@utils/parameterHasher.js';

describe('parameterHasher', () => {
  describe('createParameterSignature', () => {
    it('should create consistent signatures for same parameters', () => {
      const sig1 = createParameterSignature('read', { file_paths: ['a.ts'], limit: 100 });
      const sig2 = createParameterSignature('read', { file_paths: ['a.ts'], limit: 100 });

      expect(sig1).toBe(sig2);
    });

    it('should be order-independent for object keys', () => {
      const sig1 = createParameterSignature('read', { limit: 100, file_paths: ['a.ts'] });
      const sig2 = createParameterSignature('read', { file_paths: ['a.ts'], limit: 100 });

      expect(sig1).toBe(sig2);
    });

    it('should preserve array order (order matters)', () => {
      const sig1 = createParameterSignature('read', { file_paths: ['a.ts', 'b.ts'] });
      const sig2 = createParameterSignature('read', { file_paths: ['b.ts', 'a.ts'] });

      expect(sig1).not.toBe(sig2);
    });

    it('should handle nested objects', () => {
      const sig1 = createParameterSignature('tool', {
        config: { b: 2, a: 1 },
        name: 'test'
      });
      const sig2 = createParameterSignature('tool', {
        name: 'test',
        config: { a: 1, b: 2 }
      });

      expect(sig1).toBe(sig2);
    });

    it('should treat null and undefined consistently', () => {
      const sig1 = createParameterSignature('tool', { value: null });
      const sig2 = createParameterSignature('tool', { value: undefined });

      expect(sig1).toBe(sig2);
    });

    it('should handle arrays of objects', () => {
      const sig1 = createParameterSignature('batch', {
        tools: [
          { name: 'read', arguments: { file: 'a.ts' } },
          { name: 'read', arguments: { file: 'b.ts' } }
        ]
      });
      const sig2 = createParameterSignature('batch', {
        tools: [
          { arguments: { file: 'a.ts' }, name: 'read' },
          { name: 'read', arguments: { file: 'b.ts' } }
        ]
      });

      expect(sig1).toBe(sig2);
    });

    it('should differentiate different tool names', () => {
      const sig1 = createParameterSignature('read', { file: 'a.ts' });
      const sig2 = createParameterSignature('write', { file: 'a.ts' });

      expect(sig1).not.toBe(sig2);
    });

    it('should differentiate different parameter values', () => {
      const sig1 = createParameterSignature('read', { file: 'a.ts' });
      const sig2 = createParameterSignature('read', { file: 'b.ts' });

      expect(sig1).not.toBe(sig2);
    });
  });
});
