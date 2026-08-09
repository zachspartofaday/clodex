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
// where reasoning_effort is inert and the real control is `enable_thinking`. So
// each level is compared against a no-effort baseline on reasoning-token count:
// a level that is accepted but produces baseline reasoning is reported as
// INERT, not supported. Levels that collapse onto each other's token counts are
// flagged too, since they are likely aliases rather than distinct grades.
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
    return {
      status: response.status,
      ok: response.ok,
      reasoning: response.ok ? reasoningTokens(payload) : undefined,
      // Bounded: an error body can echo the request.
      error: response.ok ? undefined : (payload?.error?.message ?? text).slice(0, 120),
    };
  } catch (err) {
    return { status: 0, ok: false, error: `transport: ${(err instanceof Error ? err.message : String(err)).slice(0, 80)}` };
  }
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
  process.stderr.write(`\n${model.id}\n`);

  const baseline = await callModel(id, undefined);
  if (!baseline.ok) {
    process.stderr.write(`  baseline FAILED (${baseline.status}) ${baseline.error ?? ''}\n`);
    process.stderr.write('  skipping: without a baseline an accepted level cannot be told from an inert one\n');
    results[model.id] = { error: `baseline ${baseline.status}`, detail: baseline.error };
    continue;
  }
  process.stderr.write(`  baseline           reasoning=${baseline.reasoning}\n`);
  await sleep(PAUSE_MS);

  const accepted = [];
  const inert = [];
  const rejected = [];
  const byTokens = new Map();

  for (const level of LEVELS) {
    const result = await callModel(id, level);
    if (!result.ok) {
      rejected.push(level);
      process.stderr.write(`  ${level.padEnd(8)} REJECTED  ${result.status} ${result.error ?? ''}\n`);
    } else if (result.reasoning === baseline.reasoning) {
      // Accepted by the wire, but indistinguishable from sending nothing.
      inert.push(level);
      process.stderr.write(`  ${level.padEnd(8)} inert     reasoning=${result.reasoning} (== baseline)\n`);
    } else {
      accepted.push(level);
      const seen = byTokens.get(result.reasoning);
      byTokens.set(result.reasoning, [...(seen ?? []), level]);
      process.stderr.write(`  ${level.padEnd(8)} accepted  reasoning=${result.reasoning}\n`);
    }
    await sleep(PAUSE_MS);
  }

  const aliases = [...byTokens.values()].filter(group => group.length > 1);
  results[model.id] = { baseline: baseline.reasoning, accepted, inert, rejected, aliases };
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log('\n\n// PATCHES-ready — paste into scripts/update-opencode-go-models.mjs');
  console.log(`// Probed against ${COMPLETIONS_URL} on ${new Date().toISOString().slice(0, 10)}.`);
  for (const [id, result] of Object.entries(results)) {
    if (result.error) {
      console.log(`// ${id}: probe inconclusive (${result.error})`);
      continue;
    }
    if (result.accepted.length === 0) {
      console.log(`'${id}': { supportsReasoningEffort: false },  // no level changed the output`);
      continue;
    }
    const map = Object.fromEntries(LEVELS.map(level => [level, result.accepted.includes(level) ? level : null]));
    // clodex spells "no reasoning" as `off`; the gateway's own token is `none`.
    if ('none' in map) {
      map.off = map.none;
      delete map.none;
    }
    const inline = Object.entries(map).map(([k, v]) => `${k}: ${v === null ? 'null' : `'${v}'`}`).join(', ');
    console.log(`'${id}': { reasoningEffortMap: { ${inline} } },`);
    if (result.inert.length > 0) console.log(`//   inert (accepted, no effect): ${result.inert.join('/')}`);
    if (result.aliases.length > 0) {
      console.log(`//   likely aliases: ${result.aliases.map(group => group.join('=')).join(', ')}`);
    }
  }
  console.log('\n// Distinct values matter: identical provider options dedup, and');
  console.log('// projectNativeEffort discards a capability missing low/medium/high.');
}
