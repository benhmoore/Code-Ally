/**
 * Tests for yamlUtils
 */

import { describe, it, expect } from 'vitest';
import { parseFrontmatterYAML, extractFrontmatter } from '../yamlUtils.js';

describe('yamlUtils', () => {
  describe('extractFrontmatter', () => {
    it('should extract frontmatter and body from valid markdown', () => {
      const content = `---
name: "Test Agent"
description: "A test agent"
---
This is the body content.`;

      const result = extractFrontmatter(content);
      expect(result).not.toBeNull();
      expect(result?.frontmatter).toBe('name: "Test Agent"\ndescription: "A test agent"');
      expect(result?.body).toBe('This is the body content.');
    });

    it('should return null for content without frontmatter', () => {
      const content = 'Just some regular content';
      const result = extractFrontmatter(content);
      expect(result).toBeNull();
    });

    it('should return null for malformed frontmatter (missing closing)', () => {
      const content = `---
name: "Test"
Body without closing`;
      const result = extractFrontmatter(content);
      expect(result).toBeNull();
    });

    it('should return null for empty frontmatter', () => {
      const content = `---
---
Body content`;
      const result = extractFrontmatter(content);
      expect(result).toBeNull();
    });

    it('should handle multiline body content', () => {
      const content = `---
name: "Agent"
---
Line 1
Line 2
Line 3`;

      const result = extractFrontmatter(content);
      expect(result?.body).toBe('Line 1\nLine 2\nLine 3');
    });
  });

  describe('parseFrontmatterYAML', () => {
    describe('simple values', () => {
      it('should parse string values', () => {
        const yaml = `name: "Test Agent"
description: 'Single quotes'
unquoted: value`;

        const result = parseFrontmatterYAML(yaml);
        expect(result.name).toBe('Test Agent');
        expect(result.description).toBe('Single quotes');
        expect(result.unquoted).toBe('value');
      });

      it('should parse boolean values', () => {
        const yaml = `enabled: true
disabled: false`;

        const result = parseFrontmatterYAML(yaml);
        expect(result.enabled).toBe('true');
        expect(result.disabled).toBe('false');
      });

      it('should parse numeric values', () => {
        const yaml = `temperature: 0.7
max_tokens: 1000`;

        const result = parseFrontmatterYAML(yaml);
        expect(result.temperature).toBe('0.7');
        expect(result.max_tokens).toBe('1000');
      });

      it('should handle empty values', () => {
        const yaml = `key1:
key2: ""`;

        const result = parseFrontmatterYAML(yaml);
        // Empty value after colon is treated as nested object
        expect(result.key1).toEqual({});
        expect(result.key2).toBe('');
      });
    });

    describe('JSON arrays', () => {
      it('should parse JSON array values', () => {
        const yaml = `tools: ["Read", "Write", "Edit"]`;

        const result = parseFrontmatterYAML(yaml);
        expect(result.tools).toEqual(['Read', 'Write', 'Edit']);
      });

      it('should parse empty JSON arrays', () => {
        const yaml = `tools: []`;

        const result = parseFrontmatterYAML(yaml);
        expect(result.tools).toEqual([]);
      });

      it('should handle malformed JSON arrays as strings', () => {
        const yaml = `tools: [invalid json`;

        const result = parseFrontmatterYAML(yaml);
        expect(result.tools).toBe('[invalid json');
      });

      it('should parse numeric arrays', () => {
        const yaml = `numbers: [1, 2, 3]`;

        const result = parseFrontmatterYAML(yaml);
        expect(result.numbers).toEqual([1, 2, 3]);
      });
    });

    describe('multiline strings', () => {
      it('should parse pipe multiline strings', () => {
        const yaml = `description: |
  Line 1
  Line 2
  Line 3`;

        const result = parseFrontmatterYAML(yaml);
        expect(result.description).toBe('Line 1\nLine 2\nLine 3');
      });

      it('should handle empty multiline strings', () => {
        const yaml = `description: |`;

        const result = parseFrontmatterYAML(yaml);
        expect(result.description).toBe('');
      });

      it('should preserve indentation in multiline strings', () => {
        const yaml = `code: |
  if (true) {
    console.log("hello");
  }`;

        const result = parseFrontmatterYAML(yaml);
        expect(result.code).toBe('if (true) {\n  console.log("hello");\n}');
      });

      it('should handle multiline string followed by another field', () => {
        const yaml = `description: |
  Line 1
  Line 2
other: value`;

        const result = parseFrontmatterYAML(yaml);
        expect(result.description).toBe('Line 1\nLine 2');
        expect(result.other).toBe('value');
      });
    });

    describe('nested objects', () => {
      it('should parse nested objects with colon syntax', () => {
        const yaml = `requirements:
  require_tool_use: true
  max_retries: 3`;

        const result = parseFrontmatterYAML(yaml);
        expect(result.requirements).toEqual({
          require_tool_use: true,
          max_retries: 3,
        });
      });

      it('should parse nested objects with empty value syntax', () => {
        const yaml = `requirements:
  require_tool_use: true
  max_retries: 2`;

        const result = parseFrontmatterYAML(yaml);
        expect(result.requirements).toEqual({
          require_tool_use: true,
          max_retries: 2,
        });
      });

      it('should parse string values in nested objects', () => {
        const yaml = `config:
  name: "value"
  description: 'another value'`;

        const result = parseFrontmatterYAML(yaml);
        expect(result.config).toEqual({
          name: 'value',
          description: 'another value',
        });
      });

      it('should parse boolean values in nested objects', () => {
        const yaml = `flags:
  enabled: true
  disabled: false`;

        const result = parseFrontmatterYAML(yaml);
        expect(result.flags).toEqual({
          enabled: true,
          disabled: false,
        });
      });

      it('should parse numeric values in nested objects', () => {
        const yaml = `settings:
  timeout: 5000
  retries: 3`;

        const result = parseFrontmatterYAML(yaml);
        expect(result.settings).toEqual({
          timeout: 5000,
          retries: 3,
        });
      });

      it('should parse arrays in nested objects', () => {
        const yaml = `requirements:
  required_tools_one_of: ["Read", "Grep"]
  max_retries: 2`;

        const result = parseFrontmatterYAML(yaml);
        expect(result.requirements).toEqual({
          required_tools_one_of: ['Read', 'Grep'],
          max_retries: 2,
        });
      });

      it('should handle empty nested objects', () => {
        const yaml = `empty:
other: value`;

        const result = parseFrontmatterYAML(yaml);
        expect(result.empty).toEqual({});
        expect(result.other).toBe('value');
      });

      it('should handle malformed nested arrays as strings', () => {
        const yaml = `config:
  items: [invalid`;

        const result = parseFrontmatterYAML(yaml);
        expect(result.config.items).toBe('[invalid');
      });
    });

    describe('complex structures', () => {
      it('should parse agent metadata with all field types', () => {
        const yaml = `name: "Test Agent"
description: "A comprehensive test"
model: "claude-3-5-sonnet-20241022"
temperature: 0.7
tools: ["Read", "Write", "Edit"]
usage_guidelines: |
  Use this agent for testing.
  It handles multiple scenarios.
requirements:
  require_tool_use: true
  minimum_tool_calls: 2
  required_tools_one_of: ["Read", "Grep"]
  max_retries: 3`;

        const result = parseFrontmatterYAML(yaml);
        expect(result.name).toBe('Test Agent');
        expect(result.description).toBe('A comprehensive test');
        expect(result.model).toBe('claude-3-5-sonnet-20241022');
        expect(result.temperature).toBe('0.7');
        expect(result.tools).toEqual(['Read', 'Write', 'Edit']);
        expect(result.usage_guidelines).toBe(
          'Use this agent for testing.\nIt handles multiple scenarios.'
        );
        expect(result.requirements).toEqual({
          require_tool_use: true,
          minimum_tool_calls: 2,
          required_tools_one_of: ['Read', 'Grep'],
          max_retries: 3,
        });
      });

      it('should handle multiple nested objects', () => {
        const yaml = `config1:
  key1: value1
  key2: value2
config2:
  key3: value3
  key4: value4`;

        const result = parseFrontmatterYAML(yaml);
        expect(result.config1).toEqual({ key1: 'value1', key2: 'value2' });
        expect(result.config2).toEqual({ key3: 'value3', key4: 'value4' });
      });
    });

    describe('edge cases', () => {
      it('should handle empty YAML', () => {
        const result = parseFrontmatterYAML('');
        expect(result).toEqual({});
      });

      it('should handle YAML with only whitespace', () => {
        const result = parseFrontmatterYAML('   \n  \n  ');
        expect(result).toEqual({});
      });

      it('should ignore lines without colons', () => {
        const yaml = `name: "Test"
invalid line without colon
other: value`;

        const result = parseFrontmatterYAML(yaml);
        expect(result.name).toBe('Test');
        expect(result.other).toBe('value');
      });

      it('should handle keys with no value', () => {
        const yaml = `key1:
key2: value`;

        const result = parseFrontmatterYAML(yaml);
        expect(result.key1).toEqual({});
        expect(result.key2).toBe('value');
      });

      it('should handle special characters in string values', () => {
        const yaml = `description: "Value with @#$% special chars"
path: "/path/to/file"`;

        const result = parseFrontmatterYAML(yaml);
        expect(result.description).toBe('Value with @#$% special chars');
        expect(result.path).toBe('/path/to/file');
      });

      it('should handle blank lines', () => {
        const yaml = `name: "Test"

description: "After blank"

other: value`;

        const result = parseFrontmatterYAML(yaml);
        expect(result.name).toBe('Test');
        expect(result.description).toBe('After blank');
        expect(result.other).toBe('value');
      });
    });
  });
});
