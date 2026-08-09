import { resolveProviderCredential } from './env.js';
import type { CompatibilityAgent } from './model-compatibility.js';
import { oauthAuthRef } from './registry/import-build.js';
import { loadRegistry } from './registry/io.js';
import { loadRegistryProviders } from './registry/load.js';
import { isAnonymousProvider, OAUTH_ACCOUNT_ENV } from './registry/materialize.js';
import { getTemplateById } from './provider-templates.js';
import type { LocalProvider } from './types.js';
import type { ServerModelInfo } from './server/models.js';

export async function fetchProviderCatalog(
  opts?: { agent?: CompatibilityAgent },
): Promise<LocalProvider[]> {
  return loadRegistryProviders(undefined, opts);
}

export function providersForPicker(providers: LocalProvider[]): LocalProvider[] {
  for (const p of providers) {
    p.models.sort((a, b) => {
      const nameA = a.name || a.id;
      const nameB = b.name || b.id;
      return nameA.localeCompare(nameB, undefined, { sensitivity: 'base', numeric: true });
    });
  }

  return providers.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
}

/** Resolve API key when provider.apiKey is empty (registry authRef or OAuth credential store). */
export async function resolveLocalProviderApiKey(provider: LocalProvider): Promise<string | null> {
  if (provider.authRef === 'none:anonymous' || provider.authType === 'none') return '';

  const direct = provider.apiKey?.trim();
  if (direct) return direct;

  const template = getTemplateById(provider.id);
  if (template?.apiKeyOptional || template?.anonymousFreeModels) {
    return '';
  }

  const reg = loadRegistry().providers.find(p => p.id === provider.id);
  const authRef = provider.authRef ?? reg?.authRef ?? oauthAuthRef(provider.id);
  return resolveProviderCredential(provider.id, authRef);
}

/** Human-readable auth line for `providers list` and provider detail. */
export function formatRegistryAuthLabel(
  provider: Pick<import('./registry/types.js').RegistryProvider, 'authRef' | 'authType'>,
): string {
  if (provider.authType === 'oauth' || provider.authRef.includes('oauth:provider:')) {
    return provider.authRef.startsWith('helper:') ? 'helper (OAuth)' : 'keychain (OAuth)';
  }
  if (isAnonymousProvider(provider)) return 'anonymous';
  if (provider.authType === 'none') {
    return 'gcloud / manual credentials';
  }
  if (provider.authRef.startsWith('keyring:')) {
    return 'keychain (API key)';
  }
  if (provider.authRef.startsWith('helper:')) {
    return 'helper (API key)';
  }
  if (provider.authRef.startsWith('env:')) {
    return provider.authRef;
  }
  return provider.authRef;
}

/** Row for providers list / hub. */
export interface ProviderDisplayEntry {
  id: string;
  name: string;
  modelCount: number;
  enabled: boolean;
  authLabel: string;
  inRegistry: boolean;
}

/**
 * How the provider's own credential is named wherever accounts are listed.
 *
 * Deliberately not "default": OAUTH_ACCOUNT_NAME_RE accepts `default` as a
 * real slot name, so any label a user could also type would be ambiguous with
 * a slot they created. The parenthesised form cannot collide.
 */
export const PROVIDER_DEFAULT_ACCOUNT_LABEL = '(provider default)';

/**
 * The account a launch will ACTUALLY use, and whether the environment chose it.
 *
 * One home for the precedence, because the two surfaces that report it drifted
 * apart the moment they each computed it: the list view was corrected to
 * respect CLODEX_OAUTH_ACCOUNT while the interactive detail hint went on
 * naming the stored selection, so the same screen contradicted itself about
 * the live identity. Mirrors `applySelectedOAuthAccount`: the environment wins,
 * but only for an enabled OAuth provider whose slot actually exists — a
 * variable naming a missing slot makes the launch throw rather than select
 * anything, so reporting it as active here would be a second lie.
 */
