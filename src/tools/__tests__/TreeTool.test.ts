/**
 * Tests for TreeTool
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TreeTool } from '../TreeTool.js';
import { ActivityStream } from '@services/ActivityStream.js';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

describe('TreeTool', () => {
  let activityStream: ActivityStream;
  let treeTool: TreeTool;
  let tempDir: string;

  beforeEach(async () => {
    activityStream = new ActivityStream();
    treeTool = new TreeTool(activityStream);

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tree-tool-test-'));
    await fs.writeFile(path.join(tempDir, 'README.md'), '# Test\n');
    await fs.mkdir(path.join(tempDir, 'src'));
    await fs.writeFile(path.join(tempDir, 'src', 'index.ts'), 'export {};\n');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('execute', () => {
    it('keeps the raw tree in content and a compact tree in display_content', async () => {
      const result = await treeTool.execute({
        paths: [tempDir],
        depth: 2,
      });

      expect(result.success).toBe(true);
      expect(result.content).toContain(`=== ${tempDir} ===`);
      expect(result.display_content).toBeDefined();
      expect(result.display_content).not.toContain('===');
      expect(result.display_content).not.toContain(tempDir);
      expect(result.display_content.split('\n')[0]).toBe(`${path.basename(tempDir)}/`);
      expect(result.display_content).toContain('README.md');
      expect(result.display_content).toContain('src');
    });
  });

  describe('display behavior', () => {
    it('hides tree output and omits the default dot path from subtext', () => {
      expect(treeTool.hideOutput).toBe(true);
      expect(treeTool.formatSubtext({ paths: ['.'] })).toBeNull();
      expect(treeTool.formatSubtext({ paths: ['./'] })).toBeNull();
      expect(treeTool.formatSubtext({ paths: ['src'] })).toBe('src');
    });
  });

  describe('getResultPreview', () => {
    it('previews the compact display tree instead of the raw model content', async () => {
      const result = await treeTool.execute({
        paths: [tempDir],
        depth: 1,
      });

      const preview = treeTool.getResultPreview(result, 3);

      expect(preview[0]).toBe(`${path.basename(tempDir)}/`);
      expect(preview.join('\n')).not.toContain('===');
      expect(preview.join('\n')).not.toContain(tempDir);
    });
  });
});
