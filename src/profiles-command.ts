// profiles-command.ts — clodex profiles (named snapshots of favorites + aliases)
//
// A profile captures the CURRENT favorites and model aliases under a name;
// applying one replaces both in a single step. The alias NAMES are what agent
// definitions and the Claude Code patch tables key on, so re-pointing the
// models behind them (e.g. when a plan's usage runs out) never touches agent
// config — the next `clodex claude` launch detects the changed model config
// and offers to re-patch (or run `clodex patch` directly).

import pc from 'picocolors';
import * as p from '@clack/prompts';
import { loadPreferences, savePreferences } from './config.js';
import type {
  BuiltinAliasName,
  FavoriteModel,
  ModelAlias,
  ModelProfile,
  UserPreferences,
} from './types.js';

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const RESERVED_PROFILE_NAMES = new Set(Object.getOwnPropertyNames(Object.prototype));
const BUILTIN_ALIAS_NAMES = new Set<BuiltinAliasName>(['sonnet', 'opus', 'haiku', 'fable']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFavoriteModel(value: unknown): value is FavoriteModel {
  if (!isRecord(value)) return false;
  return typeof value['providerId'] === 'string'
    && value['providerId'].trim().length > 0
    && typeof value['modelId'] === 'string'
    && value['modelId'].trim().length > 0;
}

function isModelAlias(value: unknown): value is ModelAlias {
  if (!isRecord(value)) return false;
  const name = value['name'];
  return typeof name === 'string'
    && name.trim().length > 0
    && isFavoriteModel(value);
}

function normalizeBuiltinOverrides(
  value: unknown,
): Partial<Record<BuiltinAliasName, string>> | null {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  const overrides: Partial<Record<BuiltinAliasName, string>> = {};
  for (const [alias, target] of Object.entries(value)) {
    if (!BUILTIN_ALIAS_NAMES.has(alias as BuiltinAliasName)) return null;
    if (typeof target !== 'string' || !target.trim()) return null;
    overrides[alias as BuiltinAliasName] = target.trim();
  }
  return overrides;
}

export function validateProfileName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  if (!PROFILE_NAME_RE.test(trimmed)) {
    throw new Error(
      `Invalid profile name "${name}" — use 1-32 characters: lowercase letters, digits, "-" or "_", starting with a letter or digit.`,
    );
  }
  // Reject own keys that would shadow the ordinary object prototype. The
  // profile map itself uses a null prototype too, so malformed config cannot
  // turn an absent inherited property into a profile lookup hit.
  if (RESERVED_PROFILE_NAMES.has(trimmed)) {
    throw new Error(`Invalid profile name "${name}" — reserved name.`);
  }
  return trimmed;
}

function snapshotOf(prefs: UserPreferences): Omit<ModelProfile, 'savedAt'> {
  const favoriteModels = Array.isArray(prefs.favoriteModels)
    ? prefs.favoriteModels.filter(isFavoriteModel)
    : [];
  const modelAliases = Array.isArray(prefs.modelAliases)
    ? prefs.modelAliases.filter(isModelAlias)
    : [];
  const builtinModelOverrides = normalizeBuiltinOverrides(prefs.builtinModelOverrides) ?? {};
  return {
    favoriteModels: structuredClone(favoriteModels),
    modelAliases: structuredClone(modelAliases),
    builtinModelOverrides: structuredClone(builtinModelOverrides),
  };
}

/**
 * Treat the on-disk profile map as untrusted input. Older/manual config edits
 * can leave arrays, partial objects, or malformed members behind; list/show/use
 * must skip those entries rather than throwing from `.map`, `.length`, or
 * `structuredClone` before the user can repair the config.
 */
