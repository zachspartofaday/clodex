import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  filterTemplates,
  getTemplateById,
  listAddableTemplates,
  listSupportedTemplates,
  listVisibleOAuthTemplates,
} from '../src/provider-templates.js';
import { fetchTemplateModels } from '../src/registry/fetch-template-models.js';

describe('provider templates', () => {
  it('offers OpenAI and OpenCode Go API-key templates as addable', () => {
    expect(listSupportedTemplates().map(t => t.id)).toEqual(['meta-ai', 'openai', 'opencode-go']);
  });

  it('filters templates by search query', () => {
    const templates = listSupportedTemplates();
    expect(filterTemplates(templates, 'open').map(t => t.id)).toEqual(['meta-ai', 'openai', 'opencode-go']);
    expect(filterTemplates(templates, 'groq')).toEqual([]);
  });

  it('describes the Meta AI template with curated 1M context windows', () => {
    const template = getTemplateById('meta-ai');
    expect(template).toMatchObject({
      authType: 'api',
      npm: '@ai-sdk/openai-compatible',
      defaultBaseUrl: 'https://api.meta.ai/v1',
      modelSource: 'api-list',
      staticModelPolicy: 'overlay',
    });
    // /v1/models authenticates (401 invalid_api_key on a bad key), so the
    // api-list flow validates the credential itself — no verifyCredential.
    expect(template?.verifyCredential).toBeUndefined();
    const ids = template?.staticModels?.map(m => m.id);
    expect(ids).toEqual(['muse-spark-1.1', 'muse-spark-1.2', 'muse-spark-1.2-contributor']);
    for (const model of template?.staticModels ?? []) {
      expect(model.contextWindow).toBe(1_048_576);
      expect(model.modelFormat).toBe('openai');
    }
  });

  it('looks up template by id', () => {
    expect(getTemplateById('openai')?.npm).toBe('@ai-sdk/openai');
    expect(getTemplateById('openai-oauth')?.authType).toBe('oauth');
    expect(getTemplateById('opencode-go')?.staticModelPolicy).toBe('allowlist');
    expect(getTemplateById('groq')).toBeUndefined();
  });

  it('lists only the OpenAI OAuth template for discovery surfaces', () => {
    expect(listVisibleOAuthTemplates().map(t => t.id)).toEqual(['openai-oauth']);
    expect(listVisibleOAuthTemplates(['openai-oauth']).map(t => t.id)).not.toContain('openai-oauth');
  });

  it('excludes already-configured providers from addable list', () => {
    expect(listAddableTemplates(['openai']).map(t => t.id)).toEqual(['meta-ai', 'opencode-go']);
    expect(listAddableTemplates(['openai', 'opencode-go', 'meta-ai']).map(t => t.id)).toEqual([]);
    expect(listAddableTemplates([]).map(t => t.id)).toEqual(['meta-ai', 'openai', 'opencode-go']);
  });
});

describe('fetchTemplateModels', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses OpenAI-style model list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }],
      }),
    }));

    const template = getTemplateById('openai')!;
    const result = await fetchTemplateModels(template, 'test-key');
    expect(result.error).toBeUndefined();
    expect(result.models).toHaveLength(1);
    expect(result.models[0]?.id).toBe('gpt-5.6-sol');
    expect(result.models[0]?.modelFormat).toBe('openai');
  });

  it('returns helpful error on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'invalid key',
    }));

    const template = getTemplateById('openai')!;
    const result = await fetchTemplateModels(template, 'bad-key');
    expect(result.models).toHaveLength(0);
    expect(result.error).toContain('rejected');
  });
});
