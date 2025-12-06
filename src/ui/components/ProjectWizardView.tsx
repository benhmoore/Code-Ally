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
import { UI_COLORS } from '../constants/colors.js';
import { ModalContainer } from './ModalContainer.js';
import { ChickAnimation } from './ChickAnimation.js';
import { SelectionIndicator } from './SelectionIndicator.js';
import { TextInput } from './TextInput.js';

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
  const [welcomeChoiceIndex, setWelcomeChoiceIndex] = useState(0); // 0 = Continue, 1 = Skip
  const [projectName, setProjectName] = useState(path.basename(process.cwd()));
  const [projectNameBuffer, setProjectNameBuffer] = useState(path.basename(process.cwd()));
  const [projectNameCursor, setProjectNameCursor] = useState(path.basename(process.cwd()).length);
  const [description, setDescription] = useState('');
  const [descriptionBuffer, setDescriptionBuffer] = useState('');
  const [descriptionCursor, setDescriptionCursor] = useState(0);
  const [language, setLanguage] = useState('TypeScript');
  const [languageBuffer, setLanguageBuffer] = useState('TypeScript');
  const [languageCursor, setLanguageCursor] = useState('TypeScript'.length);
  const [setupCommands, setSetupCommands] = useState<string[]>([]);
  const [setupCommandBuffer, setSetupCommandBuffer] = useState('');
  const [setupCommandCursor, setSetupCommandCursor] = useState(0);
  const [buildCommands, setBuildCommands] = useState<string[]>([]);
  const [buildCommandBuffer, setBuildCommandBuffer] = useState('');
  const [buildCommandCursor, setBuildCommandCursor] = useState(0);
  const [testCommands, setTestCommands] = useState<string[]>([]);
  const [testCommandBuffer, setTestCommandBuffer] = useState('');
  const [testCommandCursor, setTestCommandCursor] = useState(0);
  const [formatter, setFormatter] = useState('');
  const [formatterBuffer, setFormatterBuffer] = useState('');
  const [formatterCursor, setFormatterCursor] = useState(0);
  const [linter, setLinter] = useState('');
  const [linterBuffer, setLinterBuffer] = useState('');
  const [linterCursor, setLinterCursor] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Submit handlers for each step
  const handleProjectNameSubmit = (value: string) => {
    setProjectName(value);
    setStep(WizardStep.DESCRIPTION);
  };

  const handleDescriptionSubmit = (value: string) => {
    setDescription(value);
    setStep(WizardStep.LANGUAGE);
  };

  const handleLanguageSubmit = (value: string) => {
    setLanguage(value);
    setStep(WizardStep.SETUP_COMMANDS);
  };

  const handleSetupCommandSubmit = (value: string) => {
    if (value.trim()) {
      setSetupCommands([...setupCommands, value.trim()]);
      setSetupCommandBuffer('');
      setSetupCommandCursor(0);
    } else {
      setStep(WizardStep.BUILD_COMMANDS);
    }
  };

  const handleBuildCommandSubmit = (value: string) => {
    if (value.trim()) {
      setBuildCommands([...buildCommands, value.trim()]);
      setBuildCommandBuffer('');
      setBuildCommandCursor(0);
    } else {
      setStep(WizardStep.TEST_COMMANDS);
    }
  };

  const handleTestCommandSubmit = (value: string) => {
    if (value.trim()) {
      setTestCommands([...testCommands, value.trim()]);
      setTestCommandBuffer('');
      setTestCommandCursor(0);
    } else {
      setStep(WizardStep.FORMATTER);
    }
  };

  const handleFormatterSubmit = (value: string) => {
    setFormatter(value);
    setStep(WizardStep.LINTER);
  };

  const handleLinterSubmit = (value: string) => {
    setLinter(value);
    generateAllyFile();
  };

  // Steps where TextInput is active (handles its own Ctrl+C)
  const isTextInputStep = step !== WizardStep.WELCOME &&
                          step !== WizardStep.GENERATING &&
                          step !== WizardStep.COMPLETED;

  // Handle skip from TextInput's onCtrlC (empty buffer)
  const handleCtrlC = () => {
    if (onSkip) {
      onSkip();
    }
  };

  // Handle keyboard input for non-text-input steps
  useInput((input, key) => {
    // ESC - always exit
    if (key.escape) {
      if (onSkip) {
        onSkip();
      }
      return;
    }

    // Ctrl+C - only handle for non-TextInput steps (TextInput handles its own)
    if (key.ctrl && input === 'c' && !isTextInputStep) {
      if (onSkip) {
        onSkip();
      }
      return;
    }

    if (step === WizardStep.WELCOME) {
      if (key.upArrow) {
        setWelcomeChoiceIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setWelcomeChoiceIndex((prev) => Math.min(1, prev + 1));
      } else if (key.return) {
        if (welcomeChoiceIndex === 0) {
          // Continue
          setStep(WizardStep.PROJECT_NAME);
        } else {
          // Skip
          if (onSkip) {
            onSkip();
          }
        }
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
    <Box flexDirection="column" paddingX={2} paddingY={1} width="100%">
      <ModalContainer borderColor={UI_COLORS.TEXT_DIM}>
        <Box minHeight={20} width="100%" flexDirection="column">
      {step === WizardStep.WELCOME && (
        <>
          {/* Header with ChickAnimation */}
          <Box marginBottom={1} flexDirection="row" gap={1}>
            <Text bold>
              <ChickAnimation />
            </Text>
            <Text color={UI_COLORS.TEXT_DEFAULT} bold>
              Project Configuration
            </Text>
          </Box>

          {/* Main description */}
          <Box marginBottom={1}>
            <Text>
              Quick setup wizard to create an ALLY.md configuration file for your project.
            </Text>
          </Box>

          {/* Feature list header */}
          <Box marginBottom={1}>
            <Text dimColor>
              You'll configure:
            </Text>
          </Box>

          {/* Feature list */}
          <Box paddingLeft={2} marginBottom={1} flexDirection="column">
            <Text dimColor>• Project name and description</Text>
            <Text dimColor>• Primary programming language</Text>
            <Text dimColor>• Setup, build, and test commands</Text>
            <Text dimColor>• Code formatter and linter</Text>
          </Box>

          {/* Footer separator */}
          <Box marginTop={1} borderTop borderColor="gray" paddingTop={1} flexDirection="column" gap={1}>
            <Text dimColor>Select an option:</Text>
            <Box marginLeft={2} flexDirection="column">
              <SelectionIndicator isSelected={welcomeChoiceIndex === 0}>
                Continue
              </SelectionIndicator>
              <SelectionIndicator isSelected={welcomeChoiceIndex === 1}>
                Skip
              </SelectionIndicator>
            </Box>
          </Box>
        </>
      )}

      {step === WizardStep.PROJECT_NAME && (
        <>
          <Box marginBottom={1} flexDirection="row" gap={1}>
            <Text bold>
              <ChickAnimation />
            </Text>
            <Text color={UI_COLORS.TEXT_DEFAULT} bold>
              Step 1: Project Name
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text>
              Enter a name for your project
            </Text>
          </Box>
          <Box marginBottom={1}>
            <TextInput
              label="Project Name:"
              value={projectNameBuffer}
              onValueChange={setProjectNameBuffer}
              cursorPosition={projectNameCursor}
              onCursorChange={setProjectNameCursor}
              onSubmit={handleProjectNameSubmit}
              onEscape={onSkip}
              onCtrlC={handleCtrlC}
              isActive={true}
              multiline={false}
              placeholder="my-project"
            />
          </Box>
          <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
            <Text dimColor>Press Enter to continue</Text>
          </Box>
        </>
      )}

      {step === WizardStep.DESCRIPTION && (
        <>
          <Box marginBottom={1} flexDirection="row" gap={1}>
            <Text bold>
              <ChickAnimation />
            </Text>
            <Text color={UI_COLORS.TEXT_DEFAULT} bold>
              Step 2: Description
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text>
              Enter a brief project description (optional)
            </Text>
          </Box>
          <Box marginBottom={1}>
            <TextInput
              label="Description:"
              value={descriptionBuffer}
              onValueChange={setDescriptionBuffer}
              cursorPosition={descriptionCursor}
              onCursorChange={setDescriptionCursor}
              onSubmit={handleDescriptionSubmit}
              onEscape={onSkip}
              onCtrlC={handleCtrlC}
              isActive={true}
              multiline={false}
              placeholder="A brief description"
            />
          </Box>
          <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
            <Text dimColor>Press Enter to continue</Text>
          </Box>
        </>
      )}

      {step === WizardStep.LANGUAGE && (
        <>
          <Box marginBottom={1} flexDirection="row" gap={1}>
            <Text bold>
              <ChickAnimation />
            </Text>
            <Text color={UI_COLORS.TEXT_DEFAULT} bold>
              Step 3: Primary Language
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text>
              Enter the primary programming language used in this project
            </Text>
          </Box>
          <Box marginBottom={1}>
            <TextInput
              label="Language:"
              value={languageBuffer}
              onValueChange={setLanguageBuffer}
              cursorPosition={languageCursor}
              onCursorChange={setLanguageCursor}
              onSubmit={handleLanguageSubmit}
              onEscape={onSkip}
              onCtrlC={handleCtrlC}
              isActive={true}
              multiline={false}
              placeholder="TypeScript"
            />
          </Box>
          <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
            <Text dimColor>Press Enter to continue</Text>
          </Box>
        </>
      )}

      {step === WizardStep.SETUP_COMMANDS && (
        <>
          <Box marginBottom={1} flexDirection="row" gap={1}>
            <Text bold>
              <ChickAnimation />
            </Text>
            <Text color={UI_COLORS.TEXT_DEFAULT} bold>
              Step 4: Environment Setup
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text>
              Add commands to set up the development environment (e.g., npm install, pip install -r requirements.txt)
            </Text>
          </Box>
          {setupCommands.length > 0 && (
            <Box flexDirection="column" marginBottom={1}>
              {setupCommands.map((cmd, i) => (
                <Box key={i}>
                  <Text color={UI_COLORS.PRIMARY}>✓ </Text>
                  <Text>{cmd}</Text>
                </Box>
              ))}
            </Box>
          )}
          <Box marginBottom={1}>
            <TextInput
              label="Command:"
              value={setupCommandBuffer}
              onValueChange={setSetupCommandBuffer}
              cursorPosition={setupCommandCursor}
              onCursorChange={setSetupCommandCursor}
              onSubmit={handleSetupCommandSubmit}
              onEscape={onSkip}
              onCtrlC={handleCtrlC}
              isActive={true}
              multiline={false}
              placeholder="npm install"
            />
          </Box>
          <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
            <Text dimColor>Press Enter to add command, or Enter on empty line to continue</Text>
          </Box>
        </>
      )}

      {step === WizardStep.BUILD_COMMANDS && (
        <>
          <Box marginBottom={1} flexDirection="row" gap={1}>
            <Text bold>
              <ChickAnimation />
            </Text>
            <Text color={UI_COLORS.TEXT_DEFAULT} bold>
              Step 5: Build Commands
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text>
              Add commands to build the project (e.g., npm run build, make)
            </Text>
          </Box>
          {buildCommands.length > 0 && (
            <Box flexDirection="column" marginBottom={1}>
              {buildCommands.map((cmd, i) => (
                <Box key={i}>
                  <Text color={UI_COLORS.PRIMARY}>✓ </Text>
                  <Text>{cmd}</Text>
                </Box>
              ))}
            </Box>
          )}
          <Box marginBottom={1}>
            <TextInput
              label="Command:"
              value={buildCommandBuffer}
              onValueChange={setBuildCommandBuffer}
              cursorPosition={buildCommandCursor}
              onCursorChange={setBuildCommandCursor}
              onSubmit={handleBuildCommandSubmit}
              onEscape={onSkip}
              onCtrlC={handleCtrlC}
              isActive={true}
              multiline={false}
              placeholder="npm run build"
            />
          </Box>
          <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
            <Text dimColor>Press Enter to add command, or Enter on empty line to continue</Text>
          </Box>
        </>
      )}

      {step === WizardStep.TEST_COMMANDS && (
        <>
          <Box marginBottom={1} flexDirection="row" gap={1}>
            <Text bold>
              <ChickAnimation />
            </Text>
            <Text color={UI_COLORS.TEXT_DEFAULT} bold>
              Step 6: Test Commands
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text>
              Add commands to run tests (e.g., npm test, pytest)
            </Text>
          </Box>
          {testCommands.length > 0 && (
            <Box flexDirection="column" marginBottom={1}>
              {testCommands.map((cmd, i) => (
                <Box key={i}>
                  <Text color={UI_COLORS.PRIMARY}>✓ </Text>
                  <Text>{cmd}</Text>
                </Box>
              ))}
            </Box>
          )}
          <Box marginBottom={1}>
            <TextInput
              label="Command:"
              value={testCommandBuffer}
              onValueChange={setTestCommandBuffer}
              cursorPosition={testCommandCursor}
              onCursorChange={setTestCommandCursor}
              onSubmit={handleTestCommandSubmit}
              onEscape={onSkip}
              onCtrlC={handleCtrlC}
              isActive={true}
              multiline={false}
              placeholder="npm test"
            />
          </Box>
          <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
            <Text dimColor>Press Enter to add command, or Enter on empty line to continue</Text>
          </Box>
        </>
      )}

      {step === WizardStep.FORMATTER && (
        <>
          <Box marginBottom={1} flexDirection="row" gap={1}>
            <Text bold>
              <ChickAnimation />
            </Text>
            <Text color={UI_COLORS.TEXT_DEFAULT} bold>
              Step 7: Code Formatter
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text>
              Enter the code formatter used in this project (e.g., prettier, black)
            </Text>
          </Box>
          <Box marginBottom={1}>
            <TextInput
              label="Formatter:"
              value={formatterBuffer}
              onValueChange={setFormatterBuffer}
              cursorPosition={formatterCursor}
              onCursorChange={setFormatterCursor}
              onSubmit={handleFormatterSubmit}
              onEscape={onSkip}
              onCtrlC={handleCtrlC}
              isActive={true}
              multiline={false}
              placeholder="prettier"
            />
          </Box>
          <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
            <Text dimColor>Press Enter to continue</Text>
          </Box>
        </>
      )}

      {step === WizardStep.LINTER && (
        <>
          <Box marginBottom={1} flexDirection="row" gap={1}>
            <Text bold>
              <ChickAnimation />
            </Text>
            <Text color={UI_COLORS.TEXT_DEFAULT} bold>
              Step 8: Linter
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text>
              Enter the linter used in this project (e.g., eslint, ruff)
            </Text>
          </Box>
          <Box marginBottom={1}>
            <TextInput
              label="Linter:"
              value={linterBuffer}
              onValueChange={setLinterBuffer}
              cursorPosition={linterCursor}
              onCursorChange={setLinterCursor}
              onSubmit={handleLinterSubmit}
              onEscape={onSkip}
              onCtrlC={handleCtrlC}
              isActive={true}
              multiline={false}
              placeholder="eslint"
            />
          </Box>
          <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
            <Text dimColor>Press Enter to generate ALLY.md</Text>
          </Box>
        </>
      )}

      {step === WizardStep.GENERATING && (
        <>
          {/* Header with ChickAnimation */}
          <Box marginBottom={1} flexDirection="row" gap={1}>
            <Text bold>
              <ChickAnimation />
            </Text>
            <Text color={UI_COLORS.TEXT_DEFAULT} bold>
              Generating ALLY.md...
            </Text>
          </Box>

          {/* Status message */}
          <Box marginBottom={1}>
            <Text>
              Creating your project configuration file
            </Text>
          </Box>
        </>
      )}

      {step === WizardStep.COMPLETED && (
        <>
          {error ? (
            <>
              {/* Error State */}
              <Box marginBottom={1} flexDirection="row" gap={1}>
                <Text bold>
                  <ChickAnimation />
                </Text>
                <Text color={UI_COLORS.ERROR} bold>
                  Error Creating ALLY.md
                </Text>
              </Box>
              <Box marginBottom={1}>
                <Text color={UI_COLORS.ERROR}>{error}</Text>
              </Box>
            </>
          ) : (
            <>
              {/* Success State - Header */}
              <Box marginBottom={1} flexDirection="row" gap={1}>
                <Text bold>
                  <ChickAnimation />
                </Text>
                <Text color={UI_COLORS.PRIMARY} bold>
                  Project Configuration Complete
                </Text>
              </Box>

              {/* Success message */}
              <Box marginBottom={1}>
                <Text>
                  Generated ALLY.md successfully.
                </Text>
              </Box>

              {/* Configuration details */}
              <Box marginBottom={1} flexDirection="column">
                <Text dimColor>File location: {process.cwd()}/ALLY.md</Text>
                <Text dimColor>• Project: {projectName}</Text>
                <Text dimColor>• Language: {language}</Text>
                {setupCommands.length > 0 && (
                  <Text dimColor>• Setup commands: {setupCommands.length}</Text>
                )}
                {buildCommands.length > 0 && (
                  <Text dimColor>• Build commands: {buildCommands.length}</Text>
                )}
                {testCommands.length > 0 && (
                  <Text dimColor>• Test commands: {testCommands.length}</Text>
                )}
              </Box>

              {/* Next steps */}
              <Box marginBottom={1} flexDirection="column">
                <Text dimColor>You can:</Text>
                <Text dimColor>  • Edit ALLY.md manually for more details</Text>
                <Text dimColor>  • Regenerate with /project init</Text>
                <Text dimColor>  • View with /project view</Text>
              </Box>
            </>
          )}

          {/* Footer separator */}
          <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
            <Text>
              Press <Text color={UI_COLORS.PRIMARY}>Enter</Text> to continue
            </Text>
          </Box>
        </>
      )}
        </Box>
      </ModalContainer>
    </Box>
  );
};
