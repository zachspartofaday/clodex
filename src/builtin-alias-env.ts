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
