// builtin-alias-env.ts — remap Claude Code's built-in aliases via env.
//
// Leaf module by design (imports only types): the per-session `clodex claude`
// proxy launcher (env.ts) and the `clodex-claude` wrapper bin (wrapper-env.ts)
// must apply the SAME remap rule, and wrapper-env stays dependency-free
// because it runs for every Claude-Code-spawned agent process. If the rule
// ever forked between those two launch paths, the same saved override would
// route differently depending on how claude was started.

import type { BuiltinAliasName } from './types.js';

/** Env var behind each remappable built-in alias. */
export const BUILTIN_ALIAS_ENV: Record<BuiltinAliasName, string> = {
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
};

/**
 * Claude Code resolves sonnet/opus/haiku/fable to canonical ids BEFORE
 * sending, so remapping a built-in happens through its ANTHROPIC_DEFAULT_*
 * env var, not through a clodex alias. Config supplies the values; an env
 * var the user set explicitly always wins (pass the pre-sweep env as
 * `explicit` so a launcher that deletes conflicting vars still honors it).
 */
export function applyBuiltinModelOverrides(
  env: NodeJS.ProcessEnv,
  overrides: Partial<Record<BuiltinAliasName, string>> | undefined,
  explicit: NodeJS.ProcessEnv = process.env,
): void {
  for (const [alias, envName] of Object.entries(BUILTIN_ALIAS_ENV) as Array<[BuiltinAliasName, string]>) {
    const value = explicit[envName] ?? overrides?.[alias];
    if (value !== undefined && String(value).trim() !== '') env[envName] = String(value).trim();
  }
}

/**
 * Keep only remaps the CURRENT proxy route table can serve. A saved override
 * can go stale after selection — its alias removed-then-readded with a
 * conflict, its favorite dropped, or a profile restoring routing that no
 * longer resolves — and injecting a non-routable name through
 * ANTHROPIC_DEFAULT_*_MODEL turns every request for that built-in into the
 * proxy's route-unavailable 400. Stale entries revert to the native default
 * for the launch and are reported through `warn`.
 */
export function routableBuiltinOverrides(
  overrides: Partial<Record<BuiltinAliasName, string>> | undefined,
  routableNames: Iterable<string>,
  warn?: (message: string) => void,
): Partial<Record<BuiltinAliasName, string>> {
  const routable = new Set<string>();
  for (const name of routableNames) routable.add(name.trim().toLowerCase());
  const out: Partial<Record<BuiltinAliasName, string>> = {};
  for (const [alias, target] of Object.entries(overrides ?? {}) as Array<[BuiltinAliasName, string]>) {
    const trimmed = typeof target === 'string' ? target.trim() : '';
    if (trimmed && routable.has(trimmed.toLowerCase())) {
      out[alias] = target;
    } else if (trimmed) {
      warn?.(`Built-in remap ${alias} → ${trimmed} is not routable by this proxy; ${alias} reverts to the native default for this launch.`);
    }
  }
  return out;
}

/** Names the aliases a clodex launcher itself injected into a child env. */
export const WRAPPER_INJECTED_BUILTINS_ENV = 'CLODEX_INJECTED_BUILTINS';

/**
 * Apply remaps while distinguishing a USER's explicit env var from one a
 * previous clodex launch injected. Claude Code spawns nested processes with
 * the injected ANTHROPIC_DEFAULT_* values still in the environment; treating
 * those as explicit would let a stale injection from an older server or
 * profile permanently outrank every newer route-bound snapshot. Inherited
 * injections (named in the provenance sentinel) are cleared first, the
 * current overrides applied with true user env winning, and the sentinel
 * rewritten to exactly what THIS launch injected.
 */
export function applyBuiltinModelOverridesWithProvenance(
  env: NodeJS.ProcessEnv,
  overrides: Partial<Record<BuiltinAliasName, string>> | undefined,
  baseEnv: NodeJS.ProcessEnv,
): void {
  const inherited = new Set(
    (baseEnv[WRAPPER_INJECTED_BUILTINS_ENV] ?? '').split(',').map(name => name.trim()).filter(Boolean),
  );
  const explicit: NodeJS.ProcessEnv = { ...baseEnv };
  for (const alias of inherited) {
    const envName = BUILTIN_ALIAS_ENV[alias as BuiltinAliasName];
    if (envName) {
      delete explicit[envName];
      // A stale injection not re-issued by this launch must not linger.
      delete env[envName];
    }
  }
  applyBuiltinModelOverrides(env, overrides, explicit);
  const injected = (Object.entries(BUILTIN_ALIAS_ENV) as Array<[BuiltinAliasName, string]>)
    .filter(([alias, envName]) => explicit[envName] === undefined && env[envName] !== undefined
      && String(overrides?.[alias] ?? '').trim() !== '')
    .map(([alias]) => alias);
  if (injected.length > 0) env[WRAPPER_INJECTED_BUILTINS_ENV] = injected.join(',');
  else delete env[WRAPPER_INJECTED_BUILTINS_ENV];
}
