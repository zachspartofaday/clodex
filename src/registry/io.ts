// src/registry/io.ts — load/save providers.json with secure permissions

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { getAppHome, getProvidersPath } from '../paths.js';
import type { ProviderRegistry, RegistryModelsCache, RegistryProvider } from './types.js';
import {
  OAUTH_ACCOUNT_NAME_RE,
  REGISTRY_SCHEMA_VERSION,
  REGISTRY_SCHEMA_VERSION_WITH_ACCOUNT_SLOTS,
  REGISTRY_SCHEMA_VERSION_WITH_ACTIVE_ACCOUNT,
  REGISTRY_SCHEMA_VERSION_WITH_ACCOUNT_MODEL_CACHES,
} from './types.js';
import {
  assertRegistryWriteOwnership,
  withRegistryWriteLockSync,
} from './lock.js';
import { migrateOAuthOpenAiProvider } from './migrate.js';
import { isValidProviderId } from './validate.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function ensureSecureAppHome(): void {
  const home = getAppHome();
  mkdirSync(home, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(home, DIR_MODE);
  } catch {
    // best-effort on platforms that restrict chmod
  }
}

export function writeSecureFile(path: string, content: string): void {
  ensureSecureAppHome();
  mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
  const fd = openSync(path, 'wx', FILE_MODE);
  try {
    const payload = Buffer.from(content);
    let offset = 0;
    while (offset < payload.length) {
      const written = writeSync(fd, payload, offset, payload.length - offset);
      if (written <= 0) {
        throw new Error(`Could not complete secure file write: ${path}`);
      }
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(path, FILE_MODE);
  } catch {
    // best-effort
  }
}

export function syncParentDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dirname(path), 'r');
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EPERM') throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseProvider(raw: unknown): RegistryProvider | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== 'string' || !isValidProviderId(p.id)) return null;
  if (typeof p.templateId !== 'string' || !p.templateId) return null;
  if (typeof p.name !== 'string' || !p.name) return null;
  if (typeof p.enabled !== 'boolean') return null;
  if (typeof p.authRef !== 'string' || !p.authRef) return null;
  if (typeof p.addedAt !== 'string' || !p.addedAt) return null;
  const api = p.api;
  if (!api || typeof api !== 'object') return null;

  const provider: RegistryProvider = {
    id: p.id,
    templateId: p.templateId,
    name: p.name,
    enabled: p.enabled,
    authRef: p.authRef,
    api: api as RegistryProvider['api'],
    addedAt: p.addedAt,
  };

  if (p.subscriptionFilter === 'free') {
    provider.subscriptionFilter = p.subscriptionFilter;
  }
  if (typeof p.preserveModelPricing === 'boolean') {
    provider.preserveModelPricing = p.preserveModelPricing;
  }
  if (p.authType === 'api' || p.authType === 'oauth' || p.authType === 'none') {
    provider.authType = p.authType;
  }
  if (hasOwn(p, 'authAccounts')) {
    const slots = parseAuthAccounts(p.authAccounts);
    if (slots === null) return null;
    provider.authAccounts = slots;
  }
  if (hasOwn(p, 'activeAuthAccount')) {
    if (!isAccountName(p.activeAuthAccount)) return null;
    provider.activeAuthAccount = p.activeAuthAccount;
  }
  if (typeof p.refreshedAt === 'string') provider.refreshedAt = p.refreshedAt;
  const modelsCache = parseModelsCache(p.modelsCache);
  if (modelsCache) provider.modelsCache = modelsCache;
  return provider;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * Shape check only, deliberately not a slot-membership check: see the
 * `activeAuthAccount` doc comment on RegistryProvider for why a stale-but-
 * well-formed name must survive the load and fail at apply time instead.
 */
function isAccountName(raw: unknown): raw is string {
  return typeof raw === 'string' && OAUTH_ACCOUNT_NAME_RE.test(raw);
}

function parseModelsCache(raw: unknown): RegistryModelsCache | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const cache = raw as Record<string, unknown>;
  if (typeof cache.fetchedAt !== 'string' || !Array.isArray(cache.models)) return null;
  if (cache.models.some(model => !model || typeof model !== 'object' || Array.isArray(model))) {
    return null;
  }
  return {
    fetchedAt: cache.fetchedAt,
    models: cache.models as RegistryModelsCache['models'],
  };
}

