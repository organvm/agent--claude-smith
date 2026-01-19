/**
 * Mock Anthropic Client
 *
 * Provides mock implementations of the Anthropic SDK for testing.
 */

import { vi } from 'vitest';

export interface MockMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<{
    type: 'text';
    text: string;
  }>;
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export function createMockMessageResponse(
  text: string,
  overrides: Partial<MockMessageResponse> = {}
): MockMessageResponse {
  return {
    id: 'msg_test123',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model: 'claude-sonnet-4-20250514',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
    ...overrides,
  };
}

export function createMockAnthropicClient() {
  return {
    messages: {
      create: vi.fn().mockResolvedValue(
        createMockMessageResponse('Mock response')
      ),
    },
  };
}

/**
 * Mock the Anthropic module
 */
export function mockAnthropicModule() {
  const mockClient = createMockAnthropicClient();

  vi.mock('@anthropic-ai/sdk', () => ({
    default: vi.fn().mockImplementation(() => mockClient),
  }));

  return mockClient;
}
