---
name: pr-review-guide
description: Turn a GitHub pull request into an interactive, pedagogic review page (one local HTML file opened in the browser) with a verdict and executive summary, a claims check of the PR description against the diff and CI, a narrated code walkthrough with a sticky code panel, Mermaid diagrams, a reading order, risks, a tickable merge checklist, concept explainers with a quiz, and the full diff. Use it whenever the user wants to review, understand, be walked through or have explained a GitHub PR, from a PR number, a github.com/…/pull/N link, "my open PR" or "the PR Claude just opened", and especially for PRs written by AI agents. Trigger even on short asks like "help me review #130", "what does this PR actually do?" or "should I merge this?". It does not post reviews to GitHub, and it is not for changes that are not a GitHub PR.
---

# PR review guide

The reader is the person who has to decide whether to merge, usually a PR an AI agent wrote. They did not write
the code, may not know every library it touches, and have limited time. The page gets them from "what is this?"
to "I understand it and know what to check" in about ten minutes, then gives them the full diff to confirm.

Two kinds of content sit on the page and it says which is which:

- **Facts** come from scripts: the diff, files, line numbers, CI, commits and linked issues (`pr.json`).
- **Claude's analysis** is what you write in `analysis.json`: verdict, story, diagrams, risks, notes, quiz. It
  carries a "Claude's analysis" label on the page.

Keep that boundary honest. Every line reference you write is checked against the real diff, and every claim
from the PR body gets a status you can back up.

## Workflow

`S` is this skill's `scripts/` folder; `OUT` is `~/pr-reviews/<owner>-<repo>-<number>` unless the user names
another place. Keep everything read-only: never post to GitHub, push, or change the user's working tree.

### 1. Collect

```bash
python3 $S/collect_pr.py collect <PR URL or number> [--repo owner/name] --out $OUT
```

It writes `$OUT/pr.json` and prints an outline: state, agent signals, CI, linked issues, and every file with its
category, +/− and hunk start lines. If GitHub refuses the diff (over 300 files or 20,000 lines), re-run with
`--repo-dir <local clone>`. Don't read `pr.json` whole; use the outline and `show`.

### 2. Understand the change like a reviewer

- Read the PR body and the linked issues: `python3 -c "import json;d=json.load(open('$OUT/pr.json'));print(d['body']);[print('#',i['number'],i['title'],'\n',i['body']) for i in d['linked_issues']]"`.
- Print each source, test, migration and CI file you will talk about with
  `python3 $S/collect_pr.py show $OUT/pr.json <path>`. Take every line number from this output (second column =
  new side, first = old side); never count lines by hand. Glance at docs and config; skip lockfiles unless the
  PR is about dependencies.
- Look beyond the diff when the change depends on it (callers of a changed function, a config the code reads).
  If a local clone exists, read the PR's version without touching the checkout:
  `git -C <clone> fetch -q origin pull/<N>/head:refs/pr-review/<N>` then `git -C <clone> show refs/pr-review/<N>:<path>`
  or `git -C <clone> grep <symbol> refs/pr-review/<N>`. Otherwise use `gh api repos/<o>/<r>/contents/<path>?ref=<head_sha>`.
- **Look past the diff for what the change breaks.** The diff only shows what the author touched; the bugs a
  reviewer misses usually sit in files the author forgot. For every contract the PR changes (an API response
  shape or status code, a function signature, a config or env key, a CLI flag, a table or column, a file
  format), search the whole repo at the PR head for its consumers: code, scripts, CI, docs, examples
  (`git -C <clone> grep -n <name> refs/pr-review/<N>` or `gh search code`). A consumer the PR did not update is a
  finding, often the most valuable one on the page. Also check that the docs the PR adds or changes match the
  code (an env var the docs promise but the code ignores).
- **Check the PR description itself is current**: base branch, "stacked on", test counts, file lists. Agents
  rewrite code across iterations and leave the description from the first one.
- **Look for missing bounds** in anything that waits, loops, retries, polls, queues or stores: is there a
  timeout, a maximum, a cleanup? A job with no time limit or a table that only grows is a risk worth naming.
- **Be skeptical with agent-written PRs.** Treat a PR as agent-written when the outline sees the signs *or the
  user says so*; the user's word outweighs missing markers (squash merges and rewritten commits drop them). Agents state results
  confidently, including ones they never ran. List each factual claim in the body and commits: tests passed, "no
  behaviour change", "only X changes", counts, "verified in Docker". Check each against the diff, the CI jobs in
  `pr.json` and the code. A claim is `verified` only when you saw the evidence. If checking needs a command (run
  one test file, grep for remaining uses), do it in a throwaway worktree or a scratch clone, never in the user's
  checkout, and say what you ran in the evidence.

