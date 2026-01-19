/**
 * Safe JSON Utilities
 *
 * Provides type-safe JSON parsing with Zod schema validation.
 * Prevents unsafe type assertions and provides better error handling.
 */

import { z, type ZodSchema, type ZodError } from 'zod';

/**
 * Result type for safe parsing operations
 */
export type SafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: Error };

/**
 * Safely parse JSON string with Zod schema validation
 *
 * @param json - The JSON string to parse
 * @param schema - The Zod schema to validate against
 * @returns SafeParseResult with either the parsed data or an error
 *
 * @example
 * ```typescript
 * const schema = z.object({ name: z.string() });
 * const result = safeJsonParse('{"name": "test"}', schema);
 * if (result.success) {
 *   console.log(result.data.name); // Type-safe access
 * }
 * ```
 */
export function safeJsonParse<T>(
  json: string,
  schema: ZodSchema<T>
): SafeParseResult<T> {
  try {
    const parsed = JSON.parse(json);
    const validated = schema.safeParse(parsed);

    if (validated.success) {
      return { success: true, data: validated.data };
    }

    return {
      success: false,
      error: new Error(formatZodError(validated.error)),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Safely parse JSON string with schema validation, throwing on error
 *
 * @throws Error if parsing or validation fails
 */
export function safeJsonParseOrThrow<T>(
  json: string,
  schema: ZodSchema<T>
): T {
  const result = safeJsonParse(json, schema);
  if (!result.success) {
    throw result.error;
  }
  return result.data;
}

/**
 * Safely parse JSON with a default value on failure
 */
export function safeJsonParseWithDefault<T>(
  json: string,
  schema: ZodSchema<T>,
  defaultValue: T
): T {
  const result = safeJsonParse(json, schema);
  return result.success ? result.data : defaultValue;
}

/**
 * Format Zod errors into a readable string
 */
function formatZodError(error: ZodError): string {
  const issues = error.issues.map(issue => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  return `Validation failed: ${issues.join('; ')}`;
}

/**
 * Type guard for checking if a value is a valid JSON object
 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Type guard for checking if a value is a valid JSON array
 */
export function isJsonArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Schema for generic JSON data (any valid JSON)
 */
export const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ])
);

/**
 * Schema for chezmoi data (used in chezmoi-manager.ts)
 *
 * This schema is permissive to handle varying chezmoi output across
 * different operating systems. Required fields are the minimum needed
 * for the application to function.
 */
export const ChezmoiDataSchema = z.object({
  chezmoi: z.object({
    // Required fields
    os: z.string(),
    arch: z.string(),
    hostname: z.string(),
    username: z.string(),
    homeDir: z.string(),
    // Optional fields that may vary by OS
    fqdnHostname: z.string().optional(),
    gid: z.string().optional(),
    group: z.string().optional(),
    uid: z.string().optional(),
    sourceDir: z.string().optional(),
    workingTree: z.string().optional(),
    kernel: z.object({
      osrelease: z.string(),
      ostype: z.string(),
      version: z.string(),
    }).optional(),
    osRelease: z.object({
      id: z.string(),
      idLike: z.array(z.string()).optional(),
      name: z.string(),
      prettyName: z.string(),
      versionId: z.string().optional(),
    }).optional(),
    version: z.object({
      builtBy: z.string().optional(),
      commit: z.string().optional(),
      date: z.string().optional(),
      version: z.string().optional(),
    }).optional(),
  }).passthrough(), // Allow additional chezmoi fields
}).passthrough(); // Allow additional top-level fields (custom data)

// Re-export the ChezmoiData type from types.ts for consistency
export type { ChezmoiData } from '../config/types.js';
