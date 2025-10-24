/**
 * ConfigViewer - Interactive configuration viewer
 *
 * Displays all configuration settings organized by category with current and default values
 * Fetches data from ServiceRegistry on each render for live updates
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import { ConfigManager } from '../../services/ConfigManager.js';
import { DEFAULT_CONFIG, CONFIG_TYPES } from '../../config/defaults.js';

export interface ConfigEntry {
  key: string;
  type: string;
  currentValue: any;
  defaultValue: any;
  isModified: boolean;
}

export interface ConfigCategory {
  name: string;
  entries: ConfigEntry[];
}

export interface ConfigViewerProps {
  /** Whether the viewer is visible */
  visible?: boolean;
}

/**
 * ConfigViewer Component
 */
export const ConfigViewer: React.FC<ConfigViewerProps> = ({
  visible = true,
}) => {
  // Fetch current config on each render for live updates
  const categories = useMemo(() => {
    const registry = ServiceRegistry.getInstance();
    const configManager = registry.get('config_manager') as ConfigManager;
    const config = configManager.getConfig();

    // Group configurations by category
    const categoryDefs = {
      'LLM Model Settings': ['model', 'endpoint', 'context_size', 'temperature', 'max_tokens'],
      'Execution Settings': ['bash_timeout', 'auto_confirm', 'parallel_tools'],
      'UI Preferences': ['theme', 'compact_threshold', 'show_context_in_prompt'],
      'Tool Result Preview': ['tool_result_preview_lines', 'tool_result_preview_enabled'],
      'Diff Display': ['diff_display_enabled', 'diff_display_max_file_size', 'diff_display_context_lines', 'diff_display_theme', 'diff_display_color_removed', 'diff_display_color_added', 'diff_display_color_modified'],
      'Tool Result Truncation': ['tool_result_max_tokens_normal', 'tool_result_max_tokens_moderate', 'tool_result_max_tokens_aggressive', 'tool_result_max_tokens_critical'],
    };

    // Build categories
    return Object.entries(categoryDefs).map(([name, keys]) => ({
      name,
      entries: keys.map(key => ({
        key,
        type: (CONFIG_TYPES as any)[key],
        currentValue: (config as any)[key],
        defaultValue: (DEFAULT_CONFIG as any)[key],
        isModified: JSON.stringify((config as any)[key]) !== JSON.stringify((DEFAULT_CONFIG as any)[key]),
      })),
    }));
  }, []); // Empty deps means recalculate on every render for live updates

  if (!visible) {
    return null;
  }

  // Calculate column widths for alignment
  let maxKeyWidth = 0;
  let maxTypeWidth = 0;
  let maxCurrentWidth = 0;
  let maxDefaultWidth = 0;

  categories.forEach(category => {
    category.entries.forEach(entry => {
      maxKeyWidth = Math.max(maxKeyWidth, entry.key.length);
      maxTypeWidth = Math.max(maxTypeWidth, entry.type.length);
      maxCurrentWidth = Math.max(maxCurrentWidth, JSON.stringify(entry.currentValue).length);
      maxDefaultWidth = Math.max(maxDefaultWidth, JSON.stringify(entry.defaultValue).length);
    });
  });

  // Pad function
  const pad = (text: string, width: number) => text.padEnd(width, ' ');

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Header */}
      <Box
        borderStyle="round"
        borderColor="cyan"
        paddingX={2}
        paddingY={1}
        flexDirection="column"
      >
        <Box marginBottom={1}>
          <Text color="cyan" bold>
            Configuration
          </Text>
        </Box>

        <Box marginBottom={1}>
          <Text dimColor>
            View and modify application settings
          </Text>
        </Box>

        {/* Categories */}
        {categories.map((category, catIdx) => (
          <Box key={catIdx} flexDirection="column" marginTop={catIdx > 0 ? 1 : 0}>
            <Box marginBottom={1}>
              <Text color="yellow" bold>
                {category.name}
              </Text>
            </Box>

            {/* Table header */}
            <Box>
              <Text bold dimColor>
                {pad('Key', maxKeyWidth + 2)}
              </Text>
              <Text bold dimColor>
                {pad('Type', maxTypeWidth + 2)}
              </Text>
              <Text bold dimColor>
                {pad('Current', maxCurrentWidth + 2)}
              </Text>
              <Text bold dimColor>
                {pad('Default', maxDefaultWidth + 2)}
              </Text>
              <Text bold dimColor>
                Status
              </Text>
            </Box>

            {/* Entries */}
            {category.entries.map((entry, idx) => (
              <Box key={idx}>
                <Text color={entry.isModified ? 'green' : undefined}>
                  {pad(entry.key, maxKeyWidth + 2)}
                </Text>
                <Text dimColor>
                  {pad(entry.type, maxTypeWidth + 2)}
                </Text>
                <Text color={entry.isModified ? 'green' : undefined}>
                  {pad(JSON.stringify(entry.currentValue), maxCurrentWidth + 2)}
                </Text>
                <Text dimColor>
                  {pad(JSON.stringify(entry.defaultValue), maxDefaultWidth + 2)}
                </Text>
                <Text color={entry.isModified ? 'yellow' : 'green'}>
                  {entry.isModified ? 'modified' : 'default'}
                </Text>
              </Box>
            ))}
          </Box>
        ))}

        {/* Footer */}
        <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
          <Text dimColor>
            Use /config set key=value to change • /config reset to restore defaults • /config to close
          </Text>
        </Box>
      </Box>
    </Box>
  );
};
