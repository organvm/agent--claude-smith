/**
 * Command Validator
 *
 * Comprehensive security validation for shell commands using a combination
 * of whitelist-based validation and normalized pattern matching.
 *
 * This replaces the simple regex-based approach that had numerous bypass vectors.
 */

export interface ValidationResult {
  allowed: boolean;
  reason?: string;
  severity?: 'info' | 'warning' | 'critical';
  suggestion?: string;
}

/**
 * Dangerous command categories with normalized patterns
 */
const DANGEROUS_PATTERNS = {
  // Destructive file operations
  destructiveFiles: [
    /\brm\s+(-[a-z]*[rf][a-z]*\s+)*[\/~$]/i,
    /\brm\s+.*--recursive.*--force/i,
    /\brm\s+.*--force.*--recursive/i,
    /\bshred\b/i,
    /\bwipe\b/i,
    /\bsrm\b/i, // secure rm
  ],

  // Bare file deletion of source/prototype files (with or without flags)
  bareFileDeletion: [
    /\brm\s+(-[a-z]+\s+)*[^\|;&]*\.(html?|jsx|tsx|vue|svelte|ipynb|proto|graphql|sql)\b/i,
    /\brm\s+(-[a-z]+\s+)*[^\|;&]*prototype/i,
    /\brm\s+(-[a-z]+\s+)*[^\|;&]*draft/i,
  ],

  // Privilege escalation
  privilegeEscalation: [
    /\bsudo\b/,
    /\bdoas\b/,
    /\bpkexec\b/,
    /\bsu\s+-?\s*$/,
    /\bsu\s+-\s+root\b/i,
    /\bchmod\s+[+-]?[ugo]*\+?s/i, // setuid/setgid
    /\bchown\s+(root|0)[:.]?/i,
    /\bchgrp\s+(root|wheel|0)/i,
  ],

  // Filesystem corruption
  filesystemDamage: [
    /\bmkfs\b/i,
    /\bfdisk\b/i,
    /\bparted\b/i,
    /\bdd\s+.*of=\/dev\//i,
    /\bmount\s+/,
    /\bumount\s+/,
    /\bfsck\b/i,
  ],

  // Fork bombs and resource exhaustion
  resourceExhaustion: [
    /:\(\)\s*\{[^}]*\}\s*;?\s*:/,  // :(){ :|:& };:
    /\bwhile\s+true\s*;\s*do/i,
    /\bfork\s*\(\)/,
    /\(\s*\)\s*\{\s*\|\s*&\s*\}/,
    /(\w+)\s*\(\)\s*\{\s*\1\s*\|\s*\1\s*&?\s*\}/,  // bomb(){ bomb|bomb& }
  ],

  // Remote code execution
  remoteCodeExec: [
    /\bcurl\s+.*\|\s*(ba)?sh/i,
    /\bwget\s+.*\|\s*(ba)?sh/i,
    /\bcurl\s+.*-o[^|]*;\s*(ba)?sh/i,
    /\bwget\s+.*-O[^|]*;\s*(ba)?sh/i,
    /(ba)?sh\s+<\s*\(\s*curl/i,
    /(ba)?sh\s+<\s*\(\s*wget/i,
    /\beval\s+.*\$\(/i,
    /\bsource\s+<\(/i,
    /\.\s+<\(/,
  ],

  // Reverse shells
  reverseShells: [
    /\bnc\s+.*-e\s*\/bin\/(ba)?sh/i,
    /\bnetcat\s+.*-e\s*\/bin\/(ba)?sh/i,
    /\bpython[23]?\s+.*socket.*subprocess/i,
    /\bperl\s+.*socket.*exec/i,
    /\bphp\s+.*fsockopen.*\/bin\/(ba)?sh/i,
    /\bbash\s+.*-i\s+.*\/dev\/tcp/i,
    /\/dev\/tcp\/\d+\.\d+\.\d+\.\d+/i,
  ],

  // Cron/at scheduling (persistence)
  scheduledExecution: [
    /\bcrontab\s+-[elr]?/i,
    /\bcrontab\s+</i,
    /\bat\s+/i,
    /\bbatch\s+/i,
    />\s*\/etc\/cron/i,
    /echo\s+.*crontab/i,
  ],

  // System modification
  systemModification: [
    />\s*\/etc\//,
    />\s*\/boot\//,
    />\s*\/sys\//,
    />\s*\/proc\//,
    /\bsystemctl\s+(enable|disable|mask|unmask)/i,
    /\bservice\s+\w+\s+(start|stop|restart)/i,
    /\bkillall\s+-9/i,
    /\bpkill\s+-9/i,
  ],

  // SSH key manipulation
  sshManipulation: [
    />\s*.*\.ssh\/authorized_keys/i,
    />\s*.*\.ssh\/id_/i,
    /ssh-keygen\s+.*-f\s*\/.*\.ssh/i,
  ],

  // Shell initialization file modification
  shellInit: [
    />\s*.*\.(bashrc|bash_profile|zshrc|profile|zprofile)/i,
    /echo\s+.*>>\s*.*\.(bashrc|bash_profile|zshrc|profile)/i,
  ],

  // History manipulation (hiding tracks)
  historyManipulation: [
    /\bhistory\s+-[cd]/i,
    /\bunset\s+HISTFILE/i,
    /\bexport\s+HISTSIZE=0/i,
    /\bshred\s+.*history/i,
    />\s*.*\.bash_history/i,
    />\s*.*\.zsh_history/i,
  ],

  // Encoded command execution
  encodedExecution: [
    /\bbase64\s+(-d|--decode).*\|\s*(ba)?sh/i,
    /echo\s+.*\|\s*base64\s+(-d|--decode).*\|\s*(ba)?sh/i,
    /\bpython[23]?\s+-c\s+.*exec.*base64/i,
    // Echo with -e flag containing hex escapes piped to shell
    /echo\s+-e\s+.*\\x[0-9a-f]{2}.*\|\s*(ba)?sh/i,
    // Hex escape sequences in any echo command piped to shell
    /echo\s+.*\\x[0-9a-f]{2}.*\|\s*(ba)?sh/i,
    /\$'\\x[0-9a-f]/i,
    /printf\s+.*\\x.*\|\s*(ba)?sh/i,
    // Hex escape sequences piped to shell (generic pattern)
    /\\\\x[0-9a-f]{2}.*\|\s*(ba)?sh/i,
  ],

  // Container escape attempts
  containerEscape: [
    /\bdocker\s+run.*--privileged/i,
    /\bdocker\s+exec.*-it.*\/bin\/(ba)?sh/i,
    /\bkubectl\s+exec.*-it/i,
    /nsenter\s+/i,
  ],

  // Dangerous network operations
  dangerousNetwork: [
    /\bssh\s+-R\s+.*\d+.*:\d+.*@/i,  // SSH reverse tunnel
    /\bsocat\s+.*exec:/i,
    /\bnmap\s+/i,
    /\btcpdump\s+.*-w/i,
    /\btshark\s+.*-w/i,
  ],
} as const;

/**
 * Known safe command prefixes (whitelist)
 */
const SAFE_COMMAND_PREFIXES = [
  // Development tools
  'npm', 'npx', 'yarn', 'pnpm', 'bun',
  'node', 'ts-node', 'tsx',
  'cargo', 'rustc', 'rustup',
  'go', 'gofmt',
  'python', 'pip', 'python3', 'pip3',
  'gem', 'bundle', 'ruby',
  'php', 'composer',
  'java', 'javac', 'mvn', 'gradle',

  // Version control
  'git', 'gh', 'svn', 'hg',

  // File operations (safe subset)
  'ls', 'pwd', 'cd', 'cat', 'head', 'tail', 'less', 'more',
  'grep', 'rg', 'ag', 'awk', 'sed', 'sort', 'uniq', 'wc',
  'find', 'fd', 'locate', 'which', 'whereis', 'type',
  'diff', 'cmp', 'comm',
  'file', 'stat', 'du', 'df',

  // Build tools
  'make', 'cmake', 'ninja', 'meson',
  'tsc', 'esbuild', 'vite', 'webpack', 'rollup',
  'jest', 'vitest', 'mocha', 'pytest',
  'eslint', 'prettier', 'biome',

  // Text processing
  'jq', 'yq', 'xq',
  'tr', 'cut', 'paste', 'join',

  // Archive/compression
  'tar', 'zip', 'unzip', 'gzip', 'gunzip', 'bzip2',

  // Misc safe
  'echo', 'printf', 'date', 'env', 'export',
  'mkdir', 'touch', 'cp', 'mv', 'ln', 'trash',
  'basename', 'dirname', 'realpath', 'readlink',
  'true', 'false', 'test', '[',
  'xargs', 'parallel',
];

/**
 * Normalize a command by removing quotes, expanding simple variables,
 * and standardizing whitespace.
 *
 * NOTE: We intentionally preserve escape sequences like \x (hex), \n, \t
 * as they could be used for obfuscation.
 */
function normalizeCommand(command: string): string {
  let normalized = command
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    // Remove inline comments (but not in strings)
    .replace(/#[^'"\n]*$/gm, '')
    // Remove string quotes (preserve content)
    .replace(/["']/g, '')
    .trim();

  // Expand some common variable patterns that could hide commands
  normalized = normalized
    .replace(/\$SUDO\b/gi, 'sudo')
    .replace(/\$\{SUDO\}/gi, 'sudo')
    .replace(/\$HOME\b/gi, '~')
    .replace(/\$\{HOME\}/gi, '~');

  return normalized;
}

/**
 * Extract the base command from a command string
 */
function extractBaseCommand(command: string): string {
  // Handle command substitution prefix
  const withoutSubstitution = command
    .replace(/^\$\([^)]+\)\s*/, '')
    .replace(/^`[^`]+`\s*/, '');

  // Handle path prefix
  const withoutPath = withoutSubstitution.replace(/^\/\S+\//, '');

  // Get first word
  const match = withoutPath.match(/^(\S+)/);
  return match ? match[1] : '';
}

/**
 * Check if command uses dangerous shell features
 */
function hasDangerousShellFeatures(command: string): ValidationResult | null {
  // Command substitution with sudo
  if (/\$\([^)]*sudo[^)]*\)/i.test(command)) {
    return {
      allowed: false,
      reason: 'Command substitution with privilege escalation',
      severity: 'critical',
    };
  }

  // Backtick substitution with dangerous commands
  if (/`[^`]*sudo[^`]*`/i.test(command)) {
    return {
      allowed: false,
      reason: 'Backtick substitution with privilege escalation',
      severity: 'critical',
    };
  }

  // Environment variable with dangerous patterns
  if (/\$\{?[A-Z_]+\}?\s+rm\s+-rf/i.test(command)) {
    return {
      allowed: false,
      reason: 'Potential variable-based command injection',
      severity: 'critical',
    };
  }

  return null;
}

/**
 * Validate a bash command for security
 */
export function validateCommand(command: string): ValidationResult {
  if (!command || typeof command !== 'string') {
    return { allowed: true };
  }

  const normalized = normalizeCommand(command);

  // Check for dangerous shell features first
  const shellFeatureResult = hasDangerousShellFeatures(normalized);
  if (shellFeatureResult) {
    return shellFeatureResult;
  }

  // Check against all dangerous patterns
  for (const [category, patterns] of Object.entries(DANGEROUS_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(normalized)) {
        const result: ValidationResult = {
          allowed: false,
          reason: `Blocked: ${category} pattern detected`,
          severity: 'critical',
        };
        if (category === 'bareFileDeletion') {
          result.suggestion = 'Use trash or mv <file> .archive/ instead of rm';
        }
        return result;
      }
    }
  }

  // Extract base command and check whitelist for simple commands
  const baseCommand = extractBaseCommand(normalized);

  // If it's a simple command (no pipes, redirects, semicolons)
  // and starts with a safe prefix, allow it
  if (!/[|;&><]/.test(normalized)) {
    if (SAFE_COMMAND_PREFIXES.includes(baseCommand)) {
      return { allowed: true };
    }
  }

  // For complex commands (with pipes, etc.), verify each part
  const parts = normalized.split(/[|;&]/);
  for (const part of parts) {
    const partNormalized = part.trim();
    if (!partNormalized) continue;

    // Re-check each part for dangerous patterns
    for (const [category, patterns] of Object.entries(DANGEROUS_PATTERNS)) {
      for (const pattern of patterns) {
        if (pattern.test(partNormalized)) {
          const pipeResult: ValidationResult = {
            allowed: false,
            reason: `Blocked in pipeline: ${category} pattern detected`,
            severity: 'critical',
          };
          if (category === 'bareFileDeletion') {
            pipeResult.suggestion = 'Use trash or mv <file> .archive/ instead of rm';
          }
          return pipeResult;
        }
      }
    }
  }

  // Allow command if no issues found
  return { allowed: true };
}

/**
 * Dangerous paths that should never be written to
 */
const DANGEROUS_PATHS = [
  /^\/$/,
  /^\/etc(\/|$)/,
  /^\/boot(\/|$)/,
  /^\/sys(\/|$)/,
  /^\/proc(\/|$)/,
  /^\/dev(\/|$)/,
  /^\/root(\/|$)/,
  /^\/var\/log(\/|$)/,
  /\.ssh\/authorized_keys$/,
  /\.ssh\/id_[a-z]+$/,
  /\.(bashrc|bash_profile|zshrc|zprofile|profile|zlogin|zlogout)$/,
  /\.netrc$/,
  /\.pgpass$/,
  /\.aws\/credentials$/,
  /\.kube\/config$/,
  /\.docker\/config\.json$/,
  /\.npmrc$/,
  /\.pypirc$/,
  /\.gitconfig$/,
  /crontab$/,
  /\/etc\/passwd$/,
  /\/etc\/shadow$/,
  /\/etc\/sudoers(\.d\/.*)?$/,
];

/**
 * Validate a file path for writing
 */
export function validateWritePath(filePath: string): ValidationResult {
  if (!filePath || typeof filePath !== 'string') {
    return { allowed: true };
  }

  const normalized = filePath
    .replace(/["']/g, '')
    .replace(/~/, process.env.HOME || '/home/user');

  for (const pattern of DANGEROUS_PATHS) {
    if (pattern.test(normalized)) {
      return {
        allowed: false,
        reason: `Writing to ${normalized} is not allowed for security reasons`,
        severity: 'critical',
      };
    }
  }

  return { allowed: true };
}

/**
 * Session ID validation pattern (UUID format only)
 */
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validate a session ID to prevent path traversal
 */
export function validateSessionId(sessionId: string): ValidationResult {
  if (!sessionId || typeof sessionId !== 'string') {
    return {
      allowed: false,
      reason: 'Session ID is required',
      severity: 'warning',
    };
  }

  // Check for path traversal patterns
  if (sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\')) {
    return {
      allowed: false,
      reason: 'Invalid session ID: contains path traversal characters',
      severity: 'critical',
    };
  }

  // Validate UUID format
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return {
      allowed: false,
      reason: 'Invalid session ID format: must be a valid UUID',
      severity: 'warning',
    };
  }

  return { allowed: true };
}
