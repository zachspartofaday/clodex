import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * The probe's verdict function, lifted out of the script by source slice.
 *
 * The script is plain ESM with no exports and a live network call in its body,
 * so it cannot be imported — but the classification is the part that can be
 * wrong in a way nobody notices, because a wrong verdict produces a
 * plausible-looking map rather than an error. Slicing it out means a rename or
 * deletion fails here rather than silently removing the coverage.
 */
async function loadClassifier(): Promise<(
  baseline: number[],
  observed: { readings?: number[]; rejection?: { status: number; error: string }; transient?: unknown },
) => { verdict: string; detail: string }> {
  const source = await readFile('scripts/probe-opencode-effort.mjs', 'utf8');
  const start = source.indexOf('function classify');
  const end = source.indexOf('const catalog =');
  expect(start, 'classify() missing from the probe').toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return new Function(`${source.slice(start, end)}; return classify;`)() as never;
}

describe('probe effort classification', () => {
  it('does not read noise as support', async () => {
    // Reasoning length is stochastic, so an IGNORED value drifts from the
    // baseline by chance. One sample per level would have called this
    // supported and written it into the map.
    const classify = await loadClassifier();
    const result = classify([100, 140, 120], { readings: [130, 105, 118] });
    expect(result.verdict).toBe('inconclusive');
    expect(result.detail).toContain('overlaps baseline');
  });

  it('accepts only a range that never touches the baseline', async () => {
    const classify = await loadClassifier();
    expect(classify([100, 104, 102], { readings: [400, 420, 390] }).verdict).toBe('supported');
  });

  it('does not read the gateway default as inert', async () => {
    // Omitting reasoning_effort does not mean "no reasoning" — the gateway has
    // its own default, so whichever level equals it legitimately matches the
    // baseline. Calling that inert would disable a supported level.
    const classify = await loadClassifier();
    const result = classify([100, 104, 102], { readings: [100, 104, 102] });
    expect(result.verdict).toBe('inconclusive');
    expect(result.detail).toContain('gateway default');
  });

  it('never turns a transient failure into a rejection', async () => {
    // A timeout, rate limit or 5xx during a long sequential paid run would
    // otherwise be recorded as unsupported and null that level in the map.
    const classify = await loadClassifier();
    const result = classify([100, 104, 102], { readings: [], transient: { error: '429' } });
    expect(result.verdict).toBe('inconclusive');
    expect(result.verdict).not.toBe('rejected');
  });

  it('reserves rejected for an explicit parameter refusal', async () => {
    const classify = await loadClassifier();
    const result = classify([100, 104, 102], {
      rejection: { status: 400, error: 'invalid reasoning_effort' },
    });
    expect(result.verdict).toBe('rejected');
    expect(result.detail).toContain('400');
  });

  it('treats a single overlapping sample as inconclusive, not evidence', async () => {
    // Guards the guard: with one trial there is no range to be disjoint from,
    // so nothing should reach `supported` on a coincidence.
    const classify = await loadClassifier();
    expect(classify([100], { readings: [100] }).verdict).toBe('inconclusive');
    expect(classify([100], { readings: [101] }).verdict).toBe('supported');
  });
});
