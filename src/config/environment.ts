/**
 * Environment Configuration
 *
 * Provides Zod-validated environment configuration with sensible defaults.
 * All environment variables are validated at startup to fail fast on
 * misconfiguration.
 */

import { z } from 'zod';

/**
 * Custom boolean transformer for environment variables.
 * Handles "true", "false", "1", "0", etc.
 */
const booleanEnvSchema = z.union([
  z.boolean(),
  z.string().transform((val) => {
    const lower = val.toLowerCase();
    if (lower === 'true' || lower === '1' || lower === 'yes') return true;
    if (lower === 'false' || lower === '0' || lower === 'no') return false;
    throw new Error(`Invalid boolean value: ${val}`);
  }),
]);

/**
 * Schema for environment configuration
 */
const EnvironmentConfigSchema = z.object({
  /**
   * Anthropic API key for Claude
   */
  anthropicApiKey: z.string().min(1, 'ANTHROPIC_API_KEY is required'),

  /**
   * Default model to use for agent execution
   */
  defaultModel: z.string().default('claude-sonnet-4-20250514'),

  /**
   * Path to session storage directory
   */
  sessionStoragePath: z.string().default('./.sessions'),

  /**
   * Default working directory for agents
   */
  defaultWorkingDirectory: z.string().default(process.cwd()),

  /**
   * Maximum turns per agent execution (safety limit)
   */
  maxTurns: z.coerce.number().int().positive().default(100),

  /**
   * Maximum execution time per agent in milliseconds
   */
  maxExecutionTimeMs: z.coerce.number().int().positive().default(300000),

  /**
   * Auto-save interval for sessions in milliseconds
   */
  autoSaveIntervalMs: z.coerce.number().int().positive().default(30000),

  /**
   * TTL for completed sessions in milliseconds (default: 7 days)
   */
  completedSessionTtlMs: z.coerce.number().int().positive().default(7 * 24 * 60 * 60 * 1000),

  /**
   * 1Password service account token (optional)
   */
  onePasswordToken: z.string().optional(),

  /**
   * Path to chezmoi agent config templates (optional)
   */
  agentTemplatesPath: z.string().optional(),

  /**
   * Log level for debug output
   */
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /**
   * Whether to enable audit logging
   */
  enableAuditLog: booleanEnvSchema.default(true),

  /**
   * Maximum concurrent agent executions
   */
  maxConcurrentAgents: z.coerce.number().int().positive().default(10),
});

export type EnvironmentConfig = z.infer<typeof EnvironmentConfigSchema>;

/**
 * Load and validate environment configuration.
 *
 * @returns Validated environment configuration
 * @throws {Error} If required environment variables are missing or invalid
 */
export function loadEnvironmentConfig(): EnvironmentConfig {
  const rawConfig = {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
    defaultModel: process.env.CLAUDE_DEFAULT_MODEL,
    sessionStoragePath: process.env.CLAUDE_SESSION_PATH,
    defaultWorkingDirectory: process.env.CLAUDE_WORKING_DIR,
    maxTurns: process.env.CLAUDE_MAX_TURNS,
    maxExecutionTimeMs: process.env.CLAUDE_MAX_EXECUTION_TIME_MS,
    autoSaveIntervalMs: process.env.CLAUDE_AUTO_SAVE_INTERVAL_MS,
    completedSessionTtlMs: process.env.CLAUDE_SESSION_TTL_MS,
    onePasswordToken: process.env.OP_SERVICE_ACCOUNT_TOKEN,
    agentTemplatesPath: process.env.CLAUDE_AGENT_TEMPLATES,
    logLevel: process.env.CLAUDE_LOG_LEVEL,
    enableAuditLog: process.env.CLAUDE_ENABLE_AUDIT_LOG,
    maxConcurrentAgents: process.env.CLAUDE_MAX_CONCURRENT_AGENTS,
  };

  // Remove undefined values to let Zod defaults work
  const cleanConfig = Object.fromEntries(
    Object.entries(rawConfig).filter(([, v]) => v !== undefined)
  );

  const result = EnvironmentConfigSchema.safeParse(cleanConfig);

  if (!result.success) {
    const issues = result.error.issues.map(issue => {
      const path = issue.path.join('.');
      return `  - ${path}: ${issue.message}`;
    }).join('\n');
    throw new Error(`Environment configuration validation failed:\n${issues}`);
  }

  return result.data;
}

/**
 * Get a safe environment config with defaults, for testing or when API key might be missing.
 * This version uses a placeholder for the API key if not set.
 *
 * @param overrides - Values to override defaults
 * @returns Environment configuration with defaults applied
 */
export function getEnvironmentConfigWithDefaults(
  overrides: Partial<EnvironmentConfig> = {}
): EnvironmentConfig {
  const defaults: EnvironmentConfig = {
    anthropicApiKey: overrides.anthropicApiKey || process.env.ANTHROPIC_API_KEY || 'not-set',
    defaultModel: 'claude-sonnet-4-20250514',
    sessionStoragePath: './.sessions',
    defaultWorkingDirectory: process.cwd(),
    maxTurns: 100,
    maxExecutionTimeMs: 300000,
    autoSaveIntervalMs: 30000,
    completedSessionTtlMs: 7 * 24 * 60 * 60 * 1000,
    onePasswordToken: undefined,
    agentTemplatesPath: undefined,
    logLevel: 'info',
    enableAuditLog: true,
    maxConcurrentAgents: 10,
  };

  return { ...defaults, ...overrides };
}

/**
 * Validate that a config is valid without loading from environment.
 *
 * @param config - Configuration to validate
 * @returns Validated configuration
 * @throws {Error} If configuration is invalid
 */
export function validateConfig(config: unknown): EnvironmentConfig {
  const result = EnvironmentConfigSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Invalid configuration: ${result.error.message}`);
  }
  return result.data;
}

// Singleton cached config
let cachedConfig: EnvironmentConfig | null = null;

/**
 * Get the cached environment configuration, loading it if necessary.
 *
 * @returns Validated environment configuration
 * @throws {Error} If configuration is invalid
 */
export function getEnvironmentConfig(): EnvironmentConfig {
  if (!cachedConfig) {
    cachedConfig = loadEnvironmentConfig();
  }
  return cachedConfig;
}

/**
 * Reset the cached environment configuration.
 * Useful for testing.
 */
export function resetEnvironmentConfig(): void {
  cachedConfig = null;
}
