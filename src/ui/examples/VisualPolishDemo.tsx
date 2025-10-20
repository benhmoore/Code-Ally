/**
 * Visual Polish Demo
 *
 * Demonstrates all the new UI polish features:
 * - Animated status line with agent/sub-agent display
 * - Markdown rendering with syntax highlighting
 * - Diff display with color-coded changes
 * - Progress indicators with multiple spinner types
 * - Tool output streaming
 */

import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { StatusLine } from '../components/StatusLine.js';
import { MarkdownText } from '../components/MarkdownText.js';
import { DiffDisplay } from '../components/DiffDisplay.js';
import {
  ProgressIndicator,
  ThinkingIndicator,
  ToolExecutionIndicator,
} from '../components/ProgressIndicator.js';
import { ToolOutputStream, StreamingToolOutput } from '../components/ToolOutputStream.js';

/**
 * Visual Polish Demo Component
 *
 * Shows off all the new visual features in action.
 */
export const VisualPolishDemo: React.FC = () => {
  const [contextUsage, setContextUsage] = useState(45);
  const [activeTools, setActiveTools] = useState(0);
  const [startTime] = useState(Date.now());

  // Animate context usage
  useEffect(() => {
    const interval = setInterval(() => {
      setContextUsage((prev) => (prev < 95 ? prev + 5 : 45));
      setActiveTools((prev) => (prev < 3 ? prev + 1 : 0));
    }, 2000);

    return () => clearInterval(interval);
  }, []);

  const markdownContent = `
# Code Ally UI Polish Demo

This demonstrates the new **visual polish features**:

## Features

1. **Animated Status Line** - Shows agent activity
2. **Markdown Rendering** - With syntax highlighting
3. **Diff Display** - Color-coded file changes
4. **Progress Indicators** - Multiple spinner types

### Code Example

\`\`\`typescript
interface Agent {
  name: string;
  status: 'active' | 'idle';
  execute: () => Promise<void>;
}

const agent: Agent = {
  name: 'code-reviewer',
  status: 'active',
  execute: async () => {
    console.log('Reviewing code...');
  }
};
\`\`\`

### Inline Code

Use \`const x = 5;\` for inline code.

## Lists

- Animated spinners
- Syntax highlighting
- Diff previews
- Tool output streaming

That's it!
  `;

  const oldCode = `function greet(name) {
  console.log("Hello " + name);
}

greet("World");
`;

  const newCode = `function greet(name: string): void {
  console.log(\`Hello \${name}!\`);
}

function farewell(name: string): void {
  console.log(\`Goodbye \${name}!\`);
}

greet("World");
farewell("World");
`;

  const toolOutput = `Searching files...
Found 15 matches in 8 files
Processing results...
Completed successfully!`;

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Visual Polish Demo
        </Text>
      </Box>

      {/* Status Line Demo */}
      <Box marginBottom={2} flexDirection="column">
        <Text bold color="yellow">
          1. Animated Status Line
        </Text>
        <StatusLine
          contextUsagePercent={contextUsage}
          activeToolCount={activeTools}
          modelName="qwen2.5-coder"
          agent="code-reviewer"
          subAgents={['security-checker', 'style-linter']}
          alwaysShow={true}
        />
      </Box>

      {/* Progress Indicators Demo */}
      <Box marginBottom={2} flexDirection="column">
        <Text bold color="yellow">
          2. Progress Indicators
        </Text>
        <Box paddingLeft={2} flexDirection="column">
          <ProgressIndicator type="dots" text="Loading..." color="cyan" />
          <ThinkingIndicator
            context="analyzing"
            tokenCount={150}
            modelName="qwen2.5-coder"
            startTime={startTime}
          />
          <ToolExecutionIndicator
            toolName="grep"
            description="Searching for pattern in files"
            startTime={startTime}
          />
        </Box>
      </Box>

      {/* Markdown Rendering Demo */}
      <Box marginBottom={2} flexDirection="column">
        <Text bold color="yellow">
          3. Markdown Rendering
        </Text>
        <Box borderStyle="single" borderColor="gray" paddingX={1}>
          <MarkdownText content={markdownContent} />
        </Box>
      </Box>

      {/* Diff Display Demo */}
      <Box marginBottom={2} flexDirection="column">
        <Text bold color="yellow">
          4. Diff Display
        </Text>
        <DiffDisplay
          oldContent={oldCode}
          newContent={newCode}
          filePath="greet.ts"
          maxLines={20}
        />
      </Box>

      {/* Tool Output Demo */}
      <Box marginBottom={2} flexDirection="column">
        <Text bold color="yellow">
          5. Tool Output Streaming
        </Text>
        <ToolOutputStream
          toolName="grep"
          output={toolOutput}
          status="success"
          maxLines={10}
        />
      </Box>

      {/* Streaming Tool Output Demo */}
      <Box marginBottom={2} flexDirection="column">
        <Text bold color="yellow">
          6. Streaming Tool Output
        </Text>
        <StreamingToolOutput
          toolName="bash"
          description="Running build command"
          outputLines={[
            'npm run build',
            'Compiling TypeScript...',
            'src/services/SyntaxHighlighter.ts',
            'src/ui/components/MarkdownText.tsx',
            'src/ui/components/DiffDisplay.tsx',
            'Build complete!',
          ]}
          maxVisibleLines={5}
          elapsedSeconds={Math.floor((Date.now() - startTime) / 1000)}
        />
      </Box>

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>
          All features working! Press Ctrl+C to exit.
        </Text>
      </Box>
    </Box>
  );
};
