import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyModelProfile,
  clearSavedServerPassword,
  deleteModelProfile,
  getAppPathOverride,
  getSavedServerPassword,
  getServerListenMode,
  loadPreferences,
  recordLaunchFolder,
  resolveBridgeMode,
  savePreferences,
  setAppPathOverride,
  setModelProfile,
  setSavedServerPassword,
  setServerListenMode,
} from '../src/config.js';
import { getAppHome, getConfigPath } from '../src/paths.js';
import type { ModelProfile } from '../src/types.js';

const profileP: ModelProfile = {
  savedAt: '2026-01-01T00:00:00.000Z',
  favoriteModels: [{ providerId: 'provider-p', modelId: 'model-p' }],
  modelAliases: [{ name: 'route', providerId: 'provider-p', modelId: 'model-p' }],
  builtinModelOverrides: { sonnet: 'route' },
};
const profileQ: ModelProfile = {
  savedAt: '2026-01-02T00:00:00.000Z',
  favoriteModels: [{ providerId: 'provider-q', modelId: 'model-q' }],
  modelAliases: [{ name: 'route', providerId: 'provider-q', modelId: 'model-q' }],
  builtinModelOverrides: { opus: 'route' },
};

let tempHome: string;
let previousHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'clodex-test-'));
  previousHome = process.env['HOME'];
  process.env['HOME'] = tempHome;
  process.env['CLODEX_HOME'] = join(tempHome, 'app-home');
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = previousHome;
  delete process.env['CLODEX_HOME'];
});

describe('app paths', () => {
  it('uses CLODEX_HOME when set', () => {
    process.env['CLODEX_HOME'] = join(tempHome, 'custom-home');

    expect(getAppHome()).toBe(join(tempHome, 'custom-home'));
  });

  it('defaults to a .clodex folder under the user home', () => {
    expect(getAppHome({ HOME: tempHome })).toBe(join(tempHome, '.clodex'));
  });

  it('stores config.json inside the app home', () => {
    process.env['CLODEX_HOME'] = join(tempHome, 'app');

    expect(getConfigPath()).toBe(join(tempHome, 'app', 'config.json'));
  });
});

