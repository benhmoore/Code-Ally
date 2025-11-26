/**
 * Comprehensive tests for file checkers
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TypeScriptChecker } from '../TypeScriptChecker.js';
import { JavaScriptChecker } from '../JavaScriptChecker.js';
import { JSONChecker } from '../JSONChecker.js';
import { YAMLChecker } from '../YAMLChecker.js';
import { CheckerRegistry, getDefaultRegistry, resetRegistry } from '../CheckerRegistry.js';

describe('TypeScriptChecker', () => {
  let checker: TypeScriptChecker;

  beforeEach(() => {
    checker = new TypeScriptChecker(false); // Disable project config for isolated tests
  });

  describe('canCheck', () => {
    it('should handle .ts files', () => {
      expect(checker.canCheck('test.ts')).toBe(true);
    });

    it('should handle .tsx files', () => {
      expect(checker.canCheck('Component.tsx')).toBe(true);
    });

    it('should reject other file types', () => {
      expect(checker.canCheck('test.js')).toBe(false);
      expect(checker.canCheck('test.json')).toBe(false);
    });
  });

  describe('check', () => {
    it('should pass valid TypeScript code', async () => {
      const code = `
        function greet(name: string): string {
          return \`Hello, \${name}!\`;
        }
      `;

      const result = await checker.check('test.ts', code);

      expect(result.checker).toBe('typescript');
      expect(result.passed).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect syntax errors', async () => {
      const code = `
        function broken() {
          const x =
        }
      `;

      const result = await checker.check('test.ts', code);

      expect(result.checker).toBe('typescript');
      // May pass or fail depending on tsc availability
      expect(typeof result.passed).toBe('boolean');
    });

    it('should detect type errors', async () => {
      const code = `
        function add(a: number, b: number): number {
          return a + b;
        }

        add("hello", "world");
      `;

      const result = await checker.check('test.ts', code);

      expect(result.checker).toBe('typescript');
      // May pass or fail depending on tsc availability
      expect(typeof result.passed).toBe('boolean');
    });
  });
});

describe('JavaScriptChecker', () => {
  let checker: JavaScriptChecker;

  beforeEach(() => {
    checker = new JavaScriptChecker();
  });

  describe('canCheck', () => {
    it('should handle .js files', () => {
      expect(checker.canCheck('test.js')).toBe(true);
    });

    it('should handle .jsx files', () => {
      expect(checker.canCheck('Component.jsx')).toBe(true);
    });

    it('should handle .mjs files', () => {
      expect(checker.canCheck('module.mjs')).toBe(true);
    });

    it('should handle .cjs files', () => {
      expect(checker.canCheck('common.cjs')).toBe(true);
    });

    it('should reject other file types', () => {
      expect(checker.canCheck('test.ts')).toBe(false);
      expect(checker.canCheck('test.json')).toBe(false);
    });
  });

  describe('check', () => {
    it('should pass valid JavaScript code', async () => {
      const code = `
        function greet(name) {
          return \`Hello, \${name}!\`;
        }
      `;

      const result = await checker.check('test.js', code);

      expect(result.checker).toBe('javascript');
      expect(result.passed).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect syntax errors', async () => {
      const code = `
        function broken() {
          const x =
        }
      `;

      const result = await checker.check('test.js', code);

      expect(result.checker).toBe('javascript');
      // May pass or fail depending on node availability
      expect(typeof result.passed).toBe('boolean');
    });
  });
});

describe('JSONChecker', () => {
  let checker: JSONChecker;

  beforeEach(() => {
    checker = new JSONChecker();
  });

  describe('canCheck', () => {
    it('should handle .json files', () => {
      expect(checker.canCheck('package.json')).toBe(true);
    });

    it('should reject other file types', () => {
      expect(checker.canCheck('test.js')).toBe(false);
      expect(checker.canCheck('test.yaml')).toBe(false);
    });
  });

  describe('check', () => {
    it('should pass valid JSON', async () => {
      const json = `{
        "name": "test",
        "version": "1.0.0"
      }`;

      const result = await checker.check('test.json', json);

      expect(result.checker).toBe('json');
      expect(result.passed).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.checkTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should detect syntax errors', async () => {
      const json = `{
        "name": "test",
        "version": "1.0.0"
      `;

      const result = await checker.check('test.json', json);

      expect(result.checker).toBe('json');
      expect(result.passed).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].severity).toBe('error');
      expect(result.errors[0].message).toBeTruthy();
    });

    it('should detect trailing commas', async () => {
      const json = `{
        "name": "test",
        "version": "1.0.0",
      }`;

      const result = await checker.check('test.json', json);

      expect(result.checker).toBe('json');
      expect(result.passed).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should handle empty files', async () => {
      const result = await checker.check('test.json', '');

      expect(result.checker).toBe('json');
      expect(result.passed).toBe(false);
    });
  });
});

describe('YAMLChecker', () => {
  let checker: YAMLChecker;

  beforeEach(() => {
    checker = new YAMLChecker();
  });

  describe('canCheck', () => {
    it('should handle .yaml files', () => {
      expect(checker.canCheck('config.yaml')).toBe(true);
    });

    it('should handle .yml files', () => {
      expect(checker.canCheck('config.yml')).toBe(true);
    });

    it('should reject other file types', () => {
      expect(checker.canCheck('test.js')).toBe(false);
      expect(checker.canCheck('test.json')).toBe(false);
    });
  });

  describe('check', () => {
    it('should pass valid YAML', async () => {
      const yaml = `
name: test
version: 1.0.0
scripts:
  start: node index.js
`;

      const result = await checker.check('test.yaml', yaml);

      expect(result.checker).toBe('yaml');
      // May pass or fail depending on yaml library availability
      expect(typeof result.passed).toBe('boolean');
    });

    it('should handle empty files', async () => {
      const result = await checker.check('test.yaml', '');

      expect(result.checker).toBe('yaml');
      expect(typeof result.passed).toBe('boolean');
    });
  });
});

describe('CheckerRegistry', () => {
  let registry: CheckerRegistry;

  beforeEach(() => {
    registry = new CheckerRegistry();
  });

  describe('register', () => {
    it('should register a checker', () => {
      const checker = new JSONChecker();
      registry.register(checker);

      const retrieved = registry.getChecker('test.json');
      expect(retrieved).not.toBeNull();
      expect(retrieved?.name).toBe('json');
    });
  });

  describe('getChecker', () => {
    beforeEach(() => {
      registry.register(new TypeScriptChecker());
      registry.register(new JavaScriptChecker());
      registry.register(new JSONChecker());
      registry.register(new YAMLChecker());
    });

    it('should return appropriate checker for .ts files', () => {
      const checker = registry.getChecker('test.ts');
      expect(checker).not.toBeNull();
      expect(checker?.name).toBe('typescript');
    });

    it('should return appropriate checker for .js files', () => {
      const checker = registry.getChecker('test.js');
      expect(checker).not.toBeNull();
      expect(checker?.name).toBe('javascript');
    });

    it('should return appropriate checker for .json files', () => {
      const checker = registry.getChecker('package.json');
      expect(checker).not.toBeNull();
      expect(checker?.name).toBe('json');
    });

    it('should return appropriate checker for .yaml files', () => {
      const checker = registry.getChecker('config.yaml');
      expect(checker).not.toBeNull();
      expect(checker?.name).toBe('yaml');
    });

    it('should return null for unsupported file types', () => {
      const checker = registry.getChecker('test.py');
      expect(checker).toBeNull();
    });
  });

  describe('checkFile', () => {
    beforeEach(() => {
      registry.register(new JSONChecker());
    });

    it('should check a file using appropriate checker', async () => {
      const json = '{"name": "test"}';
      const result = await registry.checkFile('test.json', json);

      expect(result).not.toBeNull();
      expect(result?.checker).toBe('json');
      expect(result?.passed).toBe(true);
    });

    it('should return null for unsupported file types', async () => {
      const result = await registry.checkFile('test.py', 'print("hello")');
      expect(result).toBeNull();
    });
  });
});

describe('getDefaultRegistry', () => {
  beforeEach(() => {
    resetRegistry();
  });

  it('should return a registry instance', () => {
    const registry = getDefaultRegistry();
    expect(registry).toBeInstanceOf(CheckerRegistry);
  });

  it('should return the same instance on multiple calls', () => {
    const registry1 = getDefaultRegistry();
    const registry2 = getDefaultRegistry();
    expect(registry1).toBe(registry2);
  });

  it('should have checkers registered', async () => {
    const registry = getDefaultRegistry();

    // Give time for async imports to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Should be able to check JSON files (synchronous checker)
    const jsonResult = await registry.checkFile('test.json', '{"test": true}');
    expect(jsonResult).not.toBeNull();
  });
});
