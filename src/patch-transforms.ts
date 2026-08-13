// src/patch-transforms.ts — clodex patch transforms, applied in-process.
//
// Ported from the relay-ai scripts/patch-custom-models wrapper, originally run
// as a tweakcc `adhoc-patch --script` inside tweakcc's sandbox (with the Claude
// Code source as global `js`). Now a pure function: patcher.ts extracts the
// bundled JS with tweakcc's programmatic `readContent`, calls
// `applyClodexPatches`, and repacks with `writeContent`. The patch sites and
// their regex/replacement logic are unchanged — they are hard-won; do not
// "improve" them.
//
// Inspired by https://github.com/East-rayyy/claude-alias-patch (MIT); this is a
// from-scratch reimplementation with a different patch mechanism and an added
// per-model context window patch.
//
// Each ALIAS is a model identity inside the binary: for any entry that defines
// one or more, every alias (not the canonical `clodex:<provider>:<model>` id)
// lands in the Agent-tool enum, the known-alias validator, the /model picker,
// and the context-window table — so `model: sol` in agent/skill frontmatter
// validates, and so several saved names pointing at one favorite each stay a
// complete identity instead of collapsing to whichever was saved last. Entries
// with no alias fall back to their canonical id as the identity (they still
// join the enum, validator, and context table, but skip the resolver and
// /model picker patches).

import { isReservedModelAlias } from './model-aliases.js';
import {
  CHILD_NETWORK_ENV_VARS,
  NETWORK_ENV_CONTRACT_VAR,
} from './network-env.js';

/**
 * Version of the transform set below — NOT of the patch-state manifest, whose
 * shape is unrelated. It is folded into `computePatchConfigHash`, so bumping it
 * is what makes an existing install read as `stale-config` and repatch.
 *
 * IMPORTANT: bump this whenever the transform set changes materially — adding or
 * removing a PATCH site, or changing a site's regex, replacement, or ordering.
 * Without a bump, users whose favorites are unchanged keep the OLD patch forever
 * and never receive the new transforms, silently. `tests/patcher.test.ts` pins a
 * hash of the transform inputs to force that decision to be made rather than
 * forgotten.
 */
export const PATCH_TRANSFORMS_VERSION = 10;

export interface PatchScriptModelEntry {
  /** Ordered native identities for this model, in saved alias order. */
  aliases?: string[];
  /** Legacy single-identity input, accepted while callers migrate to `aliases`. */
  alias?: string;
  context?: number;
  /** Human label for the /model picker, e.g. `GPT-5.6 Sol (OpenAI (ChatGPT))`. */
  display?: string;
  /** Provider reasoning levels projected onto Claude Code's native effort ladder. */
  effort?: PatchScriptEffort;
}

export interface PatchScriptEffort {
  levels: string[];
  defaultLevel: string;
}

/** Real model id (e.g. `clodex:openai-oauth:gpt-5.6-sol`) → alias/context. */
export type PatchScriptModelConfig = Record<string, PatchScriptModelEntry>;

/**
 * The ordered aliases an entry carries, normalized the same way saved aliases
 * are. The legacy single `alias` comes first so a mixed entry keeps a stable
 * order, and so `{alias:'x'}` and `{aliases:['x']}` are the same configuration
 * to every consumer — including the freshness hash.
 */
export function patchEntryAliases(entry: PatchScriptModelEntry): string[] {
  return [
    ...(entry.alias === undefined ? [] : [entry.alias]),
    ...(entry.aliases ?? []),
  ].map(alias => String(alias).trim().toLowerCase());
}

const NATIVE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const BASE_EFFORT_LEVELS = ['low', 'medium', 'high'] as const;

export function projectNativeEffort(
  effort: PatchScriptEffort | undefined,
): PatchScriptEffort | undefined {
  if (!effort || !Array.isArray(effort.levels) || typeof effort.defaultLevel !== 'string') return undefined;
  const declared = new Set(effort.levels);
  const levels = NATIVE_EFFORT_LEVELS.filter(level => declared.has(level));
  if (!BASE_EFFORT_LEVELS.every(level => declared.has(level))) return undefined;
  if (!levels.some(level => level === effort.defaultLevel)) return undefined;
  // The native client defaults custom identities to high; preserve that contract.
  return { levels, defaultLevel: 'high' };
}

export type PatchSiteStatus = 'OK' | 'SKIP' | 'FAIL';

export interface PatchSiteResult {
  status: PatchSiteStatus;
  name: string;
  extra?: string;
}

