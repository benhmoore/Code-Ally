#!/usr/bin/env node
/**
 * Build script to copy agent markdown files from src/agents to dist/agents
 */

import { cpSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const srcAgents = join(projectRoot, 'src', 'agents');
const distAgents = join(projectRoot, 'dist', 'agents');

try {
  if (!existsSync(srcAgents)) {
    console.error('✗ Source agents directory not found:', srcAgents);
    process.exit(1);
  }

  cpSync(srcAgents, distAgents, { recursive: true });
  console.log('✓ Copied agent files to dist/agents/');
} catch (error) {
  console.error('✗ Failed to copy agent files:', error.message);
  process.exit(1);
}