function parseStoredProfile(value: unknown): ModelProfile | null {
  if (!isRecord(value)) return null;
  if (typeof value['savedAt'] !== 'string' || !value['savedAt'].trim()) return null;
  if (!Array.isArray(value['favoriteModels']) || !value['favoriteModels'].every(isFavoriteModel)) {
    return null;
  }
  if (!Array.isArray(value['modelAliases']) || !value['modelAliases'].every(isModelAlias)) {
    return null;
  }
  const builtinModelOverrides = normalizeBuiltinOverrides(value['builtinModelOverrides']);
  if (builtinModelOverrides === null) return null;
  return {
    savedAt: value['savedAt'],
    favoriteModels: structuredClone(value['favoriteModels']),
    modelAliases: structuredClone(value['modelAliases']),
    ...(Object.keys(builtinModelOverrides).length > 0
      ? { builtinModelOverrides: structuredClone(builtinModelOverrides) }
      : {}),
  };
}

function ownProfiles(prefs: UserPreferences): Record<string, ModelProfile> {
  const profiles: Record<string, ModelProfile> = Object.create(null);
  if (!isRecord(prefs.modelProfiles)) return profiles;
  for (const [storedName, value] of Object.entries(prefs.modelProfiles)) {
    let name: string;
    try {
      name = validateProfileName(storedName);
    } catch {
      continue;
    }
    // All command-created keys are canonical. Refuse ambiguous legacy/manual
    // spellings rather than folding two different own keys onto one profile.
    if (name !== storedName) continue;
    const profile = parseStoredProfile(value);
    if (profile) profiles[name] = profile;
  }
  return profiles;
}

/** Preserve unknown/malformed own entries during unrelated save/delete operations. */
function storedProfileEntries(prefs: UserPreferences): Record<string, unknown> {
  const stored: Record<string, unknown> = Object.create(null);
  if (!isRecord(prefs.modelProfiles)) return stored;
  for (const [name, value] of Object.entries(prefs.modelProfiles)) stored[name] = value;
  return stored;
}

function sameSnapshot(a: Omit<ModelProfile, 'savedAt'>, b: Omit<ModelProfile, 'savedAt'>): boolean {
  const canonical = (value: unknown): string => JSON.stringify(value ?? []);
  return canonical(a.favoriteModels) === canonical(b.favoriteModels)
    && canonical(a.modelAliases) === canonical(b.modelAliases)
    && JSON.stringify(a.builtinModelOverrides ?? {}) === JSON.stringify(b.builtinModelOverrides ?? {});
}

function aliasSummary(profile: ModelProfile): string {
  const aliases = profile.modelAliases
    .map(alias => `${alias.name}→${String(alias.modelId ?? '?')}`)
    .join(', ');
  return aliases || '(no aliases)';
}

export function profilesHelpText(): string {
  return `${pc.bold('clodex profiles')} — named snapshots of favorites + model aliases

${pc.bold('Usage:')}
  clodex profiles                 list saved profiles
  clodex profiles save <name>     snapshot the CURRENT favorites + aliases
  clodex profiles use <name>      apply a profile (replaces favorites + aliases)
  clodex profiles show <name>     print a profile's aliases and favorites
  clodex profiles delete <name>   remove a saved profile

${pc.bold('Why:')} agent definitions pin alias names (sol, luna, ...). A profile
re-points the models behind those names in one step — e.g. when a plan's
usage runs out. The next ${pc.bold('clodex claude')} launch detects the change
and offers to re-patch — accept it, or run ${pc.bold('clodex patch')} directly.
Running sessions keep their old routing until relaunched, and a standalone
${pc.bold('clodex server')} keeps its old routing until restarted — clients
launched through it follow the server's snapshot, not this profile.`;
}