export function resolveActiveAccount(
  provider: Pick<
    import('./registry/types.js').RegistryProvider,
    'authAccounts' | 'activeAuthAccount' | 'authType' | 'enabled'
  >,
  env: NodeJS.ProcessEnv = process.env,
): { name: string | undefined; fromEnvironment: boolean } {
  const override = env[OAUTH_ACCOUNT_ENV]?.trim();
  const applies = Boolean(override)
    && provider.authType === 'oauth'
    && provider.enabled
    && Object.prototype.hasOwnProperty.call(provider.authAccounts ?? {}, override!);
  if (applies) return { name: override!, fromEnvironment: true };
  return { name: provider.activeAuthAccount, fromEnvironment: false };
}

export async function resolveProvidersForDisplay(): Promise<ProviderDisplayEntry[]> {
  const reg = loadRegistry();
  const entries: ProviderDisplayEntry[] = [];

  for (const provider of reg.providers) {
    const accountNames = Object.keys(provider.authAccounts ?? {}).sort();
    // Which identity a launch actually uses is the point of listing the slots
    // at all, so it is marked inline rather than left to be inferred from a
    // variable the operator has to remember setting.
    //
    // The provider's own credential is labelled "(provider default)", never
    // "default": `default` is a VALID slot name, so reusing it would render
    // two identical entries and mark both active, leaving the listing unable
    // to say which credential launches — the one question it exists to answer.
    //
    // The environment wins over the stored selection at launch, so it wins
    // here too; showing the stored one while a variable overrides it would
    // misreport the live identity in exactly the persistent shell this feature
    // is meant to make visible.
    const { name: active, fromEnvironment: overrideApplies } = resolveActiveAccount(provider);
    const label = (name: string, isActive: boolean): string => {
      if (!isActive) return name;
      return overrideApplies
        ? `${name} (active, from ${OAUTH_ACCOUNT_ENV})`
        : `${name} (active)`;
    };
    const accountList = [
      label(PROVIDER_DEFAULT_ACCOUNT_LABEL, active === undefined),
      ...accountNames.map(name => label(name, name === active)),
    ].join(', ');
    const authLabel = accountNames.length
      ? `${formatRegistryAuthLabel(provider)}; accounts: ${accountList}`
      : formatRegistryAuthLabel(provider);
    entries.push({
      id: provider.id,
      name: provider.name,
      modelCount: provider.modelsCache?.models.length ?? 0,
      enabled: provider.enabled,
      authLabel,
      inRegistry: true,
    });
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function localProvidersToServerModels(localProviders: LocalProvider[]): ServerModelInfo[] {
  return localProviders.flatMap(provider =>
    provider.models.map(model => ({
      id: model.id,
      name: model.name,
      isFree: model.isFree ?? false,
      freeStatus: model.freeStatus,
      brand: model.brand,
      providerLabel: provider.name,
      providerId: provider.id,
      sourceBackend: provider.id,
      modelFormat: model.modelFormat,
      upstreamModelId: model.upstreamModelId,
      cost: model.cost,
      baseUrl: model.baseUrl,
      completionsUrl: model.completionsUrl,
      npm: model.modelFormat === 'openai' ? (model.npm || '@ai-sdk/openai-compatible') : model.npm,
      apiBaseUrl: model.apiBaseUrl,
      apiKey: provider.apiKey,
      authRef: provider.authRef,
      authType: provider.authType,
      oauthAccountId: provider.oauthAccountId,
      contextWindow: model.contextWindow,
      supportedParameters: model.supportedParameters,
      reasoning: model.reasoning,
      interleavedReasoningField: model.interleavedReasoningField,
      useResponsesLite: model.useResponsesLite,
      preferWebSockets: model.preferWebSockets,
      compatibility: model.compatibility,
      headers: provider.headers,
      providerData: provider.providerData,
    }))
  );
}
