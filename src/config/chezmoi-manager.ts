import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import * as TOML from '@iarna/toml';
import type {
  ChezmoiData,
  ChezmoiManagerConfig,
  EnvironmentInfo,
  Environment,
  LoadedAgentConfigs,
  RawAgentConfig,
  ConfigLoadError,
} from './types.js';
import { RawAgentConfigSchema } from './types.js';
import { safeJsonParse, ChezmoiDataSchema } from '../utils/safe-json.js';

const execAsync = promisify(exec);

// ============================================================================
// chezmoi Manager
// ============================================================================

/**
 * Manages chezmoi templates and agent configuration loading
 */
export class ChezmoiManager {
  private readonly templatesPath: string;
  private readonly templateExtension: string;
  private chezmoiData: ChezmoiData | null = null;
  private chezmoiAvailable: boolean | null = null;

  constructor(config: ChezmoiManagerConfig) {
    this.templatesPath = config.templatesPath;
    this.templateExtension = config.templateExtension ?? '.toml.tmpl';

    if (config.chezmoiAvailable !== undefined) {
      this.chezmoiAvailable = config.chezmoiAvailable;
    }
  }

  /**
   * Check if chezmoi is available in PATH
   */
  async isChezmoiAvailable(): Promise<boolean> {
    if (this.chezmoiAvailable !== null) {
      return this.chezmoiAvailable;
    }

    try {
      await execAsync('chezmoi --version');
      this.chezmoiAvailable = true;
      return true;
    } catch {
      this.chezmoiAvailable = false;
      return false;
    }
  }

  /**
   * Get chezmoi data (machine-specific variables)
   */
  async getChezmoiData(): Promise<ChezmoiData | null> {
    if (this.chezmoiData) {
      return this.chezmoiData;
    }

    if (!(await this.isChezmoiAvailable())) {
      console.warn('[ChezmoiManager] chezmoi not available, using fallback data');
      return null;
    }

    try {
      const { stdout } = await execAsync('chezmoi data --format json');
      // Use safe JSON parsing with schema validation
      const result = safeJsonParse(stdout, ChezmoiDataSchema);
      if (!result.success) {
        console.error('[ChezmoiManager] Invalid chezmoi data format:', result.error.message);
        return null;
      }
      this.chezmoiData = result.data;
      return this.chezmoiData;
    } catch (error) {
      console.error('[ChezmoiManager] Failed to get chezmoi data:', error);
      return null;
    }
  }

  /**
   * Detect current environment
   */
  async detectEnvironment(): Promise<EnvironmentInfo> {
    const chezmoiData = await this.getChezmoiData();

    // Check for Docker
    const isDocker = await this.checkIsDocker();

    // Check for WSL
    const isWsl = await this.checkIsWsl();

    // Check for CI
    const isCI = !!(process.env.CI || process.env.GITHUB_ACTIONS || process.env.GITLAB_CI);

    // Determine environment
    let environment: Environment = 'unknown';
    const osName = chezmoiData?.chezmoi.os ?? process.platform;

    if (isDocker) {
      environment = 'docker';
    } else if (isWsl) {
      environment = 'wsl';
    } else if (osName === 'darwin') {
      environment = 'macos';
    } else if (osName === 'linux') {
      environment = 'linux';
    } else if (osName === 'windows' || osName === 'win32') {
      environment = 'windows';
    }

    return {
      environment,
      os: osName,
      arch: chezmoiData?.chezmoi.arch ?? process.arch,
      hostname: chezmoiData?.chezmoi.hostname ?? '',
      username: chezmoiData?.chezmoi.username ?? process.env.USER ?? '',
      homeDir: chezmoiData?.chezmoi.homeDir ?? process.env.HOME ?? '',
      isDocker,
      isWsl,
      isCI,
    };
  }

  /**
   * Check if running in Docker
   */
  private async checkIsDocker(): Promise<boolean> {
    try {
      await stat('/.dockerenv');
      return true;
    } catch {
      try {
        const { stdout } = await execAsync('cat /proc/1/cgroup 2>/dev/null || true');
        return stdout.includes('docker');
      } catch {
        return false;
      }
    }
  }

