/**
 * Safe JSON Utilities Unit Tests
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  safeJsonParse,
  safeJsonParseOrThrow,
  safeJsonParseWithDefault,
  isJsonObject,
  isJsonArray,
  JsonValueSchema,
  ChezmoiDataSchema,
} from '../../../src/utils/safe-json.js';

describe('safeJsonParse', () => {
  const TestSchema = z.object({
    name: z.string(),
    age: z.number(),
  });

  describe('successful parsing', () => {
    it('should parse valid JSON matching schema', () => {
      const json = '{"name": "Alice", "age": 30}';
      const result = safeJsonParse(json, TestSchema);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('Alice');
        expect(result.data.age).toBe(30);
      }
    });

    it('should parse JSON with extra fields when schema allows', () => {
      const LooseSchema = z.object({ name: z.string() }).passthrough();
      const json = '{"name": "Bob", "extra": "field"}';
      const result = safeJsonParse(json, LooseSchema);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('Bob');
        expect((result.data as Record<string, unknown>).extra).toBe('field');
      }
    });

    it('should parse nested objects', () => {
      const NestedSchema = z.object({
        user: z.object({
          name: z.string(),
          address: z.object({
            city: z.string(),
          }),
        }),
      });
      const json = '{"user": {"name": "Charlie", "address": {"city": "NYC"}}}';
      const result = safeJsonParse(json, NestedSchema);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.user.name).toBe('Charlie');
        expect(result.data.user.address.city).toBe('NYC');
      }
    });

    it('should parse arrays', () => {
      const ArraySchema = z.array(z.number());
      const json = '[1, 2, 3, 4, 5]';
      const result = safeJsonParse(json, ArraySchema);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual([1, 2, 3, 4, 5]);
      }
    });
  });

  describe('validation failures', () => {
    it('should return error for missing required field', () => {
      const json = '{"name": "Alice"}'; // missing age
      const result = safeJsonParse(json, TestSchema);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain('Validation failed');
        expect(result.error.message).toContain('age');
      }
    });

    it('should return error for wrong type', () => {
      const json = '{"name": "Alice", "age": "thirty"}'; // age should be number
      const result = safeJsonParse(json, TestSchema);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain('Validation failed');
      }
    });

    it('should return error for wrong root type', () => {
      const json = '"just a string"';
      const result = safeJsonParse(json, TestSchema);

      expect(result.success).toBe(false);
    });

    it('should include field path in error message', () => {
      const NestedSchema = z.object({
        user: z.object({
          email: z.string().email(),
        }),
      });
      const json = '{"user": {"email": "not-an-email"}}';
      const result = safeJsonParse(json, NestedSchema);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain('user.email');
      }
    });
  });

  describe('JSON parse failures', () => {
    it('should return error for invalid JSON syntax', () => {
      const json = '{invalid json}';
      const result = safeJsonParse(json, TestSchema);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(Error);
      }
    });

    it('should return error for empty string', () => {
      const result = safeJsonParse('', TestSchema);

      expect(result.success).toBe(false);
    });

    it('should return error for trailing comma', () => {
      const json = '{"name": "Alice",}';
      const result = safeJsonParse(json, TestSchema);

      expect(result.success).toBe(false);
    });

    it('should return error for single quotes', () => {
      const json = "{'name': 'Alice'}";
      const result = safeJsonParse(json, TestSchema);

      expect(result.success).toBe(false);
    });
  });
});

describe('safeJsonParseOrThrow', () => {
  const TestSchema = z.object({ value: z.number() });

  it('should return data for valid JSON', () => {
    const result = safeJsonParseOrThrow('{"value": 42}', TestSchema);
    expect(result.value).toBe(42);
  });

  it('should throw for invalid JSON', () => {
    expect(() => safeJsonParseOrThrow('{invalid}', TestSchema)).toThrow();
  });

  it('should throw for validation failure', () => {
    expect(() => safeJsonParseOrThrow('{"value": "not a number"}', TestSchema)).toThrow(
      'Validation failed'
    );
  });

  it('should throw with descriptive error message', () => {
    expect(() => safeJsonParseOrThrow('{"wrong": 1}', TestSchema)).toThrow('value');
  });
});

describe('safeJsonParseWithDefault', () => {
  const TestSchema = z.object({ count: z.number() });
  const defaultValue = { count: 0 };

  it('should return parsed data for valid JSON', () => {
    const result = safeJsonParseWithDefault('{"count": 10}', TestSchema, defaultValue);
    expect(result.count).toBe(10);
  });

  it('should return default for invalid JSON', () => {
    const result = safeJsonParseWithDefault('{invalid}', TestSchema, defaultValue);
    expect(result.count).toBe(0);
  });

  it('should return default for validation failure', () => {
    const result = safeJsonParseWithDefault('{"count": "ten"}', TestSchema, defaultValue);
    expect(result.count).toBe(0);
  });

  it('should return default for empty string', () => {
    const result = safeJsonParseWithDefault('', TestSchema, defaultValue);
    expect(result.count).toBe(0);
  });
});

describe('isJsonObject', () => {
  it('should return true for plain objects', () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject({ key: 'value' })).toBe(true);
    expect(isJsonObject({ nested: { obj: true } })).toBe(true);
  });

  it('should return false for arrays', () => {
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject([1, 2, 3])).toBe(false);
  });

  it('should return false for null', () => {
    expect(isJsonObject(null)).toBe(false);
  });

  it('should return false for primitives', () => {
    expect(isJsonObject('string')).toBe(false);
    expect(isJsonObject(123)).toBe(false);
    expect(isJsonObject(true)).toBe(false);
    expect(isJsonObject(undefined)).toBe(false);
  });
});

describe('isJsonArray', () => {
  it('should return true for arrays', () => {
    expect(isJsonArray([])).toBe(true);
    expect(isJsonArray([1, 2, 3])).toBe(true);
    expect(isJsonArray(['a', 'b'])).toBe(true);
    expect(isJsonArray([{ obj: true }])).toBe(true);
  });

  it('should return false for objects', () => {
    expect(isJsonArray({})).toBe(false);
    expect(isJsonArray({ length: 3 })).toBe(false); // Array-like but not array
  });

  it('should return false for primitives', () => {
    expect(isJsonArray('string')).toBe(false);
    expect(isJsonArray(123)).toBe(false);
    expect(isJsonArray(null)).toBe(false);
    expect(isJsonArray(undefined)).toBe(false);
  });
});

describe('JsonValueSchema', () => {
  it('should accept strings', () => {
    const result = JsonValueSchema.safeParse('hello');
    expect(result.success).toBe(true);
  });

  it('should accept numbers', () => {
    const result = JsonValueSchema.safeParse(42);
    expect(result.success).toBe(true);
    expect(JsonValueSchema.safeParse(3.14).success).toBe(true);
    expect(JsonValueSchema.safeParse(-10).success).toBe(true);
  });

  it('should accept booleans', () => {
    expect(JsonValueSchema.safeParse(true).success).toBe(true);
    expect(JsonValueSchema.safeParse(false).success).toBe(true);
  });

  it('should accept null', () => {
    expect(JsonValueSchema.safeParse(null).success).toBe(true);
  });

  it('should accept arrays', () => {
    expect(JsonValueSchema.safeParse([]).success).toBe(true);
    expect(JsonValueSchema.safeParse([1, 'two', true]).success).toBe(true);
  });

  it('should accept objects', () => {
    expect(JsonValueSchema.safeParse({}).success).toBe(true);
    expect(JsonValueSchema.safeParse({ key: 'value' }).success).toBe(true);
  });

  it('should accept nested structures', () => {
    const nested = {
      array: [1, 2, { deep: true }],
      object: { nested: { value: null } },
    };
    expect(JsonValueSchema.safeParse(nested).success).toBe(true);
  });

  it('should reject undefined', () => {
    expect(JsonValueSchema.safeParse(undefined).success).toBe(false);
  });

  it('should reject functions', () => {
    expect(JsonValueSchema.safeParse(() => {}).success).toBe(false);
  });
});

describe('ChezmoiDataSchema', () => {
  const validChezmoiData = {
    chezmoi: {
      os: 'darwin',
      arch: 'arm64',
      hostname: 'my-mac',
      username: 'user',
      homeDir: '/Users/user',
    },
  };

  it('should accept valid minimal chezmoi data', () => {
    const result = ChezmoiDataSchema.safeParse(validChezmoiData);
    expect(result.success).toBe(true);
  });

  it('should accept chezmoi data with optional fields', () => {
    const data = {
      ...validChezmoiData,
      chezmoi: {
        ...validChezmoiData.chezmoi,
        fqdnHostname: 'my-mac.local',
        gid: '20',
        group: 'staff',
        uid: '501',
        sourceDir: '/Users/user/.local/share/chezmoi',
        workingTree: '/Users/user/.local/share/chezmoi',
      },
    };
    const result = ChezmoiDataSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('should accept chezmoi data with kernel info', () => {
    const data = {
      ...validChezmoiData,
      chezmoi: {
        ...validChezmoiData.chezmoi,
        kernel: {
          osrelease: '23.0.0',
          ostype: 'Darwin',
          version: 'Darwin Kernel Version 23.0.0',
        },
      },
    };
    const result = ChezmoiDataSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('should accept chezmoi data with version info', () => {
    const data = {
      ...validChezmoiData,
      chezmoi: {
        ...validChezmoiData.chezmoi,
        version: {
          builtBy: 'goreleaser',
          commit: 'abc123',
          date: '2024-01-01',
          version: '2.40.0',
        },
      },
    };
    const result = ChezmoiDataSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('should accept custom data at top level (passthrough)', () => {
    const data = {
      ...validChezmoiData,
      customField: 'customValue',
      nested: { data: true },
    };
    const result = ChezmoiDataSchema.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).customField).toBe('customValue');
    }
  });

  it('should reject missing required fields', () => {
    const data = {
      chezmoi: {
        os: 'darwin',
        // missing arch, hostname, username, homeDir
      },
    };
    const result = ChezmoiDataSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('should reject wrong types for required fields', () => {
    const data = {
      chezmoi: {
        os: 123, // should be string
        arch: 'arm64',
        hostname: 'my-mac',
        username: 'user',
        homeDir: '/Users/user',
      },
    };
    const result = ChezmoiDataSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('should reject missing chezmoi object', () => {
    const data = { notChezmoi: {} };
    const result = ChezmoiDataSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});
