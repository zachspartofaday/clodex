// src/registry/crud.ts — add/remove providers in the native registry

import {
  queueCredentialDelete,
  reconcilePendingCredentialDeletes,
} from './credential-lifecycle.js';
import { loadRegistryStrict, saveRegistry } from './io.js';
import {
  withProviderMutationLock,
  withRegistryWriteLock,
  withRegistryWriteLockSync,
} from './lock.js';

export interface RemoveProviderResult {
  removed: boolean;
  id: string;
  name?: string;
  credentialDeleted: boolean;
  credentialCleanupPending?: boolean;
  credentialCleanupReconciled?: boolean;
  error?: string;
}

interface PendingProviderRemoval {
  result: RemoveProviderResult;
  /** Every credential ref queued for cleanup: the default plus each named slot. */
  queuedRefs: string[];
}

/** Remove a provider from the registry; delete its stored credential when safe. */
async function removeProviderWithinLifecycle(
  id: string,
  opts?: { deleteCredential?: boolean },
): Promise<RemoveProviderResult> {
  const removal = await withRegistryWriteLock<PendingProviderRemoval>(async () => {
    const registry = loadRegistryStrict();
    const index = registry.providers.findIndex(p => p.id === id);
    if (index < 0) {
      return {
        result: {
          removed: false,
          id,
          credentialDeleted: false,
          error: `Provider not found: ${id}`,
        },
        queuedRefs: [],
      };
    }

    const [removedProvider] = registry.providers.splice(index, 1);
    const queuedRefs: string[] = [];
    if (opts?.deleteCredential !== false) {
      if (await queueCredentialDelete(removedProvider.authRef)) {
        queuedRefs.push(removedProvider.authRef);
      }
      // Named OAuth account slots own disjoint credential lineages; removing
      // the provider must not orphan them in the credential store.
      for (const slot of Object.values(removedProvider.authAccounts ?? {})) {
        if (slot.authRef && slot.authRef !== removedProvider.authRef
          && await queueCredentialDelete(slot.authRef)) {
          queuedRefs.push(slot.authRef);
        }
      }
    }
    saveRegistry(registry);

    return {
      result: {
        removed: true,
        id,
        name: removedProvider.name,
        credentialDeleted: false,
      },
      queuedRefs,
    };
  });

  if (removal.queuedRefs.length > 0) {
    // Deletion and pending status derive from the COMPLETE queued set: a
    // failed slot deletion must surface as pending even when the default
    // credential deleted cleanly, or the pending-cleanup warning is
    // suppressed while credentials remain queued in the store.
    try {
      const cleanup = await reconcilePendingCredentialDeletes();
      removal.result.credentialDeleted =
        removal.queuedRefs.every(ref => cleanup.deleted.includes(ref));
      removal.result.credentialCleanupPending =
        removal.queuedRefs.some(ref => cleanup.pending.includes(ref))
        || cleanup.persistenceError !== undefined;
    } catch {
      removal.result.credentialCleanupPending = true;
    }
    removal.result.credentialCleanupReconciled = true;
  }
  return removal.result;
}

export async function removeProviderFromRegistry(
  id: string,
  opts?: { deleteCredential?: boolean },
): Promise<RemoveProviderResult> {
  return withProviderMutationLock(id, () => removeProviderWithinLifecycle(id, opts));
}

export function toggleProviderEnabled(id: string): { toggled: boolean; enabled?: boolean; error?: string } {
  return withRegistryWriteLockSync(() => {
    const registry = loadRegistryStrict();
    const provider = registry.providers.find(p => p.id === id);
    if (!provider) return { toggled: false, error: `Provider not found: ${id}` };
    provider.enabled = !provider.enabled;
    saveRegistry(registry);
    return { toggled: true, enabled: provider.enabled };
  });
}
