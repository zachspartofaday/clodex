import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserPreferences } from '../src/types.js';

const configState = vi.hoisted(() => ({
  current: {} as UserPreferences,
}));

vi.mock('../src/config.js', () => ({
  loadPreferences: vi.fn(() => structuredClone(configState.current)),
  savePreferences: vi.fn((prefs: Partial<UserPreferences>) => {
    for (const [key, value] of Object.entries(prefs)) {
      if (key === 'activeModelProfile' && value === '') {
        delete (configState.current as Record<string, unknown>).activeModelProfile;
      } else {
        (configState.current as Record<string, unknown>)[key] = structuredClone(value);
      }
    }
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

  it('never treats prototype names as saved profiles', async () => {
    expect(await runProfilesCommand(['use', 'constructor'])).toBe(1);
    expect(vi.mocked(prompts.log.error)).toHaveBeenCalledWith(
      expect.stringContaining('No profile named "constructor"'),
    );
  });
});
