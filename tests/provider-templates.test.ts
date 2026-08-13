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
  it('offers Meta AI, OpenAI and OpenCode Go API-key templates as addable', () => {
    expect(listSupportedTemplates().map(t => t.id)).toEqual(['meta-ai', 'openai', 'opencode-go']);
  });

  it('filters templates by search query', () => {
    const templates = listSupportedTemplates();
    // meta-ai matches 'open' through its npm package (@ai-sdk/openai-compatible),
    // which is the filter's existing id/name/npm semantics, not a Meta-specific rule.
    expect(filterTemplates(templates, 'open').map(t => t.id)).toEqual(['meta-ai', 'openai', 'opencode-go']);
    expect(filterTemplates(templates, 'meta').map(t => t.id)).toEqual(['meta-ai']);
    expect(filterTemplates(templates, 'groq')).toEqual([]);
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
    expect(listAddableTemplates(['openai', 'opencode-go']).map(t => t.id)).toEqual(['meta-ai']);
    expect(listAddableTemplates(['meta-ai', 'openai', 'opencode-go']).map(t => t.id)).toEqual([]);
    expect(listAddableTemplates([]).map(t => t.id)).toEqual(['meta-ai', 'openai', 'opencode-go']);
  });

  it('describes Meta AI as a key-validating api-list provider with curated context windows', () => {
    const meta = getTemplateById('meta-ai')!;
    expect(meta.defaultBaseUrl).toBe('https://api.meta.ai/v1');
    expect(meta.authType).toBe('api');
    expect(meta.modelSource).toBe('api-list');

    // Overlay, not allowlist: Meta's live /v1/models is authoritative for WHICH
    // models exist, and the curated entries only supply the context windows that
    // list omits. An allowlist here would hide every newly launched Meta model.
    expect(meta.staticModelPolicy).toBe('overlay');
    expect(meta.staticModels?.map(m => m.id)).toEqual([
      'muse-spark-1.1',
      'muse-spark-1.2',
      'muse-spark-1.2-contributor',
    ]);
    expect(meta.staticModels?.every(m => m.contextWindow === 1_048_576)).toBe(true);

    // No probe by design: /v1/models requires the key, so the shared api-list
    // fetch already rejects a bad one. Declaring a verifyCredential here would
    // add a live-credential destination for no validation benefit.
    expect(meta.verifyCredential).toBeUndefined();
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
