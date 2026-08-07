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
  // Map lowercased → canonical spelling: matching is case-insensitive, but
  // the INJECTED value must be the exact routable name — the MITM route
  // lookup is case-sensitive, so injecting the saved spelling ("WJudge")
  // would pass this filter yet miss the route and go upstream unknown.
  const routable = new Map<string, string>();
  for (const name of routableNames) routable.set(name.trim().toLowerCase(), name.trim());
  const out: Partial<Record<BuiltinAliasName, string>> = {};
  for (const [alias, target] of Object.entries(overrides ?? {}) as Array<[BuiltinAliasName, string]>) {
    const trimmed = typeof target === 'string' ? target.trim() : '';
    const canonical = trimmed ? routable.get(trimmed.toLowerCase()) : undefined;
    if (canonical !== undefined) {
      out[alias] = canonical;
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
/**
 * Parse the provenance sentinel into alias → injected value. Entries are
 * `alias=encodedValue`; a bare `alias` (older sentinel format) matches any
 * current value. Only entries whose recorded value still matches the live
 * env var are "ours to clear" — a user who deliberately replaced an
 * injected var made it explicit, and explicit env always wins.
 */
function inheritedInjections(baseEnv: NodeJS.ProcessEnv): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const entry of (baseEnv[WRAPPER_INJECTED_BUILTINS_ENV] ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      map.set(trimmed, null);
    } else {
      // The sentinel is untrusted provenance: a corrupted percent escape must
      // never throw a launch-killing URIError, and it must not be GRANTED a
      // match-any ownership claim either — that would delete a var the user
      // set explicitly. An undecodable entry is simply ignored; the worst
      // case is a stale injection surviving one launch, never a destroyed
      // explicit value.
      try {
        map.set(trimmed.slice(0, eq), decodeURIComponent(trimmed.slice(eq + 1)));
      } catch { /* ignore the malformed entry */ }
    }
  }
  return map;
}

function stillOurs(baseEnv: NodeJS.ProcessEnv, envName: string, recorded: string | null): boolean {
  return recorded === null || baseEnv[envName] === recorded;
}

/**
 * Remove every remap a PREVIOUS launch injected (per the provenance
 * sentinel), plus the sentinel itself. Every launch mode needs this — a
 * stale injection surviving into a no-server launch goes straight to
 * Anthropic as an unknown model id, and into an endpoint launch as a name
 * its catalog may not expose. Only a proxy launch re-applies a snapshot
 * afterwards. A var whose current value no longer matches what was
 * recorded is a deliberate user replacement and is left untouched.
 */
export function clearInheritedBuiltinOverrides(
  env: NodeJS.ProcessEnv,
  baseEnv: NodeJS.ProcessEnv,
): void {
  for (const [alias, recorded] of inheritedInjections(baseEnv)) {
    const envName = BUILTIN_ALIAS_ENV[alias as BuiltinAliasName];
    if (envName && stillOurs(baseEnv, envName, recorded)) delete env[envName];
  }
  delete env[WRAPPER_INJECTED_BUILTINS_ENV];
}

export function applyBuiltinModelOverridesWithProvenance(
  env: NodeJS.ProcessEnv,
  overrides: Partial<Record<BuiltinAliasName, string>> | undefined,
  baseEnv: NodeJS.ProcessEnv,
): void {
  const explicit: NodeJS.ProcessEnv = { ...baseEnv };
  for (const [alias, recorded] of inheritedInjections(baseEnv)) {
    const envName = BUILTIN_ALIAS_ENV[alias as BuiltinAliasName];
    if (envName && stillOurs(baseEnv, envName, recorded)) delete explicit[envName];
  }
  clearInheritedBuiltinOverrides(env, baseEnv);
  applyBuiltinModelOverrides(env, overrides, explicit);
  const injected = (Object.entries(BUILTIN_ALIAS_ENV) as Array<[BuiltinAliasName, string]>)
    .filter(([alias, envName]) => explicit[envName] === undefined && env[envName] !== undefined
      && String(overrides?.[alias] ?? '').trim() !== '')
    .map(([alias, envName]) => `${alias}=${encodeURIComponent(String(env[envName]))}`);
  if (injected.length > 0) env[WRAPPER_INJECTED_BUILTINS_ENV] = injected.join(',');
  else delete env[WRAPPER_INJECTED_BUILTINS_ENV];
}

/**
 * Explicit marker a per-session proxy launch stamps into its child env:
 * `<port>:<owner-pid>`. Path heuristics (a "clodex" substring in the CA
 * path) fail for custom CLODEX_HOMEs and combined-ca bundles, so
 * session-proxy detection uses this marker cross-checked against the live
 * proxy var AND the owner process's liveness.
 */
export const SESSION_PROXY_ENV = 'CLODEX_SESSION_PROXY';

/**
 * True when the environment still routes through a live per-session clodex
 * proxy: `clodex claude --proxy` deliberately publishes no runtime record,
 * so a wrapper invoked inside that session sees state=null while the
 * inherited HTTP(S)_PROXY still points at the running proxy. Clearing the
 * session's remap there would break the very routing the session set up.
 * Three conditions gate preservation: the marker parses as
 * `<port>:<owner-pid>`, the proxy var agrees on the port, and the owner
 * process is still alive — a crashed session must fall through to the
 * normal no-server path instead of sending requests to a dead port.
 * Port-only markers (older format) are unverifiable and never preserve.
 */
export function insideSessionProxy(
  baseEnv: NodeJS.ProcessEnv,
  isAlive: (pid: number) => boolean,
): boolean {
  const marker = /^(\d+):(\d+)$/.exec((baseEnv[SESSION_PROXY_ENV] ?? '').trim());
  if (!marker) return false;
  const proxy = baseEnv['HTTPS_PROXY'] ?? baseEnv['https_proxy'] ?? '';
  if (proxy !== `http://127.0.0.1:${marker[1]}`) return false;
  return isAlive(Number(marker[2]));
}