export interface ApplyPatchesOutcome {
  /** The patched Claude Code source. */
  content: string;
  /** Per-site outcome, in patch order. */
  results: PatchSiteResult[];
}

/**
 * Thrown when a required patch site fails (or the config is invalid). Carries
 * the per-site results collected up to the failure so `--trace` can report
 * exactly what the sandboxed script used to print.
 */
export class PatchApplyError extends Error {
  readonly results: PatchSiteResult[];
  constructor(message: string, results: PatchSiteResult[]) {
    super(message);
    this.name = 'PatchApplyError';
    this.results = results;
  }
}

/** One report line, same format the tweakcc-sandbox script wrote to stderr. */
export function formatPatchSiteLine(result: PatchSiteResult): string {
  return '  ' + result.status.padEnd(4) + ' ' + result.name + (result.extra ? ' — ' + result.extra : '');
}

/**
 * Apply the clodex patch sites (PATCH 1–10) to the Claude Code source.
 * Pure: source string in → patched string + per-site results out. Throws
 * `PatchApplyError` when the config is invalid or a required site fails —
 * nothing should be written to the binary in that case.
 */
export function applyClodexPatches(source: string, config: PatchScriptModelConfig): ApplyPatchesOutcome {
  let js = source;
  const MODEL_CONFIG = config;
  const MODEL_ENTRIES = Object.entries(MODEL_CONFIG);

  // ---- derive helpers ------------------------------------------------------
  // alias -> model id (only for entries that define aliases)
  const ALIAS_TO_ID: Record<string, string> = Object.create(null);
  const ALIASES: string[] = [];
  // The names Claude Code knows a model by: every alias when it has any, else
  // its canonical id. These values are used for the Agent-tool enum, the
  // known-alias validator, the /model picker value, and the context-window table,
  // so the name the binary validates == the name it sends upstream == the name
  // the proxy echoes back == the key its context window is stored under.
  const IDENTITIES: string[] = [];
  // identity -> human label for the /model picker (falls back at use site)
  const DISPLAY_BY_IDENTITY: Record<string, string> = Object.create(null);
  // lowercased alias AND id -> context-window tokens (only for models that set it)
  const CONTEXT_BY_KEY: Record<string, number> = Object.create(null);
  const CONTEXT_KEYS: string[] = [];
  // lowercased alias AND id for every configured model. Capability verdicts
  // must distinguish configured-false from an unknown identity that may use
  // the native fallback.
  const CONFIGURED_CAPABILITY_KEYS = new Set<string>();
  const CAPABILITY_KEYS: string[] = [];
  // lowercased alias AND id -> effort metadata for Claude Code's capability gates.
  const EFFORT_BY_KEY = Object.create(null) as Record<
    string,
    PatchScriptModelEntry['effort']
  >;
  const EFFORT_KEYS: string[] = [];

  const report: PatchSiteResult[] = [];
  const fail = (message: string): never => {
    throw new PatchApplyError(message, report);
  };
  const capabilityKeys = (value: string): string[] => {
    const normalized = value.trim().toLowerCase();
    const bare = normalized.replace(/\[1m\]$/i, '');
    return [...new Set([bare, `${bare}[1m]`])];
  };
  const registerCapabilityKeys = (value: string): void => {
    for (const key of capabilityKeys(value)) {
      if (!CONFIGURED_CAPABILITY_KEYS.has(key)) CAPABILITY_KEYS.push(key);
      CONFIGURED_CAPABILITY_KEYS.add(key);
    }
  };
  const registerOrderedValue = <T>(
    keys: string[],
    values: Record<string, T>,
    key: string,
    value: T,
  ): void => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) keys.push(key);
    values[key] = value;
  };

  for (const [id, value] of MODEL_ENTRIES) {
    const spec: PatchScriptModelEntry = value && typeof value === 'object' ? value : { alias: value as unknown as string };
    if (spec.aliases !== undefined && !Array.isArray(spec.aliases)) {
      fail('clodex patch: aliases for "' + id + '" must be an array');
    }
    const rawAliases: unknown[] = [
      ...(spec.alias === undefined ? [] : [spec.alias]),
      ...(spec.aliases ?? []),
    ];
    for (const raw of rawAliases) {
      if (typeof raw !== 'string') {
        fail('clodex patch: alias for "' + id + '" must be a string');
      }
    }
    const aliases = patchEntryAliases(spec);
    for (const [index, a] of aliases.entries()) {
      const raw = rawAliases[index] as string;
      if (!/^[a-z0-9][a-z0-9._-]*(\[1m\])?$/.test(a)) {
        fail('clodex patch: alias "' + raw + '" is not a safe lowercase alias');
      }
      if (isReservedModelAlias(a)) {
        fail('clodex patch: reserved alias "' + a + '" cannot be reassigned');
      }
      // Two entries (or one entry twice) claiming a name would silently make the
      // later one win the resolver and context lookups. Fail instead.
      if (ALIAS_TO_ID[a] !== undefined) {
        fail('clodex patch: alias "' + a + '" is configured more than once');
      }
      ALIAS_TO_ID[a] = String(id);
      ALIASES.push(a);
      IDENTITIES.push(a);
      if (spec.display) DISPLAY_BY_IDENTITY[a] = String(spec.display);
    }
    if (aliases.length === 0) {
      IDENTITIES.push(String(id));
      if (spec.display) DISPLAY_BY_IDENTITY[String(id)] = String(spec.display);
    }
    for (const alias of aliases) {
      registerCapabilityKeys(alias);
    }
    registerCapabilityKeys(String(id));

    if (spec.context !== undefined) {
      const n = Number(spec.context);
      if (!Number.isInteger(n) || n <= 0) {
        fail('clodex patch: context for "' + id + '" must be a positive integer, got ' + spec.context);
      }
      // A [1m] suffix hard-codes 1M upstream (and sends the context-1m beta header
      // + raises the media cap). An explicit context on a [1m] model would win via
      // PATCH 7 while those side effects silently stayed on — so reject it.
      if (aliases.some(alias => /\[1m\]/i.test(alias)) || /\[1m\]/i.test(id)) {
        fail(
          'clodex patch: "' + id + '" sets context but keeps the [1m] suffix — drop the suffix from the id and every alias'
        );
      }
      for (const alias of aliases) {
        registerOrderedValue(CONTEXT_KEYS, CONTEXT_BY_KEY, alias, n);
      }
      registerOrderedValue(
        CONTEXT_KEYS,
        CONTEXT_BY_KEY,
        String(id).trim().toLowerCase(),
        n,
      );
    }

    if (spec.effort) {
      const effort = projectNativeEffort(spec.effort);
      if (!effort) {
        fail(
          `clodex patch: effort for "${id}" must include low, medium, and high with a native default`,
        );
      }
      for (const alias of aliases) {
        for (const key of capabilityKeys(alias)) {
          registerOrderedValue(EFFORT_KEYS, EFFORT_BY_KEY, key, effort);
        }
      }
      for (const key of capabilityKeys(String(id))) {
        registerOrderedValue(EFFORT_KEYS, EFFORT_BY_KEY, key, effort);
      }
    }
  }
  if (MODEL_ENTRIES.length === 0) fail('clodex patch: MODEL_CONFIG is empty');

  /** Picker/description label for an identity; falls back to the old wording. */
  function displayFor(identity: string, fallbackId: string): string {
    return DISPLAY_BY_IDENTITY[identity] || 'Custom model (' + fallbackId + ')';
  }

  const reEsc = (s: string) => s.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
  const q = (s: string) => JSON.stringify(s); // safe JS string literal
  const orderedRecordLiteral = <T>(keys: string[], values: Record<string, T>): string =>
    '{' + keys.map(key => q(key) + ':' + JSON.stringify(values[key])).join(',') + '}';

  // ---- reporting -----------------------------------------------------------
  function log(status: PatchSiteStatus, name: string, extra?: string) {
    report.push(extra === undefined ? { status, name } : { status, name, extra });
  }

  /**
   * Apply exactly one regex replacement.
   *  - marker: if present in js, treat as already-patched -> SKIP.
   *  - expects exactly one match; 0 -> FAIL, >1 -> FAIL (ambiguous).
   *  - fn(match, ...groups) returns the replacement text.
   *  - required: on FAIL, throw (aborts the whole patch).
   */
  function applyOnce(
    name: string,
    regex: RegExp,
    fn: (match: string, ...groups: string[]) => string,
    { marker, required, noopIsSkip }: { marker?: string; required?: boolean; noopIsSkip?: boolean } = {},
  ): void {
    if (marker && js.includes(marker)) { log('SKIP', name, 'already patched'); return; }
    const g = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
    const matches = js.match(g);
    const count = matches ? matches.length : 0;
    if (count === 0) {
      log('FAIL', name, 'anchor not found');
      if (required) fail('clodex patch: required patch failed: ' + name);
      return;
    }
    if (count > 1) {
      log('FAIL', name, 'anchor matched ' + count + ' times (expected 1)');
      if (required) fail('clodex patch: ambiguous anchor: ' + name);
      return;
    }
    const before = js;
    js = js.replace(regex, fn as (substring: string, ...args: unknown[]) => string);
    if (js === before) {
      // For array-extend / append patches, "no change" means the aliases are
      // already present (anchor matched, but fn had nothing new to add) -> SKIP.
      if (noopIsSkip) { log('SKIP', name, 'already patched'); return; }
      log('FAIL', name, 'replacement made no change');
      if (required) fail(name);
      return;
    }
    log('OK', name);
  }

  /** Insert missing identities just before the closing bracket of a JS array literal string. */
  function extendAliasArray(arrLiteral: string): string {
    const toAdd = IDENTITIES.filter((a) => !new RegExp('"' + reEsc(a) + '"').test(arrLiteral));
    if (toAdd.length === 0) return arrLiteral; // idempotent
    return arrLiteral.replace(/\]\s*$/, ',' + toAdd.map(q).join(',') + ']');
  }

  // ---------------------------------------------------------------------------
  // PATCH 1 — Agent/subagent tool 'model' zod enum.
  // Anchor: the aliases array ["sonnet",...,"fable"] wrapped in an enum
  // constructor and immediately followed by .optional().describe(. Builds
  // through 2.1.223 spell the constructor `.enum(`; 2.1.224+ minifies it to a
  // bare helper call on the model property (`model:xr([...])`), so both are
  // accepted. We append our identities (alias when defined, else the canonical
  // id) inside the enum so the tool accepts them — this is the same enum
  // subagent/skill 'model:' frontmatter is validated against, which is why
  // the short alias has to be the value that lands here.
  // (This same .describe( is patched by PATCH 4 below.)
  // ---------------------------------------------------------------------------
  applyOnce(
    'PATCH 1: Agent tool model enum',
    /((?:\.enum|model:[A-Za-z_$][\w$]*)\()(\["sonnet","opus","haiku"(?:,"[^"]+")*\])\)(\.optional\(\)\.describe\()/,
    (_m, open, arr, tail) => open! + extendAliasArray(arr!) + ')' + tail!,
    { required: true, noopIsSkip: true }
  );

  // ---------------------------------------------------------------------------
  // PATCH 3 — known-alias validator list (drives "is this a known alias?").
  // Anchor: the master list literal, matched loosely as
  // ["sonnet","opus","haiku","fable", ...anything... ,"opusplan"] so it
  // tolerates new built-ins being added in the middle. Appending our identities
  // makes them recognized as first-class aliases everywhere the gate runs.
  // ---------------------------------------------------------------------------
  applyOnce(
    'PATCH 3: known-alias validator list',
    /\["sonnet","opus","haiku","fable"(?:,"[^"]+")*,"opusplan"(?:,"[^"]+")*\]/,
    (m) => extendAliasArray(m),
    { required: true, noopIsSkip: true }
  );

  // ---------------------------------------------------------------------------
  // PATCH 6 — alias resolver switch (IDENTITY mapping).
  // Anchor: case"best":{ ... } (the case"best":{ is unique). We inject
  // case"<alias>":return"<alias>"; right after it (before the switch's
  // default:return null).
  //
  // The mapping is deliberately an identity, NOT alias -> canonical id: the alias
  // IS the model's identity everywhere else in the patched binary (enum,
  // validator, picker, context table), and the MITM proxy resolves short alias
  // names as request model ids and echoes request bodies unrewritten. Resolving
  // to the canonical id here would make Claude Code send one name and look its
  // context window up under another — the exact mismatch that stopped auto-compact
  // from firing and killed agents with "Prompt is too long". The case still has to
  // EXIST (rather than be skipped) so the resolver returns the name instead of
  // falling through to default:return null.
  // Only aliases not already present are inserted, so a rerun (or a config
  // edit) tops up cleanly rather than duplicating cases.
  // ---------------------------------------------------------------------------
  {
    const resolverRegex = /(case"best":\{[^{}]*\})((?:case"[^"]+":return[^{};]+;)*)/;
    const classifyResolverSuffix = (suffix: string): { missing: string[]; invalid: string[] } => {
      const missing: string[] = [];
      const invalid: string[] = [];
      for (const a of ALIASES) {
        const labelCount = suffix.match(new RegExp('case' + reEsc(q(a)) + ':', 'g'))?.length ?? 0;
        const selfCount = suffix.match(
          new RegExp('case' + reEsc(q(a)) + ':return ' + reEsc(q(a)) + ';', 'g'),
        )?.length ?? 0;
        if (labelCount === 0) missing.push(a);
        else if (labelCount !== 1 || selfCount !== 1) invalid.push(a);
      }
      return { missing, invalid };
    };
    const resolverMatches = js.match(new RegExp(resolverRegex.source, 'g'));
    const resolverMatch = resolverMatches?.length === 1 ? resolverRegex.exec(js) : undefined;
    const resolverClassification = resolverMatch
      ? classifyResolverSuffix(resolverMatch[2] ?? '')
      : undefined;
    if (ALIASES.length === 0) {
      log('SKIP', 'PATCH 6: alias resolver switch', 'no aliases configured');
    } else if (resolverClassification?.invalid.length) {
      log('FAIL', 'PATCH 6: alias resolver switch', 'invalid alias resolver cases');
      fail('clodex patch: invalid alias resolver cases');
    } else {
      applyOnce(
        'PATCH 6: alias resolver switch',
        resolverRegex,
        (_m, anchor, suffix) => {
          const { missing, invalid } = classifyResolverSuffix(suffix ?? '');
          if (invalid.length) {
            log('FAIL', 'PATCH 6: alias resolver switch', 'invalid alias resolver cases');
            fail('clodex patch: invalid alias resolver cases');
          }
          const cases = missing.map((a) => 'case' + q(a) + ':return ' + q(a) + ';').join('');
          return (anchor ?? '') + cases + (suffix ?? '');
        },
        { required: true, noopIsSkip: true }
      );
    }
  }

  // ---------------------------------------------------------------------------
  // PATCH 5 — interactive /model picker.
  // The picker is assembled through a single choke-point function; we insert,
  // right after its loop, a snippet that appends our custom
  // {value,label,description} entries — with a runtime .some() dedupe guard so
  // it is safe even if the function runs over the same array twice. Only
  // aliases not already injected are added, so reruns top up cleanly.
  // ---------------------------------------------------------------------------
  {
    const escapedJsonString = '"(?:\\\\.|[^"\\\\])*"';
    const pickerEntry = '\\{value:' + escapedJsonString + ',label:' + escapedJsonString + ',description:' + escapedJsonString + '\\}';
    const pickerInjection = '\\[' + pickerEntry
      + '(?:,' + pickerEntry + ')*\\]\\.forEach\\(function\\(_o\\)\\{if\\(!e\\.some\\(function\\(_i\\)\\{return _i\\.value===_o\\.value\\}\\)\\)e\\.push\\(_o\\)\\}\\);';
    const pickerRegex = new RegExp(
      '(\\?\\[[\\w$]+,r\\]:\\[r\\];for\\(let [\\w$]+ of [\\w$]+\\)[\\w$]+\\(e,[\\w$]+,t\\);)'
      + '((?:' + pickerInjection + ')*)',
    );
    const pickerEntryForAlias = (alias: string): string =>
      '{value:' + q(alias)
      + ',label:' + q(alias.charAt(0).toUpperCase() + alias.slice(1))
      + ',description:' + q(displayFor(alias, ALIAS_TO_ID[alias]!))
      + '}';
    const classifyPickerSuffix = (suffix: string): { missing: string[]; invalid: string[] } => {
      const missing: string[] = [];
      const invalid: string[] = [];
      for (const a of ALIASES) {
        const valueOccurrences = suffix.match(
          new RegExp('\\{value:' + reEsc(q(a)) + '(?=,label:)', 'g'),
        )?.length ?? 0;
        const entryOccurrences = suffix.match(
          new RegExp(reEsc(pickerEntryForAlias(a)), 'g'),
        )?.length ?? 0;
        if (valueOccurrences === 0) missing.push(a);
        else if (valueOccurrences !== 1 || entryOccurrences !== 1) invalid.push(a);
      }
      return { missing, invalid };
    };
    const pickerMatches = js.match(new RegExp(pickerRegex.source, 'g'));
    const pickerMatch = pickerMatches?.length === 1 ? pickerRegex.exec(js) : undefined;
    const pickerClassification = pickerMatch
      ? classifyPickerSuffix(pickerMatch[2] ?? '')
      : undefined;
    if (ALIASES.length === 0) {
      log('SKIP', 'PATCH 5: model picker options', 'no aliases configured');
    } else if (pickerClassification?.invalid.length) {
      log('FAIL', 'PATCH 5: model picker options', 'invalid target-owned picker entries');
    } else {
      applyOnce(
        'PATCH 5: model picker options',
        pickerRegex,
        (_m, anchor, suffix) => {
          const { missing } = classifyPickerSuffix(suffix ?? '');
          const entries = missing.map(pickerEntryForAlias).join(',');
          const inject = missing.length
            ? '[' + entries + '].forEach(function(_o){if(!e.some(function(_i){return _i.value===_o.value}))e.push(_o)});'
            : '';
          return (anchor ?? '') + inject + (suffix ?? '');
        },
        { required: false, noopIsSkip: true }
      );
    }
  }

  // ---------------------------------------------------------------------------
  // PATCH 4 — Agent tool 'model' parameter description text.
  // Append the available model names (with their real labels) before the closing
  // backtick so the model knows which extra names it may request and what they
  // actually are. Best-effort (cosmetic). The text is spliced into a backtick
  // template literal, so backticks and interpolation openers are stripped.
  // ---------------------------------------------------------------------------
  {
    const safe = (s: string) => String(s).replace(/`/g, "'").replace(/\$\{/g, '(');
    const listing = IDENTITIES.map(function (i) {
      const d = DISPLAY_BY_IDENTITY[i];
      return d ? safe(i) + ' = ' + safe(d) : safe(i);
    }).join('; ');
    applyOnce(
      'PATCH 4: Agent tool model description',
      /(describe\(`Optional model override for this agent[^`]*?)(`\))/,
      (_m, body, close) =>
        body!.includes('Additional custom models')
          ? body! + close!
          : body! + ' Additional custom models: ' + listing + '.' + close!,
      { required: false, noopIsSkip: true }
    );
  }

  // ---------------------------------------------------------------------------
  // PATCH 7 — per-model context window.
  //
  // Claude Code funnels EVERY context-window consumer (autocompact threshold,
  // /context, the countdown, statusline, cost/usage records, subagent budgets)
  // through one resolver function. We inject a baked table lookup at the TOP of
  // that resolver, so it wins over the 200k clamp and the global
  // CLAUDE_CODE_MAX_CONTEXT_TOKENS env override. Lookup is on the raw,
  // lowercased model string — alias and id are both in the table, so it hits
  // pre- or post-alias-resolution.
  //
  // Anchor: the resolver's exact body shape. Identifiers are wildcarded (they
  // churn per build); the (e,t) arity + 3-statement shape matches once.
  // ---------------------------------------------------------------------------
  if (CONTEXT_KEYS.length) {
    const MARKER = '/*ccpatch:ctx*/';
    const SNIPPET =
      MARKER + 'var _ccw=(' + orderedRecordLiteral(CONTEXT_KEYS, CONTEXT_BY_KEY) + ')[String(e||"").trim().toLowerCase()];if(_ccw!==void 0)return _ccw;';

    if (js.includes(MARKER)) {
      // Re-patching an already-patched binary: refresh the baked table in place
      // so a MODEL_CONFIG edit takes effect without a restore first.
      applyOnce(
        'PATCH 7: per-model context window (refresh)',
        /\/\*ccpatch:ctx\*\/var _ccw=\(\{[^{}]*\}\)\[[^\]]*\];if\(_ccw!==void 0\)return _ccw;/,
        () => SNIPPET,
        { required: true, noopIsSkip: true }
      );
    } else {
      applyOnce(
        'PATCH 7: per-model context window',
        /(function [\w$]+\(e,t\)\{)(let [\w$]+=[\w$]+\(\);if\([\w$]+!==void 0\)return [\w$]+;if\([\w$]+\(e,t\)\)return [\w$]+;return [\w$]+\(e,t\)\})/,
        (_m, head, body) => head! + SNIPPET + body!,
        { required: true }
      );
    }
  }

  // ---------------------------------------------------------------------------
  // PATCH 8 — per-model effort capability gates.
  //
  // Claude Code checks three separate resolvers before it exposes effort at all,
  // includes xhigh/max in the picker, and emits effort.level in status hooks.
  // Inject model-specific lookups after the native denylist, but before the
  // built-in metadata and provider-fallback checks.
  // ---------------------------------------------------------------------------
  function patchEffortCapability(
    capability: 'effort' | 'xhigh_effort' | 'max_effort',
    marker: string,
    name: string,
    anchor: RegExp,
  ): void {
    const verdicts: Record<string, boolean> = Object.create(null);
    for (const key of CAPABILITY_KEYS) {
      const effort = EFFORT_BY_KEY[key];
      verdicts[key] = effort !== undefined && (
        capability === 'effort'
        || effort.levels.includes(capability === 'xhigh_effort' ? 'xhigh' : 'max')
      );
    }
    const hasMarker = js.includes(marker);
    if (CAPABILITY_KEYS.length === 0 && !hasMarker) return;

    const snippet = (arg: string) =>
      marker
      + 'var _ccv=Object.assign(Object.create(null),' + orderedRecordLiteral(CAPABILITY_KEYS, verdicts)
      + ')[String(' + arg + '||"").trim().toLowerCase()];'
      + 'if(_ccv!==void 0)return _ccv;';

    if (hasMarker) {
      const markerPattern = reEsc(marker);
      applyOnce(
        name + ' (refresh)',
        new RegExp(
          markerPattern
          + 'var _ccv=Object\\.assign\\(Object\\.create\\(null\\),\\{[^{}]*\\}\\)'
          + '\\[String\\(([\\w$]+)\\|\\|""\\)\\.trim\\(\\)\\.toLowerCase\\(\\)\\];'
          + 'if\\(_ccv!==void 0\\)return _ccv;',
        ),
        (_m, arg) => snippet(arg!),
        { required: false, noopIsSkip: true },
      );
      return;
    }

    applyOnce(
      name,
      anchor,
      (_m, head, arg, body) => head! + snippet(arg!) + body!,
      { required: false },
    );
  }

  patchEffortCapability(
    'effort',
    '/*ccpatch:effort*/',
    'PATCH 8a: effort capability',
    /(function [\w$]+\(([\w$]+)\)\{if\([\w$]+\(\2\)\)return!1;)(let [\w$]+=[\w$]+\(\2,"effort"\);)/,
  );
  patchEffortCapability(
    'xhigh_effort',
    '/*ccpatch:xhigh-effort*/',
    'PATCH 8b: xhigh effort capability',
    /(function [\w$]+\(([\w$]+)\)\{if\([\w$]+\(\2\)\)return!1;)(let [\w$]+=[\w$]+\(\2,"xhigh_effort"\);)/,
  );
  patchEffortCapability(
    'max_effort',
    '/*ccpatch:max-effort*/',
    'PATCH 8c: max effort capability',
    /(function [\w$]+\(([\w$]+)\)\{if\([\w$]+\(\2\)\)return!1;)(let [\w$]+=[\w$]+\(\2,"max_effort"\);)/,
  );

  // ---------------------------------------------------------------------------
  // PATCH 9 — per-model default effort.
  // ---------------------------------------------------------------------------
  const DEFAULT_EFFORT_MARKER = '/*ccpatch:default-effort*/';
  const defaults: Record<string, string> = Object.create(null);
  for (const key of EFFORT_KEYS) defaults[key] = EFFORT_BY_KEY[key]!.defaultLevel;
  if (EFFORT_KEYS.length || js.includes(DEFAULT_EFFORT_MARKER)) {
    const snippet = (arg: string) =>
      DEFAULT_EFFORT_MARKER
      + 'var _cce=Object.assign(Object.create(null),' + orderedRecordLiteral(EFFORT_KEYS, defaults)
      + ')[String(' + arg + '||"").trim().toLowerCase()];'
      + 'if(_cce!==void 0)return _cce;';

    if (js.includes(DEFAULT_EFFORT_MARKER)) {
      applyOnce(
        'PATCH 9: default effort (refresh)',
        /\/\*ccpatch:default-effort\*\/var _cce=Object\.assign\(Object\.create\(null\),\{[^{}]*\}\)\[String\(([\w$]+)\|\|""\)\.trim\(\)\.toLowerCase\(\)\];if\(_cce!==void 0\)return _cce;/,
        (_m, arg) => snippet(arg!),
        { required: false, noopIsSkip: true },
      );
    } else {
      applyOnce(
        'PATCH 9: default effort',
        /(function [\w$]+\(([\w$]+)\)\{)(return [\w$]+\([\w$]+\(\2\)\)\?\.default_effort\?\?"high"\})/,
        (_m, head, arg, body) => head! + snippet(arg!) + body!,
        { required: false },
      );
    }
  }

  // ---------------------------------------------------------------------------
  // PATCH 10 — child command network environment.
  //
  // The wrapper routes the parent client through a local bridge and records the
  // external and injected values. In the shared child-environment builder,
  // revert a key only while its live value still equals the Clodex injection.
  // Settings-level overrides therefore remain authoritative, and the builder's
  // existing filtering continues against the resulting copy.
  //
  // The anchor tolerates extra declarators between the first `Object.keys(...)
  // .length>0` binding and the `CLAUDE_CODE_REMOTE` ternary: Claude Code 2.1.228
  // hoisted the settings-colour env into one (`r=<mod>.settingsColorEnv`), which
  // a fixed declarator count would have read as a missing anchor. `[^;{}]` keeps
  // the run inside the same `let` statement, and the literal + nested-function
  // checks below still prove the target really is the child-env builder.
  // ---------------------------------------------------------------------------
  {
    const patchName = 'PATCH 10: child network environment';
    const marker = '/*ccpatch:child-network-env*/';
    const contractVar = q(NETWORK_ENV_CONTRACT_VAR);
    const networkVars = JSON.stringify(CHILD_NETWORK_ENV_VARS);
    const requiredBodyLiterals = [
      '{...process.env',
      'CLAUDE_CODE_REMOTE',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_SUBSCRIPTION_TYPE',
      'CLAUDE_BG_PTY_AUTH',
      '"OTEL_"',
      'CLAUDE_CODE_OTEL_DIAG_STDERR',
    ];
    applyOnce(
      patchName,
      /(function [\w$]+\(\)\{)(let [\w$]+=[\w$]+\(\),[\w$]+=Object\.keys\([\w$]+\)\.length>0,[^;{}]*?[\w$]+=[\w$]+\(process\.env\.CLAUDE_CODE_REMOTE\)\?(?:(?!\}\s*function )[\s\S])*?for\(let [\w$]+ of [\w$]+\)delete [\w$]+\[[\w$]+\],delete [\w$]+\[`INPUT_\$\{[\w$]+\}`\];return [\w$]+)(\})/,
      (_match, head, body, tail) => {
        const targetIsValid = requiredBodyLiterals.every(literal => body!.includes(literal))
          && !/\bfunction\s*[\w$]*\(/.test(body!);
        if (!targetIsValid) {
          log('FAIL', patchName, 'target validation failed');
          fail('clodex patch: child network environment target validation failed');
        }
        const restoredBody = body!.replace(/process\.env/g, '_clodexChildEnv');
        const restore = marker
          + 'let _clodexChildEnv=process.env,_clodexNetworkRaw=_clodexChildEnv[' + contractVar + '];'
          + 'if(_clodexNetworkRaw!==void 0){_clodexChildEnv={..._clodexChildEnv};'
          + 'delete _clodexChildEnv[' + contractVar + '];try{'
          + 'let _clodexNetwork=JSON.parse(_clodexNetworkRaw);'
          + 'if(_clodexNetwork&&typeof _clodexNetwork==="object"&&!Array.isArray(_clodexNetwork)'
          + '&&_clodexNetwork.version===1&&_clodexNetwork.original'
          + '&&typeof _clodexNetwork.original==="object"&&!Array.isArray(_clodexNetwork.original)'
          + '&&_clodexNetwork.injected&&typeof _clodexNetwork.injected==="object"'
          + '&&!Array.isArray(_clodexNetwork.injected)'
          + '&&Object.keys(_clodexNetwork.original).every(_clodexKey=>'
          + networkVars + '.includes(_clodexKey)'
          + '&&(typeof _clodexNetwork.original[_clodexKey]==="string"'
          + '||_clodexNetwork.original[_clodexKey]===null)'
          + '&&Object.prototype.hasOwnProperty.call(_clodexNetwork.injected,_clodexKey))'
          + '&&Object.keys(_clodexNetwork.injected).every(_clodexKey=>'
          + networkVars + '.includes(_clodexKey)'
          + '&&(typeof _clodexNetwork.injected[_clodexKey]==="string"'
          + '||_clodexNetwork.injected[_clodexKey]===null)'
          + '&&Object.prototype.hasOwnProperty.call(_clodexNetwork.original,_clodexKey)))'
          + 'for(let _clodexKey of ' + networkVars + '){'
          + 'if(Object.prototype.hasOwnProperty.call(_clodexNetwork.original,_clodexKey)'
          + '&&Object.prototype.hasOwnProperty.call(_clodexNetwork.injected,_clodexKey)){'
          + 'let _clodexOriginal=_clodexNetwork.original[_clodexKey],'
          + '_clodexInjected=_clodexNetwork.injected[_clodexKey],'
          + '_clodexCurrent=_clodexChildEnv[_clodexKey]===void 0?null:_clodexChildEnv[_clodexKey];'
          + 'if((typeof _clodexOriginal==="string"||_clodexOriginal===null)'
          + '&&(typeof _clodexInjected==="string"||_clodexInjected===null)'
          + '&&_clodexCurrent===_clodexInjected){if(_clodexOriginal===null)'
          + 'delete _clodexChildEnv[_clodexKey];else '
          + '_clodexChildEnv[_clodexKey]=_clodexOriginal}}}}catch(_clodexError){}}';
        return head! + restore + restoredBody + tail!;
      },
      { marker, required: true },
    );
  }

  return { content: js, results: report };
}