/**
 * Named OAuth account slots must survive a registry load intact and are
 * fail-closed: a silently dropped slot would revert a CLODEX_OAUTH_ACCOUNT
 * launch to the default identity and let credential reconciliation delete the
 * slot's tokens as unreferenced. A malformed slot therefore invalidates the
 * whole provider record instead of being skipped.
 */
function parseAuthAccounts(raw: unknown): RegistryProvider['authAccounts'] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: NonNullable<RegistryProvider['authAccounts']> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!OAUTH_ACCOUNT_NAME_RE.test(name)) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const slot = value as Record<string, unknown>;
    if (typeof slot.authRef !== 'string' || !slot.authRef) return null;
    if (typeof slot.addedAt !== 'string' || !slot.addedAt) return null;
    if (hasOwn(slot, 'oauthAccountId') && (typeof slot.oauthAccountId !== 'string' || !slot.oauthAccountId)) {
      return null;
    }
    const modelsCache = hasOwn(slot, 'modelsCache')
      ? parseModelsCache(slot.modelsCache)
      : undefined;
    if (hasOwn(slot, 'modelsCache') && !modelsCache) return null;
    out[name] = {
      authRef: slot.authRef,
      addedAt: slot.addedAt,
      ...(typeof slot.oauthAccountId === 'string' ? { oauthAccountId: slot.oauthAccountId } : {}),
      ...(modelsCache ? { modelsCache } : {}),
    };
  }
  return out;
}

function hasValidStrictProviderFields(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const provider = raw as Record<string, unknown>;
  if (hasOwn(provider, 'subscriptionFilter') && provider.subscriptionFilter !== 'free') {
    return false;
  }
  if (hasOwn(provider, 'preserveModelPricing') && typeof provider.preserveModelPricing !== 'boolean') {
    return false;
  }
  if (
    hasOwn(provider, 'authType')
    && provider.authType !== 'api'
    && provider.authType !== 'oauth'
    && provider.authType !== 'none'
  ) {
    return false;
  }
  if (hasOwn(provider, 'refreshedAt') && typeof provider.refreshedAt !== 'string') {
    return false;
  }
  if (hasOwn(provider, 'authAccounts') && parseAuthAccounts(provider.authAccounts) === null) {
    return false;
  }
  if (hasOwn(provider, 'activeAuthAccount') && !isAccountName(provider.activeAuthAccount)) {
    return false;
  }
  if (hasOwn(provider, 'modelsCache')) {
    if (parseModelsCache(provider.modelsCache) === null) return false;
  }
  return true;
}

function parseRegistry(raw: unknown): ProviderRegistry {
  const empty: ProviderRegistry = { schemaVersion: REGISTRY_SCHEMA_VERSION, providers: [] };
  if (!raw || typeof raw !== 'object') return empty;
  const data = raw as Record<string, unknown>;
  const providers: RegistryProvider[] = [];
  if (Array.isArray(data.providers)) {
    for (const entry of data.providers) {
      const parsed = parseProvider(entry);
      if (parsed) providers.push(parsed);
    }
  }
  const registry: ProviderRegistry = {
    schemaVersion:
      typeof data.schemaVersion === 'number' ? data.schemaVersion : REGISTRY_SCHEMA_VERSION,
    providers,
  };
  if (typeof data.importedAt === 'string') registry.importedAt = data.importedAt;
  if (typeof data.pricingCacheAt === 'string') registry.pricingCacheAt = data.pricingCacheAt;
  return registry;
}

