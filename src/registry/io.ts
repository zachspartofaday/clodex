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
import { isDeepStrictEqual } from 'node:util';
import { getAppHome, getProvidersPath } from '../paths.js';
import type { ProviderRegistry, RegistryModelsCache, RegistryProvider } from './types.js';
import {
  OAUTH_ACCOUNT_NAME_RE,
  REGISTRY_SCHEMA_VERSION,
  REGISTRY_SCHEMA_VERSION_WITH_ACCOUNT_SLOTS,
  REGISTRY_SCHEMA_VERSION_WITH_ACTIVE_ACCOUNT,
  REGISTRY_SCHEMA_VERSION_WITH_ACCOUNT_MODEL_CACHES,
  REGISTRY_SCHEMA_VERSION_WITH_MATERIALIZED_ACTIVE_ACCOUNT,
} from './types.js';
import {
  assertRegistryWriteOwnership,
  RegistryLockLostError,
  withRegistryWriteLockSync,
} from './lock.js';
import { migrateRegistry } from './migrate.js';
import {
  getOAuthAccountSlot,
  migrateActiveOAuthAccountStorage,
} from './oauth-account-storage.js';
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

  if (hasOwn(p, 'defaultAuthRef')) {
    if (typeof p.defaultAuthRef !== 'string' || !p.defaultAuthRef) return null;
    provider.defaultAuthRef = p.defaultAuthRef;
  }

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
  if (hasOwn(provider, 'defaultAuthRef')
    && (typeof provider.defaultAuthRef !== 'string' || !provider.defaultAuthRef)) {
    return false;
  }
  if (hasOwn(provider, 'modelsCache')) {
    if (parseModelsCache(provider.modelsCache) === null) return false;
  }
  return true;
}

function hasPresentInvalidAuthType(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const provider = raw as Record<string, unknown>;
  return hasOwn(provider, 'authType')
    && provider.authType !== 'api'
    && provider.authType !== 'oauth'
    && provider.authType !== 'none';
}

/** Single home for the registry-repair sentence every diagnostic ends with. */
function registryRepairGuidance(path: string): string {
  return `Repair it or restore ${path}.bak, then retry.`;
}

const SELECTOR_BEFORE_SELECTOR_SCHEMA =
  'a selected account appears before the selector schema version';

/**
 * Explain the cross-field credential-storage violation for the schema that
 * supplied it. Versions 1-4 are valid migration input only when the parked
 * field is absent. Version 5 requires every live OAuth selector to name a slot
 * and to materialize that exact slot in `authRef`; otherwise launch must fail
 * closed rather than falling back to the provider default.
 */
function selectionStorageError(
  provider: RegistryProvider,
  schemaVersion: number,
): string | undefined {
  const name = provider.activeAuthAccount?.trim();
  const hasDefault = provider.defaultAuthRef !== undefined;

  if (schemaVersion < REGISTRY_SCHEMA_VERSION_WITH_ACCOUNT_MODEL_CACHES
    && Object.values(provider.authAccounts ?? {}).some(account => account.modelsCache !== undefined)) {
    return 'an account cache appears before the schema version that establishes its ownership';
  }
  if (name && schemaVersion < REGISTRY_SCHEMA_VERSION_WITH_ACTIVE_ACCOUNT) {
    return SELECTOR_BEFORE_SELECTOR_SCHEMA;
  }
  if (schemaVersion <= REGISTRY_SCHEMA_VERSION_WITH_ACCOUNT_MODEL_CACHES && hasDefault) {
    return 'a parked provider default appears before materialized selection storage';
  }
  if (!name) {
    return hasDefault ? 'a provider default is parked without a selected account' : undefined;
  }
  if (provider.authType !== 'oauth') {
    return hasDefault ? 'a non-OAuth selector parks a provider default' : undefined;
  }
  if (schemaVersion <= REGISTRY_SCHEMA_VERSION_WITH_ACCOUNT_MODEL_CACHES) {
    // A well-formed but missing legacy slot remains repairable. Migration does
    // not materialize it, and current launch-time selection still throws.
    return undefined;
  }
  if (schemaVersion !== REGISTRY_SCHEMA_VERSION_WITH_MATERIALIZED_ACTIVE_ACCOUNT) {
    // Preserve the lenient reader's forward-compatible behavior. Strict reads
    // reject unsupported versions before reaching this branch. The parked-
    // default-without-selector invariant above is version-independent, so that
    // corruption remains visible even in a future lenient schema.
    return undefined;
  }
  if (!hasDefault) return 'the selected account has no parked provider default';
  const selected = getOAuthAccountSlot(provider, name);
  if (!selected) return `the selected account "${name}" has no matching account slot`;
  if (provider.authRef !== selected.authRef) {
    return 'the selected account does not match the downgrade-visible credential reference';
  }
  // A downgraded launch consumes top-level authRef AND modelsCache. Require
  // the cache to be the selected slot's proven cache (or both absent), or it
  // could launch the right credential with another account's entitlements.
  if (!isDeepStrictEqual(provider.modelsCache, selected.modelsCache)) {
    return 'the selected account does not own the downgrade-visible model cache';
  }
  return undefined;
}

