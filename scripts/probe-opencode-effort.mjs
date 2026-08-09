#!/usr/bin/env node
//
// Probe which reasoning-effort values OpenCode Go actually accepts, per model.
//
// PATCHES in update-opencode-go-models.mjs is documented as "validated against
// the live endpoint". For the effort ladders that has been aspirational: the
// values came from upstream vendors' own API references (which describe THEIR
// endpoint, not OpenCode's gateway) and from models.dev (a community catalog
// of model specifications, not a statement of what the gateway accepts). Where
// those two disagree, we have been guessing. This settles it.
//
//   OPENCODE_API_KEY=sk-... node scripts/probe-opencode-effort.mjs
//   OPENCODE_API_KEY=sk-... node scripts/probe-opencode-effort.mjs --model kimi-k3
//   OPENCODE_API_KEY=sk-... node scripts/probe-opencode-effort.mjs --json
//
// Accepted is NOT the whole question. A gateway that ignores an unknown value
// answers 200 while the level does nothing — qwen3.6-plus is exactly that case,
// where reasoning_effort is inert and the real control is `enable_thinking`.
//
// But reasoning length is STOCHASTIC, so a single call per level cannot
// establish causality either: an ignored value can differ from the baseline by
// chance and look supported, and a genuinely supported level can coincide with
// the baseline and look inert. Worse, omitting reasoning_effort does not mean
// "no reasoning" — the gateway has its own default, so whichever level equals
// that default legitimately matches the baseline.
//
// So each setting is sampled several times and a level is only called
// supported when its samples are DISJOINT from the baseline's observed range.
// Overlap is reported inconclusive, never inferred either way, and an
// inconclusive level is left out of the generated map rather than nulled —
// disabling a working level silently is the failure mode to avoid.
//
// Read-only: it writes nothing, and prints a PATCHES-ready map to paste.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const CATALOG_PATH = resolve('src/data/opencode-go-models.json');
const COMPLETIONS_URL = 'https://opencode.ai/zen/go/v1/chat/completions';
// clodex's ladder, widest first so an alias collapses onto the stronger label.
const LEVELS = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'];
const REQUEST_TIMEOUT_MS = 60_000;
const PAUSE_MS = 750;
// Samples per setting. Three is enough to expose obvious variance without
// making a full-catalog run expensive; --trials raises it when a model is noisy.
const DEFAULT_TRIALS = 3;
// A transient failure is not a rejection. Retried, and if it persists the level
// is inconclusive rather than being recorded as unsupported.
const TRANSIENT_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const RETRIES = 2;

// Enough work to produce reasoning on a model that reasons, small enough to
// stay cheap: at ~7 requests per model this is the difference between a few
// cents and a few dollars.
const PROMPT = 'What is 17 * 23? Reply with only the number.';
const MAX_TOKENS = 256;

const apiKey = process.env.OPENCODE_API_KEY?.trim();
if (!apiKey) {
  console.error('OPENCODE_API_KEY is not set. This probe needs a live OpenCode Go key.');
  process.exit(2);
}

const args = process.argv.slice(2);
const only = args.includes('--model') ? args[args.indexOf('--model') + 1] : undefined;
const asJson = args.includes('--json');
const trials = args.includes('--trials')
  ? Math.max(2, Number(args[args.indexOf('--trials') + 1]) || DEFAULT_TRIALS)
  : DEFAULT_TRIALS;

const sleep = (ms) => new Promise(done => setTimeout(done, ms));

function reasoningTokens(payload) {
  const usage = payload?.usage ?? {};
  const details = usage.completion_tokens_details ?? usage.output_tokens_details ?? {};
  const counted = details.reasoning_tokens ?? details.reasoning ?? undefined;
  if (typeof counted === 'number') return counted;
  // Some gateways return the text but no token breakdown; fall back to its size
  // so "did it reason at all" is still answerable.
  const message = payload?.choices?.[0]?.message ?? {};
  const text = message.reasoning_content ?? message.reasoning ?? '';
  return typeof text === 'string' && text.length > 0 ? text.length : 0;
}

async function callModel(model, effort) {
  const body = { model, messages: [{ role: 'user', content: PROMPT }], max_tokens: MAX_TOKENS };
  if (effort !== undefined) body.reasoning_effort = effort;
  try {
    const response = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
    if (response.ok) return { outcome: 'ok', reasoning: reasoningTokens(payload) };
    // Bounded: an error body can echo the request.
    const message = (payload?.error?.message ?? text).slice(0, 120);
    return {
      // Only a durable client-side rejection means "this parameter value is not
      // supported". Everything else is weather.
      outcome: TRANSIENT_STATUSES.has(response.status) ? 'transient' : 'rejected',
      status: response.status,
      error: message,
    };
  } catch (err) {
    const detail = (err instanceof Error ? err.message : String(err)).slice(0, 80);
    return { outcome: 'transient', status: 0, error: `transport: ${detail}` };
  }
}

