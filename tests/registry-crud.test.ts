import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRegistry } from '../src/registry/types.js';

const registryState = vi.hoisted(() => ({
  current: { schemaVersion: 1, providers: [] } as ProviderRegistry,
}));
const lockState = vi.hoisted(() => ({
  active: false,
  registryTail: Promise.resolve(),
  credentialActive: false,
  providerActive: false,
  credentialTails: new Map<string, Promise<void>>(),
  providerTails: new Map<string, Promise<void>>(),
}));
const journalState = vi.hoisted(() => ({
  pending: new Set<string>(),
}));

vi.mock('../src/env.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/env.js')>(),
  deleteProviderCredential: vi.fn(),
}));
vi.mock('../src/registry/io.js', () => ({
  loadRegistry: vi.fn(() => structuredClone(registryState.current)),
  loadRegistryStrict: vi.fn(() => structuredClone(registryState.current)),
  saveRegistry: vi.fn((registry: ProviderRegistry) => {
    if (!lockState.active) throw new Error('registry write escaped its lock');
    registryState.current = structuredClone(registry);
  }),
}));
vi.mock('../src/registry/credential-cleanup-journal.js', () => ({
  isStoredCredentialRef: vi.fn((authRef: string) =>
    authRef.startsWith('keyring:') || authRef.startsWith('helper:v1:')),
  loadPendingCredentialDeletes: vi.fn(async () => [...journalState.pending]),
  queueCredentialDelete: vi.fn(async (authRef: string) => {
    if (!authRef.startsWith('keyring:') && !authRef.startsWith('helper:v1:')) return false;
    journalState.pending.add(authRef);
    return true;
  }),
  cancelCredentialDelete: vi.fn(async (authRef: string) =>
    journalState.pending.delete(authRef)),
}));
vi.mock('../src/registry/lock.js', () => ({
  withRegistryWriteLock: vi.fn(
    async <T>(operation: () => Promise<T> | T): Promise<T> => {
      const previous = lockState.registryTail;
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      lockState.registryTail = previous.then(() => gate);
      await previous;
      lockState.active = true;
      try {
        return await operation();
      } finally {
        lockState.active = false;
        release();
      }
    },
  ),
  withCredentialMutationLock: vi.fn(async <T>(
    authRef: string,
    operation: () => Promise<T> | T,
  ): Promise<T> => {
    const previous = lockState.credentialTails.get(authRef) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    lockState.credentialTails.set(authRef, tail);
    await previous;
    lockState.credentialActive = true;
    try {
      return await operation();
    } finally {
      lockState.credentialActive = false;
      release();
      if (lockState.credentialTails.get(authRef) === tail) {
        lockState.credentialTails.delete(authRef);
      }
    }
  }),
  withProviderMutationLock: vi.fn(async <T>(
    providerSlot: string,
    operation: () => Promise<T> | T,
  ): Promise<T> => {
    const previous = lockState.providerTails.get(providerSlot) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    lockState.providerTails.set(providerSlot, tail);
    await previous;
    lockState.providerActive = true;
    try {
      return await operation();
    } finally {
      lockState.providerActive = false;
      release();
      if (lockState.providerTails.get(providerSlot) === tail) {
        lockState.providerTails.delete(providerSlot);
      }
    }
  }),
  // Runs the operation for real and holds the lock flag while it does, so the
  // saveRegistry mock's "write escaped its lock" assertion covers sync
  // mutations too. A bare vi.fn() stub silently swallows the callback and
  // returns undefined, which reads as a mutation helper that does nothing.
  withRegistryWriteLockSync: vi.fn(<T>(operation: () => T): T => {
    lockState.active = true;
    try {
      return operation();
    } finally {
      lockState.active = false;
    }
  }),
}));

import { deleteProviderCredential } from '../src/env.js';
import { removeProviderFromRegistry, setActiveOAuthAccount } from '../src/registry/crud.js';
import {
  withCredentialMutationLock,
  withProviderMutationLock,
  withRegistryWriteLock,
} from '../src/registry/lock.js';