function hasValidSelectionStorage(
  provider: RegistryProvider,
  schemaVersion: number,
): boolean {
  return selectionStorageError(provider, schemaVersion) === undefined;
}

class RegistrySelectionStorageError extends Error {
  constructor(
    readonly providerId: string,
    readonly detail: string,
    options?: ErrorOptions,
  ) {
    super(detail, options);
    this.name = 'RegistrySelectionStorageError';
  }
}

function parseRegistry(raw: unknown): ProviderRegistry {
  const empty: ProviderRegistry = { schemaVersion: REGISTRY_SCHEMA_VERSION, providers: [] };
  if (!raw || typeof raw !== 'object') return empty;
  const data = raw as Record<string, unknown>;
  const schemaVersion =
    typeof data.schemaVersion === 'number' ? data.schemaVersion : REGISTRY_SCHEMA_VERSION;
  const providers: RegistryProvider[] = [];
  if (Array.isArray(data.providers)) {
    for (const entry of data.providers) {
      const parsed = parseProvider(entry);
      const invalidKnownSelectionAuthType = schemaVersion >= REGISTRY_SCHEMA_VERSION_WITH_ACTIVE_ACCOUNT
        && schemaVersion <= REGISTRY_SCHEMA_VERSION_WITH_MATERIALIZED_ACTIVE_ACCOUNT
        && parsed?.activeAuthAccount !== undefined
        && hasPresentInvalidAuthType(entry);
      const selectionError = parsed
        ? selectionStorageError(parsed, schemaVersion)
        : undefined;
      // A parked provider default IS materialized-selection storage, so finding
      // one below v5 is partial or downgraded corruption rather than a legacy
      // state this build can repair. Dropping such a record leniently would
      // erase the provider from the very screens that could fix it while every
      // mutating path already fails loud. A legacy `activeAuthAccount` with no
      // parked default stays loadable and repairable (see types.ts).
      const failClosed = schemaVersion >= REGISTRY_SCHEMA_VERSION_WITH_MATERIALIZED_ACTIVE_ACCOUNT
        || parsed?.defaultAuthRef !== undefined;
      if (parsed && selectionError && failClosed) {
        throw new RegistrySelectionStorageError(parsed.id, selectionError);
      }
      if (parsed && !invalidKnownSelectionAuthType && !selectionError) providers.push(parsed);
    }
  }
  const registry: ProviderRegistry = {
    schemaVersion,
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
    && data.schemaVersion !== REGISTRY_SCHEMA_VERSION_WITH_MATERIALIZED_ACTIVE_ACCOUNT
  ) {
    throw new Error('Provider registry has an unsupported schema version.');
  }
  if (!Array.isArray(data.providers)) {
    throw new Error('Provider registry is missing its providers list.');
  }
  for (const entry of data.providers) {
    const provider = parseProvider(entry);
    if (!provider || !hasValidStrictProviderFields(entry)
      || !hasValidSelectionStorage(provider, data.schemaVersion)) {
      throw new Error('Provider registry contains an invalid provider entry.');
    }
  }
  return parseRegistry(raw);
}