### 3. Write `$OUT/analysis.json`

Read `references/analysis-schema.md` first: it has the exact shape, the `ref` format and field-by-field
guidance. The writing principles are below in "Writing for understanding".

### 4. Render, fix, open

```bash
python3 $S/render.py $OUT --open
```

It validates `analysis.json` against `pr.json` (refs inside the diff, files that exist, enums, quiz answers,
reading order covering every file) and prints problems. Fix them and render again until it says
`analysis.json: no problems`. Don't read `index.html` back; it is large and only repeats your inputs.

### 5. Reply

At most six lines: the verdict and headline, the top risk, any claim that is `contradicted` or `unverified` and
matters, and the page path (`$OUT/index.html`). Mention what you could not check.

## Writing for understanding

The page teaches as much as it judges. Write so a capable reader who hasn't seen this codebase gets it on the
first pass.

- **Lead with the answer.** The verdict headline states the decision and its main cost in one sentence ("Safe to
  merge: driver swap is contained; the pg_dump round trip never ran in CI"). The TL;DR then explains the
  problem, the change and the effect in 3–4 sentences, without code names the reader hasn't met yet.
- **Tell it as a story, in the order understanding builds.** 4–8 walkthrough steps, usually: the problem or the
  old behaviour → where the change goes in → the new code → who calls it → how it's tested → the operational
  bits (CI, docs). Each step makes one point in its title, explains it in ≤ 3 sentences, and points at the few
  lines that prove it. Depth (edge cases, alternatives, the trace of a value) goes in the step's `more` toggle,
  whose title names what's inside.
- **Gloss every tool or term the first time it appears**, in a few words in the same sentence ("Alembic, the
  project's database-migration tool"). Terms that need more than a phrase also get a `concepts` card, aimed at
  what the reader needs for *this* PR (e.g. how psycopg v3 binds parameters differently from psycopg2).
- **Draw the mechanism, not decoration.** 1–3 Mermaid diagrams that show something the prose can't show as
  quickly: a before/after flow, a call sequence, which modules now depend on which. Skip diagrams for a typo fix.
- **Say exactly what the facts say.** "Migrated" is not "unchanged"; "tests pass in CI" is not "tests pass"; a
  number measured once is not "always". Name exceptions in the same sentence. No "all"/"every" you didn't check.
- **Risks are scenarios, not worries.** Each names the input or state that breaks, what breaks, and what would
  catch it. Severity reflects likelihood × impact for this project. An empty list is a fine answer; padding it
  teaches the reader to ignore the section.
- **The checklist is what the reader should verify themselves**, each item tied to a risk or an unverified claim
  ("Run `make test-postgres` once against a real database: CI's job is not required yet").
- **Let the reader try the behaviour** when the core of the PR is a pure mapping from input to output (a URL
  rewrite, a parser, a status transition, a pricing rule). Add a `try_it` block: 4–8 real example inputs with
  the output the PR's code produces, each worked out from the code, never guessed. The page lets the reader
  pick an input and see the result before and after the PR. Skip it when the behaviour is not a pure mapping.
- **The quiz checks understanding of behaviour**: "what happens to an existing `.env` with
  `postgresql+psycopg2://`?", not "which file changed". Wrong options are plausible misreadings. 3–5 questions.
- **Reading order covers every file**: dependencies first, each test right after its code, mechanical files
  last as `skip`. This is what lets the reader spend their minutes where they matter.

## Size

For PRs over ~40 files or ~3,000 changed lines, keep the story on the core change, cover the rest through the
reading order and file notes, and say in the verdict if the PR would review better split up. The diff tab still
shows every file; very large single files are truncated with a link to GitHub.

## What the page offers the reader

Six tabs, each linkable (`index.html#walkthrough`):

- **Summary**: verdict, stats (files, ±, commits, CI, reading time), TL;DR, why / what changes / impact, a bar
  of where the lines are by file type, the claims check, CI jobs, linked issues, questions for the author, and
  the original PR description.
- **Walkthrough**: steps on the left; the sticky code panel on the right shows the step's file, dims the rest
  and highlights its lines, following the scroll (j/k keys too). On narrow screens each step shows its excerpt.
- **Map**: the diagrams and the reading order.
- **Risks & checklist**: risks by severity, a checklist saved in the browser, and review notes to copy and post.
- **Learn**: an optional "try it" picker (input → before / after), concept cards, and the quiz with
  explanations after each answer.
- **Diff**: every file with word-level highlights, file notes, "Viewed" boxes, and links to GitHub's view.

Every `ref` on the page is a link that opens the Diff tab at those lines. Mermaid loads from jsDelivr; offline,
diagrams show as their source text and everything else works.
