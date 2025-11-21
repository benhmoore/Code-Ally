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
          <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
            <Text>
              Press <Text color={UI_COLORS.PRIMARY}>Enter</Text> to continue or <Text color={UI_COLORS.PRIMARY}>S</Text> to skip
            </Text>
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
            <Text color={UI_COLORS.PRIMARY}>Project Name: </Text>
            <Text>{projectNameInput}</Text>
            <Text color={UI_COLORS.TEXT_DEFAULT}>█</Text>
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
            <Text color={UI_COLORS.PRIMARY}>Description: </Text>
            <Text>{descriptionInput}</Text>
            <Text color={UI_COLORS.TEXT_DEFAULT}>█</Text>
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
            <Text color={UI_COLORS.PRIMARY}>Language: </Text>
            <Text>{languageInput}</Text>
            <Text color={UI_COLORS.TEXT_DEFAULT}>█</Text>
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
            <Text color={UI_COLORS.PRIMARY}>Command: </Text>
            <Text>{setupCommandInput}</Text>
            <Text color={UI_COLORS.TEXT_DEFAULT}>█</Text>
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
            <Text color={UI_COLORS.PRIMARY}>Command: </Text>
            <Text>{buildCommandInput}</Text>
            <Text color={UI_COLORS.TEXT_DEFAULT}>█</Text>
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
            <Text color={UI_COLORS.PRIMARY}>Command: </Text>
            <Text>{testCommandInput}</Text>
            <Text color={UI_COLORS.TEXT_DEFAULT}>█</Text>
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
            <Text color={UI_COLORS.PRIMARY}>Formatter: </Text>
            <Text>{formatterInput}</Text>
            <Text color={UI_COLORS.TEXT_DEFAULT}>█</Text>
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
            <Text color={UI_COLORS.PRIMARY}>Linter: </Text>
            <Text>{linterInput}</Text>
            <Text color={UI_COLORS.TEXT_DEFAULT}>█</Text>
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
