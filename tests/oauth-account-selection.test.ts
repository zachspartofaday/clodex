import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySelectedOAuthAccount } from '../src/registry/materialize.js';
import { accountSwitchHint, accountSwitchOutcome, shouldOfferAccountSwitch } from '../src/providers-command.js';
import { resolveActiveAccount } from '../src/provider-catalog.js';
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

  it('an environment selector cannot mask an orphaned stored selection', () => {
    // Gating the orphan check on which selector WON conflated two things:
    // exporting the variable for any provider made every orphaned stored
    // selection resolve silently to the provider default — the exact
    // substitution the check exists to refuse. The environment cannot rescue a
    // broken stored selection anyway, since with no slot table it has nothing
    // to select either.
    const orphaned: RegistryProvider = { ...base, activeAuthAccount: 'varmez' };
    expect(() => applySelectedOAuthAccount(orphaned, 'anything')).toThrow(/has no named accounts/);
    // ...and the message names the STORED account, not whatever the variable said.
    expect(() => applySelectedOAuthAccount(orphaned, 'anything')).toThrow(/"varmez"/);
    expect(() => applySelectedOAuthAccount(orphaned, 'anything')).not.toThrow(/"anything"/);
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

  it('fences MUTATION but not older launches, which no version number can', () => {
    // The honest boundary. parseRegistryStrict throws on v3, so a pre-selector
    // build cannot load-and-save the selector away. Its LENIENT loader never
    // reads schemaVersion at all, so it still launches as the provider default
    // — and that loader has already shipped, so no version can change it.
    // Pinned so the limitation is a stated contract rather than a surprise.
    writeFileSync(path, registryWith({ ...withSlots, activeAuthAccount: 'alt' })
      .replace('"schemaVersion": 1', '"schemaVersion": 3'));
    expect(loadRegistry(path).providers[0]!.activeAuthAccount).toBe('alt');
    // A build that does not know v3 rejects it in every mutating path.
    writeFileSync(path, `${JSON.stringify({ schemaVersion: 99, providers: [] })}\n`);
    expect(() => loadRegistryStrict(path)).toThrow(/unsupported schema version/);
    // ...while the lenient path shrugs, which is exactly the gap.
    expect(loadRegistry(path).providers).toEqual([]);
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

describe('shouldOfferAccountSwitch', () => {
  it('offers the switch when slots exist', () => {
    expect(shouldOfferAccountSwitch({ authAccounts: { varmez: { authRef: 'k', addedAt: 'x' } } })).toBe(true);
  });

  it('offers the switch for an ORPHANED selector, so the advertised repair is reachable', () => {
    // Launch now throws for this state and tells the user to fix it with
    // `clodex providers`. Gating the action on slots would hide that repair and
    // leave re-authenticating or hand-editing the registry as the only ways out.
    expect(shouldOfferAccountSwitch({ activeAuthAccount: 'varmez' })).toBe(true);
    expect(shouldOfferAccountSwitch({ authAccounts: {}, activeAuthAccount: 'varmez' })).toBe(true);
  });

  it('stays hidden for a provider with neither', () => {
    expect(shouldOfferAccountSwitch({})).toBe(false);
    expect(shouldOfferAccountSwitch({ authAccounts: {} })).toBe(false);
  });
});

describe('resolveActiveAccount', () => {
  const oauth = { ...withSlots, activeAuthAccount: 'alt' } as RegistryProvider;

  it('reports the stored selection when nothing overrides it', () => {
    expect(resolveActiveAccount(oauth, {})).toEqual({ kind: 'slot', name: 'alt', fromEnvironment: false });
  });

  it('reports the environment override, which is what a launch will use', () => {
    expect(resolveActiveAccount(oauth, { CLODEX_OAUTH_ACCOUNT: 'work' }))
      .toEqual({ kind: 'slot', name: 'work', fromEnvironment: true });
  });

  it('reports BROKEN for a selector the launch will throw on', () => {
    // The state the previous shape could not express. Returning a plain name
    // here promised a launch that does not happen: the detail hint read it as
    // "every launch uses ghost" while applySelectedOAuthAccount threw.
    expect(resolveActiveAccount({ ...withSlots, activeAuthAccount: 'ghost' }, {}))
      .toEqual({ kind: 'broken', name: 'ghost', fromEnvironment: false });
    expect(resolveActiveAccount(oauth, { CLODEX_OAUTH_ACCOUNT: 'ghost' }))
      .toEqual({ kind: 'broken', name: 'ghost', fromEnvironment: true });
  });

  it('never calls a selection fine when a launch would throw on it', () => {
    // One-directional on purpose. `applySelectedOAuthAccount` deliberately does
    // NOT throw for a provider that cannot launch — a stale selector must not
    // take down a catalog load — but such a selection is equally unhonourable,
    // and calling it fine means the listing looks healthy right up until the
    // provider is enabled. So: anything that would throw is reported broken;
    // not everything reported broken throws today.
    const cases: Array<[string, RegistryProvider, NodeJS.ProcessEnv]> = [
      ['healthy stored', oauth, {}],
      ['healthy env', oauth, { CLODEX_OAUTH_ACCOUNT: 'work' }],
      ['orphaned stored, slots remain', { ...withSlots, activeAuthAccount: 'ghost' }, {}],
      ['env names a missing slot', oauth, { CLODEX_OAUTH_ACCOUNT: 'ghost' }],
      ['orphaned stored, no slots', { ...base, activeAuthAccount: 'ghost' }, {}],
      ['no selection at all', withSlots, {}],
      ['env on a provider with no slots', base, { CLODEX_OAUTH_ACCOUNT: 'work' }],
      ['disabled provider, orphaned', { ...withSlots, enabled: false, activeAuthAccount: 'ghost' }, {}],
      ['non-oauth provider, orphaned', { ...withSlots, authType: 'api', activeAuthAccount: 'ghost' }, {}],
    ];
    for (const [label, provider, env] of cases) {
      const shown = resolveActiveAccount(provider, env);
      let launchThrew = false;
      try {
        applySelectedOAuthAccount(provider, env.CLODEX_OAUTH_ACCOUNT);
      } catch {
        launchThrew = true;
      }
      if (launchThrew) {
        expect(shown.kind, `${label}: launch throws, so the display must say broken`).toBe('broken');
      }
    }
  });

  it('reports a latent orphan on a provider that cannot launch yet', () => {
    // The gap this closes: the early return for a disabled or non-OAuth
    // provider handed back `{ kind: 'slot' }` without checking membership, so
    // an orphaned selection was invisible until someone enabled the provider
    // and every launch began failing.
    for (const provider of [
      { ...withSlots, enabled: false, activeAuthAccount: 'ghost' },
      { ...withSlots, authType: 'api' as const, activeAuthAccount: 'ghost' },
    ]) {
      expect(resolveActiveAccount(provider as RegistryProvider, {}))
        .toEqual({ kind: 'broken', name: 'ghost', fromEnvironment: false, dormant: true });
      // ...and it still does not throw, which is why the property above is
      // one-directional rather than an iff.
      expect(() => applySelectedOAuthAccount(provider as RegistryProvider, undefined)).not.toThrow();
    }
    // A healthy selection on a disabled provider is still just a slot.
    expect(resolveActiveAccount({ ...withSlots, enabled: false, activeAuthAccount: 'work' } as RegistryProvider, {}))
      .toEqual({ kind: 'slot', name: 'work', fromEnvironment: false, dormant: true });
  });

  it('keeps a stored orphan visible when an override is masking it', () => {
    // The override hides the breakage only while the variable is set. Reporting
    // just the live answer made the listing and the hint read healthy right up
    // until someone opened a shell without it, at which point every launch
    // failed on a selection nothing had ever mentioned.
    const masked = { ...withSlots, activeAuthAccount: 'ghost' } as RegistryProvider;
    expect(resolveActiveAccount(masked, { CLODEX_OAUTH_ACCOUNT: 'work' }))
      .toEqual({ kind: 'slot', name: 'work', fromEnvironment: true, latentOrphan: 'ghost' });
    // Unset the variable and the same registry is openly broken.
    expect(resolveActiveAccount(masked, {}))
      .toEqual({ kind: 'broken', name: 'ghost', fromEnvironment: false });
  });

  it('keeps BOTH failures visible when the override is broken too', () => {
    // Two independent breakages at once. Reporting only the override meant
    // unsetting the variable traded one unexplained failure for another —
    // the stored selection behind it was never mentioned.
    const both = { ...withSlots, activeAuthAccount: 'ghost' } as RegistryProvider;
    expect(resolveActiveAccount(both, { CLODEX_OAUTH_ACCOUNT: 'phantom' }))
      .toEqual({ kind: 'broken', name: 'phantom', fromEnvironment: true, latentOrphan: 'ghost' });
    // The hint says both, so fixing the variable is not a surprise halfway.
    expect(accountSwitchHint(
      { activeAuthAccount: 'ghost' },
      { kind: 'broken', name: 'phantom', fromEnvironment: true, latentOrphan: 'ghost' },
    )).toContain('stored "ghost" is missing too');
  });

  it('does not duplicate the name when only the stored selection is broken', () => {
    // The broken name IS the stored one here; repeating it as a latent orphan
    // would report one failure as two.
    expect(resolveActiveAccount({ ...withSlots, activeAuthAccount: 'ghost' } as RegistryProvider, {}))
      .toEqual({ kind: 'broken', name: 'ghost', fromEnvironment: false });
  });

  it('does not invent a latent orphan for a healthy stored selection', () => {
    expect(resolveActiveAccount(oauth, { CLODEX_OAUTH_ACCOUNT: 'work' }))
      .toEqual({ kind: 'slot', name: 'work', fromEnvironment: true });
  });

  it('phrases a dormant provider as saved state, not a live outcome', () => {
    // "every launch fails" is untrue of a provider that is not launching:
    // applySelectedOAuthAccount returns it untouched and materialization
    // excludes it. The selection still matters — it will start failing the
    // moment the provider is enabled — so it is reported, differently.
    const dormant = resolveActiveAccount(
      { ...withSlots, enabled: false, activeAuthAccount: 'ghost' } as RegistryProvider, {},
    );
    expect(dormant).toMatchObject({ kind: 'broken', dormant: true });
    const hint = accountSwitchHint({ activeAuthAccount: 'ghost' }, dormant);
    expect(hint).toContain('will fail if this provider is enabled');
    expect(hint).not.toContain('every launch fails');
  });

  it('does not report one broken selection as two', () => {
    // Stored and override naming the SAME missing slot is a single failure.
    // Carrying it as a latent orphan as well rendered `ghost` twice and made
    // the hint say the stored account was missing "too".
    const both = { ...withSlots, activeAuthAccount: 'ghost' } as RegistryProvider;
    expect(resolveActiveAccount(both, { CLODEX_OAUTH_ACCOUNT: 'ghost' }))
      .toEqual({ kind: 'broken', name: 'ghost', fromEnvironment: true });
    // Two DIFFERENT missing names remain two failures.
    expect(resolveActiveAccount(both, { CLODEX_OAUTH_ACCOUNT: 'phantom' }))
      .toEqual({ kind: 'broken', name: 'phantom', fromEnvironment: true, latentOrphan: 'ghost' });
  });

  it('reports the provider default as its own kind, never as a name', () => {
    expect(resolveActiveAccount(withSlots, {})).toEqual({ kind: 'default' });
  });
});

describe('accountSwitchHint', () => {
  it('says the launch fails when the selection is broken', () => {
    expect(accountSwitchHint({ activeAuthAccount: 'ghost' }, { kind: 'broken', name: 'ghost', fromEnvironment: false }))
      .toContain('every launch fails');
    expect(accountSwitchHint({ activeAuthAccount: 'alt' }, { kind: 'broken', name: 'ghost', fromEnvironment: true }))
      .toContain('names no such account');
  });

  it('flags a masked stored orphan in the hint', () => {
    const hint = accountSwitchHint(
      { activeAuthAccount: 'ghost' },
      { kind: 'slot', name: 'work', fromEnvironment: true, latentOrphan: 'ghost' },
    );
    expect(hint).toContain('stored "ghost" no longer exists');
    expect(hint).toContain('will fail without it');
  });

  it('names the live account otherwise', () => {
    expect(accountSwitchHint({ activeAuthAccount: 'alt' }, { kind: 'slot', name: 'alt', fromEnvironment: false }))
      .toContain('currently uses alt');
    expect(accountSwitchHint({}, { kind: 'default' })).toContain('(provider default)');
  });
});

describe('accountSwitchOutcome', () => {
  it('warns instead of confirming when the saved choice still cannot launch', () => {
    // Persisting succeeds under the write lock while a nonblank
    // CLODEX_OAUTH_ACCOUNT naming a missing slot still makes every launch
    // throw. Reporting the picker choice back verbatim confirmed a repair that
    // had not happened.
    const outcome = accountSwitchOutcome('OpenAI', 'work', {
      kind: 'broken', name: 'ghost', fromEnvironment: true,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('names no such account');
    expect(outcome.message).toContain('every launch fails');
  });

  it('flags an override that shadows what was just saved', () => {
    const outcome = accountSwitchOutcome('OpenAI', 'work', {
      kind: 'slot', name: 'alt', fromEnvironment: true,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain('overrides it in this shell');
  });

  it('confirms plainly when the saved choice is what will launch', () => {
    expect(accountSwitchOutcome('OpenAI', 'work', { kind: 'slot', name: 'work', fromEnvironment: false }))
      .toEqual({ ok: true, message: 'OpenAI will launch as work.' });
    // An override naming the SAME account is not worth a caveat.
    expect(accountSwitchOutcome('OpenAI', 'work', { kind: 'slot', name: 'work', fromEnvironment: true }).ok)
      .toBe(true);
    expect(accountSwitchOutcome('OpenAI', undefined, { kind: 'default' }).message)
      .toContain('(provider default)');
  });

  it('never confirms an outcome the resolver calls broken', () => {
    // The property, not the phrasing: this is the third surface to have decided
    // a launch outcome on its own, so the guard is that ok tracks the resolver.
    for (const effective of [
      { kind: 'broken', name: 'ghost', fromEnvironment: true },
      { kind: 'broken', name: 'ghost', fromEnvironment: false },
    ] as const) {
      expect(accountSwitchOutcome('OpenAI', 'work', effective).ok).toBe(false);
    }
    for (const effective of [
      { kind: 'default' },
      { kind: 'slot', name: 'work', fromEnvironment: false },
      { kind: 'slot', name: 'alt', fromEnvironment: true },
    ] as const) {
      expect(accountSwitchOutcome('OpenAI', 'work', effective).ok).toBe(true);
    }
  });
});