function readRegistryStrict(path: string): ProviderRegistry {
  return parseRegistryStrict(JSON.parse(readFileSync(path, 'utf8')));
}

class RegistryMigrationValidationError extends Error {
  constructor(
    readonly registryPath: string,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(detail, { cause });
    this.name = 'RegistryMigrationValidationError';
  }
}

class RegistryMigrationReadError extends Error {
  constructor(
    readonly registryPath: string,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(detail, { cause });
    this.name = 'RegistryMigrationReadError';
  }
}

class RegistrySaveValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RegistrySaveValidationError';
  }
}

/**
 * A save refused because one provider's selection storage is invalid. Carries
 * the offending provider id and the same non-secret reason the load-side
 * diagnostic prints, so a mixed legacy registry says which provider to repair
 * instead of only that some provider is broken.
 */
class RegistrySelectionStorageSaveError extends RegistrySaveValidationError {
  constructor(
    path: string,
    readonly providerId: string,
    readonly detail: string,
  ) {
    super(
      'Provider registry contains invalid OAuth account selection storage '
      + `for provider "${providerId}": ${detail}. `
      + registryRepairGuidance(path),
    );
    this.name = 'RegistrySelectionStorageSaveError';
  }
}

class RegistryPersistenceError extends Error {
  constructor(
    readonly registryPath: string,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(detail, { cause });
    this.name = 'RegistryPersistenceError';
  }
}

class RegistryDurabilityCheckError extends Error {
  constructor(
    readonly registryPath: string,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(detail, { cause });
    this.name = 'RegistryDurabilityCheckError';
  }
}

function selectionStorageDiagnostic(
  path: string,
  cause: RegistrySelectionStorageError,
): Error {
  return new Error(
    'Could not safely persist the selected OAuth account before launch. '
    + `The provider registry at ${path} contains an invalid provider entry: `
    + `invalid OAuth account selection storage for provider "${cause.providerId}": ${cause.detail}. `
    + registryRepairGuidance(path),
    { cause },
  );
}

function selectedAccountFilesystemError(
  path: string,
  cause: unknown,
  action: string,
): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    'Could not safely persist the selected OAuth account before launch. '
    + `Could not ${action} the provider registry at ${path}: ${detail} `
    + 'Check filesystem permissions, storage health, and free disk space, then retry.',
    { cause },
  );
}

function hasMaterializedActiveAccount(registry: ProviderRegistry): boolean {
  return registry.schemaVersion === REGISTRY_SCHEMA_VERSION_WITH_MATERIALIZED_ACTIVE_ACCOUNT
    && registry.providers.some(provider => provider.defaultAuthRef !== undefined);
}