export async function runProfilesCommand(args: string[]): Promise<number> {
  const filteredArgs = args.filter(arg => arg !== '--help' && arg !== '-h');
  const [sub, rawName, ...extra] = filteredArgs;
  if (args.includes('--help') || args.includes('-h')) {
    console.log(profilesHelpText());
    return 0;
  }
  const namedSubcommands = new Set(['save', 'use', 'show', 'delete']);
  const unexpected = extra[0]
    ?? (rawName && !namedSubcommands.has(sub ?? '') ? rawName : undefined);
  if (unexpected) {
    p.log.error(`Unexpected argument: ${unexpected}`);
    return 1;
  }

  const prefs = loadPreferences();
  const profiles = ownProfiles(prefs);
  const storedProfiles = storedProfileEntries(prefs);

  if (!sub || sub === 'list') {
    const names = Object.keys(profiles).sort();
    if (names.length === 0) {
      p.log.info('No profiles saved. Snapshot the current setup with: clodex profiles save <name>');
      return 0;
    }
    console.log('');
    for (const name of names) {
      const profile = profiles[name]!;
      const isActive = prefs.activeModelProfile === name;
      const drifted = isActive && !sameSnapshot(snapshotOf(prefs), profile);
      const marker = isActive ? (drifted ? pc.yellow('● active, edited since') : pc.green('● active')) : pc.dim('○');
      console.log(`  ${marker} ${pc.bold(name)} ${pc.dim(`— ${aliasSummary(profile)}`)}`);
    }
    console.log('');
    return 0;
  }

  if (sub === 'save' || sub === 'use' || sub === 'show' || sub === 'delete') {
    if (!rawName) {
      p.log.error(`Usage: clodex profiles ${sub} <name>`);
      return 1;
    }
    let name: string;
    try {
      name = validateProfileName(rawName);
    } catch (err) {
      p.log.error(err instanceof Error ? err.message : String(err));
      return 1;
    }

    if (sub === 'save') {
      const profile: ModelProfile = { savedAt: new Date().toISOString(), ...snapshotOf(prefs) };
      savePreferences({
        modelProfiles: { ...storedProfiles, [name]: profile } as Record<string, ModelProfile>,
        activeModelProfile: name,
      });
      p.log.success(`Saved profile "${name}" (${profile.modelAliases.length} alias${profile.modelAliases.length === 1 ? '' : 'es'}, ${profile.favoriteModels.length} favorite${profile.favoriteModels.length === 1 ? '' : 's'}).`);
      return 0;
    }

    const profile = profiles[name];
    if (!profile) {
      const available = Object.keys(profiles).sort().join(', ');
      p.log.error(`No profile named "${name}"${available ? ` (saved: ${available})` : ''}.`);
      return 1;
    }

    if (sub === 'use') {
      savePreferences({
        favoriteModels: structuredClone(profile.favoriteModels),
        modelAliases: structuredClone(profile.modelAliases),
        builtinModelOverrides: structuredClone(profile.builtinModelOverrides ?? {}),
        activeModelProfile: name,
      });
      p.log.success(`Applied profile "${name}": ${aliasSummary(profile)}`);
      p.log.info('New clodex claude launches use this routing. The launcher will offer to re-patch for the changed model config — accept it, or run `clodex patch` now. Running sessions keep their old routing until relaunched, and a standalone `clodex server` keeps its old routing until you RESTART it — clients launched through it (clodex-claude) follow the server, not this profile.');
      return 0;
    }

    if (sub === 'show') {
      console.log(`\n${pc.bold(name)} ${pc.dim(`(saved ${profile.savedAt})`)}`);
      for (const alias of profile.modelAliases) {
        console.log(`  alias ${pc.bold(alias.name)} → clodex:${String(alias.providerId ?? '?')}:${String(alias.modelId ?? '?')}`);
      }
      for (const favorite of profile.favoriteModels) {
        console.log(`  favorite ${String(favorite.providerId)}:${String(favorite.modelId)}`);
      }
      for (const [builtin, target] of Object.entries(profile.builtinModelOverrides ?? {})) {
        console.log(`  built-in ${pc.bold(builtin)} → ${String(target)}`);
      }
      console.log('');
      return 0;
    }

    // delete
    const remaining = { ...storedProfiles };
    delete remaining[name];
    savePreferences({
      modelProfiles: remaining as Record<string, ModelProfile>,
      ...(prefs.activeModelProfile === name ? { activeModelProfile: '' } : {}),
    });
    p.log.success(`Deleted profile "${name}".`);
    return 0;
  }

  p.log.error(`Unknown profiles subcommand: ${sub}`);
  console.log(profilesHelpText());
  return 1;
}
