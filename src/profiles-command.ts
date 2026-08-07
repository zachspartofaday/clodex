// profiles-command.ts — clodex profiles (named snapshots of favorites + aliases)
//
// A profile captures the CURRENT favorites and model aliases under a name;
// applying one replaces both in a single step. The alias NAMES are what agent
// definitions and the Claude Code patch tables key on, so re-pointing the
// models behind them (e.g. when a plan's usage runs out) never touches agent
// config — the next `clodex claude` launch re-patches automatically because
// the model-config hash changes.

import pc from 'picocolors';
import * as p from '@clack/prompts';
import { loadPreferences, savePreferences } from './config.js';
import type { ModelProfile, UserPreferences } from './types.js';

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function validateProfileName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  if (!PROFILE_NAME_RE.test(trimmed)) {
    throw new Error(
      `Invalid profile name "${name}" — use 1-32 characters: lowercase letters, digits, "-" or "_", starting with a letter or digit.`,
    );
  }
  // The regex admits lowercase prototype keys like "constructor"; storing one
  // as an own property would let a later plain-object lookup shadow it. The
  // profile map is null-prototype, but the name is rejected here so the
  // reserved-name contract holds at the entry point, not just at lookup.
  if (Object.getOwnPropertyNames(Object.prototype).includes(trimmed)) {
    throw new Error(`Invalid profile name "${name}" — reserved name.`);
  }
  return trimmed;
}

function snapshotOf(prefs: UserPreferences): Omit<ModelProfile, 'savedAt'> {
  return {
    favoriteModels: structuredClone(prefs.favoriteModels ?? []),
    modelAliases: structuredClone(prefs.modelAliases ?? []),
    builtinModelOverrides: structuredClone(prefs.builtinModelOverrides ?? {}),
  };
}

function ownProfiles(prefs: UserPreferences): Record<string, ModelProfile> {
  const profiles: Record<string, ModelProfile> = Object.create(null);
  for (const [name, profile] of Object.entries(prefs.modelProfiles ?? {})) {
    if (profile && typeof profile === 'object') profiles[name] = profile;
  }
  return profiles;
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
usage runs out — and the next ${pc.bold('clodex claude')} launch re-patches
automatically. Running sessions keep their old routing until relaunched.`;
}

export async function runProfilesCommand(args: string[]): Promise<number> {
  const [sub, rawName, ...extra] = args.filter(arg => arg !== '--help' && arg !== '-h');
  if (args.includes('--help') || args.includes('-h')) {
    console.log(profilesHelpText());
    return 0;
  }
  if (extra.length > 0) {
    p.log.error(`Unexpected argument: ${extra[0]}`);
    return 1;
  }

  const prefs = loadPreferences();
  const profiles = ownProfiles(prefs);

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
        modelProfiles: { ...profiles, [name]: profile },
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
      p.log.info('New clodex claude launches use this routing (the patcher re-runs if the model config changed). Running sessions keep their old routing until relaunched.');
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
    const remaining = { ...profiles };
    delete remaining[name];
    savePreferences({
      modelProfiles: remaining,
      ...(prefs.activeModelProfile === name ? { activeModelProfile: '' } : {}),
    });
    p.log.success(`Deleted profile "${name}".`);
    return 0;
  }

  p.log.error(`Unknown profiles subcommand: ${sub}`);
  console.log(profilesHelpText());
  return 1;
}
