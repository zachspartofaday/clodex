import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySelectedOAuthAccount } from '../src/registry/materialize.js';
import { emptyRegistry, loadRegistry, loadRegistryStrict, saveRegistry } from '../src/registry/io.js';
import { credentialIsReferenced } from '../src/registry/credential-lifecycle.js';
import { withRegistryWriteLockSync } from '../src/registry/lock.js';
import { oauthProviderIdFromAccount } from '../src/env.js';
import type { RegistryProvider } from '../src/registry/types.js';

const base: RegistryProvider = {
  id: 'openai-oauth',
  templateId: 'openai',
  name: 'OpenAI (ChatGPT)',
  enabled: true,
  authRef: 'keyring:oauth:provider:openai-oauth::credential::v1:default',
  authType: 'oauth',
  api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
  addedAt: '2026-08-07T00:00:00.000Z',
};

const withSlots: RegistryProvider = {
  ...base,
  authAccounts: {
    work: { authRef: 'keyring:oauth:provider:openai-oauth:account:work::credential::v1:w', addedAt: '2026-08-07T00:00:00.000Z', oauthAccountId: 'acct-work' },
    alt: { authRef: 'keyring:oauth:provider:openai-oauth:account:alt::credential::v1:a', addedAt: '2026-08-07T00:00:00.000Z' },
  },
};

describe('applySelectedOAuthAccount', () => {
  it('returns the provider unchanged when no account is selected', () => {
    expect(applySelectedOAuthAccount(withSlots, undefined)).toBe(withSlots);
    expect(applySelectedOAuthAccount(withSlots, '')).toBe(withSlots);
    expect(applySelectedOAuthAccount(withSlots, '   ')).toBe(withSlots);
  });

  it('swaps the authRef for the selected slot without mutating the original', () => {
    const selected = applySelectedOAuthAccount(withSlots, 'work');
    expect(selected.authRef).toBe(withSlots.authAccounts!.work!.authRef);
    expect(selected).not.toBe(withSlots);
    expect(withSlots.authRef).toBe(base.authRef);
    // Everything else is untouched, so models/aliases/partitions are stable.
    expect(selected.id).toBe(withSlots.id);
    expect(selected.authAccounts).toBe(withSlots.authAccounts);
  });

  it('ignores the selector on providers without slots', () => {
    expect(applySelectedOAuthAccount(base, 'work')).toBe(base);
  });

  it('ignores the selector on non-oauth providers', () => {
    const apiProvider: RegistryProvider = { ...withSlots, authType: 'api' };
    expect(applySelectedOAuthAccount(apiProvider, 'work')).toBe(apiProvider);
  });

  it('fails loud when a slotted provider lacks the named slot', () => {
    expect(() => applySelectedOAuthAccount(withSlots, 'personal')).toThrow(
      /has no account named "personal" \(available: alt, work\)/,
    );
  });

  it('never resolves prototype names as slots', () => {
    // JSON-parsed registries carry Object.prototype; a selector like
    // "constructor" must be a missing-slot error, not a Function-valued slot.
    const parsed = JSON.parse(JSON.stringify(withSlots)) as RegistryProvider;
    expect(() => applySelectedOAuthAccount(parsed, 'constructor')).toThrow(/has no account named "constructor"/);
  });
});

describe('the stored account selection', () => {
  const withActive: RegistryProvider = { ...withSlots, activeAuthAccount: 'alt' };

  it('launches as the stored account when nothing is passed', () => {
    // The whole point of persisting it: no environment variable to remember,
    // and forgetting one no longer silently runs the default identity.
    expect(applySelectedOAuthAccount(withActive, undefined).authRef)
      .toBe(withSlots.authAccounts!.alt!.authRef);
  });

  it('lets an explicit selector override the stored one for a single run', () => {
    expect(applySelectedOAuthAccount(withActive, 'work').authRef)
      .toBe(withSlots.authAccounts!.work!.authRef);
    // ...without disturbing the stored choice every other launch reads.
    expect(withActive.activeAuthAccount).toBe('alt');
  });

  it('still returns the provider default when neither is set', () => {
    expect(applySelectedOAuthAccount(withSlots, undefined)).toBe(withSlots);
  });

  it('points a stale stored selector at the repair path, not the add path', () => {
    // Distinct from the environment message on purpose: this account was
    // chosen deliberately and its slot is gone, so the fix is to choose
    // again — and it must never quietly fall back to the default identity.
    const stale: RegistryProvider = { ...withSlots, activeAuthAccount: 'personal' };
    expect(() => applySelectedOAuthAccount(stale, undefined)).toThrow(
      /is set to use account "personal", which no longer exists \(available: alt, work\).*clodex providers/s,
    );
    expect(() => applySelectedOAuthAccount(stale, undefined)).not.toThrow(/CLODEX_OAUTH_ACCOUNT=/);
  });

  it('ignores a stored selector on a provider that cannot launch', () => {
    const disabled: RegistryProvider = { ...withSlots, enabled: false, activeAuthAccount: 'personal' };
    expect(applySelectedOAuthAccount(disabled, undefined)).toBe(disabled);
  });

  it('fails loudly when the stored selector has no slot table left at all', () => {
    // The registry serializes selector-only state as valid, so an empty or
    // absent slot table is reachable. Returning the provider default here
    // would run every launch as the wrong identity in silence — the whole
    // failure this feature exists to prevent.
    const orphaned: RegistryProvider = { ...base, activeAuthAccount: 'varmez' };
    expect(() => applySelectedOAuthAccount(orphaned, undefined)).toThrow(
      /has no named accounts.*clodex providers/s,
    );
    const emptyTable: RegistryProvider = { ...base, authAccounts: {}, activeAuthAccount: 'varmez' };
    expect(() => applySelectedOAuthAccount(emptyTable, undefined)).toThrow(/has no named accounts/);
  });

  it('still ignores an ENVIRONMENT selector on a provider with no slots', () => {
    // Unchanged contract: the variable only ever chooses among slots, and a
    // stale one must not take down a catalog load for providers that can run.
    expect(applySelectedOAuthAccount(base, 'varmez')).toBe(base);
  });
});

