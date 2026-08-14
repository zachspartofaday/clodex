import { describe, expect, it } from 'vitest';
import {
  applyAnthropicMessagesEffort,
  transformOpenAiCompatibleRequestBody,
} from '../src/model-runtime-compatibility.js';
import { resolveRequestEffort, type EffortProfile } from '../src/effort-policy.js';

describe('transformOpenAiCompatibleRequestBody', () => {
  it('applies OpenAI-compatible field and message compatibility rules without mutating input', () => {
    const input = {
      store: false,
      prompt_cache_retention: '24h',
      max_completion_tokens: 8192,
      reasoning_effort: 'max',
      messages: [
        { role: 'developer', content: 'system instructions' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1' }] },
        { role: 'assistant', content: 'answer', reasoning_content: 'kept' },
      ],
    };

    const result = transformOpenAiCompatibleRequestBody(input, {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsLongCacheRetention: false,
      maxTokensField: 'max_tokens',
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: 'deepseek',
    });

    expect(result).toEqual({
      max_tokens: 8192,
      reasoning_effort: 'max',
      thinking: { type: 'enabled' },
      messages: [
        { role: 'system', content: 'system instructions' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1' }],
          reasoning_content: '',
        },
        { role: 'assistant', content: 'answer', reasoning_content: 'kept' },
      ],
    });
    expect(input).toEqual({
      store: false,
      prompt_cache_retention: '24h',
      max_completion_tokens: 8192,
      reasoning_effort: 'max',
      messages: [
        { role: 'developer', content: 'system instructions' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1' }] },
        { role: 'assistant', content: 'answer', reasoning_content: 'kept' },
      ],
    });
  });

  it('omits unsupported reasoning effort and thinking without mutating input', () => {
    const input = { reasoning_effort: 'high' };
    const result = transformOpenAiCompatibleRequestBody(input, {
      supportsReasoningEffort: false,
      thinkingFormat: 'deepseek',
    });

    expect(result).toEqual({});
    expect(input).toEqual({ reasoning_effort: 'high' });
  });

  it('deletes a mapped provider-disabled reasoning level', () => {
    expect(transformOpenAiCompatibleRequestBody(
      { reasoning_effort: 'high' },
      { reasoningEffortMap: { high: null }, thinkingFormat: 'deepseek' },
    )).toEqual({});
  });

  it('replaces a mapped reasoning level with the provider value', () => {
    expect(transformOpenAiCompatibleRequestBody(
      { reasoning_effort: 'high' },
      { reasoningEffortMap: { high: 'max' }, thinkingFormat: 'qwen' },
    )).toEqual({ reasoning_effort: 'max', enable_thinking: true });
  });

  it('preserves an unmapped provider-native reasoning level', () => {
    expect(transformOpenAiCompatibleRequestBody(
      { reasoning_effort: 'native' },
      { reasoningEffortMap: { high: 'max' }, thinkingFormat: 'qwen' },
    )).toEqual({ reasoning_effort: 'native', enable_thinking: true });
  });

  it('preserves non-string reasoning effort values', () => {
    expect(transformOpenAiCompatibleRequestBody(
      { reasoning_effort: 3 },
      { reasoningEffortMap: { '3': 'max' }, thinkingFormat: 'qwen' },
    )).toEqual({ reasoning_effort: 3 });
  });

  it('lets unsupported reasoning effort take precedence over a conflicting map', () => {
    expect(transformOpenAiCompatibleRequestBody(
      { reasoning_effort: 'high' },
      {
        supportsReasoningEffort: false,
        reasoningEffortMap: { high: 'max' },
        thinkingFormat: 'qwen',
      },
    )).toEqual({});
  });

  it('omits unsupported temperature while preserving other fields without mutating input', () => {
    const input = {
      model: 'kimi-k3',
      temperature: 0.2,
      top_p: 0.9,
      messages: [{ role: 'user', content: 'hello' }],
    };
    const result = transformOpenAiCompatibleRequestBody(input, { supportsTemperature: false });

    expect(result).toEqual({
      model: 'kimi-k3',
      top_p: 0.9,
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(input).toEqual({
      model: 'kimi-k3',
      temperature: 0.2,
      top_p: 0.9,
      messages: [{ role: 'user', content: 'hello' }],
    });
  });

  it('enables Qwen thinking only when an effort is present', () => {
    expect(transformOpenAiCompatibleRequestBody(
      { reasoning_effort: 'high', messages: [] },
      { thinkingFormat: 'qwen' },
    )).toEqual({
      reasoning_effort: 'high',
      enable_thinking: true,
      messages: [],
    });

    expect(transformOpenAiCompatibleRequestBody(
      { messages: [] },
      { thinkingFormat: 'qwen' },
    )).toEqual({ messages: [] });
  });

  it('can normalize output tokens in either direction', () => {
    expect(transformOpenAiCompatibleRequestBody(
      { max_tokens: 2048 },
      { maxTokensField: 'max_completion_tokens' },
    )).toEqual({ max_completion_tokens: 2048 });
  });
});

describe('applyAnthropicMessagesEffort', () => {
  const budgetProfile: EffortProfile = {
    modelId: 'qwen3.8-max',
    transport: 'anthropic-messages',
    defaultLevel: null,
    levels: [
      { level: 'high', native: { kind: 'anthropic-thinking', thinking: { budget_tokens: 16_000, type: 'enabled' } } },
      { level: 'max', native: { kind: 'anthropic-thinking', thinking: { budget_tokens: 31_999, type: 'enabled' } } },
    ],
  };
  const effortProfile: EffortProfile = {
    modelId: 'kimi-k3',
    transport: 'openai-completions',
    defaultLevel: null,
    levels: [{ level: 'max', native: { kind: 'reasoning-effort', value: 'max' } }],
  };
  const emptyProfile: EffortProfile = {
    modelId: 'minimax-m3',
    transport: 'anthropic-messages',
    defaultLevel: null,
    levels: [],
  };

  const request = (effort?: string) => ({
    model: 'qwen3.8-max',
    messages: [{ role: 'user', content: 'hi' }],
    ...(effort === undefined ? {} : { output_config: { effort } }),
  });

  it('translates the resolved level into the upstream thinking object', () => {
    const body = request('max');
    const out = applyAnthropicMessagesEffort(
      body,
      budgetProfile,
      resolveRequestEffort('max', budgetProfile),
    );
    expect(out.thinking).toEqual({ budget_tokens: 31_999, type: 'enabled' });
    // clodex's own vocabulary does not travel alongside its translation.
    expect(out.output_config).toBeUndefined();
    expect(out.messages).toBe(body.messages);
    // The caller's body is never mutated.
    expect(body).toEqual(request('max'));
  });

  it('sends the rounded level when the policy rounds an unsupported one', () => {
    const out = applyAnthropicMessagesEffort(
      request('low'),
      budgetProfile,
      resolveRequestEffort('low', budgetProfile, 'up'),
    );
    expect(out.thinking).toEqual({ budget_tokens: 16_000, type: 'enabled' });
  });

  it('sends no thinking when the policy defers to the provider', () => {
    const out = applyAnthropicMessagesEffort(
      request('low'),
      budgetProfile,
      resolveRequestEffort('low', budgetProfile, 'provider-default'),
    );
    expect(out.thinking).toBeUndefined();
    expect(out.output_config).toBeUndefined();
  });

  it('overrides a thinking object the client wrote itself', () => {
    // The route advertises a graded ladder, so the resolved grade is the one
    // clodex is accountable for — leaving the client's value would make the
    // advertised control a no-op.
    const out = applyAnthropicMessagesEffort(
      { ...request('high'), thinking: { budget_tokens: 1, type: 'enabled' } },
      budgetProfile,
      resolveRequestEffort('high', budgetProfile),
    );
    expect(out.thinking).toEqual({ budget_tokens: 16_000, type: 'enabled' });
  });

  it('keeps other output_config keys while dropping only the effort', () => {
    const out = applyAnthropicMessagesEffort(
      { ...request('high'), output_config: { effort: 'high', verbosity: 'low' } },
      budgetProfile,
      resolveRequestEffort('high', budgetProfile),
    );
    expect(out.output_config).toEqual({ verbosity: 'low' });
  });

  it.each<[string, EffortProfile | undefined]>([
    ['a route with no profile at all', undefined],
    ['a Messages route with no executable ladder', emptyProfile],
    ['a route graded by reasoning_effort instead', effortProfile],
  ])('leaves the body byte-identical for %s', (_label, profile) => {
    const body = request('max');
    const out = applyAnthropicMessagesEffort(
      body,
      profile,
      profile ? resolveRequestEffort('max', profile) : undefined,
    );
    expect(out).toBe(body);
  });

  it('leaves a body with no effort untouched apart from carrying no thinking', () => {
    const out = applyAnthropicMessagesEffort(
      request(),
      budgetProfile,
      resolveRequestEffort(undefined, budgetProfile),
    );
    expect(out.thinking).toBeUndefined();
    expect(out).toEqual(request());
  });
});