describe('dotfolder config', () => {
  it('writes preferences to config.json in the app home', () => {
    savePreferences({ lastProvider: 'openai-oauth', lastModel: 'gpt-5.6-sol' });

    expect(loadPreferences()).toMatchObject({
      lastProvider: 'openai-oauth',
      lastModel: 'gpt-5.6-sol',
    });
    expect(JSON.parse(readFileSync(getConfigPath(), 'utf8'))).toMatchObject({
      lastProvider: 'openai-oauth',
      lastModel: 'gpt-5.6-sol',
    });
  });

  it('saves favorites and aliases', () => {
    savePreferences({
      favoriteModels: [{ providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
      modelAliases: [{ name: 'Sol', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
    });

    expect(loadPreferences()).toMatchObject({
      favoriteModels: [{ providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
      modelAliases: [{ name: 'Sol', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
    });
    expect(JSON.parse(readFileSync(getConfigPath(), 'utf8')).modelAliases).toEqual([
      { name: 'Sol', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
    ]);
  });

  it('returns missing without writing when a profile is deleted before apply', async () => {
    setModelProfile('profile', profileP);
    expect(deleteModelProfile('profile')).toBe(true);
    const before = readFileSync(getConfigPath(), 'utf8');

    expect(await applyModelProfile('profile')).toEqual({ status: 'missing' });
    expect(readFileSync(getConfigPath(), 'utf8')).toBe(before);
  });

  it('applies the profile currently saved at the time of the update', async () => {
    setModelProfile('profile', profileP);
    setModelProfile('profile', profileQ);

    expect(await applyModelProfile('profile')).toEqual({ status: 'applied', profile: profileQ });
    expect(loadPreferences()).toMatchObject({
      favoriteModels: profileQ.favoriteModels,
      modelAliases: profileQ.modelAliases,
      builtinModelOverrides: profileQ.builtinModelOverrides,
      activeModelProfile: 'profile',
    });
  });

  it('returns missing without writing for a malformed profile', async () => {
    savePreferences({ lastModel: 'keep-me' });
    writeFileSync(getConfigPath(), JSON.stringify({
      lastModel: 'keep-me',
      modelProfiles: {
        broken: {
          savedAt: '2026-01-01T00:00:00.000Z',
          favoriteModels: [{ providerId: 'provider-p' }],
          modelAliases: [],
        },
      },
    }));
    const before = readFileSync(getConfigPath(), 'utf8');

    expect(await applyModelProfile('broken')).toEqual({ status: 'missing' });
    expect(readFileSync(getConfigPath(), 'utf8')).toBe(before);
  });

  it('preserves unrelated fields and the profile map when applying a profile', async () => {
    setModelProfile('profile', profileQ);
    const before = JSON.parse(readFileSync(getConfigPath(), 'utf8')) as Record<string, unknown>;
    before.lastModel = 'untouched';
    before.server = { listenMode: 'network' };
    writeFileSync(getConfigPath(), JSON.stringify(before));
    const profilesBefore = (before.modelProfiles as Record<string, unknown>);

    expect(await applyModelProfile('profile')).toEqual({ status: 'applied', profile: profileQ });
    const after = JSON.parse(readFileSync(getConfigPath(), 'utf8')) as Record<string, unknown>;
    expect(after.lastModel).toBe('untouched');
    expect(after.server).toEqual({ listenMode: 'network' });
    expect(after.modelProfiles).toEqual(profilesBefore);
    expect(after.activeModelProfile).toBe('profile');
  });

  it('deletes a profile once and reports false when it is already absent', () => {
    setModelProfile('profile', profileP);

    expect(deleteModelProfile('profile')).toBe(true);
    expect(deleteModelProfile('profile')).toBe(false);
  });

  it('persists explicit local-patch opt-in and opt-out', () => {
    savePreferences({ localPatchesEnabled: true });
    expect(loadPreferences().localPatchesEnabled).toBe(true);

    savePreferences({ localPatchesEnabled: false });
    expect(loadPreferences().localPatchesEnabled).toBe(false);
  });

  it('persists the global effort policy and defaults when none is saved', () => {
    expect(loadPreferences().effortPolicy).toBe('provider-default');

    savePreferences({ effortPolicy: 'up' });
    expect(loadPreferences().effortPolicy).toBe('up');
    expect(JSON.parse(readFileSync(getConfigPath(), 'utf8')).effortPolicy).toBe('up');

    savePreferences({ effortPolicy: 'exact' });
    expect(loadPreferences().effortPolicy).toBe('exact');
  });

  it('falls back to the default rather than honouring an unknown saved policy', () => {
    // A hand-edited or newer-version config must not reach a request path with
    // a behavior this build cannot interpret.
    savePreferences({ lastProvider: 'openai-oauth' });
    writeFileSync(
      getConfigPath(),
      JSON.stringify({ lastProvider: 'openai-oauth', effortPolicy: 'nearest' }),
    );
    expect(loadPreferences().effortPolicy).toBe('provider-default');
  });

  it('loads legacy aliases without mutating or filtering their stored form', () => {
    savePreferences({ lastProvider: 'openai-oauth' });
    const legacyPayload = JSON.stringify({
      lastProvider: 'openai-oauth',
      modelAliases: [
        { name: 'LuNa', providerId: 'one', modelId: 'model-a' },
        { name: 'luna', providerId: 'one', modelId: 'model-a' },
        { name: 'Orbit', providerId: 'one', modelId: 'model-a' },
        { name: 'ORBIT', providerId: 'two', modelId: 'model-b' },
        { name: 'best', providerId: 'one', modelId: 'model-a' },
      ],
    });
    writeFileSync(getConfigPath(), legacyPayload);

    const prefs = loadPreferences();
    expect(prefs.lastProvider).toBe('openai-oauth');
    expect(prefs.modelAliases).toEqual(JSON.parse(legacyPayload).modelAliases);
    expect(readFileSync(getConfigPath(), 'utf8')).toBe(legacyPayload);
  });

  it('saves and clears app path overrides', () => {
    setAppPathOverride('claude', '/tmp/custom-claude');

    expect(getAppPathOverride('claude')).toBe('/tmp/custom-claude');
    expect(loadPreferences().appPathOverrides).toEqual({ claude: '/tmp/custom-claude' });

    setAppPathOverride('claude', null);

    expect(getAppPathOverride('claude')).toBeUndefined();
    expect(loadPreferences().appPathOverrides).toBeUndefined();
  });

  it('records recent launch folders with most recent first', () => {
    recordLaunchFolder('/Users/jbendavi/project-a');
    recordLaunchFolder('/Users/jbendavi/project-b');
    recordLaunchFolder('/Users/jbendavi/project-a');

    expect(loadPreferences().recentLaunchFolders).toEqual([
      '/Users/jbendavi/project-a',
      '/Users/jbendavi/project-b',
    ]);
  });

  it('returns null when no server password is saved', async () => {
    expect(await getSavedServerPassword()).toBeNull();
  });

  it('saves and clears a server password', async () => {
    await setSavedServerPassword('my-lan-password');
    expect(await getSavedServerPassword()).toBe('my-lan-password');

    await clearSavedServerPassword();
    expect(await getSavedServerPassword()).toBeNull();
  });

  it('saves server listen-mode preference', () => {
    expect(getServerListenMode()).toBe('local');

    setServerListenMode('network');
    expect(getServerListenMode()).toBe('network');

    setServerListenMode('local');
    expect(getServerListenMode()).toBe('local');
  });

  it('creates the app home lazily', () => {
    expect(existsSync(process.env['CLODEX_HOME']!)).toBe(false);

    savePreferences({ lastProvider: 'openai' });

    expect(existsSync(process.env['CLODEX_HOME']!)).toBe(true);
  });
});

describe('bridge-mode memory', () => {
  it('defaults both commands to proxy mode when nothing is saved', () => {
    expect(resolveBridgeMode('claude', undefined)).toBe('proxy');
    expect(resolveBridgeMode('server', undefined)).toBe('proxy');
  });

  it('never auto-persists an explicit mode flag', () => {
    expect(resolveBridgeMode('claude', 'endpoint')).toBe('endpoint');
    expect(resolveBridgeMode('claude', undefined)).toBe('proxy');

    expect(resolveBridgeMode('server', 'endpoint', { persist: false })).toBe('endpoint');
    expect(resolveBridgeMode('server', undefined)).toBe('proxy');
  });

  it('persists only with an explicit save gesture (--save-mode), per command', () => {
    expect(resolveBridgeMode('claude', 'endpoint', { persist: true })).toBe('endpoint');
    expect(resolveBridgeMode('claude', undefined)).toBe('endpoint');
    // server is remembered independently — still the proxy default
    expect(resolveBridgeMode('server', undefined)).toBe('proxy');

    expect(resolveBridgeMode('server', 'endpoint', { persist: true })).toBe('endpoint');
    expect(resolveBridgeMode('server', undefined)).toBe('endpoint');

    // saved default is overridable for one run without losing the saved value
    expect(resolveBridgeMode('claude', 'proxy')).toBe('proxy');
    expect(resolveBridgeMode('claude', undefined)).toBe('endpoint');

    // and replaceable with another --save-mode
    expect(resolveBridgeMode('claude', 'proxy', { persist: true })).toBe('proxy');
    expect(resolveBridgeMode('claude', undefined)).toBe('proxy');
    expect(resolveBridgeMode('server', undefined)).toBe('endpoint');
  });
});
