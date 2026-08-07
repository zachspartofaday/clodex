import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySelectedOAuthAccount } from '../src/registry/materialize.js';
import { emptyRegistry, loadRegistry, loadRegistryStrict, saveRegistry } from '../src/registry/io.js';
import { credentialIsReferenced } from '../src/registry/credential-lifecycle.js';
import { withRegistryWriteLockSync } from '../src/registry/lock.js';
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

  it('slot credentials count as live references for reconciliation', () => {
    const registry = { ...emptyRegistry(), providers: [structuredClone(withSlots)] };
    expect(credentialIsReferenced(registry, withSlots.authAccounts!.work!.authRef)).toBe(true);
    expect(credentialIsReferenced(registry, withSlots.authAccounts!.alt!.authRef)).toBe(true);
    expect(credentialIsReferenced(registry, base.authRef)).toBe(true);
    expect(credentialIsReferenced(registry, 'keyring:oauth:provider:openai-oauth:account:gone::credential::v1:x')).toBe(false);
  });
});
