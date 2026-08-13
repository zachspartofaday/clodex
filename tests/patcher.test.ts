import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as p from '@clack/prompts';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  applyPatch,
  buildPatchModelConfig,
  buildDesiredPatchConfig,
  computePatchConfigHash,
  evaluatePatchState,
  getPatchManifestPath,
  reportRejectedModelAliases,
  summarizePatchResults,
  tryAcquirePatchLock,
  type PatchManifest,
} from '../src/patcher.js';
import {
  applyClodexPatches,
  PATCH_TRANSFORMS_VERSION,
  PatchApplyError,
  type PatchScriptModelConfig,
} from '../src/patch-transforms.js';
import {
  builtInPatchProofsChanged,
  captureBuiltInPatchProofs,
} from '../src/built-in-patch-proofs.js';
import {
  NETWORK_ENV_CONTRACT_VAR,
  networkEnvBaseline,
} from '../src/network-env.js';

/**
 * The digest a pre-versioning clodex wrote into `patch-state.json`: the bare
 * key-sorted 4-field tuple, with no version wrapper. This is DELIBERATELY FROZEN
 * — it models bytes that already exist on real users' disks, so it must NOT be
 * updated to track future changes to the production canonical tuple. (The
 * "version participates in the digest" property is pinned by the
 * transform-set-version test below, which is immune to tuple drift.)
 */
function computeLegacyPatchConfigHash(config: PatchScriptModelConfig): string {
  const canonical = Object.keys(config).sort().map(key => {
    const entry = config[key]!;
    return [key, entry.alias ?? null, entry.context ?? null, entry.display ?? null];
  });
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

const tweakccMocks = vi.hoisted(() => ({
  tryDetectInstallation: vi.fn(),
  readContent: vi.fn(),
  writeContent: vi.fn(),
}));

vi.mock('tweakcc', () => tweakccMocks);

describe('buildPatchModelConfig', () => {
  const favorites = [
    { providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
    { providerId: 'openai-oauth', modelId: 'gpt-5.6-luna' },
    { providerId: 'openai', modelId: 'mystery-model' },
  ];
  const aliases = [
    { name: 'sol', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
  ];
  const meta = new Map([
    ['openai-oauth:gpt-5.6-sol', {
      contextWindow: 272_000,
      displayName: 'GPT-5.6 Sol (OpenAI (ChatGPT))',
      effort: {
        levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        defaultLevel: 'medium',
      },
    }],
    ['openai-oauth:gpt-5.6-luna', {
      contextWindow: 272_000,
      displayName: 'GPT-5.6 Luna (OpenAI (ChatGPT))',
      effort: {
        levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        defaultLevel: 'medium',
      },
    }],
  ]);
  const rejectedAliases = [
    { name: 'Orbit', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
    { name: 'ORBIT', providerId: 'openai-oauth', modelId: 'gpt-5.6-luna' },
    { name: 'default', providerId: 'openai', modelId: 'davinci-002' },
    { name: 'bad:name', providerId: 'openai', modelId: 'mystery-model' },
    { name: 'ArChIvEd', providerId: 'openai', modelId: 'not-a-favorite' },
  ];
  const rejectedAliasRejections = [
    { alias: rejectedAliases[0]!, reason: 'conflicting-targets' as const },
    { alias: rejectedAliases[1]!, reason: 'conflicting-targets' as const },
    { alias: rejectedAliases[2]!, reason: 'reserved-name' as const },
    { alias: rejectedAliases[3]!, reason: 'invalid-name' as const },
    { alias: rejectedAliases[4]!, reason: 'target-not-favorite' as const },
  ];

  it('builds clodex-prefixed entries with aliases, context windows, and display labels', () => {
    const { config, unknownWindows } = buildPatchModelConfig(
      favorites,
      aliases,
      (providerId, modelId) => meta.get(`${providerId}:${modelId}`),
    );

    expect(config['clodex:openai-oauth:gpt-5.6-sol']).toEqual({
      aliases: ['sol'],
      context: 272_000,
      display: 'GPT-5.6 Sol (OpenAI (ChatGPT))',
      effort: {
        levels: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultLevel: 'high',
      },
    });
    expect(config['clodex:openai-oauth:gpt-5.6-luna']).toEqual({
      context: 272_000,
      display: 'GPT-5.6 Luna (OpenAI (ChatGPT))',
      effort: {
        levels: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultLevel: 'high',
      },
    });
    // Unknown window → no context (Claude Code's 200k default) + warning entry
    expect(config['clodex:openai:mystery-model']).toEqual({});
    expect(unknownWindows).toEqual(['clodex:openai:mystery-model']);
  });

  it('preserves every alias when several names target one favorite', () => {
    const { config } = buildPatchModelConfig(
      [{ providerId: 'opencode-go', modelId: 'deepseek-v4-flash' }],
      [
        { name: 'luna', providerId: 'opencode-go', modelId: 'deepseek-v4-flash' },
        { name: 'terra', providerId: 'opencode-go', modelId: 'deepseek-v4-flash' },
        { name: 'ds4', providerId: 'opencode-go', modelId: 'deepseek-v4-flash' },
      ],
      () => ({
        contextWindow: 1_000_000,
        displayName: 'DeepSeek V4 Flash (OpenCode Go)',
        effort: {
          levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
          defaultLevel: 'medium',
        },
      }),
    );

    // Saved order, every alias, one shared projected capability contract.
    expect(config['clodex:opencode-go:deepseek-v4-flash']).toEqual({
      aliases: ['luna', 'terra', 'ds4'],
      context: 1_000_000,
      display: 'DeepSeek V4 Flash (OpenCode Go)',
      effort: {
        levels: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultLevel: 'high',
      },
    });
  });

  it('keeps same-target aliases without inventing effort from sparse metadata', () => {
    const { config } = buildPatchModelConfig(
      [{ providerId: 'opencode-go', modelId: 'deepseek-v4-flash' }],
      [
        { name: 'luna', providerId: 'opencode-go', modelId: 'deepseek-v4-flash' },
        { name: 'ds4', providerId: 'opencode-go', modelId: 'deepseek-v4-flash' },
      ],
      () => ({
        contextWindow: 1_000_000,
        effort: { levels: ['high', 'max'], defaultLevel: 'high' },
      }),
    );

    expect(config['clodex:opencode-go:deepseek-v4-flash']).toEqual({
      aliases: ['luna', 'ds4'],
      context: 1_000_000,
    });
  });

  it('omits context when the window equals the 200k default', () => {
    const { config, unknownWindows } = buildPatchModelConfig(
      [{ providerId: 'openai', modelId: 'davinci-002' }],
      [],
      () => ({ contextWindow: 200_000 }),
    );
    expect(config['clodex:openai:davinci-002']).toEqual({});
    expect(unknownWindows).toEqual([]);
  });

  it('omits a blank display label rather than baking an empty string', () => {
    const { config } = buildPatchModelConfig(
      [{ providerId: 'openai', modelId: 'davinci-002' }],
      [],
      () => ({ contextWindow: 272_000, displayName: '   ' }),
    );
    expect(config['clodex:openai:davinci-002']).toEqual({ context: 272_000 });
  });

  it.each([
    {
      name: 'an incomplete base',
      levels: ['high', 'xhigh'],
      defaultLevel: 'high',
    },
    {
      name: 'a transport-only default',
      levels: ['none', 'low', 'medium', 'high'],
      defaultLevel: 'none',
    },
  ])('omits client effort metadata for $name', ({ levels, defaultLevel }) => {
    const { config } = buildPatchModelConfig(
      [{ providerId: 'openai', modelId: 'reasoning-model' }],
      [],
      () => ({
        contextWindow: 200_000,
        effort: { levels, defaultLevel },
      }),
    );
    expect(config['clodex:openai:reasoning-model']).toEqual({});
  });

  it('canonicalizes aliases and omits ambiguous case-fold collisions', () => {
    const { config } = buildPatchModelConfig(
      favorites,
      [
        { name: 'Sol', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
        { name: 'LUNA', providerId: 'openai-oauth', modelId: 'gpt-5.6-luna' },
        { name: 'luna', providerId: 'openai', modelId: 'mystery-model' },
      ],
      (providerId, modelId) => meta.get(`${providerId}:${modelId}`),
    );

    expect(config['clodex:openai-oauth:gpt-5.6-sol']?.aliases).toEqual(['sol']);
    expect(config['clodex:openai-oauth:gpt-5.6-luna']?.aliases).toBeUndefined();
    expect(config['clodex:openai:mystery-model']?.aliases).toBeUndefined();
  });

  it('returns every rejected saved alias so the patch command can report it', () => {
    const desired = buildPatchModelConfig(
      favorites,
      rejectedAliases,
      (providerId, modelId) => meta.get(`${providerId}:${modelId}`),
    );

    expect(desired.rejectedAliases).toEqual(rejectedAliases);
    expect(desired.rejectedAliasRejections).toEqual(rejectedAliasRejections);
  });

  it('reports each rejected alias with its exact stored name and reason', () => {
    const warn = vi.spyOn(p.log, 'warn').mockImplementation(() => {});

    try {
      reportRejectedModelAliases(rejectedAliasRejections);

      expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
        'Saved model alias "Orbit" was not patched — conflicting targets. The saved entry was preserved.',
        'Saved model alias "ORBIT" was not patched — conflicting targets. The saved entry was preserved.',
        'Saved model alias "default" was not patched — reserved client name. The saved entry was preserved.',
        'Saved model alias "bad:name" was not patched — invalid name. The saved entry was preserved.',
        'Saved model alias "ArChIvEd" was not patched — target is not a saved favorite. The saved entry was preserved.',
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not treat missing patch metadata as target unavailability', () => {
    const favorite = { providerId: 'provider', modelId: 'model-a' };
    const desired = buildPatchModelConfig(
      [favorite],
      [{ name: 'active', ...favorite }],
      () => undefined,
    );

    expect(desired.config['clodex:provider:model-a']?.aliases).toEqual(['active']);
    expect(desired.unknownWindows).toEqual(['clodex:provider:model-a']);
    expect(desired.rejectedAliasRejections).toEqual([]);
  });

  it('patches only the first catalog-sized favorite window and rejects aliases beyond it', () => {
    const manyFavorites = Array.from({ length: 25 }, (_, index) => ({
      providerId: 'provider',
      modelId: `model-${index}`,
    }));
    const desired = buildPatchModelConfig(
      manyFavorites,
      [{ name: 'late', providerId: 'provider', modelId: 'model-20' }],
      () => ({ contextWindow: 200_000 }),
    );

    expect(Object.keys(desired.config)).toEqual(
      manyFavorites.slice(0, 20).map(favorite => (
        `clodex:${favorite.providerId}:${favorite.modelId}`
      )),
    );
    expect(desired.capacitySkippedFavorites).toEqual(manyFavorites.slice(20));
    expect(desired.rejectedAliasRejections).toEqual([{
      alias: { name: 'late', providerId: 'provider', modelId: 'model-20' },
      reason: 'target-not-exposed',
    }]);
  });

  it('rejects every same-target alias beyond the catalog window without backfilling', () => {
    const manyFavorites = Array.from({ length: 21 }, (_, index) => ({
      providerId: 'provider',
      modelId: `model-${index}`,
    }));
    const desired = buildPatchModelConfig(
      manyFavorites,
      [
        { name: 'first', providerId: 'provider', modelId: 'model-0' },
        { name: 'late', providerId: 'provider', modelId: 'model-20' },
        { name: 'later', providerId: 'provider', modelId: 'model-20' },
        { name: 'alsofirst', providerId: 'provider', modelId: 'model-0' },
      ],
      () => ({ contextWindow: 200_000 }),
    );

    expect(desired.config['clodex:provider:model-0']?.aliases).toEqual(['first', 'alsofirst']);
    expect(desired.config['clodex:provider:model-20']).toBeUndefined();
    expect(desired.rejectedAliasRejections).toEqual([
      {
        alias: { name: 'late', providerId: 'provider', modelId: 'model-20' },
        reason: 'target-not-exposed',
      },
      {
        alias: { name: 'later', providerId: 'provider', modelId: 'model-20' },
        reason: 'target-not-exposed',
      },
    ]);
  });

  it('keeps the surviving same-target aliases when a sibling name is unusable', () => {
    const favorite = { providerId: 'provider', modelId: 'model-a' };
    const desired = buildPatchModelConfig(
      [favorite],
      [
        { name: 'luna', ...favorite },
        { name: 'default', ...favorite },
        { name: 'bad name', ...favorite },
        { name: 'ds4', ...favorite },
      ],
      () => ({ contextWindow: 200_000 }),
    );

    expect(desired.config['clodex:provider:model-a']?.aliases).toEqual(['luna', 'ds4']);
    expect(desired.rejectedAliasRejections).toEqual([
      { alias: { name: 'default', ...favorite }, reason: 'reserved-name' },
      { alias: { name: 'bad name', ...favorite }, reason: 'invalid-name' },
    ]);
  });
});

describe('buildDesiredPatchConfig', () => {
  const previousHome = process.env.CLODEX_HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clodex-desired-patch-'));
    process.env.CLODEX_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.CLODEX_HOME;
    else process.env.CLODEX_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  function writeInputs(
    model: Record<string, unknown>,
    provider: {
      id?: string;
      templateId?: string;
      name?: string;
      npm?: string;
    } = {},
  ): void {
    const providerId = provider.id ?? 'openai';
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        favoriteModels: [{ providerId, modelId: model.id }],
      }),
    );
    writeFileSync(
      join(home, 'providers.json'),
      JSON.stringify({
        schemaVersion: 1,
        providers: [{
          id: providerId,
          templateId: provider.templateId ?? 'openai',
          name: provider.name ?? 'OpenAI',
          enabled: true,
          authRef: 'env:OPENAI_API_KEY',
          api: { npm: provider.npm ?? '@ai-sdk/openai' },
          modelsCache: {
            fetchedAt: '2026-07-27T00:00:00.000Z',
            models: [model],
          },
          addedAt: '2026-07-27T00:00:00.000Z',
        }],
      }),
    );
  }

  it('filters only stale retained favorites while preserving ordinary unknowns and input order', () => {
    const favorites = [
      { providerId: 'opencode-go', modelId: 'stale-future-model' },
      { providerId: 'imported-opencode', modelId: 'deepseek-v4-pro' },
      { providerId: 'custom-provider', modelId: 'custom-unknown-model' },
      { providerId: 'imported-opencode', modelId: 'stale-future-model' },
      { providerId: 'opencode-go', modelId: 'qwen3.8-max' },
    ];
    const aliases = [
      { name: 'stale', providerId: 'opencode-go', modelId: 'stale-future-model' },
      { name: 'deep', providerId: 'imported-opencode', modelId: 'deepseek-v4-pro' },
      { name: 'custom', providerId: 'custom-provider', modelId: 'custom-unknown-model' },
      { name: 'stale-imported', providerId: 'imported-opencode', modelId: 'stale-future-model' },
      { name: 'qwen', providerId: 'opencode-go', modelId: 'qwen3.8-max' },
    ];
    writeFileSync(join(home, 'config.json'), JSON.stringify({ favoriteModels: favorites, modelAliases: aliases }));
    writeFileSync(join(home, 'providers.json'), JSON.stringify({
      schemaVersion: 1,
      providers: [{
        id: 'opencode-go',
        templateId: 'opencode-go',
        name: 'OpenCode Go',
        enabled: true,
        authRef: 'keyring:provider:opencode-go',
        authType: 'api',
        api: { npm: '@ai-sdk/openai-compatible', url: 'https://opencode.ai/zen/go/v1' },
        modelsCache: {
          fetchedAt: '2026-08-12T00:00:00.000Z',
          models: [{
            id: 'qwen3.8-max',
            upstreamModelId: 'qwen3.8-max',
            name: 'Qwen 3.8 Max',
            modelFormat: 'openai',
          }, {
            id: 'stale-future-model',
            upstreamModelId: 'stale-future-model',
            name: 'Stale future model',
            modelFormat: 'openai',
          }],
        },
        addedAt: '2026-08-12T00:00:00.000Z',
      }, {
        id: 'imported-opencode',
        templateId: 'opencode-go',
        name: 'Imported OpenCode Go',
        enabled: true,
        authRef: 'keyring:provider:imported-opencode',
        authType: 'api',
        api: { npm: '@ai-sdk/openai-compatible', url: 'https://opencode.ai/zen/go/v1' },
        modelsCache: {
          fetchedAt: '2026-08-12T00:00:00.000Z',
          models: [{
            id: 'deepseek-v4-pro',
            upstreamModelId: 'deepseek-v4-pro',
            name: 'DeepSeek V4 Pro',
            modelFormat: 'openai',
          }, {
            id: 'stale-future-model',
            upstreamModelId: 'stale-future-model',
            name: 'Stale future model',
            modelFormat: 'openai',
          }],
        },
        addedAt: '2026-08-12T00:00:00.000Z',
      }, {
        id: 'custom-provider',
        templateId: 'custom-openai',
        name: 'Custom provider',
        enabled: true,
        authRef: 'keyring:provider:custom-provider',
        authType: 'api',
        api: { npm: '@ai-sdk/openai-compatible', url: 'https://custom.invalid/v1' },
        modelsCache: {
          fetchedAt: '2026-08-12T00:00:00.000Z',
          models: [{
            id: 'custom-unknown-model',
            upstreamModelId: 'custom-unknown-model',
            name: 'Custom unknown model',
            modelFormat: 'openai',
          }],
        },
        addedAt: '2026-08-12T00:00:00.000Z',
      }],
    }));
    const configBefore = readFileSync(join(home, 'config.json'), 'utf8');
    const providersBefore = readFileSync(join(home, 'providers.json'), 'utf8');

    const desired = buildDesiredPatchConfig();

    expect(Object.keys(desired.config)).toEqual([
      'clodex:imported-opencode:deepseek-v4-pro',
      'clodex:custom-provider:custom-unknown-model',
      'clodex:opencode-go:qwen3.8-max',
    ]);
    expect(desired.config['clodex:imported-opencode:deepseek-v4-pro']?.aliases).toEqual(['deep']);
    expect(desired.config['clodex:custom-provider:custom-unknown-model']?.aliases).toEqual(['custom']);
    expect(desired.config['clodex:opencode-go:qwen3.8-max']?.aliases).toEqual(['qwen']);
    expect(desired.config['clodex:opencode-go:stale-future-model']).toBeUndefined();
    expect(desired.config['clodex:imported-opencode:stale-future-model']).toBeUndefined();
    expect(desired.rejectedAliases).toEqual(expect.arrayContaining([
      aliases[0],
      aliases[3],
    ]));
    expect(readFileSync(join(home, 'config.json'), 'utf8')).toBe(configBefore);
    expect(readFileSync(join(home, 'providers.json'), 'utf8')).toBe(providersBefore);
  });

  it('does not backfill past a stale retained favorite in the exposure window', () => {
    const ordinaryFavorites = Array.from({ length: 19 }, (_, index) => ({
      providerId: 'custom-provider',
      modelId: `custom-${index}`,
    }));
    const staleFavorite = { providerId: 'opencode-go', modelId: 'stale-future-model' };
    const lateFavorite = { providerId: 'opencode-go', modelId: 'qwen3.8-max' };
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      favoriteModels: [staleFavorite, ...ordinaryFavorites, lateFavorite],
      modelAliases: [
        { name: 'stale', ...staleFavorite },
        { name: 'late', ...lateFavorite },
      ],
    }));
    writeFileSync(join(home, 'providers.json'), JSON.stringify({
      schemaVersion: 1,
      providers: [{
        id: 'opencode-go',
        templateId: 'opencode-go',
        name: 'OpenCode Go',
        enabled: true,
        authRef: 'keyring:provider:opencode-go',
        authType: 'api',
        api: { npm: '@ai-sdk/openai-compatible', url: 'https://opencode.ai/zen/go/v1' },
        modelsCache: {
          fetchedAt: '2026-08-12T00:00:00.000Z',
          models: [{
            id: staleFavorite.modelId,
            name: 'Stale future model',
            modelFormat: 'openai',
          }, {
            id: lateFavorite.modelId,
            name: 'Qwen 3.8 Max',
            modelFormat: 'openai',
          }],
        },
        addedAt: '2026-08-12T00:00:00.000Z',
      }],
    }));

    const desired = buildDesiredPatchConfig();

    expect(Object.keys(desired.config)).toEqual(
      ordinaryFavorites.map(favorite => `clodex:${favorite.providerId}:${favorite.modelId}`),
    );
    expect(desired.capacitySkippedFavorites).toEqual([lateFavorite]);
    expect(desired.rejectedAliasRejections).toEqual([
      { alias: { name: 'stale', ...staleFavorite }, reason: 'target-not-exposed' },
      { alias: { name: 'late', ...lateFavorite }, reason: 'target-not-exposed' },
    ]);
  });

  it('preserves the native high default when provider metadata defaults to medium', () => {
    writeInputs({
      id: 'gpt-5.6-sol',
      upstreamModelId: 'gpt-5.6-sol',
      name: 'GPT-5.6 Sol',
      contextWindow: 272_000,
      modelFormat: 'openai',
    });

    const desired = buildDesiredPatchConfig();

    expect(desired.config['clodex:openai:gpt-5.6-sol']?.effort).toEqual({
      levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultLevel: 'high',
    });
  });

  it('does not leak provider-only extended levels through the production config path', () => {
    writeInputs({
      id: 'gpt-5.5',
      upstreamModelId: 'gpt-5.5',
      name: 'GPT-5.5',
      contextWindow: 272_000,
      modelFormat: 'openai',
    });

    const desired = buildDesiredPatchConfig();

    expect(desired.config['clodex:openai:gpt-5.5']?.effort).toEqual({
      levels: ['low', 'medium', 'high'],
      defaultLevel: 'high',
    });
  });

  it('uses the catalog id when an older cache entry lacks upstreamModelId', () => {
    writeInputs({
      id: 'gpt-5.5',
      name: 'GPT-5.5',
      contextWindow: 272_000,
      modelFormat: 'openai',
    });

    const desired = buildDesiredPatchConfig();

    expect(desired.config['clodex:openai:gpt-5.5']?.effort).toEqual({
      levels: ['low', 'medium', 'high'],
      defaultLevel: 'high',
    });
  });

  it('omits effort when enriched catalog metadata explicitly disables reasoning', () => {
    writeInputs({
      id: 'kimi-k2',
      upstreamModelId: 'kimi-k2',
      name: 'Kimi K2',
      contextWindow: 128_000,
      modelFormat: 'openai',
    }, {
      id: 'qiniu-ai',
      templateId: 'qiniu-ai',
      name: 'Qiniu',
      npm: '@ai-sdk/openai-compatible',
    });

    const desired = buildDesiredPatchConfig();

    expect(desired.config['clodex:qiniu-ai:kimi-k2']?.effort).toBeUndefined();
  });

  it('enforces the Claude-facing cap through the disk-only desired config path', () => {
    const models = Array.from({ length: 25 }, (_, index) => ({
      id: `model-${index}`,
      name: `Model ${index}`,
      contextWindow: 200_000,
      modelFormat: 'openai',
    }));
    const favorites = models.map(model => ({ providerId: 'openai', modelId: model.id }));
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ favoriteModels: favorites }),
    );
    writeFileSync(
      join(home, 'providers.json'),
      JSON.stringify({
        schemaVersion: 1,
        providers: [{
          id: 'openai',
          templateId: 'openai',
          name: 'OpenAI',
          enabled: true,
          authRef: 'env:OPENAI_API_KEY',
          api: { npm: '@ai-sdk/openai' },
          modelsCache: {
            fetchedAt: '2026-07-27T00:00:00.000Z',
            models,
          },
          addedAt: '2026-07-27T00:00:00.000Z',
        }],
      }),
    );

    const desired = buildDesiredPatchConfig();

    expect(Object.keys(desired.config)).toEqual(
      favorites.slice(0, 20).map(favorite => `clodex:${favorite.providerId}:${favorite.modelId}`),
    );
    expect(desired.capacitySkippedFavorites).toEqual(favorites.slice(20));
  });
});

