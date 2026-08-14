import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserPreferences } from '../src/types.js';

const configState = vi.hoisted(() => ({
  current: {} as UserPreferences,
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
  applyModelProfile: vi.fn(() => ({ status: 'missing' as const })),
  deleteModelProfile: vi.fn(() => false),
}));

vi.mock('@clack/prompts', () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

import * as prompts from '@clack/prompts';
import { runProfilesCommand, validateProfileName } from '../src/profiles-command.js';

describe('profile audit regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configState.current = {};
  });

  it('rejects the prototype key admitted by the profile-name grammar', () => {
    expect(() => validateProfileName('constructor')).toThrow(/reserved name/);
  });

  it('skips malformed on-disk profiles instead of crashing list or use', async () => {
    configState.current.modelProfiles = {
      broken: {} as never,
      also_broken: [] as never,
      bad_members: {
        savedAt: new Date().toISOString(),
        favoriteModels: [{ providerId: 'openai-oauth' }],
        modelAliases: [],
      } as never,
    };

    await expect(runProfilesCommand([])).resolves.toBe(0);
    expect(vi.mocked(prompts.log.info)).toHaveBeenCalledWith(
      expect.stringContaining('No profiles saved'),
    );

    await expect(runProfilesCommand(['use', 'broken'])).resolves.toBe(1);
    expect(vi.mocked(prompts.log.error)).toHaveBeenCalledWith(
      expect.stringContaining('No profile named "broken"'),
    );
  });

  it('rejects extra arguments for list instead of silently ignoring them', async () => {
    expect(await runProfilesCommand(['list', 'unexpected'])).toBe(1);
    expect(vi.mocked(prompts.log.error)).toHaveBeenCalledWith(
      'Unexpected argument: unexpected',
    );
  });

  it('preserves malformed stored entries when saving an unrelated profile', async () => {
    configState.current.modelProfiles = { broken: [] as never };

    expect(await runProfilesCommand(['save', 'clean'])).toBe(0);
    expect(configState.current.modelProfiles?.broken).toEqual([]);
    expect(configState.current.modelProfiles?.clean).toBeDefined();
  });

  it('sanitizes malformed current routing when taking a new snapshot', async () => {
    (configState.current as Record<string, unknown>).favoriteModels = 'not-an-array';
    (configState.current as Record<string, unknown>).modelAliases = [
      { name: 'sol', providerId: 'openai-oauth' },
    ];
    (configState.current as Record<string, unknown>).builtinModelOverrides = { fable: 42 };

    expect(await runProfilesCommand(['save', 'clean'])).toBe(0);
    expect(configState.current.modelProfiles?.clean).toMatchObject({
      favoriteModels: [],
      modelAliases: [],
      builtinModelOverrides: {},
    });
  });
});