describe('registry provider removal', () => {
  beforeEach(() => {
    lockState.active = false;
    lockState.registryTail = Promise.resolve();
    lockState.credentialActive = false;
    lockState.providerActive = false;
    lockState.credentialTails.clear();
    lockState.providerTails.clear();
    journalState.pending.clear();
    registryState.current = {
      schemaVersion: 1,
      providers: [
        {
          id: 'openai',
          templateId: 'openai',
          name: 'OpenAI',
          enabled: true,
          authRef: 'keyring:provider:openai',
          authType: 'api',
          api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
          addedAt: '2026-07-21T00:00:00.000Z',
        },
      ],
    };
    vi.mocked(deleteProviderCredential).mockReset().mockImplementation(
      async () => {
        expect(lockState.active).toBe(false);
        expect(lockState.credentialActive).toBe(true);
        expect(lockState.providerActive).toBe(true);
        return true;
      },
    );
  });

  it('queues every named OAuth account slot credential on provider removal', async () => {
    registryState.current.providers[0] = {
      ...registryState.current.providers[0]!,
      authType: 'oauth',
      authRef: 'keyring:oauth:provider:openai-oauth::credential::v1:default',
      authAccounts: {
        work: { authRef: 'keyring:oauth:provider:openai-oauth:account:work::credential::v1:w', addedAt: '2026-08-07T00:00:00.000Z' },
        alt: { authRef: 'keyring:oauth:provider:openai-oauth:account:alt::credential::v1:a', addedAt: '2026-08-07T00:00:00.000Z' },
      },
    };

    const result = await removeProviderFromRegistry('openai');

    expect(result.removed).toBe(true);
    expect(registryState.current.providers).toHaveLength(0);
    const deleted = vi.mocked(deleteProviderCredential).mock.calls.map(call => call[0]).sort();
    expect(deleted).toEqual([
      'keyring:oauth:provider:openai-oauth::credential::v1:default',
      'keyring:oauth:provider:openai-oauth:account:alt::credential::v1:a',
      'keyring:oauth:provider:openai-oauth:account:work::credential::v1:w',
    ].sort());
  });

  it('reports pending cleanup when a slot credential fails to delete after the default succeeded', async () => {
    registryState.current.providers[0] = {
      ...registryState.current.providers[0]!,
      authType: 'oauth',
      authRef: 'keyring:oauth:provider:openai-oauth::credential::v1:default',
      authAccounts: {
        work: { authRef: 'keyring:oauth:provider:openai-oauth:account:work::credential::v1:w', addedAt: '2026-08-07T00:00:00.000Z' },
      },
    };
    vi.mocked(deleteProviderCredential).mockImplementation(async authRef =>
      authRef === 'keyring:oauth:provider:openai-oauth::credential::v1:default');

    const result = await removeProviderFromRegistry('openai');

    // Status derives from the COMPLETE queued set: the surviving slot
    // credential must surface as pending, not be masked by the default
    // credential's clean deletion.
    expect(result).toMatchObject({
      removed: true,
      credentialDeleted: false,
      credentialCleanupPending: true,
      credentialCleanupReconciled: true,
    });
    expect(journalState.pending.has('keyring:oauth:provider:openai-oauth:account:work::credential::v1:w')).toBe(true);
    expect(journalState.pending.has('keyring:oauth:provider:openai-oauth::credential::v1:default')).toBe(false);
  });

  it('commits the registry mutation before deleting the credential outside the lock', async () => {
    const result = await removeProviderFromRegistry('openai');

    expect(result).toMatchObject({
      removed: true,
      credentialDeleted: true,
    });
    expect(registryState.current.providers).toHaveLength(0);
    expect(deleteProviderCredential).toHaveBeenCalledWith(
      'keyring:provider:openai',
    );
    expect(lockState.active).toBe(false);
  });

  it('keeps a failed credential deletion queued for retry', async () => {
    vi.mocked(deleteProviderCredential).mockImplementation(async () => {
      expect(lockState.active).toBe(false);
      expect(lockState.credentialActive).toBe(true);
      expect(lockState.providerActive).toBe(true);
      return false;
    });

    const result = await removeProviderFromRegistry('openai');

    expect(result).toMatchObject({
      removed: true,
      credentialDeleted: false,
      credentialCleanupPending: true,
    });
    expect(result.error).toBeUndefined();
    expect(registryState.current.providers).toHaveLength(0);
    expect([...journalState.pending]).toEqual([
      'keyring:provider:openai',
    ]);
    expect(deleteProviderCredential).toHaveBeenCalledWith(
      'keyring:provider:openai',
    );
    expect(lockState.active).toBe(false);
    expect(lockState.credentialActive).toBe(false);
  });

  it('serializes deletion against reattaching the same credential reference', async () => {
    let startDelete!: () => void;
    const deleteStarted = new Promise<void>((resolve) => {
      startDelete = resolve;
    });
    let finishDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => {
      finishDelete = resolve;
    });
    let credentialValue: string | null = 'old-key';
    vi.mocked(deleteProviderCredential).mockImplementation(async () => {
      startDelete();
      await deleteGate;
      credentialValue = null;
      return true;
    });

    const removal = removeProviderFromRegistry('openai');
    await deleteStarted;
    let replacementEntered = false;
    const replacement = withCredentialMutationLock(
      'keyring:provider:openai',
      async () => {
        replacementEntered = true;
        credentialValue = 'new-key';
        await withRegistryWriteLock(() => {
          registryState.current.providers.push({
            id: 'openai',
            templateId: 'openai',
            name: 'OpenAI',
            enabled: true,
            authRef: 'keyring:provider:openai',
            authType: 'api',
            api: {
              npm: '@ai-sdk/openai',
              url: 'https://api.openai.com/v1',
            },
            addedAt: '2026-07-21T01:00:00.000Z',
          });
        });
      },
    );

    await Promise.resolve();
    expect(replacementEntered).toBe(false);
    finishDelete();
    await Promise.all([removal, replacement]);

    expect(credentialValue).toBe('new-key');
    expect(registryState.current.providers).toHaveLength(1);
  });

  it('serializes removal against publishing a credential on another backend', async () => {
    let startDelete!: () => void;
    const deleteStarted = new Promise<void>(resolve => {
      startDelete = resolve;
    });
    let finishDelete!: () => void;
    const deleteGate = new Promise<void>(resolve => {
      finishDelete = resolve;
    });
    vi.mocked(deleteProviderCredential).mockImplementation(async () => {
      startDelete();
      await deleteGate;
      return true;
    });

    const removal = removeProviderFromRegistry('openai');
    await deleteStarted;
    let migrationEntered = false;
    const migration = withProviderMutationLock('openai', async () => {
      migrationEntered = true;
      await withRegistryWriteLock(() => {
        registryState.current.providers.push({
          id: 'openai',
          templateId: 'openai',
          name: 'OpenAI',
          enabled: true,
          authRef: 'helper:v1:new-helper:provider:openai',
          authType: 'api',
          api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
          addedAt: '2026-07-21T01:00:00.000Z',
        });
      });
    });

    await Promise.resolve();
    expect(migrationEntered).toBe(false);
    finishDelete();
    await Promise.all([removal, migration]);

    expect(registryState.current.providers).toHaveLength(1);
    expect(registryState.current.providers[0]?.authRef).toContain('new-helper');
  });
});

