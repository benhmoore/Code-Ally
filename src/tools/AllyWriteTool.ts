/**
 * AllyWriteTool - Append instructions to ALLY.md file
 *
 * Enables appending project-specific instructions to ALLY.md files.
 * ALLY.md contains persistent notes and instructions that are included
 * in the system prompt across conversation sessions.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { BYTE_CONVERSIONS, FORMATTING } from '../config/constants.js';
import * as fs from 'fs/promises';
import * as path from 'path';

export class AllyWriteTool extends BaseTool {
  readonly name = 'ally-write';
  readonly description =
    'Append instructions to ALLY.md file in the current directory. ' +
    'Use this tool when users give instructions they want to remember, such as: ' +
    "'Remember that you should...', 'Always use...', 'Never do...', " +
    "'The project convention is...', 'For this codebase...', etc. " +
    'ALLY.md contains project-specific notes and instructions ' +
    'that persist across conversation sessions.';
  readonly requiresConfirmation = false; // ALLY.md is a project file
  readonly breaksExploratoryStreak = false; // Meta/housekeeping, not productive work

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  /**
   * Provide function definition for LLM
   */
  getFunctionDefinition(): FunctionDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'Content to append to ALLY.md file',
            },
          },
          required: ['content'],
        },
      },
    };
  }

  /**
   * Execute the ALLY.md append operation
   */
  protected async executeImpl(args: any): Promise<ToolResult> {
    try {
      const content = args.content as string;

      if (!content) {
        return {
          success: false,
          error: 'content parameter is required',
        };
      }

      const allyMdPath = path.join(process.cwd(), 'ALLY.md');

      // Read existing content
      let existingContent = '';
      try {
        existingContent = await fs.readFile(allyMdPath, 'utf-8');
      } catch (error: any) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
        // File doesn't exist yet - that's ok
      }

      // Append to Notes for Code Ally section if it exists
      const notesSection = '## Notes for Code Ally';
      let finalContent: string;

      if (existingContent.includes(notesSection)) {
        // Find the Notes section and append as a list item
        const lines = existingContent.split('\n');
        let notesIndex: number | null = null;

        // Find the Notes for Code Ally section
        for (let i = 0; i < lines.length; i++) {
          if (lines[i]?.trim() === notesSection) {
            notesIndex = i;
            break;
          }
        }

        if (notesIndex !== null) {
          // Find the end of the Notes section (next ## section or end of file)
          let sectionEnd = lines.length;
          for (let i = notesIndex + 1; i < lines.length; i++) {
            if (lines[i]?.trim().startsWith('## ') && lines[i]?.trim() !== notesSection) {
              sectionEnd = i;
              break;
            }
          }

          // Format content as list item
          const listItem = `- ${content}`;

          // Insert the new item before the next section (or at end)
          lines.splice(sectionEnd, 0, listItem);
          finalContent = lines.join('\n');
        } else {
          // Fallback: append at end
          const separator = existingContent.endsWith('\n') ? '' : '\n';
          finalContent = existingContent + separator + `- ${content}`;
        }
      } else {
        // No Notes section exists, create one or append at end
        const separator = !existingContent || existingContent.endsWith('\n') ? '' : '\n';
        if (existingContent.trim()) {
          finalContent = existingContent + separator + `\n${notesSection}\n\n- ${content}`;
        } else {
          finalContent = `${notesSection}\n\n- ${content}`;
        }
      }

      // Write the content
      await fs.writeFile(allyMdPath, finalContent, 'utf-8');

      // Get file stats
      const stats = await fs.stat(allyMdPath);
      const lines = finalContent.split('\n').length;

      return {
        success: true,
        error: '',
        path: allyMdPath,
        lines,
        size: stats.size,
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Failed to write ALLY.md: ${error.message}`,
      };
    }
  }

  /**
   * Format the tool result for display
   */
  formatResult(result: ToolResult): string {
    if (!result.success) {
      return `Error writing ALLY.md: ${result.error}`;
    }

    const lines = result.lines || 0;
    const size = result.size || 0;

    // Format file size
    const sizeStr =
      size < BYTE_CONVERSIONS.BYTES_PER_KB
        ? `${size} bytes`
        : `${(size / BYTE_CONVERSIONS.BYTES_PER_KB).toFixed(FORMATTING.FILE_SIZE_DECIMAL_PLACES)} KB`;

    return `📝 Added to ALLY.md (${lines} lines, ${sizeStr})`;
  }
}
