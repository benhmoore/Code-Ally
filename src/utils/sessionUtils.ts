/**
 * Session utilities for formatting and processing session data
 */

import { Session, ToolCall } from '../types/index.js';
import { TEXT_LIMITS } from '../config/constants.js';

/**
 * Format tool call for minimal display
 */
function formatToolCall(toolCall: ToolCall): string {
  const args = toolCall.function.arguments;
  const keyArgs = Object.keys(args)
    .filter(k => !['todo_id', 'current_directory_only', 'all', 'long'].includes(k))
    .map(k => {
      const val = args[k];
      if (typeof val === 'string' && val.length > 50) {
        return `${k}="${val.slice(0, 47)}..."`;
      }
      if (Array.isArray(val)) {
        return `${k}=[${val.length} items]`;
      }
      return `${k}=${JSON.stringify(val)}`;
    })
    .join(', ');

  return `${toolCall.function.name}(${keyArgs})`;
}

/**
 * Compress tool result content for minimal display
 */
function compressToolResult(content: string, toolName: string): string {
  if (!content || content.length === 0) {
    return 'No output';
  }

  // Handle error messages
  if (content.startsWith('Error')) {
    const firstLine = content.split('\n')[0] || content;
    return firstLine.slice(0, TEXT_LIMITS.MESSAGE_PREVIEW_MAX);
  }

  // Handle duplicate markers
  if (content.includes('[Duplicate tool result truncated')) {
    return 'Duplicate result (skipped)';
  }

  // Try to parse as JSON (many tools return JSON)
  try {
    const parsed = JSON.parse(content);

    // Handle structured results
    if (parsed.success !== undefined) {
      if (!parsed.success) {
        return `Error: ${parsed.error || 'Unknown error'}`;
      }

      // Extract meaningful summary
      if (parsed.content) {
        const lines = parsed.content.split('\n');
        if (lines.length > 5) {
          return `${lines[0]}\n...(${lines.length} lines total)`;
        }
        return parsed.content.slice(0, TEXT_LIMITS.CONTENT_PREVIEW_MAX);
      }
    }
  } catch {
    // Not JSON, treat as plain text
  }

  // For sessions tool results
  if (toolName === 'sessions' && content.includes('Found')) {
    return content.split('\n')[0] || content;
  }

  // Default: first line or first N chars
  const firstLine = content.split('\n')[0] || content;
  if (firstLine.length > TEXT_LIMITS.CONTENT_PREVIEW_MAX) {
    return `${firstLine.slice(0, TEXT_LIMITS.CONTENT_PREVIEW_MAX - 3)}...`;
  }
  return firstLine;
}

/**
 * Format session for LLM query
 *
 * Strips timestamps, IDs, verbose tool results to save tokens
 */
export function formatSessionForQuery(session: Session): string {
  const parts: string[] = [];

  // Metadata
  const date = new Date(session.created_at).toLocaleDateString();
  parts.push(`<metadata>`);
  parts.push(`Session: ${session.metadata?.title || session.id}`);
  parts.push(`Working Directory: ${session.working_dir}`);
  parts.push(`Date: ${date}`);
  parts.push(`</metadata>`);
  parts.push('');
  parts.push(`<conversation>`);

  // Process messages
  for (const msg of session.messages) {
    // Skip system messages
    if (msg.role === 'system') {
      continue;
    }

    // User messages
    if (msg.role === 'user') {
      parts.push(`User: ${msg.content}`);
      parts.push('');
      continue;
    }

    // Assistant messages
    if (msg.role === 'assistant') {
      // Text response
      if (msg.content && msg.content.trim().length > 0) {
        parts.push(`Assistant: ${msg.content}`);
        parts.push('');
      }

      // Tool calls
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        if (msg.tool_calls.length === 1) {
          parts.push(`Assistant used tool:`);
        } else {
          parts.push(`Assistant used ${msg.tool_calls.length} tools:`);
        }

        for (const toolCall of msg.tool_calls) {
          parts.push(`- ${formatToolCall(toolCall)}`);
        }
        parts.push('');
      }
      continue;
    }

    // Tool results
    if (msg.role === 'tool' && msg.name) {
      const compressed = compressToolResult(msg.content, msg.name);
      parts.push(`  Result: ${compressed}`);
      parts.push('');
    }
  }

  parts.push(`</conversation>`);

  return parts.join('\n');
}
