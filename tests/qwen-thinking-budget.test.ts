import { describe, expect, it } from 'vitest';
import { buildOpenCodeGoModels } from '../src/data/opencode-go-models.js';
import { effortProviderOptions } from '../src/provider-factory.js';
import { transformOpenAiCompatibleRequestBody } from '../src/model-runtime-compatibility.js';

/**
 * Qwen grades thinking by BUDGET, not by an effort word.
 *
 * Confirmed against OpenCode's own client, which sends
 * `thinking: {type:'enabled', budgetTokens: N}` — 16000 at high, 31999 at max —
 * and no `reasoning_effort` at all. clodex maps an effort value only so the
 * transform can resolve a budget from it.
 */
describe('qwen thinking budget', () => {
  const model = buildOpenCodeGoModels().find(entry => entry.id === 'qwen3.6-plus')!;
  const meta = { reasoning: model.reasoning, compatibility: model.compatibility, providerId: 'opencode-go' };

  const bodyFor = (level: string) => {
    const options = effortProviderOptions(model.npm!, level, model.id, meta as never) as
      Record<string, Record<string, unknown>> | undefined;
    const effort = options?.opencodeGo?.reasoningEffort as string | undefined;
    return transformOpenAiCompatibleRequestBody(
      { model: model.id, ...(effort ? { reasoning_effort: effort } : {}) },
      model.compatibility,
    ) as Record<string, unknown>;
  };

  it('sends the budget the reference client sends, per grade', () => {
    expect(bodyFor('high').thinking).toEqual({ type: 'enabled', budgetTokens: 16000 });
    expect(bodyFor('max').thinking).toEqual({ type: 'enabled', budgetTokens: 31999 });
  });

  it('drops reasoning_effort rather than sending it alongside', () => {
    // The upstream ignores it. Leaving it in makes the request look like it
    // carries a control it does not, which is how this model came to advertise
    // grades that did nothing.
    for (const level of ['high', 'max']) {
      expect(bodyFor(level).reasoning_effort, level).toBeUndefined();
      expect(bodyFor(level).enable_thinking, level).toBeUndefined();
    }
  });

  it('leaves thinking off entirely when no level is chosen', () => {
    const body = bodyFor('off');
    expect(body.thinking).toBeUndefined();
    expect(body.enable_thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('falls back to the boolean toggle when a value has no budget', () => {
    // A wire value the budget map does not cover still has to enable thinking,
    // or a future mapping change would silently stop the model reasoning.
    const body = transformOpenAiCompatibleRequestBody(
      { model: model.id, reasoning_effort: 'medium' },
      model.compatibility,
    ) as Record<string, unknown>;
    expect(body.enable_thinking).toBe(true);
    expect(body.thinking).toBeUndefined();
  });

  it('does not disturb the deepseek thinking shape', () => {
    // The budget branch is qwen-only; deepseek keeps its bare enabled object.
    const deepseek = buildOpenCodeGoModels().find(entry => entry.id === 'deepseek-v4-pro')!;
    const body = transformOpenAiCompatibleRequestBody(
      { model: deepseek.id, reasoning_effort: 'high' },
      deepseek.compatibility,
    ) as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('high');
  });
});
