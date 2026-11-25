# analysis.json

Everything Claude writes for the page lives in one file next to `pr.json`. `render.py` checks it against
`pr.json` and lists what does not match, so a wrong file path or line range is caught before the reader sees it.

Text fields accept a small Markdown subset: `**bold**`, `*italic*`, `` `code` ``, `[link](https://…)`, blank-line
paragraphs and `- ` bullet lists. Nothing else is interpreted; HTML is shown as text.

## Line references (`ref`)

```json
{ "file": "src/db/config.py", "side": "new", "start": 85, "end": 87 }
```

- `side` is `"new"` (lines in the PR's version, the `+` and context lines) or `"old"` (the base version, `-` and
  context lines). Use `"old"` only for code that was removed.
- Take the numbers from `collect_pr.py show`; the second number column is `new`, the first is `old`.
- The range must fall inside the diff (a hunk). Code outside the diff can be quoted in prose, not referenced.
- `end` may equal `start`. Keep ranges tight: the lines that make the point, not the whole hunk.

## Top-level shape

Every key is optional except `verdict`, `summary` and `story`; leave a list empty rather than padding it.

```json
{
  "agent_written": true,
  "agent_written_why": "Set when you treat the PR as agent-written but pr.json found no markers, e.g. 'The user said Claude wrote most of it.'",
  "verdict": {
    "recommendation": "approve | approve-with-nits | request-changes | needs-discussion",
    "headline": "One sentence: the answer and its main cost. ≤ 120 characters.",
    "why": "2–3 sentences behind the recommendation.",
    "confidence": "high | medium | low",
    "confidence_note": "What would raise the confidence (e.g. 'the pg_dump round trip never ran in CI')."
  },
  "summary": {
    "tldr": "3–4 sentences for someone who has not opened the code: problem, change, effect.",
    "why": "The motivation, from the linked issues and the body. Cite #numbers.",
    "what_changed": ["One bullet per behaviour change, in plain words; 3–6 bullets."],
    "impact": "Who or what notices this change after merge (users, deployments, CI, other devs).",
    "key_numbers": [{ "label": "short", "value": "61 / 62", "note": "PostgreSQL tests passed locally (author's claim)" }]
  },
  "claims": [
    {
      "claim": "A factual statement from the PR body or commit message, quoted or tightly paraphrased.",
      "status": "verified | partly | unverified | contradicted",
      "evidence": "What you checked and what you saw: the diff lines, a CI job, a command you ran.",
      "ref": { "file": "…", "side": "new", "start": 1, "end": 3 }
    }
  ],
  "story": [
    {
      "title": "One bold idea this step shows (≤ 10 words).",
      "body": "≤ 3 short sentences. Gloss new terms here.",
      "ref": { "file": "…", "side": "new", "start": 85, "end": 87 },
      "more_title": "Names what the toggle holds, e.g. 'Why a regex · the URLs it accepts'",
      "more": "Optional depth: a table-free explanation, a list, an edge case."
    }
  ],
  "diagrams": [
    {
      "title": "Before and after: which driver a DATABASE_URL reaches",
      "caption": "One sentence telling the reader what to look at.",
      "mermaid": "flowchart LR\n  A[DATABASE_URL] --> B{prefix}\n  ..."
    }
  ],
  "reading_order": [
    { "file": "src/db/config.py", "attention": "read | glance | skip", "why": "One sentence." }
  ],
  "file_notes": { "path/in/pr": "One sentence: what this file's change does and why." },
  "risks": [
    {
      "title": "Short name of what could go wrong",
      "severity": "high | medium | low",
      "detail": "The failure scenario: inputs or state → wrong result. Concrete.",
      "catch": "What would catch it: a test, a check, a manual step.",
      "ref": { "file": "…", "side": "new", "start": 1, "end": 1 }
    }
  ],
  "checklist": [
    { "item": "Something the reviewer should verify themselves", "why": "Which risk or claim it settles", "ref": null }
  ],
  "questions_for_author": ["A question you would post on the PR; specific, answerable."],
  "concepts": [
    {
      "term": "psycopg v3",
      "short": "The current PostgreSQL driver for Python (package `psycopg`).",
      "explain": "2–5 sentences: what it is, why it matters for this PR, how it differs from what the reader may know.",
      "link": "https://www.psycopg.org/psycopg3/docs/basic/from_pg2.html"
    }
  ],
  "try_it": {
    "title": "Type of input → what the code does with it, e.g. 'What happens to your DATABASE_URL'",
    "input_label": "DATABASE_URL",
    "before_label": "Before this PR",
    "after_label": "After this PR",
    "rows": [
      { "input": "postgresql://u:p@db/pv", "before": "postgresql+psycopg2://u:p@db/pv", "after": "postgresql+psycopg://u:p@db/pv", "note": "Bare URL: driver made explicit." }
    ]
  },
  "quiz": [
    {
      "question": "After this PR, what does DATABASE_URL=postgresql+psycopg2://u:p@db/pv connect with?",
      "options": ["psycopg2", "psycopg v3", "It fails at startup"],
      "answer": 1,
      "explain": "The legacy prefix matches `_PSYCOPG_REWRITE_RE` and is rewritten to `postgresql+psycopg://`."
    }
  ]
}
```

## Field guidance

- **reading_order**: list every changed file once, in the order a reviewer should read them: the code others depend
  on first, each test right after the code it exercises, mechanical files (lockfiles, generated, pure renames)
  last with `skip`. `glance` = look at it, nothing subtle; `read` = read every line.
- **claims**: `verified` only when you saw the evidence yourself (diff, CI job, a command's output). The author
  saying "tests pass" is evidence for `unverified`, not `verified`. `partly` when part holds; say which part.
  `contradicted` when the diff or CI shows otherwise.
- **risks**: honest severities. `high` = likely to break something users or deployments see. No generic risks
  ("could have bugs"); each one names its scenario. An empty list is a valid answer.
- **claims**: also list the claims you found stale (the description says one thing, the final code another) as
  `contradicted`, and findings from consumers outside the diff go in `risks` (no `ref` needed: name the file
  and line in `detail`, since `ref` must point inside the diff).
- **try_it**: only for a pure input → output mapping. Work out every row from the code (run it when cheap); a
  wrong row teaches the wrong thing. `before` may be omitted for new behaviour.
- **quiz**: 3–5 questions on *behaviour* (what happens when…), not trivia (which line, which name). Wrong options
  should be the mistakes a reader would plausibly make.
- **diagrams**: Mermaid `flowchart`, `sequenceDiagram`, `stateDiagram-v2` or `classDiagram`. ≤ 12 nodes, labels ≤ 4
  words, quote labels containing punctuation: `A["postgresql://"]`. Avoid `click`, `style` with URLs and HTML labels.
