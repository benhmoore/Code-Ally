/**
 * ProjectWizardView - Interactive project setup wizard UI
 *
 * Multi-step wizard for creating ALLY.md configuration:
 * 1. Welcome screen
 * 2. Project name & description
 * 3. Primary language
 * 4. Development commands
 * 5. Code style preferences
 * 6. Completion screen
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import * as fs from 'fs/promises';
import * as path from 'path';

enum WizardStep {
  WELCOME,
  PROJECT_NAME,
  DESCRIPTION,
  LANGUAGE,
  SETUP_COMMANDS,
  BUILD_COMMANDS,
  TEST_COMMANDS,
  FORMATTER,
  LINTER,
  GENERATING,
  COMPLETED,
}

interface ProjectWizardViewProps {
  onComplete: () => void;
  onSkip?: () => void;
}

export const ProjectWizardView: React.FC<ProjectWizardViewProps> = ({ onComplete, onSkip }) => {
  const [step, setStep] = useState<WizardStep>(WizardStep.WELCOME);
  const [projectName, setProjectName] = useState(path.basename(process.cwd()));
  const [projectNameInput, setProjectNameInput] = useState(path.basename(process.cwd()));
  const [description, setDescription] = useState('');
  const [descriptionInput, setDescriptionInput] = useState('');
  const [language, setLanguage] = useState('TypeScript');
  const [languageInput, setLanguageInput] = useState('TypeScript');
  const [setupCommands, setSetupCommands] = useState<string[]>([]);
  const [setupCommandInput, setSetupCommandInput] = useState('');
  const [buildCommands, setBuildCommands] = useState<string[]>([]);
  const [buildCommandInput, setBuildCommandInput] = useState('');
  const [testCommands, setTestCommands] = useState<string[]>([]);
  const [testCommandInput, setTestCommandInput] = useState('');
  const [formatter, setFormatter] = useState('');
  const [formatterInput, setFormatterInput] = useState('');
  const [linter, setLinter] = useState('');
  const [linterInput, setLinterInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Handle keyboard input
  useInput((input, key) => {
    if (step === WizardStep.WELCOME) {
      if (key.return) {
        setStep(WizardStep.PROJECT_NAME);
      } else if (input === 's' || input === 'S') {
        if (onSkip) {
          onSkip();
        }
      }
    } else if (step === WizardStep.PROJECT_NAME) {
      if (key.return) {
        setProjectName(projectNameInput);
        setStep(WizardStep.DESCRIPTION);
      } else if (key.backspace || key.delete) {
        setProjectNameInput((prev) => prev.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setProjectNameInput((prev) => prev + input);
      }
    } else if (step === WizardStep.DESCRIPTION) {
      if (key.return) {
        setDescription(descriptionInput);
        setStep(WizardStep.LANGUAGE);
      } else if (key.backspace || key.delete) {
        setDescriptionInput((prev) => prev.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setDescriptionInput((prev) => prev + input);
      }
    } else if (step === WizardStep.LANGUAGE) {
      if (key.return) {
        setLanguage(languageInput);
        setStep(WizardStep.SETUP_COMMANDS);
      } else if (key.backspace || key.delete) {
        setLanguageInput((prev) => prev.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setLanguageInput((prev) => prev + input);
      }
    } else if (step === WizardStep.SETUP_COMMANDS) {
      if (key.return) {
        if (setupCommandInput.trim()) {
          setSetupCommands([...setupCommands, setupCommandInput.trim()]);
          setSetupCommandInput('');
        } else {
          setStep(WizardStep.BUILD_COMMANDS);
        }
      } else if (key.backspace || key.delete) {
        setSetupCommandInput((prev) => prev.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setSetupCommandInput((prev) => prev + input);
      }
    } else if (step === WizardStep.BUILD_COMMANDS) {
      if (key.return) {
        if (buildCommandInput.trim()) {
          setBuildCommands([...buildCommands, buildCommandInput.trim()]);
          setBuildCommandInput('');
        } else {
          setStep(WizardStep.TEST_COMMANDS);
        }
      } else if (key.backspace || key.delete) {
        setBuildCommandInput((prev) => prev.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setBuildCommandInput((prev) => prev + input);
      }
    } else if (step === WizardStep.TEST_COMMANDS) {
      if (key.return) {
        if (testCommandInput.trim()) {
          setTestCommands([...testCommands, testCommandInput.trim()]);
          setTestCommandInput('');
        } else {
          setStep(WizardStep.FORMATTER);
        }
      } else if (key.backspace || key.delete) {
        setTestCommandInput((prev) => prev.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setTestCommandInput((prev) => prev + input);
      }
    } else if (step === WizardStep.FORMATTER) {
      if (key.return) {
        setFormatter(formatterInput);
        setStep(WizardStep.LINTER);
      } else if (key.backspace || key.delete) {
        setFormatterInput((prev) => prev.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setFormatterInput((prev) => prev + input);
      }
    } else if (step === WizardStep.LINTER) {
      if (key.return) {
        setLinter(linterInput);
        generateAllyFile();
      } else if (key.backspace || key.delete) {
        setLinterInput((prev) => prev.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setLinterInput((prev) => prev + input);
      }
    } else if (step === WizardStep.COMPLETED) {
      if (key.return) {
        onComplete();
      }
    }
  });

  const generateAllyFile = async () => {
    setStep(WizardStep.GENERATING);
    setError(null);

    try {
      const allyPath = path.join(process.cwd(), 'ALLY.md');

      let content = `# ALLY.md

This file provides project-specific guidance to Code Ally when working with this codebase.

## Project Information

**Name**: ${projectName}
**Primary Language**: ${language}
`;

      if (description) {
        content += `**Description**: ${description}\n`;
      }

      content += '\n## Development Commands\n';

      if (setupCommands.length > 0) {
        content += '\n### Environment Setup\n```bash\n';
        content += setupCommands.join('\n') + '\n';
        content += '```\n';
      }

      if (buildCommands.length > 0) {
        content += '\n### Build\n```bash\n';
        content += buildCommands.join('\n') + '\n';
        content += '```\n';
      }

      if (testCommands.length > 0) {
        content += '\n### Testing\n```bash\n';
        content += testCommands.join('\n') + '\n';
        content += '```\n';
      }

      content += '\n## Code Style & Standards\n';
      if (formatter) {
        content += `**Formatter**: ${formatter}\n`;
      }
      if (linter) {
        content += `**Linter**: ${linter}\n`;
      }

      content += `
## Notes for Code Ally

- Please follow the development commands and coding standards specified above when working with this project.
`;

      await fs.writeFile(allyPath, content, 'utf-8');
      setStep(WizardStep.COMPLETED);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create ALLY.md');
      setStep(WizardStep.COMPLETED);
    }
  };

  return (
    <Box flexDirection="column" padding={1}>
      {step === WizardStep.WELCOME && (
        <Box flexDirection="column">
          <Box borderStyle="double" borderColor="cyan" padding={1} marginBottom={1}>
            <Text bold color="cyan">
              Welcome to Project Configuration!
            </Text>
          </Box>
          <Text>
            This wizard will help you create an ALLY.md file for your project.
          </Text>
          <Text dimColor>
            This file provides context to Code Ally about your project's structure,
          </Text>
          <Text dimColor>
            development practices, and specific requirements.
          </Text>
          <Box marginTop={1}>
            <Text>
              Press <Text color="green" bold>Enter</Text> to continue or <Text color="yellow" bold>S</Text> to skip
            </Text>
          </Box>
        </Box>
      )}

      {step === WizardStep.PROJECT_NAME && (
        <Box flexDirection="column">
          <Text bold color="cyan">Project Name:</Text>
          <Box marginTop={1}>
            <Text color="green">&gt; </Text>
            <Text>{projectNameInput}</Text>
            <Text color="gray">█</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Press Enter to continue</Text>
          </Box>
        </Box>
      )}

      {step === WizardStep.DESCRIPTION && (
        <Box flexDirection="column">
          <Text bold color="cyan">Brief project description (optional):</Text>
          <Box marginTop={1}>
            <Text color="green">&gt; </Text>
            <Text>{descriptionInput}</Text>
            <Text color="gray">█</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Press Enter to continue</Text>
          </Box>
        </Box>
      )}

      {step === WizardStep.LANGUAGE && (
        <Box flexDirection="column">
          <Text bold color="cyan">Primary programming language:</Text>
          <Box marginTop={1}>
            <Text color="green">&gt; </Text>
            <Text>{languageInput}</Text>
            <Text color="gray">█</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Press Enter to continue</Text>
          </Box>
        </Box>
      )}

      {step === WizardStep.SETUP_COMMANDS && (
        <Box flexDirection="column">
          <Text bold color="cyan">Setup commands (e.g., npm install):</Text>
          {setupCommands.map((cmd, i) => (
            <Box key={i} marginLeft={2}>
              <Text color="green">✓ </Text>
              <Text>{cmd}</Text>
            </Box>
          ))}
          <Box marginTop={1}>
            <Text color="green">&gt; </Text>
            <Text>{setupCommandInput}</Text>
            <Text color="gray">█</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Press Enter to add command, or Enter on empty line to continue</Text>
          </Box>
        </Box>
      )}

      {step === WizardStep.BUILD_COMMANDS && (
        <Box flexDirection="column">
          <Text bold color="cyan">Build commands (e.g., npm run build):</Text>
          {buildCommands.map((cmd, i) => (
            <Box key={i} marginLeft={2}>
              <Text color="green">✓ </Text>
              <Text>{cmd}</Text>
            </Box>
          ))}
          <Box marginTop={1}>
            <Text color="green">&gt; </Text>
            <Text>{buildCommandInput}</Text>
            <Text color="gray">█</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Press Enter to add command, or Enter on empty line to continue</Text>
          </Box>
        </Box>
      )}

      {step === WizardStep.TEST_COMMANDS && (
        <Box flexDirection="column">
          <Text bold color="cyan">Test commands (e.g., npm test):</Text>
          {testCommands.map((cmd, i) => (
            <Box key={i} marginLeft={2}>
              <Text color="green">✓ </Text>
              <Text>{cmd}</Text>
            </Box>
          ))}
          <Box marginTop={1}>
            <Text color="green">&gt; </Text>
            <Text>{testCommandInput}</Text>
            <Text color="gray">█</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Press Enter to add command, or Enter on empty line to continue</Text>
          </Box>
        </Box>
      )}

      {step === WizardStep.FORMATTER && (
        <Box flexDirection="column">
          <Text bold color="cyan">Code formatter (e.g., prettier, black):</Text>
          <Box marginTop={1}>
            <Text color="green">&gt; </Text>
            <Text>{formatterInput}</Text>
            <Text color="gray">█</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Press Enter to continue</Text>
          </Box>
        </Box>
      )}

      {step === WizardStep.LINTER && (
        <Box flexDirection="column">
          <Text bold color="cyan">Linter (e.g., eslint, ruff):</Text>
          <Box marginTop={1}>
            <Text color="green">&gt; </Text>
            <Text>{linterInput}</Text>
            <Text color="gray">█</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Press Enter to generate ALLY.md</Text>
          </Box>
        </Box>
      )}

      {step === WizardStep.GENERATING && (
        <Box flexDirection="column">
          <Text color="yellow">⏳ Generating ALLY.md...</Text>
        </Box>
      )}

      {step === WizardStep.COMPLETED && (
        <Box flexDirection="column">
          {error ? (
            <>
              <Text color="red" bold>✗ Error creating ALLY.md</Text>
              <Text color="red">{error}</Text>
            </>
          ) : (
            <>
              <Box borderStyle="double" borderColor="green" padding={1} marginBottom={1}>
                <Text bold color="green">
                  ✓ Project Configuration Complete!
                </Text>
              </Box>
              <Text>Generated ALLY.md in: <Text color="cyan">{process.cwd()}/ALLY.md</Text></Text>
              <Box marginTop={1}>
                <Text>Code Ally will now use this configuration when working in this project.</Text>
              </Box>
              <Box marginTop={1}>
                <Text>You can:</Text>
                <Text>  • Edit ALLY.md manually to add more details</Text>
                <Text>  • Regenerate it anytime with <Text color="cyan">/project init</Text></Text>
                <Text>  • View it with <Text color="cyan">/project view</Text></Text>
              </Box>
            </>
          )}
          <Box marginTop={1}>
            <Text>Press <Text color="green" bold>Enter</Text> to continue</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
};
