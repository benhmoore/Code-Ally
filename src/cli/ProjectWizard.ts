/**
 * ProjectWizard - Interactive wizard for creating ALLY.md configuration
 *
 * Helps users create project-specific ALLY.md files with development commands,
 * coding standards, and project context.
 */

import inquirer from 'inquirer';
import * as fs from 'fs/promises';
import * as path from 'path';
import fastGlob from 'fast-glob';

interface ProjectConfig {
  project_name: string;
  description: string;
  primary_language: string;
  setup_commands: string[];
  build_commands: string[];
  run_commands: string[];
  has_tests: boolean;
  test_framework: string;
  test_commands: string[];
  formatter: string;
  linter: string;
  code_style: 'strict' | 'standard' | 'relaxed' | 'custom';
  custom_style_notes?: string;
  architecture_notes?: string;
  important_paths: Array<{ path: string; description: string }>;
  special_instructions?: string;
}

export interface ProjectWizardOptions {
  projectRoot?: string;
}

export class ProjectWizard {
  private projectRoot: string;
  private config: Partial<ProjectConfig> = {};

  constructor(options: ProjectWizardOptions = {}) {
    this.projectRoot = options.projectRoot || process.cwd();
  }

  /**
   * Run the interactive project wizard
   */
  async run(): Promise<boolean> {
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║           Welcome to Project Configuration!              ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');
    console.log('This wizard will help you create an ALLY.md file for your project.');
    console.log('This file provides context to Code Ally about your project\'s structure,');
    console.log('development practices, and specific requirements.\n');

    try {
      // Check if ALLY.md exists
      const allyPath = path.join(this.projectRoot, 'ALLY.md');
      try {
        await fs.access(allyPath);
        const { overwrite } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'overwrite',
            message: `ALLY.md already exists in ${this.projectRoot}. Overwrite?`,
            default: false,
          },
        ]);
        if (!overwrite) {
          console.log('\n✗ Project configuration cancelled.\n');
          return false;
        }
      } catch {
        // File doesn't exist, that's ok
      }

      // Run configuration steps
      await this.configureProjectInfo();
      await this.configureDevelopment();
      await this.configureCodeStyle();
      await this.configureTesting();
      await this.configureAdditionalContext();

      // Generate ALLY.md
      await this.generateAllyFile();
      this.showCompletion();

      return true;
    } catch (error) {
      if (error instanceof Error && error.message.includes('User force closed')) {
        console.log('\n✗ Project configuration cancelled.\n');
        return false;
      }
      throw error;
    }
  }

  private async configureProjectInfo(): Promise<void> {
    console.log('\n━━━ Project Information ━━━\n');

    const defaultName = path.basename(this.projectRoot);
    const languages = await this.detectLanguages();

    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'project_name',
        message: 'Project name:',
        default: defaultName,
      },
      {
        type: 'input',
        name: 'description',
        message: 'Brief project description:',
        default: '',
      },
      {
        type: 'input',
        name: 'primary_language',
        message: 'Primary programming language:',
        default: languages.length > 0 ? languages[0] : '',
      },
    ]);

    if (languages.length > 0) {
      console.log(`  (Detected: ${languages.join(', ')})`);
    }

    Object.assign(this.config, answers);
  }

  private async configureDevelopment(): Promise<void> {
    console.log('\n━━━ Development Environment ━━━\n');

    // Setup commands
    const setupCommands = await this.promptCommands('Setup commands', [
      'npm install',
      'pip install -e .',
      'go mod download',
      'cargo build',
    ]);
    this.config.setup_commands = setupCommands;

    // Build commands
    const { hasBuild } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'hasBuild',
        message: 'Does this project have build commands?',
        default: true,
      },
    ]);

    if (hasBuild) {
      const buildCommands = await this.promptCommands('Build commands', [
        'npm run build',
        'python setup.py build',
        'go build',
        'cargo build --release',
      ]);
      this.config.build_commands = buildCommands;
    } else {
      this.config.build_commands = [];
    }

    // Run commands
    const { hasRun } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'hasRun',
        message: 'Does this project have run commands?',
        default: true,
      },
    ]);

    if (hasRun) {
      const runCommands = await this.promptCommands('Run commands', [
        'npm start',
        'python main.py',
        'go run .',
        'cargo run',
      ]);
      this.config.run_commands = runCommands;
    } else {
      this.config.run_commands = [];
    }
  }

  private async configureCodeStyle(): Promise<void> {
    console.log('\n━━━ Code Style & Standards ━━━\n');

    const formatters = await this.detectFormatters();
    const linters = await this.detectLinters();

    if (formatters.length > 0) {
      console.log(`  Detected formatters: ${formatters.join(', ')}`);
    }
    if (linters.length > 0) {
      console.log(`  Detected linters: ${linters.join(', ')}`);
    }

    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'formatter',
        message: 'Code formatter (e.g., black, prettier, gofmt):',
        default: formatters[0] || '',
      },
      {
        type: 'input',
        name: 'linter',
        message: 'Linter (e.g., ruff, eslint, golint):',
        default: linters[0] || '',
      },
      {
        type: 'list',
        name: 'code_style',
        message: 'Code style preference:',
        choices: [
          { name: 'Strict (follow all conventions)', value: 'strict' },
          { name: 'Standard (follow most conventions)', value: 'standard' },
          { name: 'Relaxed (basic conventions only)', value: 'relaxed' },
          { name: 'Custom (I\'ll specify)', value: 'custom' },
        ],
        default: 'standard',
      },
    ]);

    Object.assign(this.config, answers);

    if (answers.code_style === 'custom') {
      const { custom_style_notes } = await inquirer.prompt([
        {
          type: 'input',
          name: 'custom_style_notes',
          message: 'Describe your code style preferences:',
        },
      ]);
      this.config.custom_style_notes = custom_style_notes;
    }
  }

  private async configureTesting(): Promise<void> {
    console.log('\n━━━ Testing Configuration ━━━\n');

    const { has_tests } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'has_tests',
        message: 'Does this project have tests?',
        default: true,
      },
    ]);

    this.config.has_tests = has_tests;

    if (!has_tests) {
      this.config.test_framework = '';
      this.config.test_commands = [];
      return;
    }

    const testFrameworks = await this.detectTestFrameworks();
    if (testFrameworks.length > 0) {
      console.log(`  Detected test frameworks: ${testFrameworks.join(', ')}`);
    }

    const { test_framework } = await inquirer.prompt([
      {
        type: 'input',
        name: 'test_framework',
        message: 'Test framework (e.g., pytest, jest, vitest):',
        default: testFrameworks[0] || '',
      },
    ]);

    this.config.test_framework = test_framework;

    const testCommands = await this.promptCommands('Test commands', [
      'npm test',
      'pytest',
      'go test ./...',
      'cargo test',
    ]);
    this.config.test_commands = testCommands;
  }

  private async configureAdditionalContext(): Promise<void> {
    console.log('\n━━━ Additional Context ━━━\n');

    const { addArch, addPaths, addInstructions } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'addArch',
        message: 'Add architectural notes?',
        default: false,
      },
      {
        type: 'confirm',
        name: 'addPaths',
        message: 'Specify important files or directories?',
        default: false,
      },
      {
        type: 'confirm',
        name: 'addInstructions',
        message: 'Add special instructions for Code Ally?',
        default: false,
      },
    ]);

    if (addArch) {
      const { architecture_notes } = await inquirer.prompt([
        {
          type: 'input',
          name: 'architecture_notes',
          message: 'Describe the project architecture:',
        },
      ]);
      this.config.architecture_notes = architecture_notes;
    }

    if (addPaths) {
      this.config.important_paths = [];
      console.log('Enter important files/directories (empty path to finish):');
      while (true) {
        const { pathName } = await inquirer.prompt([
          {
            type: 'input',
            name: 'pathName',
            message: '  Path:',
          },
        ]);
        if (!pathName) break;

        const { description } = await inquirer.prompt([
          {
            type: 'input',
            name: 'description',
            message: `  Description for ${pathName}:`,
            default: '',
          },
        ]);

        this.config.important_paths!.push({ path: pathName, description });
      }
    } else {
      this.config.important_paths = [];
    }

    if (addInstructions) {
      const { special_instructions } = await inquirer.prompt([
        {
          type: 'input',
          name: 'special_instructions',
          message: 'Special instructions:',
        },
      ]);
      this.config.special_instructions = special_instructions;
    }
  }

  private async promptCommands(title: string, examples: string[]): Promise<string[]> {
    const commands: string[] = [];
    console.log(`${title} (empty to skip to next):`);
    console.log(`  Examples: ${examples.join(', ')}\n`);

    while (true) {
      const { command } = await inquirer.prompt([
        {
          type: 'input',
          name: 'command',
          message: '  >',
        },
      ]);
      if (!command) break;
      commands.push(command);
    }

    return commands;
  }

  private async generateAllyFile(): Promise<void> {
    const content = this.buildAllyContent();
    const allyPath = path.join(this.projectRoot, 'ALLY.md');

    await fs.writeFile(allyPath, content, 'utf-8');
    console.log(`\n✓ Generated ALLY.md at ${allyPath}`);
  }

  private buildAllyContent(): string {
    let content = `# ALLY.md

This file provides project-specific guidance to Code Ally when working with this codebase.

## Project Information

**Name**: ${this.config.project_name || 'Unknown'}
**Primary Language**: ${this.config.primary_language || 'Unknown'}
`;

    if (this.config.description) {
      content += `**Description**: ${this.config.description}\n`;
    }

    content += '\n## Development Commands\n';

    if (this.config.setup_commands && this.config.setup_commands.length > 0) {
      content += '\n### Environment Setup\n```bash\n';
      content += this.config.setup_commands.join('\n') + '\n';
      content += '```\n';
    }

    if (this.config.build_commands && this.config.build_commands.length > 0) {
      content += '\n### Build\n```bash\n';
      content += this.config.build_commands.join('\n') + '\n';
      content += '```\n';
    }

    if (this.config.run_commands && this.config.run_commands.length > 0) {
      content += '\n### Run\n```bash\n';
      content += this.config.run_commands.join('\n') + '\n';
      content += '```\n';
    }

    if (this.config.has_tests) {
      content += '\n### Testing\n';
      if (this.config.test_framework) {
        content += `**Framework**: ${this.config.test_framework}\n\n`;
      }
      if (this.config.test_commands && this.config.test_commands.length > 0) {
        content += '```bash\n';
        content += this.config.test_commands.join('\n') + '\n';
        content += '```\n';
      }
    }

    content += '\n## Code Style & Standards\n';
    if (this.config.formatter) {
      content += `**Formatter**: ${this.config.formatter}\n`;
    }
    if (this.config.linter) {
      content += `**Linter**: ${this.config.linter}\n`;
    }

    const styleDescriptions: Record<string, string> = {
      strict: 'Follow all coding conventions strictly',
      standard: 'Follow standard coding conventions',
      relaxed: 'Follow basic coding conventions only',
      custom: 'Custom style preferences',
    };

    const style = this.config.code_style || 'standard';
    content += `**Style Preference**: ${styleDescriptions[style]}\n`;

    if (this.config.custom_style_notes) {
      content += `\n**Custom Style Notes**: ${this.config.custom_style_notes}\n`;
    }

    if (this.config.architecture_notes) {
      content += `\n## Architecture\n\n${this.config.architecture_notes}\n`;
    }

    if (this.config.important_paths && this.config.important_paths.length > 0) {
      content += '\n## Important Files & Directories\n\n';
      for (const item of this.config.important_paths) {
        content += `- \`${item.path}\``;
        if (item.description) {
          content += `: ${item.description}`;
        }
        content += '\n';
      }
    }

    if (this.config.special_instructions) {
      content += `\n## Special Instructions\n\n${this.config.special_instructions}\n`;
    }

    content += `
## Notes for Code Ally

- Please follow the development commands and coding standards specified above when working with this project.
`;

    return content;
  }

  private showCompletion(): void {
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║          Project Configuration Complete!                 ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');
    console.log(`Generated ALLY.md in: ${this.projectRoot}/ALLY.md\n`);
    console.log('Code Ally will now use this configuration when working in this');
    console.log('project directory. You can:');
    console.log('  • Edit ALLY.md manually to add more details');
    console.log('  • Regenerate it anytime with /project init');
    console.log('  • View it with /project view\n');
  }

  // ==========================================
  // Detection Helpers
  // ==========================================

  private async detectLanguages(): Promise<string[]> {
    const languages: string[] = [];
    const indicators: Record<string, string[]> = {
      TypeScript: ['**/*.ts', '**/*.tsx', '**/tsconfig.json'],
      JavaScript: ['**/*.js', '**/*.jsx', '**/package.json'],
      Python: ['**/*.py', '**/requirements.txt', '**/pyproject.toml'],
      Go: ['**/*.go', '**/go.mod'],
      Rust: ['**/*.rs', '**/Cargo.toml'],
      Java: ['**/*.java', '**/pom.xml'],
    };

    for (const [lang, patterns] of Object.entries(indicators)) {
      for (const pattern of patterns) {
        const files = await fastGlob(pattern, {
          cwd: this.projectRoot,
          ignore: ['**/node_modules/**', '**/venv/**', '**/.git/**'],
        });
        if (files.length > 0) {
          languages.push(lang);
          break;
        }
      }
    }

    return languages;
  }

  private async detectFormatters(): Promise<string[]> {
    const formatters: string[] = [];
    const formatterFiles: Record<string, string[]> = {
      prettier: ['**/.prettierrc*', '**/prettier.config.*'],
      black: ['**/pyproject.toml'],
    };

    for (const [formatter, patterns] of Object.entries(formatterFiles)) {
      for (const pattern of patterns) {
        const files = await fastGlob(pattern, {
          cwd: this.projectRoot,
          ignore: ['**/node_modules/**'],
        });
        if (files.length > 0) {
          formatters.push(formatter);
          break;
        }
      }
    }

    return formatters;
  }

  private async detectLinters(): Promise<string[]> {
    const linters: string[] = [];
    const linterFiles: Record<string, string[]> = {
      eslint: ['**/.eslintrc*', '**/eslint.config.*'],
      ruff: ['**/ruff.toml', '**/pyproject.toml'],
    };

    for (const [linter, patterns] of Object.entries(linterFiles)) {
      for (const pattern of patterns) {
        const files = await fastGlob(pattern, {
          cwd: this.projectRoot,
          ignore: ['**/node_modules/**'],
        });
        if (files.length > 0) {
          linters.push(linter);
          break;
        }
      }
    }

    return linters;
  }

  private async detectTestFrameworks(): Promise<string[]> {
    const frameworks: string[] = [];
    const testIndicators: Record<string, string[]> = {
      vitest: ['**/vitest.config.*'],
      jest: ['**/jest.config.*'],
      pytest: ['**/conftest.py', '**/pytest.ini'],
    };

    for (const [framework, patterns] of Object.entries(testIndicators)) {
      for (const pattern of patterns) {
        const files = await fastGlob(pattern, {
          cwd: this.projectRoot,
          ignore: ['**/node_modules/**'],
        });
        if (files.length > 0) {
          frameworks.push(framework);
          break;
        }
      }
    }

    return frameworks;
  }
}