function parseRegistryStrict(raw: unknown): ProviderRegistry {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Provider registry must be a JSON object.');
  }
  const data = raw as Record<string, unknown>;
  if (
    data.schemaVersion !== REGISTRY_SCHEMA_VERSION
    && data.schemaVersion !== REGISTRY_SCHEMA_VERSION_WITH_ACCOUNT_SLOTS
    && data.schemaVersion !== REGISTRY_SCHEMA_VERSION_WITH_ACTIVE_ACCOUNT
    && data.schemaVersion !== REGISTRY_SCHEMA_VERSION_WITH_ACCOUNT_MODEL_CACHES
  ) {
    throw new Error('Provider registry has an unsupported schema version.');
  }
  if (!Array.isArray(data.providers)) {
    throw new Error('Provider registry is missing its providers list.');
  }
  for (const entry of data.providers) {
    if (!parseProvider(entry) || !hasValidStrictProviderFields(entry)) {
      throw new Error('Provider registry contains an invalid provider entry.');
    }
  }
  return parseRegistry(raw);
}

function readRegistryStrict(path: string): ProviderRegistry {
  return parseRegistryStrict(JSON.parse(readFileSync(path, 'utf8')));
}

export function loadRegistry(path = getProvidersPath()): ProviderRegistry {
  if (!existsSync(path)) {
    return { schemaVersion: REGISTRY_SCHEMA_VERSION, providers: [] };
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const registry = parseRegistry(raw);
    const migrated = migrateOAuthOpenAiProvider(registry);
    if (migrated) {
      try {
        withRegistryWriteLockSync(() => {
          if (!existsSync(path)) return;
          const current = readRegistryStrict(path);
          if (migrateOAuthOpenAiProvider(current)) saveRegistry(current, path);
        }, { lockPath: `${path}.lock` });
      } catch {
        // Parsed data remains usable even when migration persistence fails.
      }
    }
    return registry;
  } catch {
    return { schemaVersion: REGISTRY_SCHEMA_VERSION, providers: [] };
  }
}

/**
 * Load a registry for destructive decisions. Unlike `loadRegistry`, read,
 * parse, and provider-shape errors propagate so callers cannot confuse an
 * unreadable registry with an empty one.
 */
export function loadRegistryStrict(path = getProvidersPath()): ProviderRegistry {
  if (!existsSync(path)) {
    return { schemaVersion: REGISTRY_SCHEMA_VERSION, providers: [] };
  }
  const registry = readRegistryStrict(path);
  migrateOAuthOpenAiProvider(registry);
  return registry;
}

export function saveRegistry(registry: ProviderRegistry, path = getProvidersPath()): void {
  assertRegistryWriteOwnership(path);
  // Slot state fences older writers via the schema version (see types.ts);
  // slot-free registries return to v1 so old builds interoperate again.
  // Highest state present wins, and the selector needs its OWN version: a
  // build predating it accepts version 2, parses the slots, drops the unknown
  // `activeAuthAccount`, and saves back without it. Version 3 stops that write.
  // It does NOT stop such a build from LAUNCHING as the provider default —
  // lenient loads never read this field — see the limitation on
  // REGISTRY_SCHEMA_VERSION_WITH_ACTIVE_ACCOUNT.
  const hasAccountModelCaches = registry.providers.some(provider => (
    Object.values(provider.authAccounts ?? {}).some(account => account.modelsCache !== undefined)
  ));
  const hasSelector = registry.providers.some(provider => provider.activeAuthAccount !== undefined);
  const hasSlots = registry.providers.some(
    provider => provider.authAccounts && Object.keys(provider.authAccounts).length > 0,
  );
  const schemaVersion = hasAccountModelCaches
    ? REGISTRY_SCHEMA_VERSION_WITH_ACCOUNT_MODEL_CACHES
    : hasSelector
      ? REGISTRY_SCHEMA_VERSION_WITH_ACTIVE_ACCOUNT
      : hasSlots
        ? REGISTRY_SCHEMA_VERSION_WITH_ACCOUNT_SLOTS
        : REGISTRY_SCHEMA_VERSION;
  const payload = `${JSON.stringify({ ...registry, schemaVersion }, null, 2)}\n`;
  const backup = `${path}.bak`;
  if (existsSync(path)) {
    try {
      copyFileSync(path, backup);
    } catch {
      // backup is best-effort
    }
  }
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeSecureFile(tmp, payload);
    assertRegistryWriteOwnership(path);
    renameSync(tmp, path);
    syncParentDirectory(path);
  } finally {
    try {
      unlinkSync(tmp);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

export function emptyRegistry(): ProviderRegistry {
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, providers: [] };
}