describe('selection on disabled providers', () => {
  it('ignores the selector on a disabled provider instead of throwing', () => {
    // A disabled slotted provider cannot participate in the launch; a stale
    // or mistyped CLODEX_OAUTH_ACCOUNT aimed at it must not take the whole
    // catalog load down for the providers that CAN launch.
    const disabled: RegistryProvider = { ...withSlots, enabled: false };
    expect(applySelectedOAuthAccount(disabled, 'personal')).toBe(disabled);
    // Enabled slotted providers keep the fail-loud contract.
    expect(() => applySelectedOAuthAccount(withSlots, 'personal')).toThrow(/has no account named/);
  });
});

describe('authAccounts registry persistence', () => {
  let home = '';
  let path = '';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clodex-account-slots-'));
    path = join(home, 'providers.json');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function registryWith(provider: unknown): string {
    return `${JSON.stringify({ schemaVersion: 1, providers: [provider] }, null, 2)}\n`;
  }

  it('named slots survive load → save-back → load', () => {
    writeFileSync(path, registryWith(withSlots));
    const loaded = loadRegistry(path);
    expect(loaded.providers[0]!.authAccounts).toEqual(withSlots.authAccounts);

    // A model refresh saves the PARSED provider back; the slots must not be
    // shed on that write, or the next launch silently reverts to the default
    // identity and reconciliation can delete the slot credential.
    withRegistryWriteLockSync(() => saveRegistry(loaded, path), { lockPath: `${path}.lock` });
    expect(loadRegistryStrict(path).providers[0]!.authAccounts).toEqual(withSlots.authAccounts);
  });

  it('fails closed on a malformed slot instead of silently dropping it', () => {
    const malformed = {
      ...withSlots,
      authAccounts: { work: { addedAt: '2026-08-07T00:00:00.000Z' } }, // no authRef
    };
    writeFileSync(path, registryWith(malformed));
    // Lenient load rejects the whole provider record — a slot-less copy of a
    // slotted provider must never come back — and the strict load propagates.
    expect(loadRegistry(path).providers).toHaveLength(0);
    expect(() => loadRegistryStrict(path)).toThrow();
  });

  it('rejects slot names the auth flow could never have created', () => {
    const malformed = {
      ...withSlots,
      authAccounts: { 'Bad Name!': { authRef: 'keyring:x', addedAt: '2026-08-07T00:00:00.000Z' } },
    };
    writeFileSync(path, registryWith(malformed));
    expect(loadRegistry(path).providers).toHaveLength(0);
  });

  it('fences older writers: slot registries persist at schema v2, slot-free at v1', () => {
    writeFileSync(path, registryWith(withSlots));
    const loaded = loadRegistry(path);
    withRegistryWriteLockSync(() => saveRegistry(loaded, path), { lockPath: `${path}.lock` });
    // Older builds throw on an unknown schema version in every mutating path,
    // so they cannot strip the slots and save the providers back slot-less.
    expect(JSON.parse(readFileSync(path, 'utf8')).schemaVersion).toBe(2);
    expect(loadRegistryStrict(path).providers[0]!.authAccounts).toEqual(withSlots.authAccounts);

    const slotFree = { ...loaded, providers: [{ ...loaded.providers[0]!, authAccounts: undefined }] };
    delete (slotFree.providers[0] as Record<string, unknown>).authAccounts;
    withRegistryWriteLockSync(() => saveRegistry(slotFree, path), { lockPath: `${path}.lock` });
    expect(JSON.parse(readFileSync(path, 'utf8')).schemaVersion).toBe(1);

    writeFileSync(path, `${JSON.stringify({ schemaVersion: 9, providers: [] })}\n`);
    expect(() => loadRegistryStrict(path)).toThrow(/unsupported schema version/);
  });

  it('the stored selection survives load → save-back → load', () => {
    writeFileSync(path, registryWith({ ...withSlots, activeAuthAccount: 'alt' }));
    const loaded = loadRegistry(path);
    expect(loaded.providers[0]!.activeAuthAccount).toBe('alt');
    withRegistryWriteLockSync(() => saveRegistry(loaded, path), { lockPath: `${path}.lock` });
    expect(loadRegistryStrict(path).providers[0]!.activeAuthAccount).toBe('alt');
  });

  it('keeps a stale-but-well-formed selection loadable so the provider can be repaired', () => {
    // Rejecting it at load would drop the provider record entirely, so the
    // account would vanish from `clodex providers` — the one screen that can
    // fix it. It has to survive the load and fail when a launch applies it.
    writeFileSync(path, registryWith({ ...withSlots, activeAuthAccount: 'ghost' }));
    const loaded = loadRegistry(path);
    expect(loaded.providers).toHaveLength(1);
    expect(loaded.providers[0]!.activeAuthAccount).toBe('ghost');
    expect(() => applySelectedOAuthAccount(loaded.providers[0]!, undefined)).toThrow(/no longer exists/);
  });

  it('fails closed on a selection the picker could never have written', () => {
    writeFileSync(path, registryWith({ ...withSlots, activeAuthAccount: 'Bad Name!' }));
    expect(loadRegistry(path).providers).toHaveLength(0);
    expect(() => loadRegistryStrict(path)).toThrow();
  });

  it('fences a selection behind its OWN schema version, not the slot version', () => {
    // Version 2 is not a fence for this: a build from before the selector
    // existed ACCEPTS 2, parses the slots, drops the unknown
    // `activeAuthAccount`, and saves back without it — after which every
    // launch quietly reverts to the provider default. Only a version that
    // build rejects actually protects the selection.
    const registry = {
      ...emptyRegistry(),
      providers: [{ ...withSlots, activeAuthAccount: 'alt' } as RegistryProvider],
    };
    withRegistryWriteLockSync(() => saveRegistry(registry, path), { lockPath: `${path}.lock` });
    expect(JSON.parse(readFileSync(path, 'utf8')).schemaVersion).toBe(3);
    expect(loadRegistryStrict(path).providers[0]!.activeAuthAccount).toBe('alt');

    // Clearing the selection returns to the slot version, so older builds
    // interoperate again the moment no selector state exists.
    const cleared = { ...emptyRegistry(), providers: [structuredClone(withSlots)] };
    withRegistryWriteLockSync(() => saveRegistry(cleared, path), { lockPath: `${path}.lock` });
    expect(JSON.parse(readFileSync(path, 'utf8')).schemaVersion).toBe(2);
  });

  it('rejects a schema version newer than this build understands', () => {
    writeFileSync(path, `${JSON.stringify({ schemaVersion: 4, providers: [] })}\n`);
    expect(() => loadRegistryStrict(path)).toThrow(/unsupported schema version/);
  });

  it('slot credentials count as live references for reconciliation', () => {
    const registry = { ...emptyRegistry(), providers: [structuredClone(withSlots)] };
    expect(credentialIsReferenced(registry, withSlots.authAccounts!.work!.authRef)).toBe(true);
    expect(credentialIsReferenced(registry, withSlots.authAccounts!.alt!.authRef)).toBe(true);
    expect(credentialIsReferenced(registry, base.authRef)).toBe(true);
    expect(credentialIsReferenced(registry, 'keyring:oauth:provider:openai-oauth:account:gone::credential::v1:x')).toBe(false);
  });
});

describe('oauthProviderIdFromAccount', () => {
  it('collapses a named slot to the base provider id used by token refresh', () => {
    // refreshStoredOAuthCredential supports exact provider ids only; a slot
    // suffix leaking through meant named accounts failed with "OAuth refresh
    // not implemented" the first time their access token expired.
    expect(oauthProviderIdFromAccount('oauth:provider:openai-oauth:account:work::credential::v1:w')).toBe('openai-oauth');
    expect(oauthProviderIdFromAccount('oauth:provider:openai-oauth:account:work')).toBe('openai-oauth');
    expect(oauthProviderIdFromAccount('oauth:provider:openai-oauth')).toBe('openai-oauth');
    expect(oauthProviderIdFromAccount('provider:openai')).toBeNull();
  });
});
