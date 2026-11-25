# Changelog

## 1.0.0 — 2026-11-25

First release.

- `scripts/collect_pr.py`: reads a GitHub PR through `gh` (or a local clone with `--repo-dir`) into `pr.json`: diff parsed with old/new line numbers, file categories, reading-time estimate, CI checks, commits, reviews, linked issues and agent-authorship signals. `show` prints one file's diff with line numbers.
- `scripts/render.py`: validates `analysis.json` against `pr.json` (line ranges inside the diff, known files, full reading order, enums, quiz answers, try-it rows) and builds one self-contained HTML page.
- Page: Summary (verdict, stats, claims check, CI, linked issues), Walkthrough (sticky code panel following the scroll), Map (Mermaid diagrams, reading order), Risks & checklist (saved in the browser, copyable review notes), Learn (try-it picker, concepts, quiz), Diff (word-level highlights, Viewed boxes). Light and dark themes, phone layout.
- `SKILL.md`: review workflow, including the search for consumers of changed contracts outside the diff, stale-description checks and missing-bound checks, and writing guidance for teaching pages.
- `scripts/selftest.py`: offline test suite.
- Distribution: Claude Code plugin marketplace (`/plugin install pr-review-guide@pr-review-guide`); skill-only ZIP attached to each release by CI.
