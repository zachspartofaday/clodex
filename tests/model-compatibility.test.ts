import { describe, it, expect } from 'vitest';
import { materializeRegistry } from '../src/registry/materialize.js';
import {
  findBlacklistEntry,
  hideReason,
  shouldHideModel,
} from '../src/model-compatibility.js';
import {
  findModelsDevModel,
  loadBundledModelsDevCache,
  readModelsDevCacheMeta,
  shouldHideByModelsDevCapabilities,
  stripModelsDevCacheMeta,
} from '../src/registry/models-dev.js';

describe('shouldHideModel', () => {
  it('allows unknown models by default', () => {
    expect(shouldHideModel({
      providerId: 'openai',
      modelId: 'gpt-9-hypothetical',
      agent: 'claude',
    })).toBe(false);
  });

  it('hides global blacklist ids regardless of provider', () => {
    expect(shouldHideModel({
      providerId: 'openai',
      modelId: 'z-ai/glm4.7',
      agent: 'claude',
    })).toBe(true);
  });

  it('exposes the blacklist reason', () => {
    const ctx = {
      providerId: 'openai',
      modelId: 'z-ai/glm4.7',
      agent: 'claude' as const,
    };
    expect(findBlacklistEntry(ctx)).not.toBeNull();
    expect(hideReason(ctx)).toContain('blacklist');
  });
});

describe('models.dev capability rules', () => {
  const cache = loadBundledModelsDevCache();

  it('ships a bundled snapshot with metadata', () => {
    const meta = readModelsDevCacheMeta(cache);
    expect(meta?.source).toBe('https://models.dev/api.json');
    expect((meta?.provider_count ?? 0) > 50).toBe(true);
    expect(stripModelsDevCacheMeta(cache).google?.models).toBeDefined();
  });

  it('hides audio-only output when catalogued', () => {
    const entry = findModelsDevModel('google', 'gemini-2.5-flash-preview-tts', cache);
    expect(entry).not.toBeNull();
    expect(shouldHideByModelsDevCapabilities(entry!)).toBe(true);
    expect(shouldHideModel({
      providerId: 'google',
      modelId: 'gemini-2.5-flash-preview-tts',
      agent: 'claude',
    })).toBe(true);
  });

  it('lets pinned capabilities bypass models.dev vetoes but not the blacklist', () => {
    const candidate = {
      providerId: 'requesty',
      modelId: 'openai/gpt-5-chat',
      agent: 'claude' as const,
    };
    const entry = findModelsDevModel(candidate.providerId, candidate.modelId, cache);
    expect(entry).not.toBeNull();
    expect(shouldHideByModelsDevCapabilities(entry!)).toBe(true);
    expect(shouldHideModel(candidate)).toBe(true);
    expect(shouldHideModel({ ...candidate, ignoreModelsDevCapabilities: true })).toBe(false);
    expect(shouldHideModel({
      providerId: 'openai',
      modelId: 'z-ai/glm4.7',
      agent: 'claude',
      ignoreModelsDevCapabilities: true,
    })).toBe(true);
  });

  it('does not hide text-output models with missing tool_call field', () => {
    const entry = findModelsDevModel('google', 'gemini-2.5-pro', cache);
    expect(entry).not.toBeNull();
    expect(shouldHideByModelsDevCapabilities(entry!)).toBe(false);
  });
});

