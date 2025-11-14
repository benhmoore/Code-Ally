/**
 * YAML frontmatter parsing utilities
 *
 * Provides functions for parsing YAML-style frontmatter from markdown files.
 * Used for agent definitions and plugin configurations.
 */

/**
 * Parse YAML-style frontmatter from markdown content
 *
 * Supports:
 * - Simple key-value pairs (string, number, boolean)
 * - JSON arrays (e.g., tools: ["Read", "Write"], visible_from_agents: ["explore", "plan"])
 * - Boolean values (e.g., can_delegate_to_agents: true, can_see_agents: false)
 * - Multiline strings using pipe syntax (key: |)
 * - Nested objects with 2-space indentation
 *
 * @param frontmatter - The frontmatter content (without --- delimiters)
 * @returns Parsed metadata object
 *
 * @example
 * ```typescript
 * const frontmatter = `
 * name: "My Agent"
 * tools: ["Read", "Write"]
 * visible_from_agents: ["explore", "plan"]
 * can_delegate_to_agents: false
 * can_see_agents: true
 * requirements:
 *   require_tool_use: true
 *   max_retries: 2
 * `;
 * const metadata = parseFrontmatterYAML(frontmatter);
 * // { name: "My Agent", tools: ["Read", "Write"], visible_from_agents: ["explore", "plan"],
 * //   can_delegate_to_agents: false, can_see_agents: true,
 * //   requirements: { require_tool_use: true, max_retries: 2 } }
 * ```
 */
export function parseFrontmatterYAML(frontmatter: string): Record<string, any> {
  const metadata: Record<string, any> = {};

  // Parse YAML-style frontmatter
  const lines = frontmatter.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line) {
      i++;
      continue;
    }

    const match = line.match(/^(\w+):\s*(.*)$/);

    if (match) {
      const key = match[1];
      const value = match[2];

      if (key && value !== undefined) {
        // Handle multiline strings (usage_guidelines: |)
        if (value.trim() === '|') {
          const multilineContent: string[] = [];
          i++;
          // Collect indented lines following the |
          while (i < lines.length) {
            const nextLine = lines[i];
            if (!nextLine || (!nextLine.startsWith('  ') && nextLine.trim() !== '')) {
              break;
            }
            // Remove the indentation (first 2 spaces)
            multilineContent.push(nextLine.replace(/^  /, ''));
            i++;
          }
          metadata[key] = multilineContent.join('\n').trim();
          continue; // Don't increment i again, already done
        }
        // Handle JSON arrays (for tools, visible_from_agents fields)
        else if (value.trim().startsWith('[')) {
          try {
            metadata[key] = JSON.parse(value);
          } catch {
            // If JSON parse fails, treat as string
            metadata[key] = value.replace(/^["']|["']$/g, '');
          }
        }
        // Handle boolean values (for can_delegate_to_agents, can_see_agents fields)
        else if (value.trim() === 'true') {
          metadata[key] = true;
        }
        else if (value.trim() === 'false') {
          metadata[key] = false;
        }
        // Handle nested objects (requirements: or other future nested fields)
        else if (value.trim() === '' || value.trim() === ':') {
          // This is a nested object - collect indented key-value pairs
          const nestedObj: Record<string, any> = {};
          i++;
          while (i < lines.length) {
            const nextLine = lines[i];
            if (!nextLine || (!nextLine.startsWith('  ') && nextLine.trim() !== '')) {
              break;
            }
            // Parse nested key-value pair
            const nestedMatch = nextLine.match(/^  (\w+):\s*(.*)$/);
            if (nestedMatch && nestedMatch[1] && nestedMatch[2] !== undefined) {
              const nestedKey = nestedMatch[1];
              const nestedValue = nestedMatch[2];
              // Parse nested value
              if (nestedValue.startsWith('[')) {
                try {
                  nestedObj[nestedKey] = JSON.parse(nestedValue);
                } catch {
                  nestedObj[nestedKey] = nestedValue.replace(/^["']|["']$/g, '');
                }
              } else if (nestedValue === 'true') {
                nestedObj[nestedKey] = true;
              } else if (nestedValue === 'false') {
                nestedObj[nestedKey] = false;
              } else if (!isNaN(Number(nestedValue))) {
                nestedObj[nestedKey] = Number(nestedValue);
              } else {
                nestedObj[nestedKey] = nestedValue.replace(/^["']|["']$/g, '');
              }
            }
            i++;
          }
          metadata[key] = nestedObj;
          continue;
        } else {
          // Remove quotes from simple values
          metadata[key] = value.replace(/^["']|["']$/g, '');
        }
      }
    }
    i++;
  }

  return metadata;
}

/**
 * Extract frontmatter and body from markdown content
 *
 * @param content - Full markdown content with frontmatter
 * @returns Object with frontmatter and body strings, or null if invalid format
 *
 * @example
 * ```typescript
 * const content = `---
 * name: "Agent"
 * ---
 * This is the body`;
 * const result = extractFrontmatter(content);
 * // { frontmatter: 'name: "Agent"', body: 'This is the body' }
 * ```
 */
export function extractFrontmatter(
  content: string
): { frontmatter: string; body: string } | null {
  const frontmatterMatch = content.match(/^---\n([\s\S]+?)\n---\n([\s\S]+)$/);

  if (!frontmatterMatch) {
    return null;
  }

  const frontmatter = frontmatterMatch[1];
  const body = frontmatterMatch[2];

  if (!frontmatter || !body) {
    return null;
  }

  return { frontmatter, body };
}
