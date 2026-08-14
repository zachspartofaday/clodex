import type {
  BuiltinAliasName,
  FavoriteModel,
  ModelAlias,
  ModelProfile,
  UserPreferences,
} from './types.js';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, unlinkSync } from 'node:fs';
import {
  DEFAULT_UNSUPPORTED_EFFORT_POLICY,
  isUnsupportedEffortPolicy,
} from './effort-policy.js';
import { getConfigPath } from './paths.js';
import { addFavorite, removeFavorite, type AddFavoriteResult } from './favorites.js';
import { modelAliasMatchesName, modelAliasMatchesStoredName } from './model-aliases.js';
import { BUILTIN_ALIAS_ENV } from './builtin-alias-env.js';
import { syncParentDirectory, writeSecureFile } from './registry/io.js';
import {
  assertRegistryWriteOwnership,
  withRegistryWriteLock,
  withRegistryWriteLockSync,
} from './registry/lock.js';

function readJsonFile(path: string): UserPreferences | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed as UserPreferences : null;
  } catch {
    return null;
  }
}

function readConfig(): UserPreferences {
  return readJsonFile(getConfigPath()) ?? {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const RESERVED_PROFILE_NAMES = new Set(Object.getOwnPropertyNames(Object.prototype));
const BUILTIN_ALIAS_NAMES = new Set<BuiltinAliasName>(['sonnet', 'opus', 'haiku', 'fable']);

function isFavoriteModel(value: unknown): value is FavoriteModel {
  if (!isRecord(value)) return false;
  return typeof value['providerId'] === 'string'
    && value['providerId'].trim().length > 0
    && typeof value['modelId'] === 'string'
    && value['modelId'].trim().length > 0;
}

function isModelAlias(value: unknown): value is ModelAlias {
  if (!isRecord(value)) return false;
  const name = value['name'];
  return typeof name === 'string'
    && name.trim().length > 0
    && isFavoriteModel(value);
}

function normalizeBuiltinOverrides(
  value: unknown,
): Partial<Record<BuiltinAliasName, string>> | null {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  const overrides: Partial<Record<BuiltinAliasName, string>> = {};
  for (const [alias, target] of Object.entries(value)) {
    if (!BUILTIN_ALIAS_NAMES.has(alias as BuiltinAliasName)) return null;
    if (typeof target !== 'string' || !target.trim()) return null;
    overrides[alias as BuiltinAliasName] = target.trim();
  }
  return overrides;
}

function parseStoredProfile(value: unknown): ModelProfile | null {
  if (!isRecord(value)) return null;
  if (typeof value['savedAt'] !== 'string' || !value['savedAt'].trim()) return null;
  if (!Array.isArray(value['favoriteModels']) || !value['favoriteModels'].every(isFavoriteModel)) {
    return null;
  }
  if (!Array.isArray(value['modelAliases']) || !value['modelAliases'].every(isModelAlias)) {
    return null;
  }
  const builtinModelOverrides = normalizeBuiltinOverrides(value['builtinModelOverrides']);
  if (builtinModelOverrides === null) return null;
  return {
    savedAt: value['savedAt'],
    favoriteModels: structuredClone(value['favoriteModels']),
    modelAliases: structuredClone(value['modelAliases']),
    ...(Object.keys(builtinModelOverrides).length > 0
      ? { builtinModelOverrides: structuredClone(builtinModelOverrides) }
      : {}),
  };
}

function currentOwnProfile(config: UserPreferences, name: string): ModelProfile | null {
  if (!PROFILE_NAME_RE.test(name) || RESERVED_PROFILE_NAMES.has(name)) return null;
  if (!isRecord(config.modelProfiles)
    || !Object.prototype.hasOwnProperty.call(config.modelProfiles, name)) {
    return null;
  }
  return parseStoredProfile(config.modelProfiles[name]);
}

function writeConfig(config: UserPreferences): void {
  const configPath = getConfigPath();
  assertRegistryWriteOwnership(configPath);
  const payload = `${JSON.stringify(config, null, 2)}\n`;
  const tmp = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeSecureFile(tmp, payload);
    assertRegistryWriteOwnership(configPath);
    renameSync(tmp, configPath);
    syncParentDirectory(configPath);
  } finally {
    try {
      unlinkSync(tmp);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function updateConfig<T>(
  mutate: (config: UserPreferences) => T,
  shouldWrite: (result: T) => boolean = () => true,
): T {
  const configPath = getConfigPath();
  return withRegistryWriteLockSync(() => {
    const config = readJsonFile(configPath) ?? {};
    const result = mutate(config);
    if (shouldWrite(result)) writeConfig(config);
    return result;
  }, { lockPath: `${configPath}.lock` });
}

interface AsyncConfigUpdate<T> {
  result: T;
  write: boolean;
}

async function updateConfigAsync<T>(
  mutate: (
    config: UserPreferences,
  ) => Promise<AsyncConfigUpdate<T>> | AsyncConfigUpdate<T>,
): Promise<T> {
  const configPath = getConfigPath();
  return withRegistryWriteLock(async () => {
    const config = readJsonFile(configPath) ?? {};
    const update = await mutate(config);
    if (update.write) writeConfig(config);
    return update.result;
  }, { lockPath: `${configPath}.lock` });
}

export function loadPreferences(): UserPreferences {
  const config = readConfig();
  // A config file carrying an unknown or hand-edited policy resolves to the
  // default rather than reaching a request path: the value only ever chooses
  // among four behaviors, and an unrecognized one has no safe interpretation.
  const effortPolicy = typeof config.effortPolicy === 'string'
    && isUnsupportedEffortPolicy(config.effortPolicy)
    ? config.effortPolicy
    : DEFAULT_UNSUPPORTED_EFFORT_POLICY;
  return {
    lastModel: config.lastModel,
    lastProvider: config.lastProvider,
    recentModelsByProvider: config.recentModelsByProvider,
    favoriteModels: config.favoriteModels,
    modelAliases: config.modelAliases,
    modelProfiles: config.modelProfiles,
    activeModelProfile: config.activeModelProfile,
    builtinModelOverrides: config.builtinModelOverrides,
    claudeBridgeMode: config.claudeBridgeMode,
    serverBridgeMode: config.serverBridgeMode,
    appPathOverrides: config.appPathOverrides,
    localPatchesEnabled: config.localPatchesEnabled,
    effortPolicy,
    recentLaunchFolders: config.recentLaunchFolders,
    server: config.server,
  };
}

export function savePreferences(prefs: Partial<Pick<UserPreferences, 'lastModel' | 'lastProvider' | 'recentModelsByProvider' | 'favoriteModels' | 'modelAliases' | 'builtinModelOverrides' | 'claudeBridgeMode' | 'serverBridgeMode' | 'appPathOverrides' | 'localPatchesEnabled' | 'effortPolicy' | 'recentLaunchFolders'>>): void {
  updateConfig(config => {
    if (prefs.lastModel !== undefined) config.lastModel = prefs.lastModel;
    if (prefs.lastProvider !== undefined) config.lastProvider = prefs.lastProvider;
    if (prefs.recentModelsByProvider !== undefined) config.recentModelsByProvider = prefs.recentModelsByProvider;
    if (prefs.favoriteModels !== undefined) config.favoriteModels = prefs.favoriteModels;
    if (prefs.modelAliases !== undefined) config.modelAliases = prefs.modelAliases;
    if (prefs.builtinModelOverrides !== undefined) {
      if (Object.keys(prefs.builtinModelOverrides).length === 0) delete config.builtinModelOverrides;
      else config.builtinModelOverrides = prefs.builtinModelOverrides;
    }
    if (prefs.claudeBridgeMode !== undefined) config.claudeBridgeMode = prefs.claudeBridgeMode;
    if (prefs.serverBridgeMode !== undefined) config.serverBridgeMode = prefs.serverBridgeMode;
    if (prefs.appPathOverrides !== undefined) config.appPathOverrides = prefs.appPathOverrides;
    if (prefs.localPatchesEnabled !== undefined) config.localPatchesEnabled = prefs.localPatchesEnabled;
    if (prefs.effortPolicy !== undefined) config.effortPolicy = prefs.effortPolicy;
    if (prefs.recentLaunchFolders !== undefined) config.recentLaunchFolders = prefs.recentLaunchFolders;
  });
}

export function setModelProfile(name: string, profile: ModelProfile): void {
  updateConfig(config => {
    const profiles: Record<string, ModelProfile> = isRecord(config.modelProfiles)
      ? { ...config.modelProfiles } as Record<string, ModelProfile>
      : {};
    profiles[name] = profile;
    config.modelProfiles = profiles;
    config.activeModelProfile = name;
  });
}

export type ApplyModelProfileResult =
  | { status: 'applied'; profile: ModelProfile }
  | { status: 'missing' };

export async function applyModelProfile(name: string): Promise<ApplyModelProfileResult> {
  return updateConfigAsync<ApplyModelProfileResult>(config => {
    const profile = currentOwnProfile(config, name);
    if (!profile) return { result: { status: 'missing' }, write: false };

    config.favoriteModels = structuredClone(profile.favoriteModels);
    config.modelAliases = structuredClone(profile.modelAliases);
    if (profile.builtinModelOverrides && Object.keys(profile.builtinModelOverrides).length > 0) {
      config.builtinModelOverrides = structuredClone(profile.builtinModelOverrides);
    } else {
      delete config.builtinModelOverrides;
    }
    config.activeModelProfile = name;
    return { result: { status: 'applied', profile }, write: true };
  });
}

export function deleteModelProfile(name: string): boolean {
  return updateConfig(config => {
    const profile = currentOwnProfile(config, name);
    if (!profile || !isRecord(config.modelProfiles)) return false;

    const profiles = { ...config.modelProfiles };
    delete profiles[name];
    config.modelProfiles = profiles as UserPreferences['modelProfiles'];
    if (config.activeModelProfile === name) delete config.activeModelProfile;
    return true;
  }, result => result);
}

export function setBuiltinModelOverride(
  builtin: BuiltinAliasName,
  target: string | null,
): Partial<Record<BuiltinAliasName, string>> {
  return updateConfig(config => {
    const next: Partial<Record<BuiltinAliasName, string>> = isRecord(config.builtinModelOverrides)
      ? { ...config.builtinModelOverrides } as Partial<Record<BuiltinAliasName, string>>
      : {};
    if (target === null) delete next[builtin];
    else next[builtin] = target;
    if (Object.keys(next).length === 0) delete config.builtinModelOverrides;
    else config.builtinModelOverrides = next;
    return next;
  });
}

export function clearBuiltinOverridesTargeting(
  aliasName: string,
): Array<[BuiltinAliasName, string]> {
  return updateConfig(config => {
    const overrides = isRecord(config.builtinModelOverrides)
      ? config.builtinModelOverrides
      : {};
    const targetName = aliasName.trim().toLowerCase();
    const cleared = (Object.entries(overrides) as Array<[string, unknown]>)
      .filter(([builtin, target]) => (
        builtin in BUILTIN_ALIAS_ENV
        && typeof target === 'string'
        && target.trim().toLowerCase() === targetName
      ))
      .map(([builtin, target]) => [builtin as BuiltinAliasName, target as string] as [BuiltinAliasName, string]);
    if (cleared.length === 0) return cleared;
    const next = { ...overrides } as Partial<Record<BuiltinAliasName, string>>;
    for (const [builtin] of cleared) delete next[builtin];
    if (Object.keys(next).length === 0) delete config.builtinModelOverrides;
    else config.builtinModelOverrides = next;
    return cleared;
  });
}

export function upsertModelAlias(alias: ModelAlias): ModelAlias[] {
  return updateConfig(config => {
    const aliases = Array.isArray(config.modelAliases) ? config.modelAliases : [];
    const next = aliases.filter(entry => !modelAliasMatchesName(entry, alias.name));
    next.push(alias);
    config.modelAliases = next;
    return next;
  });
}

export function removeModelAliasesByName(
  name: string,
): { aliases: ModelAlias[]; removedCount: number } {
  return updateConfig(config => {
    const aliases = Array.isArray(config.modelAliases) ? config.modelAliases : [];
    const aliasesAfterRemoval = aliases.filter(entry => !modelAliasMatchesName(entry, name));
    const removedCount = aliases.length - aliasesAfterRemoval.length;
    if (removedCount > 0) config.modelAliases = aliasesAfterRemoval;
    return {
      aliases: aliasesAfterRemoval,
      removedCount,
    };
  });
}

export function removeModelAliasesByStoredName(
  requestedName: string,
): { aliases: ModelAlias[]; removedCount: number } {
  return updateConfig(config => {
    const aliases = Array.isArray(config.modelAliases) ? config.modelAliases : [];
    const aliasesAfterRemoval = aliases.filter(entry => !modelAliasMatchesStoredName(entry, requestedName));
    const removedCount = aliases.length - aliasesAfterRemoval.length;
    if (removedCount > 0) config.modelAliases = aliasesAfterRemoval;
    return {
      aliases: aliasesAfterRemoval,
      removedCount,
    };
  });
}

export function addFavoriteModel(
  fav: FavoriteModel,
  max?: number,
): AddFavoriteResult {
  return updateConfig(config => {
    const favorites = Array.isArray(config.favoriteModels) ? config.favoriteModels : [];
    const result = addFavorite(favorites, fav, max);
    if (result.ok) config.favoriteModels = result.list;
    return result;
  });
}

export function removeFavoriteModel(fav: FavoriteModel): FavoriteModel[] {
  return updateConfig(config => {
    const favorites = Array.isArray(config.favoriteModels) ? config.favoriteModels : [];
    const next = removeFavorite(favorites, fav);
    config.favoriteModels = next;
    return next;
  });
}

export function getAppPathOverride(appId: string): string | undefined {
  const value = loadPreferences().appPathOverrides?.[appId];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function setAppPathOverride(appId: string, path: string | null): Record<string, string> {
  return updateConfig(config => {
    const next = { ...(config.appPathOverrides ?? {}) };
    const trimmed = path?.trim() ?? '';
    if (trimmed) next[appId] = trimmed;
    else delete next[appId];
    config.appPathOverrides = next;
    if (Object.keys(next).length === 0) delete config.appPathOverrides;
    return next;
  });
}

/**
 * Resolve the bridge mode for a command. An explicit flag applies to that run only —
 * it is persisted as the command's default ONLY when the caller opts in (--save-mode).
 * With no flag, the saved per-command default applies; with no saved default, proxy.
 */
export function resolveBridgeMode(
  command: 'claude' | 'server',
  explicit: import('./types.js').BridgeMode | undefined,
  opts: { persist?: boolean } = {},
): import('./types.js').BridgeMode {
  const key = command === 'claude' ? 'claudeBridgeMode' : 'serverBridgeMode';
  if (explicit) {
    if (opts.persist === true) savePreferences({ [key]: explicit });
    return explicit;
  }
  return loadPreferences()[key] ?? 'proxy';
}

const MAX_RECENT_MODELS = 3;
const MAX_RECENT_LAUNCH_FOLDERS = 6;

export function recordLaunchFolder(folder: string): string[] {
  const trimmed = folder.trim();
  if (!trimmed) return loadPreferences().recentLaunchFolders ?? [];
  return updateConfig(config => {
    const prev = config.recentLaunchFolders ?? [];
    const next = [trimmed, ...prev.filter(path => path !== trimmed)].slice(0, MAX_RECENT_LAUNCH_FOLDERS);
    config.recentLaunchFolders = next;
    return next;
  });
}

export function recordLaunchSelection(
  _agent: 'claude',
  providerId: string,
  modelId: string,
): void {
  updateConfig(config => {
    const recentModelsByProvider = isRecord(config.recentModelsByProvider)
      ? { ...config.recentModelsByProvider } as Record<string, string[]>
      : {};
    const prevRecent = Array.isArray(recentModelsByProvider[providerId])
      ? recentModelsByProvider[providerId]
      : [];
    const updatedRecent = [modelId, ...prevRecent.filter(id => id !== modelId)].slice(0, MAX_RECENT_MODELS);
    recentModelsByProvider[providerId] = updatedRecent;
    config.lastProvider = providerId;
    config.lastModel = modelId;
    config.recentModelsByProvider = recentModelsByProvider;
  });
}

const SERVER_PASSWORD_SERVICE = 'clodex-server-password';
const SERVER_PASSWORD_ACCOUNT = 'server-password';

async function getServerPasswordKeyring(): Promise<any | null> {
  try {
    const { Entry } = await import('@napi-rs/keyring');
    return new Entry(SERVER_PASSWORD_SERVICE, SERVER_PASSWORD_ACCOUNT);
  } catch {
    return null;
  }
}

export async function getSavedServerPassword(): Promise<string | null> {
  const keyring = await getServerPasswordKeyring();
  if (!keyring) return readConfig().server?.savedPassword ?? null;

  const savedPassword = await updateConfigAsync(async config => {
    const server = config.server;
    const password = server?.savedPassword;
    if (!password) return { result: null, write: false };
    try {
      await keyring.setPassword(password);
      delete server.savedPassword;
      if (Object.keys(server).length === 0) delete config.server;
      return { result: password, write: true };
    } catch {
      // Fallback: keep in config.json if keyring fails
      return { result: password, write: false };
    }
  });
  if (savedPassword) return savedPassword;

  try {
    return await keyring.getPassword();
  } catch {
    return null;
  }
}

export async function setSavedServerPassword(password: string): Promise<void> {
  const keyring = await getServerPasswordKeyring();
  if (keyring) {
    try {
      await keyring.setPassword(password);
      return;
    } catch {
      // Fallback
    }
  }
  await updateConfigAsync(config => {
    config.server = {
      ...(config.server ?? {}),
      savedPassword: password,
    };
    return { result: undefined, write: true };
  });
}

export async function clearSavedServerPassword(): Promise<void> {
  const keyring = await getServerPasswordKeyring();
  if (keyring) {
    try {
      await keyring.deletePassword();
    } catch {
      // Ignore
    }
  }
  await updateConfigAsync(config => {
    if (!config.server) return { result: undefined, write: false };
    delete config.server.savedPassword;
    if (Object.keys(config.server).length === 0) delete config.server;
    return { result: undefined, write: true };
  });
}

export function getServerExposedProviders(): string[] | null {
  const list = readConfig().server?.exposedProviders;
  return list && list.length > 0 ? list : null;
}

export function setServerExposedProviders(providerIds: string[]): void {
  updateConfig(config => {
    config.server = {
      ...(config.server ?? {}),
      exposedProviders: providerIds,
    };
  });
}

export function getServerMaskGatewayIds(): boolean {
  return readConfig().server?.maskGatewayIds ?? true;
}

export function setServerMaskGatewayIds(mask: boolean): void {
  updateConfig(config => {
    config.server = {
      ...(config.server ?? {}),
      maskGatewayIds: mask,
    };
  });
}

export function getServerFavoritesOnly(): boolean {
  return readConfig().server?.favoritesOnly ?? false;
}

export function setServerFavoritesOnly(favoritesOnly: boolean): void {
  updateConfig(config => {
    config.server = {
      ...(config.server ?? {}),
      favoritesOnly,
    };
  });
}

export function getServerListenMode(): 'local' | 'network' {
  return readConfig().server?.listenMode === 'network' ? 'network' : 'local';
}

export function setServerListenMode(listenMode: 'local' | 'network'): void {
  updateConfig(config => {
    config.server = {
      ...(config.server ?? {}),
      listenMode,
    };
  });
}
