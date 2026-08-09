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
 * What a launch will ACTUALLY do with this provider's account selection.
 *
 * One home for the precedence, because the two surfaces that report it drifted
 * apart the moment they each computed it. It mirrors
 * `applySelectedOAuthAccount`, including its failure: a selector naming a slot
 * that does not exist makes the launch THROW, so `broken` is a real outcome
 * and not an edge case to paper over. Reporting such a selection as "active"
 * promises a launch that will not happen — which is how the detail hint came
 * to claim a missing account was in use.
 */
export type ActiveAccount =
  /** Launches on the provider's own credential. */
  | { kind: 'default'; latentOrphan?: string }
  /** Launches on this named slot. */
  | { kind: 'slot'; name: string; fromEnvironment: boolean; latentOrphan?: string }
  /** Launches on nothing: this selector names no such slot. */
  | { kind: 'broken'; name: string; fromEnvironment: boolean; latentOrphan?: string };

/**
 * `latentOrphan` — a STORED selection that names no slot while something else
 * is currently winning, so it is not breaking anything yet.
 *
 * It has to be reported anyway. An environment override masks it for exactly
 * as long as the variable is set: unset it, or open a shell without it, and
 * every launch starts failing on a selection the listing had been calling
 * healthy the whole time.
 */

export function resolveActiveAccount(
  provider: Pick<
    import('./registry/types.js').RegistryProvider,
    'authAccounts' | 'activeAuthAccount' | 'authType' | 'enabled'
  >,
  env: NodeJS.ProcessEnv = process.env,
): ActiveAccount {
  const slots = provider.authAccounts ?? {};
  const has = (name: string) => Object.prototype.hasOwnProperty.call(slots, name);
  const stored = provider.activeAuthAccount?.trim();
  const override = env[OAUTH_ACCOUNT_ENV]?.trim();

  // A provider that cannot participate in a launch still gets its selection
  // CHECKED. `applySelectedOAuthAccount` returns such a provider untouched
  // rather than throwing — deliberately, so a stale selector cannot take down a
  // catalog load — but "does not throw yet" is not "is fine": the selection is
  // equally unhonourable, and hiding that means the listing looks healthy right
  // up until the provider is enabled and every launch starts failing.
  //
  // So `broken` means "this selection names no such slot", not "this throws
  // right now". The safety property is one-directional: anything that WOULD
  // throw is reported broken; not everything reported broken throws today.
  const launchable = provider.authType === 'oauth' && provider.enabled;
  if (!launchable) {
    if (!stored) return { kind: 'default' };
    return has(stored)
      ? { kind: 'slot', name: stored, fromEnvironment: false }
      : { kind: 'broken', name: stored, fromEnvironment: false };
  }

  // Carried on whatever answer wins below: a stored selection that names no
  // slot is still broken while an override happens to be masking it.
  const latentOrphan = stored && !has(stored) ? { latentOrphan: stored } : {};

  if (override) {
    if (has(override)) return { kind: 'slot', name: override, fromEnvironment: true, ...latentOrphan };
    // The environment is ignored only where there is no slot table at all;
    // otherwise it names a missing slot and the launch throws on it.
    if (Object.keys(slots).length > 0) {
      // Both can be broken at once, and fixing the variable then reveals the
      // second failure. Carried here too, or unsetting the override trades one
      // silent breakage for another.
      return { kind: 'broken', name: override, fromEnvironment: true, ...latentOrphan };
    }
  }

  if (!stored) return { kind: 'default' };
  if (has(stored)) return { kind: 'slot', name: stored, fromEnvironment: false };
  return { kind: 'broken', name: stored, fromEnvironment: false };
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
    const effective = resolveActiveAccount(provider);
    const active = effective.kind === 'slot' ? effective.name : undefined;
    const overrideApplies = effective.kind !== 'default' && effective.fromEnvironment;
    // A broken selection is the reason every launch for this provider fails,
    // so it is the LAST thing the listing should hide — and it is read from the
    // shared resolver rather than re-derived here, which is how the detail hint
    // drifted out of step in the first place.
    const broken = effective.kind === 'broken' ? effective : undefined;
    // Masked, not fixed. An override hides a broken stored selection only while
    // the variable is set; the listing has to say so, or it reads as healthy
    // right up until someone opens a shell without it.
    // Reported on a broken override too: the stored selection behind it is a
    // second, independent failure that survives fixing the variable.
    const latent = effective.latentOrphan;
    const label = (name: string, isActive: boolean): string => {
      if (!isActive) return name;
      return overrideApplies
        ? `${name} (active, from ${OAUTH_ACCOUNT_ENV})`
        : `${name} (active)`;
    };
    const accountList = [
      label(PROVIDER_DEFAULT_ACCOUNT_LABEL, effective.kind === 'default'),
      ...accountNames.map(name => label(name, name === active)),
      ...(broken
        ? [`${broken.name} (selected${broken.fromEnvironment ? ` via ${OAUTH_ACCOUNT_ENV}` : ''}, MISSING — every launch fails)`]
        : []),
      ...(latent
        ? [`${latent} (stored, MISSING — masked by ${OAUTH_ACCOUNT_ENV}; launches fail without it)`]
        : []),
    ].join(', ');
    const authLabel = accountNames.length || broken || latent
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