  /**
   * Check if running in WSL
   */
  private async checkIsWsl(): Promise<boolean> {
    try {
      const { stdout } = await execAsync('uname -r');
      return stdout.toLowerCase().includes('microsoft') || stdout.toLowerCase().includes('wsl');
    } catch {
      return false;
    }
  }

  /**
   * Render a chezmoi template
   */
  async renderTemplate(templateContent: string): Promise<string> {
    if (!(await this.isChezmoiAvailable())) {
      // Fallback: remove template directives and return raw content
      return this.fallbackRender(templateContent);
    }

    try {
      // Use chezmoi execute-template to render with stdin
      const result = await this.executeWithStdin('chezmoi', ['execute-template'], templateContent);
      return result;
    } catch (error) {
      console.warn('[ChezmoiManager] Template rendering failed, using fallback:', error);
      return this.fallbackRender(templateContent);
    }
  }

  /**
   * Execute a command with stdin input
   */
  private executeWithStdin(command: string, args: string[], input: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Command failed with code ${code}: ${stderr}`));
        }
      });

      child.on('error', reject);

      child.stdin.write(input);
      child.stdin.end();
    });
  }

  /**
   * Fallback template rendering (basic processing)
   */
  private fallbackRender(template: string): string {
    // Remove common chezmoi template directives
    let result = template;

    // Remove conditional blocks entirely (conservative approach)
    result = result.replace(/\{\{-?\s*if\s+.*?\}\}[\s\S]*?\{\{-?\s*end\s*-?\}\}/g, '');

    // Remove any remaining template syntax
    result = result.replace(/\{\{.*?\}\}/g, '');

    return result.trim();
  }

  /**
   * Load and parse a single agent config file
   */
  async loadAgentConfig(filePath: string): Promise<RawAgentConfig> {
    const content = await readFile(filePath, 'utf-8');

    let tomlContent: string;
    if (filePath.endsWith('.tmpl')) {
      tomlContent = await this.renderTemplate(content);
    } else {
      tomlContent = content;
    }

    const parsed = TOML.parse(tomlContent);
    const validated = RawAgentConfigSchema.parse(parsed);

    return validated;
  }

  /**
   * Load all agent configs from templates directory
   */
  async loadAllConfigs(): Promise<LoadedAgentConfigs> {
    const agents = new Map<string, RawAgentConfig>();
    const errors: ConfigLoadError[] = [];

    const chezmoiData = await this.getChezmoiData();
    const environment = await this.detectEnvironment();

    try {
      // Check if templates directory exists
      await stat(this.templatesPath);
    } catch {
      console.warn(`[ChezmoiManager] Templates directory not found: ${this.templatesPath}`);
      return { agents, chezmoiData, environment, errors };
    }

    // Find all template files
    const files = await readdir(this.templatesPath);
    const templateFiles = files.filter(
      f => f.endsWith(this.templateExtension) || f.endsWith('.toml')
    );

    for (const file of templateFiles) {
      const filePath = join(this.templatesPath, file);
      try {
        const config = await this.loadAgentConfig(filePath);
        agents.set(config.id, config);
        console.log(`[ChezmoiManager] Loaded agent config: ${config.id} from ${file}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push({
          file,
          error: errorMessage,
          recoverable: true,
        });
        console.error(`[ChezmoiManager] Failed to load ${file}: ${errorMessage}`);
      }
    }

    return { agents, chezmoiData, environment, errors };
  }

  /**
   * Get a specific agent config by ID
   */
  async getAgentConfig(agentId: string): Promise<RawAgentConfig | null> {
    const { agents } = await this.loadAllConfigs();
    return agents.get(agentId) ?? null;
  }

  /**
   * Refresh cached chezmoi data
   */
  async refreshData(): Promise<void> {
    this.chezmoiData = null;
    await this.getChezmoiData();
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Create chezmoi template data context
 */
export function createTemplateContext(
  chezmoiData: ChezmoiData | null,
  environment: EnvironmentInfo,
  customData: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    chezmoi: chezmoiData?.chezmoi ?? {
      os: environment.os,
      arch: environment.arch,
      hostname: environment.hostname,
      username: environment.username,
      homeDir: environment.homeDir,
    },
    env: environment,
    ...customData,
  };
}

/**
 * Default chezmoi manager instance factory
 */
export function createChezmoiManager(templatesPath: string): ChezmoiManager {
  return new ChezmoiManager({
    templatesPath,
  });
}