describe('computePatchConfigHash', () => {
  it('is stable across key ordering and sensitive to changes', () => {
    const a = { 'clodex:p:m1': { alias: 'x', context: 1000 }, 'clodex:p:m2': {} };
    const b = { 'clodex:p:m2': {}, 'clodex:p:m1': { alias: 'x', context: 1000 } };
    expect(computePatchConfigHash(a)).toBe(computePatchConfigHash(b));
    expect(computePatchConfigHash(a)).not.toBe(
      computePatchConfigHash({ ...a, 'clodex:p:m1': { alias: 'y', context: 1000 } }),
    );
    expect(computePatchConfigHash(a)).not.toBe(
      computePatchConfigHash({ ...a, 'clodex:p:m1': { alias: 'x', context: 2000 } }),
    );
  });

  it('hashes every alias in saved order', () => {
    const one = { 'clodex:p:m1': { aliases: ['luna'], context: 1000 } };
    const three = {
      'clodex:p:m1': { aliases: ['luna', 'terra', 'ds4'], context: 1000 },
    };

    // Adding or removing an alias makes an installed patch read as stale.
    expect(computePatchConfigHash(one)).not.toBe(computePatchConfigHash(three));
    // Reordering does too — the order is the identity order baked into the binary.
    expect(computePatchConfigHash(three)).not.toBe(computePatchConfigHash({
      'clodex:p:m1': { aliases: ['ds4', 'terra', 'luna'], context: 1000 },
    }));
    // A legacy single-alias entry and its one-element array form are the same config.
    expect(computePatchConfigHash({
      'clodex:p:m1': { alias: 'luna', context: 1000 },
    })).toBe(computePatchConfigHash(one));
  });

  it('changes when only the display label changes (so an old patch reads as stale)', () => {
    const base = { 'clodex:p:m1': { alias: 'x', context: 1000 } };
    expect(computePatchConfigHash(base)).not.toBe(
      computePatchConfigHash({ 'clodex:p:m1': { alias: 'x', context: 1000, display: 'M One (P)' } }),
    );
    expect(computePatchConfigHash({ 'clodex:p:m1': { alias: 'x', context: 1000, display: 'M One (P)' } })).not.toBe(
      computePatchConfigHash({ 'clodex:p:m1': { alias: 'x', context: 1000, display: 'M One (Q)' } }),
    );
  });

  it('changes when only the supported effort levels change', () => {
    const base = {
      'clodex:p:m1': {
        effort: {
          levels: ['low', 'medium', 'high'],
          defaultLevel: 'medium',
        },
      },
    };
    expect(computePatchConfigHash(base)).not.toBe(
      computePatchConfigHash({
        'clodex:p:m1': {
          effort: {
            levels: ['low', 'medium', 'high', 'xhigh'],
            defaultLevel: 'medium',
          },
        },
      }),
    );
  });

  it('changes when only the default effort level changes', () => {
    const base = {
      'clodex:p:m1': {
        effort: {
          levels: ['low', 'medium', 'high'],
          defaultLevel: 'medium',
        },
      },
    };
    expect(computePatchConfigHash(base)).not.toBe(
      computePatchConfigHash({
        'clodex:p:m1': {
          effort: {
            levels: ['low', 'medium', 'high'],
            defaultLevel: 'high',
          },
        },
      }),
    );
  });
  it('differs from the legacy model-config-only hash', () => {
    const config = { 'clodex:p:m1': { alias: 'x', context: 1000, display: 'M One (P)' } };
    expect(computePatchConfigHash(config)).not.toBe(computeLegacyPatchConfigHash(config));
  });

  it('changes when the transform-set version changes', () => {
    const config = { 'clodex:p:m1': { alias: 'x', context: 1000 } };
    expect(computePatchConfigHash(config)).toBe(computePatchConfigHash(config, PATCH_TRANSFORMS_VERSION));
    expect(computePatchConfigHash(config, PATCH_TRANSFORMS_VERSION + 1)).not.toBe(
      computePatchConfigHash(config, PATCH_TRANSFORMS_VERSION),
    );
  });

  it('changes with enabled local patch bytes while preserving the disabled hash', () => {
    const config = { 'clodex:p:m1': { alias: 'x', context: 1000 } };
    const disabled = computePatchConfigHash(config);

    expect(computePatchConfigHash(config, PATCH_TRANSFORMS_VERSION, undefined)).toBe(disabled);
    expect(computePatchConfigHash(config, PATCH_TRANSFORMS_VERSION, 'v1:first')).not.toBe(disabled);
    expect(computePatchConfigHash(config, PATCH_TRANSFORMS_VERSION, 'v1:first')).not.toBe(
      computePatchConfigHash(config, PATCH_TRANSFORMS_VERSION, 'v1:second'),
    );
  });
});

