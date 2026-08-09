import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildOpenCodeGoModels } from '../src/data/opencode-go-models.js';

/**
 * The updater's advisory catalog comparison, exercised directly.
 *
 * models.dev is a community-maintained catalog of model specifications, not a
 * description of what OpenCode's gateway accepts, so this reports divergence
 * and never fails an update — only a live call to the endpoint settles which
 * side is right. These tests pin that it REPORTS the right things, and
 * specifically that it does not pretend to adjudicate.
 *
 * `reportEffortLadderDivergence` lives in the generator script, which is plain ESM with
 * no exports and a network call in `main()`. It is lifted out by source slice
 * rather than imported so the check is covered without running the updater —
 * and so a rename or deletion of it fails here rather than silently removing
 * the guard.
 */
async function loadChecker(): Promise<(
  supported: unknown[],
  devModels: Record<string, unknown>,
) => { notes: string[] }> {
  const source = await readFile('scripts/update-opencode-go-models.mjs', 'utf8');
  const start = source.indexOf('function reportEffortLadderDivergence');
  const end = source.indexOf('async function fetchJson');
  expect(start, 'reportEffortLadderDivergence missing from the updater').toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return new Function(`${source.slice(start, end)}; return reportEffortLadderDivergence;`)() as never;
}

const effortFeed = (values: string[]) => ({ reasoning_options: [{ type: 'effort', values }] });
const toggleFeed = () => ({ reasoning_options: [{ type: 'toggle' }, { type: 'budget_tokens' }] });

describe('updater catalog divergence report', () => {
  it('flags a map sending values the catalog does not list, without failing', async () => {
    // Worth surfacing — it may mean the catalog is incomplete, or that the
    // gateway will reject the value. Only a live call distinguishes them, so
    // this prompts a test rather than blocking the update.
    const report = await loadChecker();
    const result = report(
      [{ id: 'glm-5.2', compatibility: { reasoningEffortMap: { low: 'low', high: 'high', max: 'max' } } }],
      { 'glm-5.2': effortFeed(['high', 'max']) },
    );
    expect(result.notes.join('\n')).toContain('sends low');
    expect(result.notes.join('\n')).toContain('verify against the live endpoint');
  });

  it('flags capability the catalog lists but the map does not send', async () => {
    const report = await loadChecker();
    const result = report(
      [{ id: 'deepseek-v4-flash', compatibility: { reasoningEffortMap: { high: 'high', max: 'max' } } }],
      { 'deepseek-v4-flash': effortFeed(['low', 'high', 'max']) },
    );
    expect(result.notes[0]).toContain('also lists low');
  });

  it('recognises an effort used as a toggle proxy, by shape rather than by id', async () => {
    const report = await loadChecker();
    const result = report(
      [{ id: 'qwen3.6-plus', compatibility: { thinkingFormat: 'qwen', reasoningEffortMap: { medium: 'high' } } }],
      { 'qwen3.6-plus': toggleFeed() },
    );
    expect(result.notes[0]).toContain('toggle proxy');
  });

  it('does not treat a toggle catalog entry as a blanket excuse', async () => {
    const report = await loadChecker();
    const result = report(
      [{ id: 'someday', compatibility: { reasoningEffortMap: { medium: 'high' } } }],
      { someday: toggleFeed() },
    );
    expect(result.notes.join('\n')).toContain('not listed by models.dev');
  });

  it('notes a suppressed model the catalog still lists a ladder for', async () => {
    const report = await loadChecker();
    const result = report(
      [{ id: 'glm-5.1', compatibility: { supportsReasoningEffort: false } }],
      { 'glm-5.1': effortFeed(['high']) },
    );
    expect(result.notes[0]).toContain('suppressed locally');
  });

  it('reports rather than adjudicates: no shape of disagreement fails', async () => {
    // The property that changed. models.dev is a community catalog, so a
    // disagreement is a prompt to go and test the model — failing the update
    // on it would block a ladder somebody had validated against the live
    // endpoint, which is the only source that settles this.
    const report = await loadChecker();
    const result = report(
      [
        { id: 'a', compatibility: { reasoningEffortMap: { low: 'low' } } },
        { id: 'b', compatibility: { supportsReasoningEffort: false } },
        { id: 'c', compatibility: {} },
      ],
      { a: effortFeed(['max']), b: effortFeed(['high']), c: effortFeed(['low']) },
    );
    expect(Object.keys(result)).toEqual(['notes']);
    expect(result.notes.length).toBeGreaterThan(0);
  });
});