export function loadRegistry(path = getProvidersPath()): ProviderRegistry {
  if (!existsSync(path)) {
    return { schemaVersion: REGISTRY_SCHEMA_VERSION, providers: [] };
  }
  let registry: ProviderRegistry;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    registry = parseRegistry(raw);
  } catch (error) {
    if (error instanceof RegistrySelectionStorageError) {
      throw selectionStorageDiagnostic(path, error);
    }
    return { schemaVersion: REGISTRY_SCHEMA_VERSION, providers: [] };
  }

  const migration = migrateRegistry(registry);
  // Reads retain their historical leniency and acquire no directory durability
  // contract. A migration publication below still performs the write-side
  // fsync barrier through saveRegistry.
  if (!migration.changed) return registry;

  let winner = registry;
  let materializedActiveAccount = migration.materializedActiveAccount;
  try {
    withRegistryWriteLockSync(() => {
      if (!existsSync(path)) {
        if (materializedActiveAccount) {
          throw new Error('the provider registry disappeared during migration');
        }
        return;
      }
      // The lock may have been contended. Re-read and migrate the winner rather
      // than publishing or returning the stale pre-lock snapshot.
      let serialized: string;
      try {
        serialized = readFileSync(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error('the provider registry disappeared during migration', { cause: error });
        }
        throw new RegistryMigrationReadError(path, error);
      }
      let raw: unknown;
      try {
        raw = JSON.parse(serialized);
      } catch (error) {
        throw new RegistryMigrationValidationError(path, error);
      }
      // Classify the winner's identity requirement before strict validation.
      // A malformed sibling can make the strict parse throw, but it must not
      // hide a valid selected provider whose downgrade-visible projection
      // would otherwise remain in memory only.
      const lenientCurrent = parseRegistry(raw);
      const lenientMigration = migrateRegistry(lenientCurrent);
      winner = lenientCurrent;
      materializedActiveAccount = lenientMigration.materializedActiveAccount
        || hasMaterializedActiveAccount(lenientCurrent);

      let current: ProviderRegistry;
      try {
        current = parseRegistryStrict(raw);
      } catch (error) {
        throw new RegistryMigrationValidationError(path, error);
      }
      const currentMigration = migrateRegistry(current);
      winner = current;
      // The winner under the lock, not the stale pre-lock snapshot, decides
      // whether a failed write could split launch identity across processes.
      materializedActiveAccount = currentMigration.materializedActiveAccount
        || hasMaterializedActiveAccount(current);
      if (currentMigration.changed) {
        try {
          saveRegistry(current, path);
        } catch (error) {
          // A refused selection-storage publication is the same corruption the
          // parser reports, so it takes the same per-provider diagnostic rather
          // than a second, vaguer wrapper around it.
          if (error instanceof RegistrySelectionStorageSaveError) {
            throw new RegistrySelectionStorageError(
              error.providerId,
              error.detail,
              { cause: error },
            );
          }
          if (error instanceof RegistrySaveValidationError) {
            throw new RegistryMigrationValidationError(path, error);
          }
          throw error;
        }
      } else {
        // Another process may have renamed this already-migrated winner but
        // failed its parent-directory fsync before we acquired the lock. The
        // authoritative reread must repair that barrier too, not only the
        // optimistic no-migration read above.
        try {
          syncParentDirectory(path);
        } catch (error) {
          throw new RegistryDurabilityCheckError(path, error);
        }
      }
    }, { lockPath: `${path}.lock` });
    return winner;
  } catch (error) {
    if (error instanceof RegistrySelectionStorageError) {
      throw selectionStorageDiagnostic(path, error);
    }
    if (error instanceof RegistryDurabilityCheckError) {
      if (materializedActiveAccount) {
        throw selectedAccountFilesystemError(
          error.registryPath,
          error,
          'durably sync',
        );
      }
      throw new Error(
        `Could not durably sync the provider registry at ${error.registryPath}: ${error.message} `
        + 'Check filesystem permissions, storage health, and free disk space, then retry.',
        { cause: error },
      );
    }
    if (materializedActiveAccount) {
      if (error instanceof RegistryMigrationValidationError) {
        throw new Error(
          'Could not safely persist the selected OAuth account before launch. '
          + `The provider registry at ${error.registryPath} is invalid: ${error.message} `
          + registryRepairGuidance(error.registryPath),
          { cause: error },
        );
      }
      if (error instanceof RegistryMigrationReadError) {
        throw selectedAccountFilesystemError(
          error.registryPath,
          error,
          'read',
        );
      }
      if (error instanceof RegistryPersistenceError) {
        throw selectedAccountFilesystemError(
          error.registryPath,
          error,
          'durably write',
        );
      }
      if (error && typeof error === 'object'
        && typeof (error as NodeJS.ErrnoException).code === 'string') {
        // Lock timeout/lost-lease errors are intentionally untyped and retain
        // the process-contention guidance below. Raw errno failures from lock
        // directory/file I/O need filesystem recovery instead.
        throw selectedAccountFilesystemError(path, error, 'access the lock for');
      }
      const detail = error instanceof Error ? ` ${error.message}` : '';
      throw new Error(
        'Could not safely persist the selected OAuth account before launch.'
        + `${detail} Stop other Clodex processes and retry.`,
        { cause: error },
      );
    }
    // The historical provider-id rename is presentation-only and remains a
    // best-effort migration. Identity materialization above is not.
    return winner;
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
  migrateRegistry(registry);
  return registry;
}