describe('PATCH_TRANSFORMS_VERSION', () => {
  // Folding the version into the config hash only helps if somebody actually
  // bumps it. Nothing else couples an edit of the transform sources to the
  // constant, and a forgotten bump reproduces exactly the silent staleness this
  // mechanism exists to prevent — with a fully green suite. So pin the sources.
  //
  // WHEN THIS FAILS: a transform source changed. Decide, deliberately:
  //   * transform set changed materially (site added/removed, or a site's regex,
  //     replacement, or ordering changed) -> bump PATCH_TRANSFORMS_VERSION AND
  //     update the digest below, in the same commit;
  //   * comment/formatting/type-only edit -> update the digest below and leave
  //     the version alone (no need to make every install repatch).
  //
  // Scope caveat: this hashes the transform file and the constants that are
  // emitted into its child-network patch. patch-transforms.ts also imports
  // `isReservedModelAlias`, so a change reaching the transforms from
  // model-aliases.ts will not trip this guard. That import feeds a `fail()` gate
  // only, so it can turn a patch into a hard PatchApplyError but cannot silently
  // alter the bytes of a patch that succeeds — the failure mode this guard exists
  // to prevent. It catches the common case (a direct edit), not every possible one.
  it('is re-pinned deliberately whenever patch-transforms.ts changes', () => {
    // Normalize line endings: a Windows checkout with core.autocrlf=true would
    // otherwise fail this guard with zero source change, which is exactly the
    // "re-pin without thinking" reflex the guard is meant to avoid.
    const source = [
      '../src/patch-transforms.ts',
      '../src/network-env.ts',
    ].map(path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n'))
      .join('\n');
    const digest = createHash('sha256').update(source).digest('hex');
    expect({ version: PATCH_TRANSFORMS_VERSION, digest }).toEqual({
      version: 8,
      digest: '125a4f90afcf04765b9aa25394edb595cbfd4ccad803c6bdbdc4dad6a55ecf7a',
    });
  });
});

describe('tweakcc dependency patch', () => {
  it('keeps tweakcc 4.3.0 patched for only the exact Bun root CLI module', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { dependencies: Record<string, string> };
    const workspace = readFileSync(
      new URL('../pnpm-workspace.yaml', import.meta.url),
      'utf8',
    );
    const lockfile = readFileSync(
      new URL('../pnpm-lock.yaml', import.meta.url),
      'utf8',
    );
    const patch = readFileSync(
      new URL('../patches/tweakcc@4.3.0.patch', import.meta.url),
      'utf8',
    );
    const tweakccEntry = createRequire(import.meta.url).resolve('tweakcc');
    const installedNativeModule = readFileSync(
      join(dirname(dirname(tweakccEntry)), 'nativeInstallation-Bo_Crunz.mjs'),
      'utf8',
    );

    expect(packageJson.dependencies['tweakcc']).toBe('4.3.0');
    expect(workspace.match(/  tweakcc@4\.3\.0: patches\/tweakcc@4\.3\.0\.patch/g)).toHaveLength(1);
    expect(lockfile.match(
      /  tweakcc@4\.3\.0:\n    hash: 9f4c832147f900c8308e842920a2796aa1e5841cf3a73c1f033ba96421c1d3bd\n    path: patches\/tweakcc@4\.3\.0\.patch/g,
    )).toHaveLength(1);
    expect(patch.match(/^\+.*e===`\/\$bunfs\/root\/cli`.*$/gm)).toHaveLength(1);

    // tweakcc does not export this selector. Execute the exact expression from
    // the installed dependency so a missing/reverse-applied pnpm patch fails
    // behaviorally rather than merely proving that the patch artifact exists.
    const selectorMatch = installedNativeModule.match(
      /function [\w$]+\(([\w$]+)\)\{return ([^}]*src\/entrypoints\/cli\.js[^}]*)\}/,
    );
    expect(selectorMatch).toBeDefined();
    const selector = new Function(
      selectorMatch![1]!,
      `return ${selectorMatch![2]!};`,
    ) as (moduleName: string) => boolean;

    expect(selector('/$bunfs/root/cli')).toBe(true);
    expect(selector('/src/entrypoints/cli.js')).toBe(true);
    expect(selector('/opt/$bunfs/root/cli')).toBe(false);
    expect(selector('$bunfs/root/cli')).toBe(false);
    expect(selector('/$bunfs/root/cli.exe')).toBe(false);
    expect(selector('\\$bunfs\\root\\cli')).toBe(false);
    expect(selector('/cli')).toBe(false);
  });
});

describe('evaluatePatchState', () => {
  const manifest: PatchManifest = {
    binaryPath: '/opt/claude/claude',
    claudeVersion: '2.1.183',
    configHash: 'hash-1',
    patchedSize: 1234,
    patchedSha256: 'sha',
    backupPath: '/backups/claude-2.1.183.orig',
    patchedAt: '2026-07-19T00:00:00.000Z',
  };

  it('reports unpatched without a manifest or for a different binary', () => {
    expect(evaluatePatchState(null, { binaryPath: '/opt/claude/claude', claudeVersion: '2.1.183', configHash: 'hash-1' })).toBe('unpatched');
    expect(evaluatePatchState(manifest, { binaryPath: '/other/claude', claudeVersion: '2.1.183', configHash: 'hash-1' })).toBe('unpatched');
  });

  it('reports current when version, size, and config hash match', () => {
    expect(evaluatePatchState(manifest, {
      binaryPath: '/opt/claude/claude',
      claudeVersion: '2.1.183',
      configHash: 'hash-1',
      binarySize: 1234,
    })).toBe('current');
  });

  it('reports stale-config when the desired config hash changed', () => {
    expect(evaluatePatchState(manifest, {
      binaryPath: '/opt/claude/claude',
      claudeVersion: '2.1.183',
      configHash: 'hash-2',
      binarySize: 1234,
    })).toBe('stale-config');
  });

  it('reports stale-config for a manifest hashed before transform-set versioning', () => {
    const config = { 'clodex:p:m1': { alias: 'x', context: 1000 } };
    const legacyManifest = { ...manifest, configHash: computeLegacyPatchConfigHash(config) };
    expect(evaluatePatchState(legacyManifest, {
      binaryPath: '/opt/claude/claude',
      claudeVersion: '2.1.183',
      configHash: computePatchConfigHash(config),
      binarySize: 1234,
    })).toBe('stale-config');
  });

  it('reports stale-binary when claude was updated or replaced', () => {
    expect(evaluatePatchState(manifest, {
      binaryPath: '/opt/claude/claude',
      claudeVersion: '2.2.0',
      configHash: 'hash-1',
    })).toBe('stale-binary');
    expect(evaluatePatchState(manifest, {
      binaryPath: '/opt/claude/claude',
      claudeVersion: '2.1.183',
      configHash: 'hash-1',
      binarySize: 9999,
    })).toBe('stale-binary');
  });
});

describe('tryAcquirePatchLock', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clodex-patch-lock-'));
    lockPath = join(dir, 'patch.lock');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('acquires and releases the lock', () => {
    const release = tryAcquirePatchLock(lockPath);
    expect(release).not.toBeNull();
    expect(existsSync(lockPath)).toBe(true);
    const content = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(content.pid).toBe(process.pid);
    release!();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('refuses the lock while a live process holds it', () => {
    const release = tryAcquirePatchLock(lockPath, { isAlive: () => true });
    expect(release).not.toBeNull();
    expect(tryAcquirePatchLock(lockPath, { isAlive: () => true })).toBeNull();
    release!();
  });

  it('steals a lock left by a dead process', () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: Date.now() }));
    const release = tryAcquirePatchLock(lockPath, { isAlive: () => false });
    expect(release).not.toBeNull();
    release!();
  });

  it('steals a stale lock older than the timeout even when the pid is alive', () => {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() - 11 * 60 * 1000 }));
    const release = tryAcquirePatchLock(lockPath, { isAlive: () => true });
    expect(release).not.toBeNull();
    release!();
  });

  it('steals an unreadable lock file', () => {
    writeFileSync(lockPath, 'not-json');
    const release = tryAcquirePatchLock(lockPath, { isAlive: () => true });
    expect(release).not.toBeNull();
    release!();
  });
});

