// src/registry/refresh-credentials.ts — keys for refresh-models (OpenCode placeholders, env fallbacks)

import { applySelectedOAuthAccount, isAnonymousProvider } from './materialize.js';
import { OAUTH_ACCOUNT_ENV } from '../oauth-account-selection.js';
import type { RegistryProvider } from './types.js';

export interface RefreshCredentialSnapshot {
  /** Provider generation and routing fields that this credential was resolved for. */
  provider: {
    id: string;
    addedAt: string;
    enabled: boolean;
    authType?: RegistryProvider['authType'];
    templateId: string;
    api: RegistryProvider['api'];
  };
  /** Effective credential reference used for this discovery request. */
  authRef: string;
  /** Stored selection at the moment credential resolution began. */
  activeAuthAccount?: string;
  /** Per-process override applied to this discovery request. */
  environmentAccount?: string;
  /** Winning named slot, including its generation even when authRef is stable. */
  selectedAccount?: {
    name: string;
    authRef: string;
    addedAt: string;
    oauthAccountId?: string;
  };
}

function providerForRefresh(
  provider: RegistryProvider,
  selected: string | undefined,
): RegistryProvider {
  // Disabled providers are excluded from launch materialization, but an
  // explicit refresh is still offered for them. Project the identity they
  // will use when enabled so their cache cannot be populated from a different
  // account in advance. Missing stored/environment slots fail closed here.
  const selectionCandidate = provider.authType === 'oauth' && !provider.enabled
    ? { ...provider, enabled: true }
    : provider;
  // Pass an explicit empty selector when the captured environment had none;
  // `undefined` would trigger applySelectedOAuthAccount's process.env default
  // and could silently adopt a variable that changed after the snapshot.
  const effective = applySelectedOAuthAccount(selectionCandidate, selected ?? '');
  return provider.enabled ? effective : { ...effective, enabled: false };
}

export function refreshCredentialSnapshot(
  provider: RegistryProvider,
  selected: string | null | undefined = process.env[OAUTH_ACCOUNT_ENV],
): RefreshCredentialSnapshot {
  const environmentAccount = selected === null ? undefined : selected?.trim() || undefined;
  const effective = providerForRefresh(provider, environmentAccount);
  const activeAuthAccount = provider.activeAuthAccount?.trim() || undefined;
  const selectedName = environmentAccount || activeAuthAccount;
  const selectedAccount = provider.authType === 'oauth' && selectedName
    ? provider.authAccounts?.[selectedName]
    : undefined;
  return {
    provider: {
      id: provider.id,
      addedAt: provider.addedAt,
      enabled: provider.enabled,
      authType: provider.authType,
      templateId: provider.templateId,
      api: {
        ...provider.api,
        ...(provider.api.headers ? { headers: { ...provider.api.headers } } : {}),
      },
    },
    authRef: effective.authRef,
    ...(activeAuthAccount ? { activeAuthAccount } : {}),
    ...(environmentAccount ? { environmentAccount } : {}),
    ...(selectedName && selectedAccount
      ? {
          selectedAccount: {
            name: selectedName,
            authRef: selectedAccount.authRef,
            addedAt: selectedAccount.addedAt,
            ...(selectedAccount.oauthAccountId
              ? { oauthAccountId: selectedAccount.oauthAccountId }
              : {}),
          },
        }
      : {}),
  };
}

/** OpenCode uses these when OAuth/env supplies the real credential at runtime. */
const PLACEHOLDER_KEYS = new Set([
  'anything',
  'local',
  'ollama',
  'none',
  'n/a',
  'na',
  'placeholder',
  'test',
  'no-key',
]);

const ENV_FALLBACK_BY_PROVIDER: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
};

export function isPlaceholderProviderKey(key: string | null | undefined): boolean {
  if (!key?.trim()) return true;
  return PLACEHOLDER_KEYS.has(key.trim().toLowerCase());
}

export function isLikelyPlaceholderKey(key: string | null | undefined): boolean {
  if (isPlaceholderProviderKey(key)) return true;
  const trimmed = key?.trim() ?? '';
  if (trimmed.length <= 2) return true;
  return false;
}

export function cachedModelCount(provider: RegistryProvider): number {
  return provider.modelsCache?.models.length ?? 0;
}

export function skipWithCachedModels(
  provider: RegistryProvider,
  reason: string,
): { id: string; name: string; ok: true; skipped: true; modelCount?: number; reason: string } {
  const count = cachedModelCount(provider);
  return {
    id: provider.id,
    name: provider.name,
    ok: true,
    skipped: true,
    modelCount: count > 0 ? count : undefined,
    reason,
  };
}

export async function resolveRefreshCredential(
  provider: RegistryProvider,
  resolveKey: (provider: RegistryProvider) => Promise<string | null>,
  selected: string | null | undefined = process.env[OAUTH_ACCOUNT_ENV],
): Promise<string | null> {
  // Model entitlements are account-specific. Resolve exactly the provider
  // identity a launch in this process would use, never the registry's default
  // authRef merely because it is the field persisted at the top level.
  const effectiveProvider = providerForRefresh(provider, selected ?? undefined);
  if (isAnonymousProvider(effectiveProvider)) return null;

  // OAuth token refresh (e.g. an expired/revoked refresh token returning 401) throws
  // rather than resolving to null. Treat that the same as "no key" so callers fall
  // through to refreshProviderModels' existing friendly "sign in again" messaging
  // instead of crashing the whole refresh with an unhandled exception.
  let key: string | null;
  try {
    key = await resolveKey(effectiveProvider);
  } catch {
    key = null;
  }
  if (!isLikelyPlaceholderKey(key)) return key;

  for (const envVar of ENV_FALLBACK_BY_PROVIDER[effectiveProvider.id] ?? []) {
    const fromEnv = process.env[envVar]?.trim();
    if (fromEnv && !isLikelyPlaceholderKey(fromEnv)) return fromEnv;
  }
  return key;
}