/** Sample one setting `trials` times, retrying transient failures. */
async function sample(model, effort, label) {
  const readings = [];
  let rejection;
  let transient;
  for (let trial = 0; trial < trials; trial++) {
    let result;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      result = await callModel(model, effort);
      if (result.outcome !== 'transient') break;
      await sleep(PAUSE_MS * (attempt + 2));
    }
    if (result.outcome === 'ok') readings.push(result.reasoning);
    else if (result.outcome === 'rejected') rejection = result;
    else transient = result;
    await sleep(PAUSE_MS);
  }
  process.stderr.write(
    `  ${label.padEnd(9)} ${rejection ? `REJECTED ${rejection.status} ${rejection.error}` : ''}`
    + `${!rejection && readings.length ? `reasoning=[${readings.join(', ')}]` : ''}`
    + `${!rejection && !readings.length ? `unreachable (${transient?.error ?? 'unknown'})` : ''}\n`,
  );
  return { readings, rejection, transient };
}

/**
 * Disjoint ranges are the only evidence accepted here.
 *
 * With a handful of samples, overlapping ranges cannot distinguish "this level
 * does nothing" from "this level does something and the model is noisy" — and
 * matching the baseline is ALSO what the gateway's own default level looks
 * like. So overlap yields `inconclusive`, and only a range that never touches
 * the baseline's counts as support.
 */
function classify(baseline, observed) {
  if (observed.rejection) return { verdict: 'rejected', detail: `${observed.rejection.status} ${observed.rejection.error}` };
  if (observed.readings.length === 0) return { verdict: 'inconclusive', detail: 'no successful trial' };
  const lo = (values) => Math.min(...values);
  const hi = (values) => Math.max(...values);
  const overlaps = lo(observed.readings) <= hi(baseline) && lo(baseline) <= hi(observed.readings);
  if (!overlaps) return { verdict: 'supported', detail: `[${observed.readings.join(', ')}] vs baseline [${baseline.join(', ')}]` };
  const identical = observed.readings.every(value => baseline.includes(value)) && baseline.every(value => observed.readings.includes(value));
  return {
    verdict: 'inconclusive',
    detail: identical
      ? 'identical to baseline — inert, or the gateway default'
      : `overlaps baseline [${baseline.join(', ')}] — raise --trials to separate`,
  };
}

const catalog = JSON.parse(await readFile(CATALOG_PATH, 'utf8'));
const models = (catalog.models ?? catalog)
  .filter(model => model.modelFormat === 'openai')
  .filter(model => !only || model.id === only);

if (models.length === 0) {
  console.error(only ? `No openai-format model called "${only}" in the catalog.` : 'No openai-format models found.');
  process.exit(2);
}

const results = {};

for (const model of models) {
  const id = model.upstreamModelId ?? model.id;
  process.stderr.write(`\n${model.id}  (${trials} trials per setting)\n`);

  const baseline = await sample(id, undefined, 'baseline');
  if (baseline.readings.length === 0) {
    process.stderr.write('  skipping: without a baseline nothing can be compared against\n');
    results[model.id] = { inconclusive: ['baseline unreachable'] };
    continue;
  }

  const supported = [];
  const inconclusive = [];
  const rejected = [];
  const detail = {};

  for (const level of LEVELS) {
    const observed = await sample(id, level, level);
    const { verdict, detail: why } = classify(baseline.readings, observed);
    detail[level] = why;
    if (verdict === 'supported') supported.push(level);
    else if (verdict === 'rejected') rejected.push(level);
    else inconclusive.push(level);
    process.stderr.write(`  ${' '.repeat(9)}└─ ${verdict}: ${why}\n`);
  }

  results[model.id] = { baseline: baseline.readings, supported, inconclusive, rejected, detail };
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log('\n\n// PATCHES-ready — paste into scripts/update-opencode-go-models.mjs');
  console.log(`// Probed against ${COMPLETIONS_URL} on ${new Date().toISOString().slice(0, 10)}, ${trials} trials per level.`);
  console.log('// Only levels whose reasoning length was DISJOINT from the no-effort');
  console.log('// baseline are mapped. Inconclusive levels are omitted rather than');
  console.log('// nulled: silently disabling a working level is the worse error.');
  for (const [id, result] of Object.entries(results)) {
    console.log('');
    if (result.inconclusive && !result.supported) {
      console.log(`// ${id}: probe inconclusive (${result.inconclusive.join('; ')})`);
      continue;
    }
    if (result.supported.length === 0) {
      console.log(`// ${id}: no level was distinguishable from the baseline.`);
      console.log(`//   Consider supportsReasoningEffort: false — but confirm it is not just`);
      console.log(`//   noise first: ${result.inconclusive.join('/') || 'none'} were inconclusive.`);
      continue;
    }
    const mapped = Object.fromEntries(LEVELS
      .filter(level => result.supported.includes(level) || result.rejected.includes(level))
      .map(level => [level, result.supported.includes(level) ? level : null]));
    if ('none' in mapped) {
      // clodex spells "no reasoning" as `off`; the gateway's token is `none`.
      mapped.off = mapped.none;
      delete mapped.none;
    }
    const inline = Object.entries(mapped).map(([k, v]) => `${k}: ${v === null ? 'null' : `'${v}'`}`).join(', ');
    console.log(`'${id}': { reasoningEffortMap: { ${inline} } },`);
    for (const level of result.inconclusive) {
      console.log(`//   ${level}: INCONCLUSIVE — ${result.detail[level]}`);
    }
  }
  console.log('\n// Distinct values matter: identical provider options dedup, and');
  console.log('// projectNativeEffort discards a capability missing low/medium/high.');
  console.log('// Re-run with --trials 5 on any model reporting overlap.');
}
