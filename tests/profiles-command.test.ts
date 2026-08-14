import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserPreferences } from '../src/types.js';

const configState = vi.hoisted(() => ({
  current: {} as UserPreferences,
  beforeAtomicOperation: null as (() => void) | null,
}));

vi.mock('../src/config.js', () => ({
  loadPreferences: vi.fn(() => structuredClone(configState.current)),
  savePreferences: vi.fn((prefs: Partial<UserPreferences>) => {
    for (const [key, value] of Object.entries(prefs)) {
      (configState.current as Record<string, unknown>)[key] = structuredClone(value);
    }
  }),
  setModelProfile: vi.fn((name: string, profile: NonNullable<UserPreferences['modelProfiles']>[string]) => {
    const profiles = configState.current.modelProfiles
      && typeof configState.current.modelProfiles === 'object'
      && !Array.isArray(configState.current.modelProfiles)
      ? { ...configState.current.modelProfiles }
      : {};
    profiles[name] = structuredClone(profile);
    configState.current.modelProfiles = profiles;
    configState.current.activeModelProfile = name;
  }),
  applyModelProfile: vi.fn((name: string) => {
    configState.beforeAtomicOperation?.();
    configState.beforeAtomicOperation = null;
    const profile = configState.current.modelProfiles?.[name];
    if (!profile) return { status: 'missing' as const };
    configState.current.favoriteModels = structuredClone(profile.favoriteModels);
    configState.current.modelAliases = structuredClone(profile.modelAliases);
    configState.current.builtinModelOverrides = structuredClone(profile.builtinModelOverrides ?? {});
    configState.current.activeModelProfile = name;
    return { status: 'applied' as const, profile: structuredClone(profile) };
  }),
  deleteModelProfile: vi.fn((name: string) => {
    configState.beforeAtomicOperation?.();
    configState.beforeAtomicOperation = null;
    const profiles = configState.current.modelProfiles
      && typeof configState.current.modelProfiles === 'object'
      && !Array.isArray(configState.current.modelProfiles)
      ? { ...configState.current.modelProfiles }
      : {};
    if (!Object.prototype.hasOwnProperty.call(profiles, name)) return false;
    delete profiles[name];
    configState.current.modelProfiles = profiles;
    if (configState.current.activeModelProfile === name) {
      delete configState.current.activeModelProfile;
    }
    return true;
  }),
}));
vi.mock('@clack/prompts', () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

import { runProfilesCommand, validateProfileName } from '../src/profiles-command.js';
import * as prompts from '@clack/prompts';

const baseAliases = [
  { name: 'sol', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
  { name: 'luna', providerId: 'openai-oauth', modelId: 'gpt-5.6-luna' },
];
const baseFavorites = [
  { providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
  { providerId: 'openai-oauth', modelId: 'gpt-5.6-luna' },
];

describe('clodex profiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configState.current = {
      favoriteModels: structuredClone(baseFavorites),
      modelAliases: structuredClone(baseAliases),
    };
    configState.beforeAtomicOperation = null;
  });

  it('validates profile names', () => {
    expect(validateProfileName(' Fallback ')).toBe('fallback');
    expect(() => validateProfileName('bad name!')).toThrow(/Invalid profile name/);
  });

  it('saves a snapshot of the current favorites and aliases', async () => {
    expect(await runProfilesCommand(['save', 'default'])).toBe(0);
    const saved = configState.current.modelProfiles?.default;
    expect(saved?.modelAliases).toEqual(baseAliases);
    expect(saved?.favoriteModels).toEqual(baseFavorites);
    expect(configState.current.activeModelProfile).toBe('default');
  });

  it('applying a profile replaces favorites and aliases in one step', async () => {
    await runProfilesCommand(['save', 'default']);
    // Simulate re-pointing sol at a different provider's model, then saving a
    // fallback profile — the alias NAME is stable, only the target moves.
    configState.current.modelAliases = [
      { name: 'sol', providerId: 'meta-ai', modelId: 'muse-spark-1.2' },
      { name: 'luna', providerId: 'opencode-go', modelId: 'kimi-k3' },
    ];
    configState.current.favoriteModels = [
      { providerId: 'meta-ai', modelId: 'muse-spark-1.2' },
      { providerId: 'opencode-go', modelId: 'kimi-k3' },
    ];
    await runProfilesCommand(['save', 'fallback']);

    expect(await runProfilesCommand(['use', 'default'])).toBe(0);
    expect(configState.current.modelAliases).toEqual(baseAliases);
    expect(configState.current.favoriteModels).toEqual(baseFavorites);
    expect(configState.current.activeModelProfile).toBe('default');

    expect(await runProfilesCommand(['use', 'fallback'])).toBe(0);
    expect(configState.current.modelAliases?.[0]).toEqual(
      { name: 'sol', providerId: 'meta-ai', modelId: 'muse-spark-1.2' },
    );
  });

  it('rejects using an unknown profile and names the saved ones', async () => {
    await runProfilesCommand(['save', 'default']);
    expect(await runProfilesCommand(['use', 'missing'])).toBe(1);
    expect(vi.mocked(prompts.log.error)).toHaveBeenCalledWith(
      expect.stringContaining('saved: default'),
    );
  });

  it('does not report success when a profile is deleted before use', async () => {
    await runProfilesCommand(['save', 'default']);
    configState.beforeAtomicOperation = () => {
      delete configState.current.modelProfiles?.default;
    };

    expect(await runProfilesCommand(['use', 'default'])).toBe(1);
    expect(vi.mocked(prompts.log.error)).toHaveBeenCalledWith(
      expect.stringContaining('No profile named "default"'),
    );
    expect(vi.mocked(prompts.log.success)).not.toHaveBeenCalledWith(
      expect.stringContaining('Applied profile "default"'),
    );
  });

  it('uses the profile returned by the atomic apply in its success summary', async () => {
    await runProfilesCommand(['save', 'default']);
    configState.beforeAtomicOperation = () => {
      configState.current.modelProfiles!.default = {
        ...configState.current.modelProfiles!.default!,
        modelAliases: [{ name: 'sol', providerId: 'returned', modelId: 'returned-model' }],
      };
    };

    expect(await runProfilesCommand(['use', 'default'])).toBe(0);
    expect(vi.mocked(prompts.log.success)).toHaveBeenCalledWith(
      expect.stringContaining('sol→returned-model'),
    );
  });

  it('uses the existing missing behavior when delete reports no deletion', async () => {
    await runProfilesCommand(['save', 'default']);
    configState.beforeAtomicOperation = () => {
      delete configState.current.modelProfiles?.default;
    };

    expect(await runProfilesCommand(['delete', 'default'])).toBe(1);
    expect(vi.mocked(prompts.log.error)).toHaveBeenCalledWith(
      expect.stringContaining('No profile named "default"'),
    );
    expect(vi.mocked(prompts.log.success)).not.toHaveBeenCalledWith(
      expect.stringContaining('Deleted profile "default"'),
    );
  });

  it('deletes a profile and clears the active marker when it was active', async () => {
    await runProfilesCommand(['save', 'default']);
    expect(await runProfilesCommand(['delete', 'default'])).toBe(0);
    expect(configState.current.modelProfiles?.default).toBeUndefined();
    expect(configState.current.activeModelProfile).toBeUndefined();
  });

  it('round-trips built-in alias overrides through profiles', async () => {
    configState.current.builtinModelOverrides = { sonnet: 'wfast', fable: 'wjudge' };
    await runProfilesCommand(['save', 'remapped']);
    configState.current.builtinModelOverrides = {};
    await runProfilesCommand(['save', 'native']);

    await runProfilesCommand(['use', 'remapped']);
    expect(configState.current.builtinModelOverrides).toEqual({ sonnet: 'wfast', fable: 'wjudge' });
    await runProfilesCommand(['use', 'native']);
    expect(configState.current.builtinModelOverrides ?? {}).toEqual({});
  });

  it('rejects prototype-key profile names at validation', async () => {
    expect(() => validateProfileName('constructor')).toThrow(/reserved name/);
    expect(await runProfilesCommand(['save', 'constructor'])).toBe(1);
    expect(configState.current.modelProfiles?.constructor).not.toBeInstanceOf(Object);
    expect(await runProfilesCommand(['use', 'constructor'])).toBe(1);
    expect(vi.mocked(prompts.log.error)).toHaveBeenCalledWith(
      expect.stringContaining('reserved name'),
    );
  });
});