describe('materializeRegistry', () => {
  it('drops blacklisted models from provider cache', () => {
    const registry = {
      schema_version: '1' as const,
      providers: [{
        id: 'openai',
        templateId: 'openai',
        name: 'OpenAI',
        enabled: true,
        authRef: 'keyring:provider:openai',
        api: { npm: '@ai-sdk/openai' },
        addedAt: '2026-06-10T00:00:00.000Z',
        modelsCache: {
          fetchedAt: '2026-06-10T00:00:00.000Z',
          models: [
            {
              id: 'z-ai/glm4.7',
              name: 'GLM 4.7',
              upstreamModelId: 'z-ai/glm4.7',
              modelFormat: 'openai' as const,
              npm: '@ai-sdk/openai',
            },
            {
              id: 'gpt-5.6-sol',
              name: 'GPT-5.6 Sol',
              upstreamModelId: 'gpt-5.6-sol',
              modelFormat: 'openai' as const,
              npm: '@ai-sdk/openai',
            },
          ],
        },
      }],
    };
    const locals = materializeRegistry(registry, () => 'key', { agent: 'claude' });
    expect(locals).toHaveLength(1);
    expect(locals[0]?.models.map(m => m.id)).toEqual(['gpt-5.6-sol']);
  });
});

/**
 * A provider whose own validated resolver states coding capability must never
 * be second-guessed by the models.dev heuristic.
 *
 * The authority is the PROVIDER IDENTITY, resolved at materialization, rather
 * than a per-model flag carried in the persisted cache — a hand-edited or stale
 * cache row therefore cannot claim the exemption, and cannot lose it either.
 */
describe('provider-authoritative models bypass the models.dev capability veto', () => {
  it('exempts every materialized retained OpenCode Go model', () => {
    const registry = {
      schema_version: '1' as const,
      providers: [{
        id: 'opencode-go',
        templateId: 'opencode-go',
        name: 'OpenCode Go',
        enabled: true,
        authRef: 'keyring:provider:opencode-go',
        authType: 'api' as const,
        api: { npm: '@ai-sdk/openai-compatible', url: 'https://opencode.ai/zen/go/v1' },
        addedAt: '2026-08-12T00:00:00.000Z',
        modelsCache: {
          fetchedAt: '2026-08-12T00:00:00.000Z',
          models: [
            { id: 'kimi-k3', name: 'Kimi K3', upstreamModelId: 'kimi-k3' },
            { id: 'qwen3.8-max', name: 'Qwen 3.8 Max', upstreamModelId: 'qwen3.8-max' },
            // A hand-edited row for a model the pinned catalog does not own.
            // The pinned allowlist, not this flag, is what keeps it out.
            { id: 'z-ai/glm4.7', name: 'GLM 4.7', upstreamModelId: 'z-ai/glm4.7' },
          ],
        },
      }],
    };
    const models = materializeRegistry(registry, () => 'key', { agent: 'claude' })[0]?.models ?? [];
    expect(models.length).toBeGreaterThan(0);
    expect(models.map(model => model.id)).not.toContain('z-ai/glm4.7');
    for (const model of models) {
      expect(model.ignoreModelsDevCapabilities, model.id).toBe(true);
      // The exemption is what the hide filter is actually given, so no
      // models.dev heuristic can veto a row this provider vouches for.
      expect(shouldHideModel({
        providerId: 'opencode-go',
        modelId: model.id,
        agent: 'claude',
        ignoreModelsDevCapabilities: model.ignoreModelsDevCapabilities,
      }), model.id).toBe(false);
    }
  });

  it('still applies the veto to the same model under an ordinary provider', () => {
    const locals = materializeRegistry({
      schema_version: '1' as const,
      providers: [{
        id: 'openai',
        templateId: 'openai',
        name: 'OpenAI',
        enabled: true,
        authRef: 'keyring:provider:openai',
        api: { npm: '@ai-sdk/openai' },
        addedAt: '2026-08-12T00:00:00.000Z',
        modelsCache: {
          fetchedAt: '2026-08-12T00:00:00.000Z',
          models: [{
            id: 'z-ai/glm4.7',
            name: 'GLM 4.7',
            upstreamModelId: 'z-ai/glm4.7',
            modelFormat: 'openai' as const,
            npm: '@ai-sdk/openai',
          }],
        },
      }],
    }, () => 'key', { agent: 'claude' });
    expect(locals).toHaveLength(0);
  });
});
