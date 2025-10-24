/**
 * ProjectContextDetector - Detects stable project context
 *
 * Detects project characteristics that rarely change and are safe to persist.
 * Results are cached and stored in sessions to avoid redundant detection.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { IService } from '../types/index.js';
import { logger } from './Logger.js';

export interface ProjectContext {
  languages: string[];
  frameworks: string[];
  projectName?: string;
  projectType?: string;
  hasGit: boolean;
  packageManager?: string;
  scale: 'small' | 'medium' | 'large';
  hasDocker?: boolean;
  cicd?: string[]; // CI/CD systems detected
  detectedAt: string;
}

const LANGUAGE_PATTERNS: Record<string, string[]> = {
  TypeScript: ['.ts', '.tsx'],
  JavaScript: ['.js', '.jsx', '.mjs', '.cjs'],
  Python: ['.py'],
  Rust: ['.rs'],
  Go: ['.go'],
  Java: ['.java'],
  C: ['.c', '.h'],
  'C++': ['.cpp', '.cc', '.cxx', '.hpp'],
  Ruby: ['.rb'],
  PHP: ['.php'],
};

export class ProjectContextDetector implements IService {
  private cachedContext: ProjectContext | null = null;
  private workingDir: string;
  private readonly staleThreshold = 30 * 60 * 1000; // 30 minutes

  constructor(workingDir: string = process.cwd()) {
    this.workingDir = workingDir;
  }

  async initialize(): Promise<void> {
    // Lightweight initialization - actual detection is lazy
  }

  async cleanup(): Promise<void> {
    // No resources to clean up
  }

  /**
   * Get cached context or return null
   */
  getCached(): ProjectContext | null {
    return this.cachedContext;
  }

  /**
   * Set cached context (for loading from session)
   */
  setCached(context: ProjectContext): void {
    this.cachedContext = context;
  }

  /**
   * Check if cached context is stale
   */
  isStale(context?: ProjectContext): boolean {
    const ctx = context || this.cachedContext;
    if (!ctx) return true;

    const age = Date.now() - new Date(ctx.detectedAt).getTime();
    return age > this.staleThreshold;
  }

  /**
   * Detect project context (async, non-blocking)
   */
  async detect(): Promise<ProjectContext> {
    try {
      logger.debug('[PROJECT_CONTEXT] Starting detection...');

      const [languages, projectInfo, hasGit, scale, packageManager, frameworks, hasDocker, cicd] = await Promise.all([
        this.detectLanguages(),
        this.detectProjectInfo(),
        this.checkGit(),
        this.detectScale(),
        this.detectPackageManager(),
        this.detectFrameworks(),
        this.detectDocker(),
        this.detectCICD(),
      ]);

      const context: ProjectContext = {
        languages,
        frameworks,
        projectName: projectInfo.name,
        projectType: projectInfo.type,
        hasGit,
        packageManager,
        scale,
        hasDocker,
        cicd: cicd.length > 0 ? cicd : undefined,
        detectedAt: new Date().toISOString(),
      };

      this.cachedContext = context;
      logger.debug('[PROJECT_CONTEXT] Detection complete:', context);

      return context;
    } catch (error) {
      logger.warn('[PROJECT_CONTEXT] Detection failed, using defaults');
      return this.getDefaultContext();
    }
  }

  /**
   * Detect languages from file extensions
   */
  private async detectLanguages(): Promise<string[]> {
    try {
      const files = await this.scanFiles(500); // Limit to 500 files
      const languageCounts: Map<string, number> = new Map();

      for (const file of files) {
        for (const [lang, exts] of Object.entries(LANGUAGE_PATTERNS)) {
          if (exts.some(ext => file.endsWith(ext))) {
            languageCounts.set(lang, (languageCounts.get(lang) || 0) + 1);
          }
        }
      }

      // Return languages with at least 3 files, sorted by count
      const languages = Array.from(languageCounts.entries())
        .filter(([_, count]) => count >= 3)
        .sort((a, b) => b[1] - a[1])
        .map(([lang]) => lang);

      return languages.slice(0, 3); // Top 3 languages
    } catch {
      return [];
    }
  }

  /**
   * Detect frameworks from package.json, requirements.txt, Cargo.toml, go.mod
   */
  private async detectFrameworks(): Promise<string[]> {
    const frameworks: string[] = [];

    // Check Rust frameworks
    try {
      const cargoPath = join(this.workingDir, 'Cargo.toml');
      const cargo = await fs.readFile(cargoPath, 'utf-8');
      if (/actix-web\s*=/.test(cargo)) frameworks.push('Actix');
      if (/rocket\s*=/.test(cargo)) frameworks.push('Rocket');
      if (/axum\s*=/.test(cargo)) frameworks.push('Axum');
      if (/clap\s*=/.test(cargo)) frameworks.push('Clap');
    } catch {
      // No Cargo.toml
    }

    // Check Go frameworks
    try {
      const goModPath = join(this.workingDir, 'go.mod');
      const goMod = await fs.readFile(goModPath, 'utf-8');
      if (/gin-gonic\/gin/.test(goMod)) frameworks.push('Gin');
      if (/labstack\/echo/.test(goMod)) frameworks.push('Echo');
      if (/gofiber\/fiber/.test(goMod)) frameworks.push('Fiber');
      if (/spf13\/cobra/.test(goMod)) frameworks.push('Cobra');
    } catch {
      // No go.mod
    }

    // Check package.json
    try {
      const pkgPath = join(this.workingDir, 'package.json');
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      if (deps.react) frameworks.push('React');
      else if (deps.vue) frameworks.push('Vue');
      else if (deps.svelte) frameworks.push('Svelte');

      if (deps.next) frameworks.push('Next.js');
      else if (deps.express) frameworks.push('Express');
      else if (deps['@nestjs/core']) frameworks.push('NestJS');

      if (deps.jest) frameworks.push('Jest');
      else if (deps.vitest) frameworks.push('Vitest');
    } catch {
      // No package.json or parse error
    }

    // Check for Python frameworks
    try {
      const reqPath = join(this.workingDir, 'requirements.txt');
      const reqs = await fs.readFile(reqPath, 'utf-8');
      if (reqs.includes('django')) frameworks.push('Django');
      else if (reqs.includes('flask')) frameworks.push('Flask');
      else if (reqs.includes('fastapi')) frameworks.push('FastAPI');

      // CLI tools
      if (reqs.includes('click')) frameworks.push('Click');
      else if (reqs.includes('typer')) frameworks.push('Typer');

      // Data science
      if (reqs.includes('pandas')) frameworks.push('Pandas');
      if (reqs.includes('numpy')) frameworks.push('NumPy');
    } catch {
      // No requirements.txt
    }

    return frameworks;
  }

  /**
   * Detect project name and type
   */
  private async detectProjectInfo(): Promise<{ name?: string; type?: string }> {
    // Try each ecosystem in order
    const detectors = [
      this.detectNodeProjectInfo.bind(this),
      this.detectRustProjectInfo.bind(this),
      this.detectGoProjectInfo.bind(this),
      this.detectPythonProjectInfo.bind(this),
    ];

    for (const detector of detectors) {
      const result = await detector();
      if (result) return result;
    }

    // Fallback: Use directory structure heuristics
    const typeFromStructure = await this.inferTypeFromStructure();
    const dirName = this.workingDir.split('/').pop();

    return {
      name: dirName,
      type: typeFromStructure,
    };
  }

  /**
   * Detect Node.js project info from package.json
   */
  private async detectNodeProjectInfo(): Promise<{ name?: string; type?: string } | null> {
    try {
      const pkgPath = join(this.workingDir, 'package.json');
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      let type: string | undefined;
      if (pkg.bin || deps.commander || deps.yargs) type = 'CLI tool';
      else if (deps.react || deps.vue || deps.svelte) type = 'Web app';
      else if (deps.express || deps['@nestjs/core']) type = 'API';
      else if (pkg.name?.includes('lib') || pkg.name?.includes('utils')) type = 'Library';

      return { name: pkg.name, type };
    } catch {
      return null;
    }
  }

  /**
   * Detect Rust project info from Cargo.toml
   */
  private async detectRustProjectInfo(): Promise<{ name?: string; type?: string } | null> {
    try {
      const cargoPath = join(this.workingDir, 'Cargo.toml');
      const content = await fs.readFile(cargoPath, 'utf-8');

      // Parse basic TOML (simple approach for our needs)
      const nameMatch = content.match(/^\s*name\s*=\s*"([^"]+)"/m);
      const name = nameMatch ? nameMatch[1] : undefined;

      // Check for [[bin]] sections
      const hasBin = /^\s*\[\[bin\]\]/m.test(content);

      // Check for web frameworks
      const hasWebFramework = /^\s*(actix-web|rocket|axum|warp)\s*=/m.test(content);

      let type: string | undefined;
      if (hasBin) type = 'CLI tool';
      else if (hasWebFramework) type = 'Web app';
      else if (/^\s*\[lib\]/m.test(content)) type = 'Library';

      return { name, type };
    } catch {
      return null;
    }
  }

  /**
   * Detect Go project info from go.mod
   */
  private async detectGoProjectInfo(): Promise<{ name?: string; type?: string } | null> {
    try {
      const goModPath = join(this.workingDir, 'go.mod');
      const content = await fs.readFile(goModPath, 'utf-8');

      // Extract module name
      const moduleMatch = content.match(/^\s*module\s+(.+)$/m);
      const moduleName = moduleMatch?.[1]?.trim();
      const name = moduleName?.split('/').pop();

      // Check for main.go or cmd/ directory
      const hasMainGo = await this.fileExists('main.go');
      const hasCmdDir = await this.directoryExists('cmd');

      // Check for web frameworks
      const hasWebFramework = /(gin-gonic\/gin|labstack\/echo|gofiber\/fiber|go-chi\/chi)/.test(content);

      let type: string | undefined;
      if (hasMainGo || hasCmdDir) type = 'CLI tool';
      else if (hasWebFramework) type = 'API';

      return { name, type };
    } catch {
      return null;
    }
  }

  /**
   * Detect Python project info from setup.py, pyproject.toml, or requirements.txt
   */
  private async detectPythonProjectInfo(): Promise<{ name?: string; type?: string } | null> {
    // Check if this is primarily a Python project
    const hasPythonFiles = await this.hasPythonFiles();
    if (!hasPythonFiles) return null;

    let name: string | undefined;
    let type: string | undefined;

    // Try pyproject.toml first
    try {
      const pyprojectPath = join(this.workingDir, 'pyproject.toml');
      const content = await fs.readFile(pyprojectPath, 'utf-8');
      const nameMatch = content.match(/^\s*name\s*=\s*"([^"]+)"/m);
      name = nameMatch ? nameMatch[1] : undefined;

      // Check for CLI scripts
      if (/^\s*\[project\.scripts\]/m.test(content) || /^\s*\[tool\.poetry\.scripts\]/m.test(content)) {
        type = 'CLI tool';
      }
    } catch {
      // Continue to other detection methods
    }

    // Check requirements.txt for frameworks
    try {
      const reqPath = join(this.workingDir, 'requirements.txt');
      const reqs = await fs.readFile(reqPath, 'utf-8');

      if (/^(click|typer|argparse-)/m.test(reqs)) type = 'CLI tool';
      else if (/^(django|flask|fastapi)/m.test(reqs)) type = 'Web app';
      else if (/^(jupyter|pandas|numpy|scikit-learn)/m.test(reqs)) type = 'Data Science';
    } catch {
      // No requirements.txt
    }

    // Fallback to directory name
    if (!name) {
      name = this.workingDir.split('/').pop();
    }

    return name || type ? { name, type } : null;
  }

  /**
   * Infer project type from directory structure
   */
  private async inferTypeFromStructure(): Promise<string | undefined> {
    const hasCmdDir = await this.directoryExists('cmd');
    const hasBinDir = await this.directoryExists('bin');
    const hasApiDir = await this.directoryExists('api');
    const hasServerDir = await this.directoryExists('server');
    const hasWebDir = await this.directoryExists('web');
    const hasLibDir = await this.directoryExists('lib');
    const hasPkgDir = await this.directoryExists('pkg');

    if (hasCmdDir || hasBinDir) return 'CLI tool';
    if (hasApiDir || hasServerDir || hasWebDir) return 'Web app';
    if (hasLibDir || hasPkgDir) return 'Library';

    return undefined;
  }

  /**
   * Check if git repository
   */
  private async checkGit(): Promise<boolean> {
    try {
      await fs.access(join(this.workingDir, '.git'));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Detect package manager
   */
  private async detectPackageManager(): Promise<string | undefined> {
    try {
      if (await this.fileExists('package-lock.json')) return 'npm';
      if (await this.fileExists('pnpm-lock.yaml')) return 'pnpm';
      if (await this.fileExists('yarn.lock')) return 'yarn';
      if (await this.fileExists('Cargo.lock')) return 'cargo';
      if (await this.fileExists('go.mod')) return 'go';
    } catch {
      // Ignore
    }
    return undefined;
  }

  /**
   * Detect project scale based on file count
   */
  private async detectScale(): Promise<'small' | 'medium' | 'large'> {
    try {
      const files = await this.scanFiles(1000);
      if (files.length < 50) return 'small';
      if (files.length < 200) return 'medium';
      return 'large';
    } catch {
      return 'small';
    }
  }

  /**
   * Scan files in working directory (recursive, with limits)
   */
  private async scanFiles(limit: number): Promise<string[]> {
    const files: string[] = [];
    const ignore = new Set(['node_modules', '.git', 'dist', 'build', 'target', '__pycache__', '.venv']);

    const scan = async (dir: string, depth: number = 0): Promise<void> => {
      if (depth > 3 || files.length >= limit) return;

      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (files.length >= limit) break;

          if (ignore.has(entry.name)) continue;

          const fullPath = join(dir, entry.name);

          if (entry.isDirectory()) {
            await scan(fullPath, depth + 1);
          } else if (entry.isFile()) {
            files.push(fullPath);
          }
        }
      } catch {
        // Permission error or other - skip directory
      }
    };

    await scan(this.workingDir);
    return files;
  }

  /**
   * Check if file exists
   */
  private async fileExists(filename: string): Promise<boolean> {
    try {
      await fs.access(join(this.workingDir, filename));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if directory exists
   */
  private async directoryExists(dirname: string): Promise<boolean> {
    try {
      const stats = await fs.stat(join(this.workingDir, dirname));
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Check if project has Python files
   */
  private async hasPythonFiles(): Promise<boolean> {
    try {
      const files = await this.scanFiles(50); // Quick check
      return files.some(f => f.endsWith('.py'));
    } catch {
      return false;
    }
  }

  /**
   * Detect Docker presence
   */
  private async detectDocker(): Promise<boolean> {
    const dockerFiles = ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', '.dockerignore'];

    for (const file of dockerFiles) {
      if (await this.fileExists(file)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Detect CI/CD systems
   */
  private async detectCICD(): Promise<string[]> {
    const systems: string[] = [];

    // GitHub Actions
    if (await this.directoryExists('.github/workflows')) {
      systems.push('GitHub Actions');
    }

    // Gitea Actions
    if (await this.directoryExists('.gitea/workflows')) {
      systems.push('Gitea Actions');
    }

    // GitLab CI
    if (await this.fileExists('.gitlab-ci.yml')) {
      systems.push('GitLab CI');
    }

    // CircleCI
    if (await this.fileExists('.circleci/config.yml')) {
      systems.push('CircleCI');
    }

    // Jenkins
    if (await this.fileExists('Jenkinsfile')) {
      systems.push('Jenkins');
    }

    // Travis CI
    if (await this.fileExists('.travis.yml')) {
      systems.push('Travis CI');
    }

    return systems;
  }

  /**
   * Get default context when detection fails
   */
  private getDefaultContext(): ProjectContext {
    return {
      languages: [],
      frameworks: [],
      hasGit: false,
      scale: 'small',
      detectedAt: new Date().toISOString(),
    };
  }
}
