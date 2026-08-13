# Fork maintenance workflow

This guide describes the intended workflow for maintaining a personal clodex fork. The repository's
upstream release automation remains documented in [`RELEASING.md`](../RELEASING.md).

> **Target steady state, not current accomplished state.** The branch model below is the destination
> after the current migration is proven. Follow [Current transition](#current-transition) until then.

## Branch model

| Branch or ref | Role in the target steady state |
| --- | --- |
| Fork `main` | A clean mirror of upstream once the current migration is proven. |
| `limitless/stable` | The reviewed personal release and install branch. |
| `stack/<program>` plus checkpoint branches | The canonical linear development history. Checkpoints identify contiguous ranges that can be reviewed and transplanted in order. |
| `contrib/<pr>` | A disposable upstream publication branch, created only when its checkpoint range is eligible for an origin PR. |

Keep upstreamable commits below fork-only or personal commits in the fork history. Build and review
the upstreamable stack first; keep fork-only work above it and out of origin PR ranges.

## Why publication is staged

Cross-fork PRs cannot display a true stack unless the upstream repository owns and exposes the
intermediate base branches. Without maintainer-owned base branches, every cross-fork PR resolves
against an upstream branch such as `main`, so the dependency chain is not represented faithfully.

Build and review the complete stack in the fork instead. Publish only the first eligible origin PR.
After that PR merges, fetch the newly merged upstream `main`, create the next disposable
`contrib/<pr>` branch from it, and transplant the next contiguous checkpoint range. Repeat in order;
do not publish later ranges before their predecessors merge.

## Native Git workflow

A contiguous range is written with an exclusive parent and inclusive tip. `A^..B` includes both
`A` and `B`; `A..B` excludes `A`.

```bash
# Inspect and transplant one checkpoint range.
git log --oneline <first-checkpoint>^..<last-checkpoint>
git switch -c contrib/<pr> upstream/main
git cherry-pick <first-checkpoint>^..<last-checkpoint>

# After the preceding origin PR merges, start the next range at the new upstream main.
git fetch upstream main
git switch -c contrib/<next-pr> upstream/main
git cherry-pick <next-first-checkpoint>^..<next-last-checkpoint>
```

Compare the original range with its transplanted range before requesting review:

```bash
git range-diff <old-base>..<old-tip> <new-base>..<new-tip>
```

Repository-local rerere can reuse known conflict resolutions during repeated transplants:

```bash
git config --local rerere.enabled true
git config --local rerere.autoupdate true
git rerere status
```

`rerere.autoupdate` may stage a recorded resolution automatically. Always inspect `git diff` and
`git diff --cached`, then run the focused validation, before committing; never treat rerere's
success as review of the resulting tree.

## Fork integration and installation

Use one fork integration PR into `limitless/stable` for the assembled personal branch. Keep that
integration separate from disposable `contrib/<pr>` publication branches and from upstream PRs.

Tag and install only an immutable commit SHA whose complete change has been reviewed and passed the
required gates. Do not install a moving branch or an unreviewed checkpoint. Before replacing a
known-good install, retain rollback tags and/or branches pointing at its immutable SHA.

## Current transition

**Migration is in progress; the target branch model above is not yet accomplished.** Do not change
fork `main`, origin PRs, or the installed clodex until the current best-available integration is
proven.

The current origin sequence is `#100 → #110 → #113 → #101 → #102 → #103 → #104`. Existing
successor PRs remain draft placeholders while source work continues in the fork. After each precursor
merges, transplant and revalidate only the next focused range against the resulting upstream `main`,
then make only that PR ready.

## Non-negotiable constraints

- Keep package publication on the repository release path in [`RELEASING.md`](../RELEASING.md); this
  workflow adds no local package-publication path.
- Preserve [`CLAUDE.md#tests`](../CLAUDE.md#tests): never automate `claude -p`.