function registrySchemaVersion(registry: ProviderRegistry): number {
  const hasMaterializedSelector = registry.providers.some(
    provider => provider.defaultAuthRef !== undefined,
  );
  const hasAccountModelCaches = registry.providers.some(provider => (
    Object.values(provider.authAccounts ?? {}).some(account => account.modelsCache !== undefined)
  ));
  const hasSelector = registry.providers.some(provider => provider.activeAuthAccount !== undefined);
  const hasSlots = registry.providers.some(
    provider => provider.authAccounts && Object.keys(provider.authAccounts).length > 0,
  );
  return hasMaterializedSelector
    ? REGISTRY_SCHEMA_VERSION_WITH_MATERIALIZED_ACTIVE_ACCOUNT
    : hasAccountModelCaches
      ? REGISTRY_SCHEMA_VERSION_WITH_ACCOUNT_MODEL_CACHES
      : hasSelector
        ? REGISTRY_SCHEMA_VERSION_WITH_ACTIVE_ACCOUNT
        : hasSlots
          ? REGISTRY_SCHEMA_VERSION_WITH_ACCOUNT_SLOTS
          : REGISTRY_SCHEMA_VERSION;
}

export function saveRegistry(registry: ProviderRegistry, path = getProvidersPath()): void {
  assertRegistryWriteOwnership(path);
  // A selector attached to a pre-selector schema has no defined storage
  // provenance, so the writer cannot know whether authRef is the default or a
  // selected slot. V3/v4 inputs do define authRef as the default and remain
  // safe migration/repair sources, including when the selected slot is missing.
  const unmaterializedSelector = registry.schemaVersion < REGISTRY_SCHEMA_VERSION_WITH_ACTIVE_ACCOUNT
    ? registry.providers.find(provider => provider.activeAuthAccount !== undefined
      && provider.defaultAuthRef === undefined)
    : undefined;
  if (unmaterializedSelector) {
    throw new RegistrySelectionStorageSaveError(
      path,
      unmaterializedSelector.id,
      SELECTOR_BEFORE_SELECTOR_SCHEMA,
    );
  }
  // Programmatic callers and strict legacy loads may hand this function a
  // v3/v4 selector. Upgrade it under the same write lock when its selected slot
  // exists. A missing slot remains unchanged and persists behind its legacy
  // schema fence so unrelated mutations do not destroy the repair path.
  if (registry.schemaVersion >= REGISTRY_SCHEMA_VERSION_WITH_ACTIVE_ACCOUNT
    && registry.schemaVersion <= REGISTRY_SCHEMA_VERSION_WITH_ACCOUNT_MODEL_CACHES) {
    migrateActiveOAuthAccountStorage(registry);
  }
  // Slot state fences older writers via the schema version (see types.ts);
  // slot-free registries return to v1 so old builds interoperate again.
  // Highest state present wins. Version 3 fences a repairable legacy selector;
  // version 5 also projects a valid selection into `authRef`, which older
  // lenient launchers already read.
  const schemaVersion = registrySchemaVersion(registry);
  for (const provider of registry.providers) {
    const selectionError = selectionStorageError(provider, schemaVersion);
    if (selectionError) {
      throw new RegistrySelectionStorageSaveError(path, provider.id, selectionError);
    }
  }
  const serializedRegistry = { ...registry, schemaVersion };
  // Validate the exact JSON shape about to be published. This catches values
  // omitted by JSON.stringify (for example an accidentally undefined authRef)
  // instead of letting the next load discover the provider has disappeared.
  try {
    parseRegistryStrict(JSON.parse(JSON.stringify(serializedRegistry)));
  } catch (error) {
    throw new RegistrySaveValidationError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  const payload = `${JSON.stringify(serializedRegistry, null, 2)}\n`;
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
  } catch (error) {
    if (error instanceof RegistryLockLostError) throw error;
    throw new RegistryPersistenceError(path, error);
  } finally {
    try {
      unlinkSync(tmp);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new RegistryPersistenceError(path, err);
      }
    }
  }
}

export function emptyRegistry(): ProviderRegistry {
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, providers: [] };
}