describe('applyClodexPatches input validation', () => {
  it('rejects an empty model config', () => {
    expect(() => applyClodexPatches('var x = 1;', {})).toThrow(/MODEL_CONFIG is empty/);
  });

  it('rejects unsafe aliases', () => {
    expect(() => applyClodexPatches('var x = 1;', {
      'clodex:openai:model': { alias: 'Bad Alias!' },
    })).toThrow(/not a safe lowercase alias/);
  });

  it('rejects reserved aliases', () => {
    expect(() => applyClodexPatches('var x = 1;', {
      'clodex:openai:model': { alias: 'sonnet' },
    })).toThrow(/reserved alias/);
  });

  it('rejects an unsafe or reserved name anywhere in an alias list', () => {
    expect(() => applyClodexPatches('var x = 1;', {
      'clodex:openai:model': { aliases: ['luna', 'Bad Alias!', 'ds4'] },
    })).toThrow(/not a safe lowercase alias/);
    expect(() => applyClodexPatches('var x = 1;', {
      'clodex:openai:model': { aliases: ['luna', 'sonnet', 'ds4'] },
    })).toThrow(/reserved alias/);
  });

  it('rejects malformed alias lists and non-string entries', () => {
    expect(() => applyClodexPatches('var x = 1;', {
      'clodex:openai:model': { aliases: 'luna' as unknown as string[] },
    })).toThrow(/aliases for "clodex:openai:model" must be an array/);
    expect(() => applyClodexPatches('var x = 1;', {
      'clodex:openai:model': { aliases: ['luna', 7 as unknown as string] },
    })).toThrow(/alias for "clodex:openai:model" must be a string/);
  });

  it('rejects duplicate aliases instead of silently overwriting one', () => {
    expect(() => applyClodexPatches('var x = 1;', {
      'clodex:openai:model-a': { aliases: ['luna'] },
      'clodex:openai:model-b': { aliases: ['luna'] },
    })).toThrow(/alias "luna" is configured more than once/);
    expect(() => applyClodexPatches('var x = 1;', {
      'clodex:openai:model': { aliases: ['luna', 'LUNA'] },
    })).toThrow(/alias "luna" is configured more than once/);
    expect(() => applyClodexPatches('var x = 1;', {
      'clodex:openai:model': { alias: 'luna', aliases: ['luna'] },
    })).toThrow(/alias "luna" is configured more than once/);
  });

  it('rejects an explicit context on a [1m]-suffixed id (the suffix already forces 1M)', () => {
    expect(() => applyClodexPatches('var x = 1;', {
      'clodex:openai:model[1m]': { context: 1_000_000 },
    })).toThrow(/keeps the \[1m\] suffix/);
  });

  it('rejects an explicit context when any alias in the list keeps the [1m] suffix', () => {
    expect(() => applyClodexPatches('var x = 1;', {
      'clodex:openai:model': {
        aliases: ['luna', 'ds4[1m]'],
        context: 1_000_000,
      },
    })).toThrow(/keeps the \[1m\] suffix/);
  });

  it.each([
    {
      levels: ['low', 'high'],
      defaultLevel: 'high',
    },
    {
      levels: ['low', 'medium', 'high'],
      defaultLevel: 'max',
    },
  ])('rejects effort metadata outside the native client contract', effort => {
    expect(() => applyClodexPatches('var x = 1;', {
      'clodex:openai:model': { effort },
    })).toThrow(/must include low, medium, and high with a native default/);
  });

  it('throws PatchApplyError carrying per-site results when a required anchor is missing', () => {
    let caught: unknown;
    try {
      applyClodexPatches('var x = 1;', { 'clodex:openai:model': { alias: 'mm' } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PatchApplyError);
    expect((caught as Error).message).toContain('required patch failed: PATCH 1');
    expect((caught as PatchApplyError).results).toEqual([
      { status: 'FAIL', name: 'PATCH 1: Agent tool model enum', extra: 'anchor not found' },
    ]);
  });
});

describe('summarizePatchResults', () => {
  it('formats per-site lines plus the applied/skipped/failed summary', () => {
    expect(summarizePatchResults([
      { status: 'OK', name: 'PATCH 1: Agent tool model enum' },
      { status: 'SKIP', name: 'PATCH 6: alias resolver switch', extra: 'no aliases configured' },
      { status: 'FAIL', name: 'PATCH 5: model picker options', extra: 'anchor not found' },
    ])).toEqual([
      '  OK   PATCH 1: Agent tool model enum',
      '  SKIP PATCH 6: alias resolver switch — no aliases configured',
      '  FAIL PATCH 5: model picker options — anchor not found',
      'clodex patch: 1 applied, 1 skipped, 1 failed',
      'clodex patch: FAILED patches: PATCH 5: model picker options',
    ]);
  });
});

// A minified stand-in for the Claude Code bundle carrying every anchor the
// patch transforms key on, so they can be executed end to end.
const CLAUDE_CORE_FIXTURE = [
  '.enum(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for this agent. Defaults to inherit.`)',
  'var KNOWN=["sonnet","opus","haiku","fable","opusplan"];',
  'function rz(x){switch(x){case"best":{return "opus"}default:return null}}',
  'function opts(e,t,r){let n=cur(),o=(n==="opus")?[n,r]:[r];for(let i of o)Dlh(e,i,t);return e}',
  'function RS(e,t){let r=FAc();if(r!==void 0)return r;if(EHi(e,t))return Dve;return $Ac(e,t)}',
  'function cwdOf(){let p=process.env.PWD;return p}',
  'function childEnv(){let e=extra(),t=Object.keys(e).length>0,n=Object.keys(e).length>0,s=flag(process.env.CLAUDE_CODE_REMOTE)?remote():{};let o=[process.env.CLAUDE_CODE_OAUTH_TOKEN,process.env.CLAUDE_CODE_SUBSCRIPTION_TYPE,process.env.CLAUDE_BG_PTY_AUTH,"OTEL_",process.env.CLAUDE_CODE_OTEL_DIAG_STDERR],u=["CLAUDE_CODE_OAUTH_TOKEN"];if(!t&&!n&&!o[0])return process.env;let v={...process.env,...e,...s};for(let k of u)delete v[k],delete v[`INPUT_${k}`];return v}function mcpAllow(){let e=process.env.CLAUDE_CODE_MCP_ALLOWLIST_ENV;return e}',
].join('\n');

const digestOf = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * The re-patch tests below all start from the same state: a live binary holding
 * a previous clodex patch, plus an ESTABLISHED pristine backup — content-addressed
 * (so no version probe is needed to trust it) and recorded in the manifest. That
 * is what makes `applyPatch` plan a `restore`, i.e. seed the candidate from the
 * backup rather than from the patched binary. Spelling it out matters: with a
 * manifest that does not identify the live bytes as clodex's own patch, the
 * planner would fall through to inspecting them and could snapshot a PATCHED
 * binary as "pristine" — the exact thing the backup rules exist to prevent.
 */
const PATCHED_BINARY = 'previously-patched-native';
const PRISTINE_BINARY = 'pristine-native';
const PRISTINE_BACKUP_NAME = `claude-test-version-${digestOf(PRISTINE_BINARY).slice(0, 16)}.orig`;

function priorPatchManifest(binaryPath: string, backupPath: string): PatchManifest {
  return {
    binaryPath,
    claudeVersion: 'test-version',
    configHash: 'previous-config-hash',
    patchedSize: Buffer.byteLength(PATCHED_BINARY),
    patchedSha256: digestOf(PATCHED_BINARY),
    backupPath,
    pristineSha256: digestOf(PRISTINE_BINARY),
    patchedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('applyPatch', () => {
  it('does not write the binary or a current manifest when effort anchors fail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-effort-anchor-failure-'));
    const binaryPath = join(dir, 'claude');
    const previousAppHome = process.env.CLODEX_HOME;
    const previousTweakccHome = process.env.TWEAKCC_CONFIG_DIR;
    writeFileSync(binaryPath, 'pristine-native');
    process.env.CLODEX_HOME = join(dir, 'app-home');
    process.env.TWEAKCC_CONFIG_DIR = join(dir, 'tweakcc-home');

    tweakccMocks.tryDetectInstallation.mockReset();
    tweakccMocks.readContent.mockReset();
    tweakccMocks.writeContent.mockReset();
    tweakccMocks.tryDetectInstallation.mockImplementation(
      async ({ path }: { path: string }) => {
        expect(path).not.toBe(binaryPath);
        expect(readFileSync(path, 'utf8')).toBe('pristine-native');
        return {
          path,
          version: 'test-version',
          kind: 'native',
        };
      },
    );
    tweakccMocks.readContent.mockResolvedValue(CLAUDE_CORE_FIXTURE);

    try {
      const outcome = await applyPatch(
        binaryPath,
        'test-version',
        {
          config: {
            'clodex:test:extended': {
              alias: 'extended',
              effort: {
                levels: ['low', 'medium', 'high', 'xhigh', 'max'],
                defaultLevel: 'high',
              },
            },
          },
          unknownWindows: [],
        },
        'desired-config-hash',
        { trace: false, manifest: null },
      );

      expect(outcome.ok).toBe(false);
      expect(outcome.message).toContain('required effort patches failed');
      expect(outcome.detailLines).toContain(
        'clodex patch: FAILED patches: PATCH 8a: effort capability; '
          + 'PATCH 8b: xhigh effort capability; '
          + 'PATCH 8c: max effort capability; PATCH 9: default effort',
      );
      expect(tweakccMocks.writeContent).not.toHaveBeenCalled();
      expect(readFileSync(binaryPath, 'utf8')).toBe('pristine-native');
      expect(existsSync(getPatchManifestPath())).toBe(false);
    } finally {
      if (previousAppHome === undefined) delete process.env.CLODEX_HOME;
      else process.env.CLODEX_HOME = previousAppHome;
      if (previousTweakccHome === undefined) delete process.env.TWEAKCC_CONFIG_DIR;
      else process.env.TWEAKCC_CONFIG_DIR = previousTweakccHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves the working binary and manifest when a re-patch fails validation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-repatch-validation-failure-'));
    const binaryPath = join(dir, 'claude');
    const tweakccHome = join(dir, 'tweakcc-home');
    const pristinePath = join(tweakccHome, PRISTINE_BACKUP_NAME);
    const previousAppHome = process.env.CLODEX_HOME;
    const previousTweakccHome = process.env.TWEAKCC_CONFIG_DIR;
    const previousManifest = '{"existing":"manifest"}\n';
    mkdirSync(tweakccHome, { recursive: true });
    writeFileSync(binaryPath, 'previously-patched-native');
    writeFileSync(pristinePath, 'pristine-native');
    process.env.CLODEX_HOME = dir;
    process.env.TWEAKCC_CONFIG_DIR = tweakccHome;
    writeFileSync(getPatchManifestPath(), previousManifest);

    tweakccMocks.tryDetectInstallation.mockReset();
    tweakccMocks.readContent.mockReset();
    tweakccMocks.writeContent.mockReset();
    tweakccMocks.tryDetectInstallation.mockImplementation(
      async ({ path }: { path: string }) => {
        expect(path).not.toBe(binaryPath);
        expect(readFileSync(path, 'utf8')).toBe('pristine-native');
        return {
          path,
          version: 'test-version',
          kind: 'native',
        };
      },
    );
    tweakccMocks.readContent.mockResolvedValue(CLAUDE_CORE_FIXTURE);

    try {
      const outcome = await applyPatch(
        binaryPath,
        'test-version',
        {
          config: {
            'clodex:test:extended': {
              alias: 'extended',
              effort: {
                levels: ['low', 'medium', 'high', 'xhigh', 'max'],
                defaultLevel: 'high',
              },
            },
          },
          unknownWindows: [],
        },
        'desired-config-hash',
        { trace: false, manifest: priorPatchManifest(binaryPath, pristinePath) },
      );

      expect(outcome.ok).toBe(false);
      expect(outcome.message).toContain('required effort patches failed');
      expect(tweakccMocks.writeContent).not.toHaveBeenCalled();
      expect(readFileSync(binaryPath, 'utf8')).toBe('previously-patched-native');
      expect(readFileSync(pristinePath, 'utf8')).toBe('pristine-native');
      expect(readFileSync(getPatchManifestPath(), 'utf8')).toBe(previousManifest);
      expect(readFileSync(join(tweakccHome, 'native-binary.backup'), 'utf8')).toBe('pristine-native');
    } finally {
      if (previousAppHome === undefined) delete process.env.CLODEX_HOME;
      else process.env.CLODEX_HOME = previousAppHome;
      if (previousTweakccHome === undefined) delete process.env.TWEAKCC_CONFIG_DIR;
      else process.env.TWEAKCC_CONFIG_DIR = previousTweakccHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves the working binary and manifest when candidate repacking fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-repatch-write-failure-'));
    const binaryPath = join(dir, 'claude');
    const tweakccHome = join(dir, 'tweakcc-home');
    const pristinePath = join(tweakccHome, PRISTINE_BACKUP_NAME);
    const previousAppHome = process.env.CLODEX_HOME;
    const previousTweakccHome = process.env.TWEAKCC_CONFIG_DIR;
    const previousManifest = '{"existing":"manifest"}\n';
    mkdirSync(tweakccHome, { recursive: true });
    writeFileSync(binaryPath, 'previously-patched-native');
    writeFileSync(pristinePath, 'pristine-native');
    process.env.CLODEX_HOME = dir;
    process.env.TWEAKCC_CONFIG_DIR = tweakccHome;
    writeFileSync(getPatchManifestPath(), previousManifest);

    tweakccMocks.tryDetectInstallation.mockReset();
    tweakccMocks.readContent.mockReset();
    tweakccMocks.writeContent.mockReset();
    tweakccMocks.tryDetectInstallation.mockImplementation(
      async ({ path }: { path: string }) => ({
        path,
        version: 'test-version',
        kind: 'native',
      }),
    );
    tweakccMocks.readContent.mockResolvedValue(CLAUDE_FIXTURE);
    tweakccMocks.writeContent.mockRejectedValue(new Error('candidate repack failed'));

    try {
      const outcome = await applyPatch(
        binaryPath,
        'test-version',
        {
          config: {
            'clodex:test:extended': {
              alias: 'extended',
              effort: {
                levels: ['low', 'medium', 'high', 'xhigh', 'max'],
                defaultLevel: 'high',
              },
            },
          },
          unknownWindows: [],
        },
        'desired-config-hash',
        { trace: false, manifest: priorPatchManifest(binaryPath, pristinePath) },
      );

      expect(outcome.ok).toBe(false);
      expect(outcome.message).toContain('candidate repack failed');
      expect(tweakccMocks.writeContent).toHaveBeenCalledOnce();
      expect(readFileSync(binaryPath, 'utf8')).toBe('previously-patched-native');
      expect(readFileSync(pristinePath, 'utf8')).toBe('pristine-native');
      expect(readFileSync(getPatchManifestPath(), 'utf8')).toBe(previousManifest);
    } finally {
      if (previousAppHome === undefined) delete process.env.CLODEX_HOME;
      else process.env.CLODEX_HOME = previousAppHome;
      if (previousTweakccHome === undefined) delete process.env.TWEAKCC_CONFIG_DIR;
      else process.env.TWEAKCC_CONFIG_DIR = previousTweakccHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('publishes the replacement and updates the manifest after a successful re-patch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-repatch-success-'));
    const binaryPath = join(dir, 'claude');
    const tweakccHome = join(dir, 'tweakcc-home');
    const pristinePath = join(tweakccHome, PRISTINE_BACKUP_NAME);
    const previousAppHome = process.env.CLODEX_HOME;
    const previousTweakccHome = process.env.TWEAKCC_CONFIG_DIR;
    const previousManifest = '{"existing":"manifest"}\n';
    const replacement = 'newly-patched-native';
    mkdirSync(tweakccHome, { recursive: true });
    writeFileSync(binaryPath, 'previously-patched-native');
    writeFileSync(pristinePath, 'pristine-native');
    process.env.CLODEX_HOME = dir;
    process.env.TWEAKCC_CONFIG_DIR = tweakccHome;
    writeFileSync(getPatchManifestPath(), previousManifest);

    tweakccMocks.tryDetectInstallation.mockReset();
    tweakccMocks.readContent.mockReset();
    tweakccMocks.writeContent.mockReset();
    tweakccMocks.tryDetectInstallation.mockImplementation(
      async ({ path }: { path: string }) => ({
        path,
        version: 'test-version',
        kind: 'native',
      }),
    );
    tweakccMocks.readContent.mockResolvedValue(CLAUDE_FIXTURE);
    tweakccMocks.writeContent.mockImplementation(
      async ({ path }: { path: string }) => {
        writeFileSync(path, replacement);
      },
    );

    try {
      const outcome = await applyPatch(
        binaryPath,
        'test-version',
        {
          config: {
            'clodex:test:extended': {
              aliases: ['extended', 'second', 'third'],
              effort: {
                levels: ['low', 'medium', 'high', 'xhigh', 'max'],
                defaultLevel: 'high',
              },
            },
          },
          unknownWindows: [],
        },
        'desired-config-hash',
        { trace: false, manifest: priorPatchManifest(binaryPath, pristinePath) },
      );

      const manifestBytes = readFileSync(getPatchManifestPath(), 'utf8');
      const manifest = JSON.parse(manifestBytes) as PatchManifest;
      expect(outcome.ok).toBe(true);
      // Every alias is a native identity, so the summary counts all of them.
      expect(outcome.message).toContain('3 aliases');
      expect(readFileSync(binaryPath, 'utf8')).toBe(replacement);
      expect(readFileSync(pristinePath, 'utf8')).toBe('pristine-native');
      expect(readFileSync(join(tweakccHome, 'native-binary.backup'), 'utf8')).toBe('pristine-native');
      expect(manifestBytes).not.toBe(previousManifest);
      expect(manifest).toMatchObject({
        binaryPath,
        claudeVersion: 'test-version',
        configHash: 'desired-config-hash',
        patchedSize: Buffer.byteLength(replacement),
        patchedSha256: createHash('sha256').update(replacement).digest('hex'),
        backupPath: pristinePath,
      });
    } finally {
      if (previousAppHome === undefined) delete process.env.CLODEX_HOME;
      else process.env.CLODEX_HOME = previousAppHome;
      if (previousTweakccHome === undefined) delete process.env.TWEAKCC_CONFIG_DIR;
      else process.env.TWEAKCC_CONFIG_DIR = previousTweakccHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const CLAUDE_FIXTURE = [
  CLAUDE_CORE_FIXTURE,
  'function OI(e){if(SNr(e))return!1;let t=Ede(e,"effort");if(t!==void 0)return t;return!1}',
  'function I_e(e){if(SNr(e))return!1;let t=Ede(e,"xhigh_effort");if(t!==void 0)return t;return!1}',
  'function eqe(e){if(SNr(e))return!1;let t=Ede(e,"max_effort");if(t!==void 0)return t;return!1}',
  'function ait(e){return ww(lo(e))?.default_effort??"high"}',
].join('\n');

const CLAUDE_PROXY_EFFORT_FIXTURE = [
  CLAUDE_CORE_FIXTURE,
  'function OI(e){if(SNr(e))return!1;let t=Ede(e,"effort");if(t!==void 0)return t;return proxyMode(e)}',
  'function I_e(e){if(SNr(e))return!1;let t=Ede(e,"xhigh_effort");if(t!==void 0)return t;return proxyMode(e)}',
  'function eqe(e){if(SNr(e))return!1;let t=Ede(e,"max_effort");if(t!==void 0)return t;return proxyMode(e)}',
  'function ait(e){return ww(lo(e))?.default_effort??"high"}',
].join('\n');

function runPatchScript(config: Parameters<typeof applyClodexPatches>[1], source = CLAUDE_FIXTURE): string {
  return applyClodexPatches(source, config).content;
}

function executeChildEnv(
  source: string,
  env: NodeJS.ProcessEnv,
  extraEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const declaration = source
    .split('\n')
    .find(line => line.startsWith('function childEnv('));
  expect(declaration).toBeDefined();
  const childEnv = Function(
    'process',
    'extra',
    'flag',
    'remote',
    // Only the 2.1.228-shaped fixture reads this; the base fixture ignores it.
    'settings',
    `${declaration};return childEnv;`,
  )(
    { env },
    () => extraEnv,
    () => false,
    () => ({}),
    { settingsColorEnv: {} },
  ) as () => NodeJS.ProcessEnv;
  return childEnv();
}

type CapabilityFunctionName = 'OI' | 'I_e' | 'eqe';

function executeCapability(
  source: string,
  functionName: CapabilityFunctionName,
  modelId: string,
  nativeFallback: boolean,
  denied = false,
): boolean {
  const declaration = source
    .split('\n')
    .find(line => line.startsWith(`function ${functionName}(`));
  expect(declaration).toBeDefined();
  const capability = Function(
    'SNr',
    'Ede',
    'proxyMode',
    `${declaration};return ${functionName};`,
  )(
    () => denied,
    () => undefined,
    () => nativeFallback,
  ) as (id: string) => boolean;
  return capability(modelId);
}

function executeDefaultEffort(
  source: string,
  modelId: string,
  nativeDefault: string,
): string {
  const declaration = source
    .split('\n')
    .find(line => line.startsWith('function ait('));
  expect(declaration).toBeDefined();
  const defaultEffort = Function(
    'lo',
    'ww',
    `${declaration};return ait;`,
  )(
    (id: string) => id,
    () => ({ default_effort: nativeDefault }),
  ) as (id: string) => string;
  return defaultEffort(modelId);
}

const CAPABILITY_GATES: Array<{
  name: string;
  functionName: CapabilityFunctionName;
}> = [
  { name: 'base effort', functionName: 'OI' },
  { name: 'xhigh effort', functionName: 'I_e' },
  { name: 'max effort', functionName: 'eqe' },
];

describe('patch script identity naming', () => {
  const config = {
    'clodex:openai-oauth:gpt-5.6-sol': {
      alias: 'sol',
      context: 272_000,
      display: 'GPT-5.6 Sol (OpenAI (ChatGPT))',
      effort: {
        levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        defaultLevel: 'medium',
      },
    },
    'clodex:openai:mystery': { context: 128_000, display: 'Mystery (OpenAI)' },
  };

  const capabilityConfig = {
    'clodex:openai:gpt-5.5': {
      alias: 'standard',
      effort: {
        levels: ['low', 'medium', 'high'],
        defaultLevel: 'high',
      },
    },
    'clodex:openai:gpt-5.6-sol': {
      alias: 'extended',
      effort: {
        levels: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultLevel: 'high',
      },
    },
    'clodex:openai:no-effort': {
      alias: 'disabled',
    },
  };

  function runCapabilityPatch(): string {
    return runPatchScript(capabilityConfig, CLAUDE_PROXY_EFFORT_FIXTURE);
  }

  it('injects the ALIAS — not the canonical id — as the model identity', () => {
    const out = runPatchScript(config);

    // PATCH 1: Agent-tool zod enum (the same enum agent/skill `model:` frontmatter
    // is validated against) gets "sol", never the canonical id.
    expect(out).toContain('.enum(["sonnet","opus","haiku","fable","sol","clodex:openai:mystery"]).optional().describe(');
    // PATCH 3: known-alias validator list.
    expect(out).toContain('["sonnet","opus","haiku","fable","opusplan","sol","clodex:openai:mystery"]');
    // The aliased model's canonical id never appears as an identity in either
    // list (it survives only as an extra key in the context table).
    expect(out).not.toMatch(/\.enum\(\[[^\]]*gpt-5\.6-sol/);
    expect(out).not.toMatch(/KNOWN=\[[^\]]*gpt-5\.6-sol/);
  });

  const multiAliasConfig = {
    'clodex:opencode-go:deepseek-v4-flash': {
      aliases: ['luna', 'terra', 'ds4'],
      context: 1_000_000,
      display: 'DeepSeek V4 Flash (OpenCode Go)',
      effort: {
        levels: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultLevel: 'high',
      },
    },
  };

  it('injects every same-target alias as a complete native identity', () => {
    const patched = applyClodexPatches(CLAUDE_FIXTURE, multiAliasConfig);
    const out = patched.content;

    // PATCH 1 + PATCH 3: all three names, in saved order, and never the id.
    expect(out).toContain(
      '.enum(["sonnet","opus","haiku","fable","luna","terra","ds4"]).optional().describe(',
    );
    expect(out).toContain(
      '["sonnet","opus","haiku","fable","opusplan","luna","terra","ds4"]',
    );
    expect(out).not.toMatch(/\.enum\(\[[^\]]*deepseek-v4-flash/);
    expect(out).not.toMatch(/KNOWN=\[[^\]]*deepseek-v4-flash/);

    const contextTable = out.match(
      /\/\*ccpatch:ctx\*\/var _ccw=\((\{[^}]*\})\)/,
    )?.[1];
    expect(contextTable).toBeTruthy();
    const context = JSON.parse(contextTable!) as Record<string, number>;
    const defaultTable = out.match(
      /\/\*ccpatch:default-effort\*\/var _cce=Object\.assign\(Object\.create\(null\),(\{[^}]*\})\)/,
    )?.[1];
    expect(defaultTable).toBeTruthy();
    const defaults = JSON.parse(defaultTable!) as Record<string, string>;

    for (const alias of ['luna', 'terra', 'ds4']) {
      // PATCH 6 — each case resolves to itself.
      expect(out).toContain(`case"${alias}":return "${alias}";`);
      // PATCH 5 — each alias is its own picker option.
      expect(out).toContain(
        `{value:"${alias}",label:"${alias.charAt(0).toUpperCase() + alias.slice(1)}",`
        + 'description:"DeepSeek V4 Flash (OpenCode Go)"}',
      );
      // PATCH 7 — each alias keys the context table.
      expect(context[alias]).toBe(1_000_000);
      // PATCH 8a/8b/8c — each alias carries the same projected capability verdicts.
      expect(executeCapability(out, 'OI', alias, false)).toBe(true);
      expect(executeCapability(out, 'I_e', alias, false)).toBe(true);
      expect(executeCapability(out, 'eqe', alias, false)).toBe(true);
      // PATCH 9 — each alias carries the same native default.
      expect(defaults[alias]).toBe('high');
      expect(executeDefaultEffort(out, alias, 'medium')).toBe('high');
    }
    // The canonical id keeps its PATCH 7/8/9 lookup keys.
    expect(context['clodex:opencode-go:deepseek-v4-flash']).toBe(1_000_000);
    expect(defaults['clodex:opencode-go:deepseek-v4-flash']).toBe('high');

    // PATCH 4 lists every identity.
    expect(out).toContain(
      'Additional custom models: luna = DeepSeek V4 Flash (OpenCode Go); '
      + 'terra = DeepSeek V4 Flash (OpenCode Go); ds4 = DeepSeek V4 Flash (OpenCode Go).',
    );

    // Built-in proof capture enumerates every alias.
    const proofNames = captureBuiltInPatchProofs(
      out,
      multiAliasConfig,
      patched.results,
    ).map(proof => proof.name);
    for (const alias of ['luna', 'terra', 'ds4']) {
      expect(proofNames).toContain(`PATCH 6: alias resolver switch (${alias})`);
      expect(proofNames).toContain(`PATCH 5: model picker options (${alias})`);
    }
    expect(builtInPatchProofsChanged(out, captureBuiltInPatchProofs(
      out,
      multiAliasConfig,
      patched.results,
    ))).toBe(false);
  });

  it('treats a legacy single alias exactly like its one-element array form', () => {
    const legacy = runPatchScript({
      'clodex:opencode-go:deepseek-v4-flash': {
        alias: 'luna',
        context: 1_000_000,
        display: 'DeepSeek V4 Flash (OpenCode Go)',
      },
    });
    const current = runPatchScript({
      'clodex:opencode-go:deepseek-v4-flash': {
        aliases: ['luna'],
        context: 1_000_000,
        display: 'DeepSeek V4 Flash (OpenCode Go)',
      },
    });

    expect(current).toBe(legacy);
  });

  it('resolves an alias to ITSELF so the sent name and the context-map key stay identical', () => {
    const out = runPatchScript(config);
    // PATCH 6 must emit the case (not skip it — default: returns null) but map
    // the alias to itself rather than to the canonical id.
    expect(out).toContain('case"sol":return "sol";');
    expect(out).not.toContain('case"sol":return "clodex:openai-oauth:gpt-5.6-sol"');
  });

  it('keys the context-window table by the alias (and still by the canonical id)', () => {
    const out = runPatchScript(config);
    const table = out.match(/\/\*ccpatch:ctx\*\/var _ccw=\((\{[^}]*\})\)/)?.[1];
    expect(table).toBeTruthy();
    const parsed = JSON.parse(table!) as Record<string, number>;
    expect(parsed['sol']).toBe(272_000);
    expect(parsed['clodex:openai-oauth:gpt-5.6-sol']).toBe(272_000);
    expect(parsed['clodex:openai:mystery']).toBe(128_000);
  });

  it('enables GPT-5.6 effort, xhigh, max, and the native high default for its alias', () => {
    const out = runPatchScript(config);
    expect(out).toContain('/*ccpatch:effort*/');
    expect(out).toContain('/*ccpatch:xhigh-effort*/');
    expect(out).toContain('/*ccpatch:max-effort*/');
    expect(out).toContain('/*ccpatch:default-effort*/');
    expect(out).toContain('"sol":"high"');
  });

  it.each([
    {
      name: 'base only',
      levels: ['low', 'medium', 'high'],
      xhigh: false,
      max: false,
    },
    {
      name: 'xhigh',
      levels: ['low', 'medium', 'high', 'xhigh'],
      xhigh: true,
      max: false,
    },
    {
      name: 'max',
      levels: ['low', 'medium', 'high', 'max'],
      xhigh: false,
      max: true,
    },
  ])('exposes $name effort capabilities independently', ({ levels, xhigh, max }) => {
    const out = runPatchScript({
      'clodex:openai:reasoning-model': {
        effort: { levels, defaultLevel: 'high' },
      },
    });
    expect(out).toContain('/*ccpatch:effort*/');
    expect(out).toContain('/*ccpatch:default-effort*/');
    const xhighVerdicts = out.match(
      /\/\*ccpatch:xhigh-effort\*\/var _ccv=Object\.assign\(Object\.create\(null\),(\{[^{}]*\})\)/,
    )?.[1];
    const maxVerdicts = out.match(
      /\/\*ccpatch:max-effort\*\/var _ccv=Object\.assign\(Object\.create\(null\),(\{[^{}]*\})\)/,
    )?.[1];
    expect(JSON.parse(xhighVerdicts!)).toEqual({
      'clodex:openai:reasoning-model': xhigh,
      'clodex:openai:reasoning-model[1m]': xhigh,
    });
    expect(JSON.parse(maxVerdicts!)).toEqual({
      'clodex:openai:reasoning-model': max,
      'clodex:openai:reasoning-model[1m]': max,
    });
  });

  it.each([
    { name: 'xhigh effort', functionName: 'I_e' as const },
    { name: 'max effort', functionName: 'eqe' as const },
  ])('overrides native true with an explicit false $name verdict', ({ functionName }) => {
    expect(executeCapability(runCapabilityPatch(), functionName, 'standard', true)).toBe(false);
  });

  it.each(CAPABILITY_GATES)(
    'overrides native false with an explicit true $name verdict',
    ({ functionName }) => {
      expect(executeCapability(runCapabilityPatch(), functionName, 'extended', false)).toBe(true);
      expect(executeCapability(runCapabilityPatch(), functionName, 'extended[1m]', false)).toBe(true);
    },
  );

  it.each(CAPABILITY_GATES)(
    'keeps configured no-effort identities false at the $name gate',
    ({ functionName }) => {
      const out = runCapabilityPatch();
      expect(executeCapability(out, functionName, 'disabled', true)).toBe(false);
      expect(executeCapability(out, functionName, 'clodex:openai:no-effort', true)).toBe(false);
      expect(executeCapability(out, functionName, 'clodex:openai:no-effort[1m]', true)).toBe(false);
    },
  );

  it.each(CAPABILITY_GATES)(
    'falls through only for an unconfigured identity at the $name gate',
    ({ functionName }) => {
      const out = runCapabilityPatch();
      expect(executeCapability(out, functionName, 'unconfigured', false)).toBe(false);
      expect(executeCapability(out, functionName, 'unconfigured', true)).toBe(true);
    },
  );

  it.each(['constructor', 'toString', '__proto__'])(
    'falls through for unconfigured object prototype identity %s',
    modelId => {
      const out = runCapabilityPatch();
      for (const { functionName } of CAPABILITY_GATES) {
        expect(executeCapability(out, functionName, modelId, false)).toBe(false);
        expect(executeCapability(out, functionName, modelId, true)).toBe(true);
      }
      expect(executeDefaultEffort(out, modelId, 'medium')).toBe('medium');
    },
  );

  it.each(CAPABILITY_GATES)(
    'keeps the native denylist ahead of the configured $name verdict',
    ({ functionName }) => {
      const out = runCapabilityPatch();
      for (const modelId of ['extended', 'extended[1m]']) {
        expect(executeCapability(
          out,
          functionName,
          modelId,
          false,
          true,
        )).toBe(false);
      }
    },
  );

  it.each([
    'sol',
    'sol[1m]',
    'clodex:openai-oauth:gpt-5.6-sol',
    'clodex:openai-oauth:gpt-5.6-sol[1m]',
  ])('returns high for configured default key %s against native medium', modelId => {
    expect(executeDefaultEffort(runPatchScript(config), modelId, 'medium')).toBe('high');
  });

  it('falls through to the native default for an unconfigured identity', () => {
    expect(executeDefaultEffort(runPatchScript(config), 'unconfigured', 'medium')).toBe('medium');
  });

  // Claude Code 2.1.228 hoisted the settings-colour env into its own declarator
  // inside the child builder's `let` statement, between the first
  // `Object.keys(...).length>0` binding and the CLAUDE_CODE_REMOTE ternary. An
  // anchor that counted declarators reported "anchor not found", and because
  // PATCH 10 is required, `clodex patch` refused to patch 2.1.228 at all.
  const CLAUDE_FIXTURE_228 = CLAUDE_FIXTURE.replace(
    'let e=extra(),t=Object.keys(e).length>0,n=Object.keys(e).length>0,',
    'let e=extra(),t=Object.keys(e).length>0,c=settings.settingsColorEnv,n=Object.keys(c).length>0,',
  );

  // The tolerated run is bounded to `[^;{}]` so it cannot reach out of the `let`
  // statement it starts in. Widen it to `[\s\S]` and the anchor starts at the
  // NEAREST preceding function whose head happens to fit, swallowing everything
  // up to the real builder's tail — so a decoy that opens with the same two
  // bindings must not be able to steal the match. Without this fixture the only
  // test that reddens on that mutation is the sha256 transform-source pin, which
  // is a tripwire, not a behavioural test.
  const CLAUDE_FIXTURE_DECOY = CLAUDE_FIXTURE_228.replace(
    'function childEnv(){',
    'function zzDecoy(){let q=extra(),w=Object.keys(q).length>0,z=w?1:2;return z}'
    + 'function childEnv(){',
  );

  it('does not let a preceding decoy with the same opening bindings steal the match', () => {
    expect(CLAUDE_FIXTURE_DECOY, 'fixture drifted from the shape this test mutates')
      .not.toBe(CLAUDE_FIXTURE_228);

    const out = runPatchScript(config, CLAUDE_FIXTURE_DECOY);

    expect(out.match(/\/\*ccpatch:child-network-env\*\//g)).toHaveLength(1);
    expect(out).toContain('function childEnv(){/*ccpatch:child-network-env*/');
    expect(out, 'the decoy is left exactly as it was').toContain(
      'function zzDecoy(){let q=extra(),w=Object.keys(q).length>0,z=w?1:2;return z}',
    );
  });

  it('patches a child builder that declares extra bindings before the remote check', () => {
    expect(CLAUDE_FIXTURE_228, 'fixture drifted from the shape this test mutates')
      .not.toBe(CLAUDE_FIXTURE);

    const result = applyClodexPatches(CLAUDE_FIXTURE_228, config);

    expect(result.results.at(-1)).toEqual({
      status: 'OK',
      name: 'PATCH 10: child network environment',
    });
    expect(result.content.match(/\/\*ccpatch:child-network-env\*\//g)).toHaveLength(1);
    expect(result.content).toContain('function childEnv(){/*ccpatch:child-network-env*/');
    // The added declarator survives, and the body still reads the local copy.
    expect(result.content).toContain('c=settings.settingsColorEnv');
    expect(result.content).toContain('let v={..._clodexChildEnv,...e,...s}');
  });

  it('restores the original network environment through the extra-binding builder', () => {
    const out = runPatchScript(config, CLAUDE_FIXTURE_228);
    const env = executeChildEnv(out, {
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://127.0.0.1:3457',
      NODE_EXTRA_CA_CERTS: '/tmp/local-ca.pem',
      [NETWORK_ENV_CONTRACT_VAR]: JSON.stringify({
        version: 1,
        original: {
          HTTPS_PROXY: 'http://corp-proxy.example:8080',
          NODE_EXTRA_CA_CERTS: null,
        },
        injected: {
          HTTPS_PROXY: 'http://127.0.0.1:3457',
          NODE_EXTRA_CA_CERTS: '/tmp/local-ca.pem',
        },
      }),
    });

    expect(env).toMatchObject({
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://corp-proxy.example:8080',
    });
    expect(env['NODE_EXTRA_CA_CERTS']).toBeUndefined();
    expect(env[NETWORK_ENV_CONTRACT_VAR]).toBeUndefined();
  });

  it('targets the child builder when a token-bearing function follows it', () => {
    const source = CLAUDE_FIXTURE.replace(
      '}function mcpAllow(){',
      '}function adjacent(){let e=process.env.CLAUDE_CODE_REMOTE;'
      + 'return process.env.CLAUDE_CODE_OAUTH_TOKEN}function mcpAllow(){',
    );
    const out = runPatchScript(config, source);

    expect(out.match(/\/\*ccpatch:child-network-env\*\//g)).toHaveLength(1);
    expect(out).toContain('function childEnv(){/*ccpatch:child-network-env*/');
    expect(out).toContain('function adjacent(){let e=process.env.CLAUDE_CODE_REMOTE;');
    expect(out).not.toContain('function adjacent(){/*ccpatch:child-network-env*/');
  });

  it.each([
    ['named', 'function nested(){}'],
    ['anonymous', 'let nested=function(){};'],
  ])('rejects a %s nested function in the child-environment patch target', (_name, nested) => {
    const source = CLAUDE_FIXTURE.replace(
      's=flag(process.env.CLAUDE_CODE_REMOTE)?remote():{};let o=',
      `s=flag(process.env.CLAUDE_CODE_REMOTE)?remote():{};${nested}let o=`,
    );

    expect(() => runPatchScript(config, source)).toThrow(
      'clodex patch: child network environment target validation failed',
    );
  });

  it('rejects a child builder whose merge spread no longer reads process.env', () => {
    const source = CLAUDE_FIXTURE.replace(
      'let v={...process.env,...e,...s}',
      'let v={...te,...e,...s}',
    );

    expect(() => runPatchScript(config, source)).toThrow(
      'clodex patch: child network environment target validation failed',
    );
  });

  it('restores the original network environment for child commands', () => {
    const out = runPatchScript(config);
    const env = executeChildEnv(out, {
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://127.0.0.1:3457',
      HTTP_PROXY: 'http://127.0.0.1:3457',
      https_proxy: 'http://127.0.0.1:3457',
      http_proxy: 'http://127.0.0.1:3457',
      NO_PROXY: 'localhost',
      no_proxy: 'localhost',
      NODE_EXTRA_CA_CERTS: '/tmp/local-ca.pem',
      [NETWORK_ENV_CONTRACT_VAR]: JSON.stringify({
        version: 1,
        original: {
          HTTPS_PROXY: 'http://corp-proxy.example:8080',
          HTTP_PROXY: null,
          https_proxy: null,
          http_proxy: null,
          NO_PROXY: '.internal.example',
          no_proxy: null,
          NODE_EXTRA_CA_CERTS: '/tmp/corporate-ca.pem',
        },
        injected: {
          HTTPS_PROXY: 'http://127.0.0.1:3457',
          HTTP_PROXY: 'http://127.0.0.1:3457',
          https_proxy: 'http://127.0.0.1:3457',
          http_proxy: 'http://127.0.0.1:3457',
          NO_PROXY: 'localhost',
          no_proxy: 'localhost',
          NODE_EXTRA_CA_CERTS: '/tmp/local-ca.pem',
        },
      }),
    });

    expect(env).toMatchObject({
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://corp-proxy.example:8080',
      NO_PROXY: '.internal.example',
      NODE_EXTRA_CA_CERTS: '/tmp/corporate-ca.pem',
    });
    expect(env['HTTP_PROXY']).toBeUndefined();
    expect(env['https_proxy']).toBeUndefined();
    expect(env['http_proxy']).toBeUndefined();
    expect(env['no_proxy']).toBeUndefined();
    expect(env[NETWORK_ENV_CONTRACT_VAR]).toBeUndefined();
  });

  it('restores the original network environment on the merge branch', () => {
    const out = runPatchScript(config);
    const env = executeChildEnv(out, {
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://127.0.0.1:3457',
      NODE_EXTRA_CA_CERTS: '/tmp/local-ca.pem',
      [NETWORK_ENV_CONTRACT_VAR]: JSON.stringify({
        version: 1,
        original: {
          HTTPS_PROXY: 'http://proxy.example.test:8080',
          NODE_EXTRA_CA_CERTS: '/tmp/external-ca.pem',
        },
        injected: {
          HTTPS_PROXY: 'http://127.0.0.1:3457',
          NODE_EXTRA_CA_CERTS: '/tmp/local-ca.pem',
        },
      }),
    }, {
      CHILD_ENV_MARKER: 'merge-branch',
    });

    expect(env).toMatchObject({
      PATH: '/usr/bin',
      CHILD_ENV_MARKER: 'merge-branch',
      HTTPS_PROXY: 'http://proxy.example.test:8080',
      NODE_EXTRA_CA_CERTS: '/tmp/external-ca.pem',
    });
    expect(env[NETWORK_ENV_CONTRACT_VAR]).toBeUndefined();
  });

  it('keeps the native child environment unchanged without a wrapper snapshot', () => {
    const out = runPatchScript(config);
    const env = {
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://proxy.example:8080',
    };

    expect(executeChildEnv(out, env)).toBe(env);
  });

  it('preserves a network value replaced after the bridge was injected', () => {
    const out = runPatchScript(config);
    const env = executeChildEnv(out, {
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://settings-proxy.example:9000',
      [NETWORK_ENV_CONTRACT_VAR]: JSON.stringify({
        version: 1,
        original: { HTTPS_PROXY: 'http://corp-proxy.example:8080' },
        injected: { HTTPS_PROXY: 'http://127.0.0.1:3457' },
      }),
    });

    expect(env).toEqual({
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://settings-proxy.example:9000',
    });
  });

  it('removes a matching bridge value when the external environment had none', () => {
    const out = runPatchScript(config);
    const env = executeChildEnv(out, {
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://127.0.0.1:3457',
      [NETWORK_ENV_CONTRACT_VAR]: JSON.stringify({
        version: 1,
        original: { HTTPS_PROXY: null },
        injected: { HTTPS_PROXY: 'http://127.0.0.1:3457' },
      }),
    });

    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it.each([
    ['array', '[]'],
    ['null', 'null'],
    ['non-string value', JSON.stringify({
      version: 1,
      original: { HTTPS_PROXY: null },
      injected: { HTTPS_PROXY: 42 },
    })],
    ['invalid JSON', '{'],
  ])('fails open for %s child-network metadata', (_name, contract) => {
    const out = runPatchScript(config);
    const env = executeChildEnv(out, {
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://127.0.0.1:3457',
      [NETWORK_ENV_CONTRACT_VAR]: contract,
    });

    expect(env).toEqual({
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://127.0.0.1:3457',
    });
  });

  it.each([
    ['valid pair', {
      version: 1,
      original: { HTTPS_PROXY: 'http://proxy.example.test:8080' },
      injected: { HTTPS_PROXY: 'http://127.0.0.1:3457' },
    }],
    ['missing injected key', {
      version: 1,
      original: { HTTPS_PROXY: null },
      injected: {},
    }],
    ['missing original key', {
      version: 1,
      original: {},
      injected: { HTTPS_PROXY: 'http://127.0.0.1:3457' },
    }],
    ['unknown original key', {
      version: 1,
      original: { HTTPS_PROXY: null, EXTRA_PROXY: null },
      injected: { HTTPS_PROXY: 'http://127.0.0.1:3457', EXTRA_PROXY: null },
    }],
    ['unknown injected key', {
      version: 1,
      original: { EXTRA_PROXY: null },
      injected: { EXTRA_PROXY: 'http://127.0.0.1:3457' },
    }],
    ['invalid original value', {
      version: 1,
      original: { HTTPS_PROXY: 42 },
      injected: { HTTPS_PROXY: 'http://127.0.0.1:3457' },
    }],
    ['invalid injected value', {
      version: 1,
      original: { HTTPS_PROXY: null },
      injected: { HTTPS_PROXY: false },
    }],
    ['invalid version', {
      version: 2,
      original: { HTTPS_PROXY: null },
      injected: { HTTPS_PROXY: 'http://127.0.0.1:3457' },
    }],
  ])('matches the host contract reader for %s', (_name, contract) => {
    const out = runPatchScript(config);
    const baseEnv = {
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://127.0.0.1:3457',
      [NETWORK_ENV_CONTRACT_VAR]: JSON.stringify(contract),
    };

    expect(executeChildEnv(out, baseEnv, { CHILD_ENV_MARKER: 'merge-branch' })).toEqual({
      ...networkEnvBaseline(baseEnv),
      CHILD_ENV_MARKER: 'merge-branch',
    });
  });

  it('falls back to the canonical id as the identity when a model has no alias', () => {
    const out = runPatchScript({ 'clodex:openai:mystery': { context: 128_000 } });
    expect(out).toContain('.enum(["sonnet","opus","haiku","fable","clodex:openai:mystery"])');
    expect(out).toContain('"clodex:openai:mystery"');
    // No alias → nothing to resolve and no picker entry.
    expect(out).not.toContain('case"clodex:openai:mystery":return');
    expect(out).not.toContain('value:"clodex:openai:mystery"');
  });

  it('patches the 2.1.224+ minified enum shape (model:xr([...]))', () => {
    const modern = CLAUDE_FIXTURE.replace(
      '.enum(["sonnet","opus","haiku","fable"])',
      'model:xr(["sonnet","opus","haiku","fable"])',
    );
    expect(modern).not.toBe(CLAUDE_FIXTURE);
    const out = runPatchScript({ 'clodex:openai:mystery': { context: 128_000 } }, modern);
    expect(out).toContain('model:xr(["sonnet","opus","haiku","fable","clodex:openai:mystery"]).optional().describe(');
  });

  it('supports a configured alias that matches an object prototype name', () => {
    const out = runPatchScript({
      'clodex:openai:model': { alias: 'constructor' },
    });
    expect(out).toContain('case"constructor":return "constructor";');
    for (const { functionName } of CAPABILITY_GATES) {
      expect(executeCapability(out, functionName, 'constructor', true)).toBe(false);
    }
  });

  it('uses the real display label in the /model picker and the Agent tool description', () => {
    const out = runPatchScript(config);
    expect(out).toContain('{value:"sol",label:"Sol",description:"GPT-5.6 Sol (OpenAI (ChatGPT))"}');
    expect(out).not.toContain('Custom model (');
    expect(out).toContain('Additional custom models: sol = GPT-5.6 Sol (OpenAI (ChatGPT)); '
      + 'clodex:openai:mystery = Mystery (OpenAI).');
  });

  it('falls back to the old "Custom model (id)" description when no label is known', () => {
    const out = runPatchScript({ 'clodex:openai-oauth:gpt-5.6-sol': { alias: 'sol', context: 272_000 } });
    expect(out).toContain('{value:"sol",label:"Sol",description:"Custom model (clodex:openai-oauth:gpt-5.6-sol)"}');
    expect(out).toContain('Additional custom models: sol.');
  });

  it('supports aliases that match object prototype property names', () => {
    const out = runPatchScript({
      'clodex:openai:model': {
        alias: 'constructor',
        context: 128_000,
        display: 'Model',
      },
    });

    expect(out).toContain('case"constructor":return "constructor";');
    expect(out).toContain('{value:"constructor",label:"Constructor",description:"Model"}');
  });

  it('is idempotent — re-running the same patch changes nothing', () => {
    const once = runPatchScript(config);
    expect(runPatchScript(config, once)).toBe(once);
  });

  it('does not treat unrelated string and auto literals as PATCH 5/6 presence', () => {
    const source = CLAUDE_FIXTURE.replace(
      'function rz(x){',
      `function decoys(){return 'case"string":return "string";value:"auto"'}\nfunction rz(x){`,
    );
    const out = runPatchScript({
      'clodex:test:string': { alias: 'string', display: 'String' },
      'clodex:test:auto': { alias: 'auto', display: 'Auto' },
    }, source);

    expect(out).toContain('case"string":return "string";');
    expect(out).toContain('case"auto":return "auto";');
    expect(out).toContain('{value:"string",label:"String",description:"String"}');
    expect(out).toContain('{value:"auto",label:"Auto",description:"Auto"}');
  });

  it('scopes PATCH 5/6 presence to their target suffixes across the collision matrix', () => {
    const source = CLAUDE_FIXTURE
      .replace(
        'function rz(x){',
        `function unrelatedResolver(){return 'case"string":return "string";case"auto":return "auto";'}\nfunction rz(x){`,
      )
      .replace(
        'function opts(e,t,r){',
        `function unrelatedPicker(){return 'value:"string";value:"auto"'}\nfunction opts(e,t,r){`,
      );
    const out = runPatchScript({
      'clodex:test:string': { alias: 'string', display: 'String' },
      'clodex:test:auto': { alias: 'auto', display: 'Auto' },
      'clodex:test:local': { alias: 'local', display: 'Local' },
      'clodex:test:darwin': { alias: 'darwin', display: 'Darwin' },
      'clodex:test:invalid': { alias: 'invalid_type', display: 'Invalid type' },
    }, source);

    expect(out).toContain(`function unrelatedResolver(){return 'case"string":return "string";case"auto":return "auto";'}`);
    expect(out).toContain(`function unrelatedPicker(){return 'value:"string";value:"auto"'}`);
    for (const alias of ['string', 'auto', 'local', 'darwin', 'invalid_type']) {
      expect(out).toContain(`case"${alias}":return "${alias}";`);
      expect(out).toContain(`value:"${alias}"`);
    }
    expect(out.match(/case"string":return "string";/g)).toHaveLength(2);
    expect(out.match(/case"auto":return "auto";/g)).toHaveLength(2);
  });

  it('tops up only missing aliases before the byte-preserved PATCH 5/6 suffixes', () => {
    const existingResolverSuffix = 'case"darwin":return "darwin";';
    const escapedDescription = JSON.stringify('Existing "Darwin" \\ path');
    const existingPickerSuffix = '[{value:"darwin",label:"Darwin",description:'
      + escapedDescription
      + '}].forEach(function(_o){if(!e.some(function(_i){return _i.value===_o.value}))e.push(_o)});';
    const source = CLAUDE_FIXTURE
      .replace(
        'function rz(x){switch(x){case"best":{return "opus"}default:return null}}',
        'function rz(x){switch(x){case"best":{return "opus"}'
          + existingResolverSuffix
          + 'default:return null}}',
      )
      .replace(
        'Dlh(e,i,t);return e}',
        'Dlh(e,i,t);' + existingPickerSuffix + 'return e}',
      );
    const config = {
      'clodex:test:local': { alias: 'local', display: 'Local' },
      'clodex:test:darwin': { alias: 'darwin', display: 'Darwin' },
      'clodex:test:invalid': { alias: 'invalid_type', display: 'Invalid type' },
    };

    const first = applyClodexPatches(source, config);
    const out = first.content;
    expect(out).toContain(
      'case"best":{return "opus"}case"local":return "local";'
        + 'case"invalid_type":return "invalid_type";'
        + existingResolverSuffix
        + 'default:return null',
    );
    const localEntry = '{value:"local",label:"Local",description:"Local"}';
    const invalidEntry = '{value:"invalid_type",label:"Invalid_type",description:"Invalid type"}';
    const insertedPicker = '[' + localEntry + ',' + invalidEntry + '].forEach(function(_o){if(!e.some(function(_i){return _i.value===_o.value}))e.push(_o)});';
    expect(out).toContain(insertedPicker + existingPickerSuffix);
    expect(out.match(/case"darwin":return "darwin";/g)).toHaveLength(1);
    expect(out.match(/value:"darwin",label:"Darwin"/g)).toHaveLength(1);

    const rerun = applyClodexPatches(out, config);
    expect(rerun.content).toBe(out);
    expect(rerun.results.find(result => result.name === 'PATCH 6: alias resolver switch')?.status).toBe('SKIP');
    expect(rerun.results.find(result => result.name === 'PATCH 5: model picker options')?.status).toBe('SKIP');
  });

  it('keeps PATCH 5 and PATCH 6 independent when either site has drifted', () => {
    const config = { 'clodex:test:local': { alias: 'local', display: 'Local' } };
    const resolverOnly = CLAUDE_FIXTURE.replace(
      'case"best":{return "opus"}default:return null',
      'case"best":{return "opus"}case"local":return "local";default:return null',
    );
    const resolverResult = applyClodexPatches(resolverOnly, config);
    expect(resolverResult.results.find(result => result.name === 'PATCH 6: alias resolver switch')?.status).toBe('SKIP');
    expect(resolverResult.results.find(result => result.name === 'PATCH 5: model picker options')?.status).toBe('OK');

    const pickerBlock = '[{value:"local",label:"Local",description:"Local"}].forEach(function(_o){if(!e.some(function(_i){return _i.value===_o.value}))e.push(_o)});';
    const pickerOnly = CLAUDE_FIXTURE.replace(
      'Dlh(e,i,t);return e}',
      'Dlh(e,i,t);' + pickerBlock + 'return e}',
    );
    const pickerResult = applyClodexPatches(pickerOnly, config);
    expect(pickerResult.results.find(result => result.name === 'PATCH 6: alias resolver switch')?.status).toBe('OK');
    expect(pickerResult.results.find(result => result.name === 'PATCH 5: model picker options')?.status).toBe('SKIP');
  });

  it('ignores unrelated duplicate resolver and picker literals', () => {
    const source = CLAUDE_FIXTURE.replace(
      'function rz(x){',
      `function unrelated(){return 'case"local":return "local";case"local":return "local";value:"local";value:"local"'}\nfunction rz(x){`,
    );
    const out = runPatchScript({ 'clodex:test:local': { alias: 'local', display: 'Local' } }, source);

    expect(out).toContain('case"best":{return "opus"}case"local":return "local";default:return null');
    expect(out).toContain('{value:"local",label:"Local",description:"Local"}');
    expect(out).toContain(`function unrelated(){return 'case"local":return "local";case"local":return "local";value:"local";value:"local"'}`);
  });

  it('fails required PATCH 6 on wrong or duplicate target-owned resolver cases', () => {
    const config = { 'clodex:test:local': { alias: 'local', display: 'Local' } };
    const wrongMap = CLAUDE_FIXTURE.replace(
      'case"best":{return "opus"}default:return null',
      'case"best":{return "opus"}case"local":return "darwin";default:return null',
    );
    expect(() => applyClodexPatches(wrongMap, config)).toThrowError(PatchApplyError);

    const duplicate = CLAUDE_FIXTURE.replace(
      'case"best":{return "opus"}default:return null',
      'case"best":{return "opus"}case"local":return "local";case"local":return "local";default:return null',
    );
    expect(() => applyClodexPatches(duplicate, config)).toThrowError(PatchApplyError);
  });

  it('reports optional PATCH 5 FAIL on duplicate target-owned picker entries', () => {
    const config = { 'clodex:test:local': { alias: 'local', display: 'Local' } };
    const pickerBlock = '[{value:"local",label:"Local",description:"Local"}].forEach(function(_o){if(!e.some(function(_i){return _i.value===_o.value}))e.push(_o)});';
    const source = CLAUDE_FIXTURE
      .replace(
        'case"best":{return "opus"}default:return null',
        'case"best":{return "opus"}case"local":return "local";default:return null',
      )
      .replace(
        'Dlh(e,i,t);return e}',
        'Dlh(e,i,t);' + pickerBlock + pickerBlock + 'return e}',
      );

    const result = applyClodexPatches(source, config);
    expect(result.results.find(result => result.name === 'PATCH 5: model picker options')).toEqual({
      status: 'FAIL',
      name: 'PATCH 5: model picker options',
      extra: 'duplicate target-owned picker entries',
    });
    expect(result.content.match(/value:"local",label:"Local"/g)).toHaveLength(2);
  });

  it('reports PATCH 5/6 SKIP when every configured target entry is already present', () => {
    const config = {
      'clodex:test:local': { alias: 'local', display: 'Local' },
      'clodex:test:darwin': { alias: 'darwin', display: 'Darwin' },
    };
    const pickerBlock = '[{value:"local",label:"Local",description:"Local"},{value:"darwin",label:"Darwin",description:"Darwin"}].forEach(function(_o){if(!e.some(function(_i){return _i.value===_o.value}))e.push(_o)});';
    const source = CLAUDE_FIXTURE
      .replace(
        'case"best":{return "opus"}default:return null',
        'case"best":{return "opus"}case"local":return "local";case"darwin":return "darwin";default:return null',
      )
      .replace('Dlh(e,i,t);return e}', 'Dlh(e,i,t);' + pickerBlock + 'return e}');

    const result = applyClodexPatches(source, config);
    expect(result.content.match(/case"local":return "local";/g)).toHaveLength(1);
    expect(result.content.match(/case"darwin":return "darwin";/g)).toHaveLength(1);
    expect(result.content.match(/value:"local",label:"Local"/g)).toHaveLength(1);
    expect(result.content.match(/value:"darwin",label:"Darwin"/g)).toHaveLength(1);
    expect(result.results.find(result => result.name === 'PATCH 6: alias resolver switch')?.status).toBe('SKIP');
    expect(result.results.find(result => result.name === 'PATCH 5: model picker options')?.status).toBe('SKIP');
  });

  it('reports OK per site on a fresh run and SKIP/refresh on a re-run', () => {
    const fresh = applyClodexPatches(CLAUDE_FIXTURE, config);
    expect(fresh.results.map(r => [r.name, r.status])).toEqual([
      ['PATCH 1: Agent tool model enum', 'OK'],
      ['PATCH 3: known-alias validator list', 'OK'],
      ['PATCH 6: alias resolver switch', 'OK'],
      ['PATCH 5: model picker options', 'OK'],
      ['PATCH 4: Agent tool model description', 'OK'],
      ['PATCH 7: per-model context window', 'OK'],
      ['PATCH 8a: effort capability', 'OK'],
      ['PATCH 8b: xhigh effort capability', 'OK'],
      ['PATCH 8c: max effort capability', 'OK'],
      ['PATCH 9: default effort', 'OK'],
      ['PATCH 10: child network environment', 'OK'],
    ]);
    const rerun = applyClodexPatches(fresh.content, config);
    expect(rerun.results.map(r => [r.name, r.status])).toEqual([
      ['PATCH 1: Agent tool model enum', 'SKIP'],
      ['PATCH 3: known-alias validator list', 'SKIP'],
      ['PATCH 6: alias resolver switch', 'SKIP'],
      ['PATCH 5: model picker options', 'SKIP'],
      ['PATCH 4: Agent tool model description', 'SKIP'],
      // PATCH 7 re-runs through the in-place refresh path; an unchanged config
      // rewrites the identical table, which reports as already patched.
      ['PATCH 7: per-model context window (refresh)', 'SKIP'],
      ['PATCH 8a: effort capability (refresh)', 'SKIP'],
      ['PATCH 8b: xhigh effort capability (refresh)', 'SKIP'],
      ['PATCH 8c: max effort capability (refresh)', 'SKIP'],
      ['PATCH 9: default effort (refresh)', 'SKIP'],
      ['PATCH 10: child network environment', 'SKIP'],
    ]);
  });

  it('captures every successful built-in postcondition before local patches run', () => {
    const patched = applyClodexPatches(CLAUDE_FIXTURE, config);
    const proofs = captureBuiltInPatchProofs(patched.content, config, patched.results);

    expect(proofs).toHaveLength(patched.results.length);
    expect(builtInPatchProofsChanged(patched.content, proofs)).toBe(false);
    expect(builtInPatchProofsChanged(
      patched.content.replace('"fable","sol"', '"sol"'),
      proofs,
    )).toBe(true);
  });

  it('refreshes the baked context table in place when only the window changes', () => {
    const once = runPatchScript(config);
    const updated = runPatchScript(
      { ...config, 'clodex:openai:mystery': { context: 131_072, display: 'Mystery (OpenAI)' } },
      once,
    );
    const table = updated.match(/\/\*ccpatch:ctx\*\/var _ccw=\((\{[^}]*\})\)/)?.[1];
    const parsed = JSON.parse(table!) as Record<string, number>;
    expect(parsed['clodex:openai:mystery']).toBe(131_072);
    expect(parsed['sol']).toBe(272_000);
  });

  it('keeps identity and context patches when every effort anchor drifts', () => {
    const patched = applyClodexPatches(CLAUDE_CORE_FIXTURE, config);

    expect(patched.content).toContain('.enum(["sonnet","opus","haiku","fable","sol","clodex:openai:mystery"])');
    expect(patched.content).toContain('/*ccpatch:ctx*/');
    expect(patched.results.slice(0, 6).map(result => [result.name, result.status])).toEqual([
      ['PATCH 1: Agent tool model enum', 'OK'],
      ['PATCH 3: known-alias validator list', 'OK'],
      ['PATCH 6: alias resolver switch', 'OK'],
      ['PATCH 5: model picker options', 'OK'],
      ['PATCH 4: Agent tool model description', 'OK'],
      ['PATCH 7: per-model context window', 'OK'],
    ]);
    expect(patched.results.slice(6, -1)).toEqual([
      { status: 'FAIL', name: 'PATCH 8a: effort capability', extra: 'anchor not found' },
      { status: 'FAIL', name: 'PATCH 8b: xhigh effort capability', extra: 'anchor not found' },
      { status: 'FAIL', name: 'PATCH 8c: max effort capability', extra: 'anchor not found' },
      { status: 'FAIL', name: 'PATCH 9: default effort', extra: 'anchor not found' },
    ]);
    expect(patched.results.at(-1)).toEqual({
      status: 'OK',
      name: 'PATCH 10: child network environment',
    });
  });

  it('refreshes every baked effort table when extended capabilities are removed', () => {
    const once = runPatchScript(config);
    const updatedConfig: Parameters<typeof applyClodexPatches>[1] = {
      ...config,
      'clodex:openai-oauth:gpt-5.6-sol': {
        ...config['clodex:openai-oauth:gpt-5.6-sol'],
        effort: {
          levels: ['low', 'medium', 'high'],
          defaultLevel: 'high',
        },
      },
    };
    const updated = runPatchScript(updatedConfig, once);

    const base = updated.match(/\/\*ccpatch:effort\*\/var _ccv=Object\.assign\(Object\.create\(null\),(\{[^{}]*\})\)/)?.[1];
    const xhigh = updated.match(/\/\*ccpatch:xhigh-effort\*\/var _ccv=Object\.assign\(Object\.create\(null\),(\{[^{}]*\})\)/)?.[1];
    const max = updated.match(/\/\*ccpatch:max-effort\*\/var _ccv=Object\.assign\(Object\.create\(null\),(\{[^{}]*\})\)/)?.[1];
    const defaults = updated.match(/\/\*ccpatch:default-effort\*\/var _cce=Object\.assign\(Object\.create\(null\),(\{[^{}]*\})\)/)?.[1];

    expect(JSON.parse(base!)).toEqual({
      sol: true,
      'sol[1m]': true,
      'clodex:openai-oauth:gpt-5.6-sol': true,
      'clodex:openai-oauth:gpt-5.6-sol[1m]': true,
      'clodex:openai:mystery': false,
      'clodex:openai:mystery[1m]': false,
    });
    expect(JSON.parse(xhigh!)).toEqual({
      sol: false,
      'sol[1m]': false,
      'clodex:openai-oauth:gpt-5.6-sol': false,
      'clodex:openai-oauth:gpt-5.6-sol[1m]': false,
      'clodex:openai:mystery': false,
      'clodex:openai:mystery[1m]': false,
    });
    expect(JSON.parse(max!)).toEqual({
      sol: false,
      'sol[1m]': false,
      'clodex:openai-oauth:gpt-5.6-sol': false,
      'clodex:openai-oauth:gpt-5.6-sol[1m]': false,
      'clodex:openai:mystery': false,
      'clodex:openai:mystery[1m]': false,
    });
    expect(JSON.parse(defaults!)).toEqual({
      sol: 'high',
      'sol[1m]': 'high',
      'clodex:openai-oauth:gpt-5.6-sol': 'high',
      'clodex:openai-oauth:gpt-5.6-sol[1m]': 'high',
    });
  });

  it('keeps capability denials and clears defaults when effort is removed', () => {
    const once = runPatchScript(config);
    const { effort: _effort, ...withoutEffort } = config['clodex:openai-oauth:gpt-5.6-sol'];
    const updated = runPatchScript({
      ...config,
      'clodex:openai-oauth:gpt-5.6-sol': withoutEffort,
    }, once);

    const base = updated.match(/\/\*ccpatch:effort\*\/var _ccv=Object\.assign\(Object\.create\(null\),(\{[^{}]*\})\)/)?.[1];
    const xhigh = updated.match(/\/\*ccpatch:xhigh-effort\*\/var _ccv=Object\.assign\(Object\.create\(null\),(\{[^{}]*\})\)/)?.[1];
    const max = updated.match(/\/\*ccpatch:max-effort\*\/var _ccv=Object\.assign\(Object\.create\(null\),(\{[^{}]*\})\)/)?.[1];
    const defaults = updated.match(/\/\*ccpatch:default-effort\*\/var _cce=Object\.assign\(Object\.create\(null\),(\{[^{}]*\})\)/)?.[1];

    const disabledVerdicts = {
      sol: false,
      'sol[1m]': false,
      'clodex:openai-oauth:gpt-5.6-sol': false,
      'clodex:openai-oauth:gpt-5.6-sol[1m]': false,
      'clodex:openai:mystery': false,
      'clodex:openai:mystery[1m]': false,
    };
    expect(JSON.parse(base!)).toEqual(disabledVerdicts);
    expect(JSON.parse(xhigh!)).toEqual(disabledVerdicts);
    expect(JSON.parse(max!)).toEqual(disabledVerdicts);
    expect(JSON.parse(defaults!)).toEqual({});

    for (const { functionName } of CAPABILITY_GATES) {
      expect(executeCapability(updated, functionName, 'sol', true)).toBe(false);
      expect(executeCapability(updated, functionName, 'sol[1m]', true)).toBe(false);
      expect(executeCapability(
        updated,
        functionName,
        'clodex:openai-oauth:gpt-5.6-sol',
        true,
      )).toBe(false);
      expect(executeCapability(
        updated,
        functionName,
        'clodex:openai-oauth:gpt-5.6-sol[1m]',
        true,
      )).toBe(false);
    }
    expect(executeDefaultEffort(updated, 'sol', 'medium')).toBe('medium');
    expect(executeDefaultEffort(updated, 'sol[1m]', 'medium')).toBe('medium');
    expect(executeDefaultEffort(
      updated,
      'clodex:openai-oauth:gpt-5.6-sol',
      'medium',
    )).toBe('medium');
    expect(executeDefaultEffort(
      updated,
      'clodex:openai-oauth:gpt-5.6-sol[1m]',
      'medium',
    )).toBe('medium');
  });
});