describe('setActiveOAuthAccount', () => {
  beforeEach(() => {
    lockState.active = false;
    lockState.registryTail = Promise.resolve();
    registryState.current = {
      schemaVersion: 2,
      providers: [
        {
          id: 'openai-oauth',
          templateId: 'openai',
          name: 'OpenAI (ChatGPT)',
          enabled: true,
          authRef: 'keyring:oauth:provider:openai-oauth::credential::v1:default',
          authType: 'oauth',
          authAccounts: {
            zachspartofaday: { authRef: 'keyring:oauth:provider:openai-oauth:account:zachspartofaday::credential::v1:z', addedAt: '2026-08-09T00:00:00.000Z' },
          },
          api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
          addedAt: '2026-08-09T00:00:00.000Z',
        },
      ],
    };
  });

  it('persists the chosen account', () => {
    const result = setActiveOAuthAccount('openai-oauth', 'zachspartofaday');
    expect(result).toMatchObject({ updated: true, changed: true, account: 'zachspartofaday' });
    expect(result.provider?.activeAuthAccount).toBe('zachspartofaday');
    expect(registryState.current.providers[0]?.activeAuthAccount).toBe('zachspartofaday');
  });

  it('reports an unchanged selection as a no-op', () => {
    registryState.current.providers[0]!.activeAuthAccount = 'zachspartofaday';

    const result = setActiveOAuthAccount('openai-oauth', 'zachspartofaday');

    expect(result).toMatchObject({
      updated: true,
      changed: false,
      account: 'zachspartofaday',
    });
    expect(result.provider?.activeAuthAccount).toBe('zachspartofaday');
  });

  it('clears the field rather than storing a sentinel when returning to the default', () => {
    setActiveOAuthAccount('openai-oauth', 'zachspartofaday');
    const result = setActiveOAuthAccount('openai-oauth', undefined);
    expect(result).toMatchObject({ updated: true });
    expect(result.provider?.activeAuthAccount).toBeUndefined();
    // Absent, not 'default': a slot may legitimately be NAMED "default", so a
    // stored sentinel would be indistinguishable from selecting that slot.
    expect('activeAuthAccount' in registryState.current.providers[0]!).toBe(false);
  });

  it('refuses a name with no slot so the registry cannot point at a missing account', () => {
    // The state applySelectedOAuthAccount has to refuse to launch on, so it
    // must be unreachable through the picker rather than merely diagnosed.
    const result = setActiveOAuthAccount('openai-oauth', 'ghost');
    expect(result.updated).toBe(false);
    expect(result.error).toMatch(/no account named "ghost" \(available: zachspartofaday\)/);
    expect(registryState.current.providers[0]?.activeAuthAccount).toBeUndefined();
  });

  it('reports an unknown provider instead of writing', () => {
    expect(setActiveOAuthAccount('nope', 'zachspartofaday')).toEqual({
      updated: false,
      error: 'Provider not found: nope',
    });
  });
});
