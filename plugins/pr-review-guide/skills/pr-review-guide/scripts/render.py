#!/usr/bin/env python3
"""Render DIR/pr.json + DIR/analysis.json into one self-contained review page.

  render.py DIR [--out DIR/index.html] [--open]

Checks analysis.json against pr.json first (shape, enums, every line reference
inside the diff, every reading-order file in the PR) and prints the problems.
The page is written anyway, with the same problems in a banner at the top, so
fix them and render again. Reads local files only; nothing is sent anywhere.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ASSETS = Path(__file__).resolve().parent.parent / "assets"
ENUMS = {
    ("verdict", "recommendation"): {"approve", "approve-with-nits", "request-changes", "needs-discussion"},
    ("verdict", "confidence"): {"high", "medium", "low"},
    ("claims", "status"): {"verified", "partly", "unverified", "contradicted"},
    ("risks", "severity"): {"high", "medium", "low"},
    ("reading_order", "attention"): {"read", "glance", "skip"},
}


def side_lines(pr: dict) -> dict[tuple[str, str], set[int]]:
    out: dict[tuple[str, str], set[int]] = {}
    for f in pr["files"]:
        new, old = set(), set()
        for h in f["hunks"]:
            for t, o, n, _ in h["lines"]:
                if n is not None:
                    new.add(n)
                if o is not None:
                    old.add(o)
        out[(f["path"], "new")] = new
        out[(f["path"], "old")] = old
    return out


def validate(pr: dict, a: dict) -> list[str]:
    problems: list[str] = []
    lines = side_lines(pr)
    paths = {f["path"] for f in pr["files"]}

    def check_ref(ref, where: str, required: bool = False) -> None:
        if not ref:
            if required:
                problems.append(f"{where}: missing ref (each step should point at the lines it explains)")
            return
        if not isinstance(ref, dict):
            problems.append(f"{where}: ref must be an object {{file, side, start, end}}")
            return
        f, side = ref.get("file"), ref.get("side", "new")
        if f not in paths:
            problems.append(f"{where}: file '{f}' is not in this PR")
            return
        if side not in ("new", "old"):
            problems.append(f"{where}: side must be 'new' or 'old', got '{side}'")
            return
        try:
            s, e = int(ref["start"]), int(ref.get("end", ref["start"]))
        except (KeyError, TypeError, ValueError):
            problems.append(f"{where}: start/end must be line numbers")
            return
        if e < s:
            problems.append(f"{where}: end {e} is before start {s}")
            return
        hit = [n for n in range(s, e + 1) if n in lines[(f, side)]]
        if not hit:
            problems.append(f"{where}: {f} {side} lines {s}-{e} are not in the diff "
                            f"(check with: collect_pr.py show pr.json {f})")
        elif len(hit) < (e - s + 1) // 2:
            problems.append(f"{where}: most of {f} {side} lines {s}-{e} are outside the diff")

    for key in ("verdict", "summary", "story"):
        if not a.get(key):
            problems.append(f"'{key}' is missing or empty")
    for (sec, field), allowed in ENUMS.items():
        val = a.get(sec)
        items = [val] if isinstance(val, dict) else (val or [])
        for i, it in enumerate(items):
            if isinstance(it, dict) and it.get(field) is not None and it.get(field) not in allowed:
                problems.append(f"{sec}[{i}].{field} = '{it.get(field)}' (allowed: {', '.join(sorted(allowed))})")
    for i, s in enumerate(a.get("story") or []):
        if not s.get("title"):
            problems.append(f"story[{i}]: missing title")
        check_ref(s.get("ref"), f"story[{i}] '{s.get('title', '')[:40]}'", required=True)
    for sec in ("claims", "risks", "checklist"):
        for i, it in enumerate(a.get(sec) or []):
            check_ref(it.get("ref"), f"{sec}[{i}]")
    seen = set()
    for i, r in enumerate(a.get("reading_order") or []):
        if r.get("file") not in paths:
            problems.append(f"reading_order[{i}]: '{r.get('file')}' is not in this PR")
        seen.add(r.get("file"))
    if a.get("reading_order"):
        missing = [p for p in paths if p not in seen]
        if missing:
            problems.append("reading_order leaves out: " + ", ".join(sorted(missing)))
    for p in (a.get("file_notes") or {}):
        if p not in paths:
            problems.append(f"file_notes: '{p}' is not in this PR")
    for i, q in enumerate(a.get("quiz") or []):
        opts = q.get("options") or []
        if len(opts) < 2:
            problems.append(f"quiz[{i}]: needs at least 2 options")
        if not isinstance(q.get("answer"), int) or not 0 <= q["answer"] < len(opts):
            problems.append(f"quiz[{i}]: answer must be the index of the right option (0-based)")
    t = a.get("try_it")
    if t:
        rows = t.get("rows") if isinstance(t, dict) else None
        if not rows:
            problems.append("try_it: needs a non-empty 'rows' list")
        else:
            for i, r in enumerate(rows):
                if not isinstance(r, dict) or r.get("input") in (None, "") or r.get("after") is None:
                    problems.append(f"try_it.rows[{i}]: needs 'input' and 'after'")
    for i, d in enumerate(a.get("diagrams") or []):
        if not (d.get("mermaid") or "").strip():
            problems.append(f"diagrams[{i}]: empty mermaid source")
    return problems


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dir", help="folder holding pr.json and analysis.json")
    ap.add_argument("--out", help="page path (default: DIR/index.html)")
    ap.add_argument("--open", action="store_true", help="open the page in the default browser")
    args = ap.parse_args()
    d = Path(args.dir).expanduser()
    pr = json.loads((d / "pr.json").read_text())
    ap_path = d / "analysis.json"
    if not ap_path.exists():
        sys.exit(f"{ap_path} not found. Write it first (see references/analysis-schema.md).")
    try:
        analysis = json.loads(ap_path.read_text())
    except json.JSONDecodeError as e:
        sys.exit(f"analysis.json is not valid JSON: {e}")
    problems = validate(pr, analysis)
    data = {"pr": pr, "analysis": analysis, "warnings": problems,
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")}
    payload = json.dumps(data, ensure_ascii=False).replace("</", "<\\/").replace("<!--", "<\\!--")
    html = (ASSETS / "template.html").read_text()
    html = (html.replace("/*__CSS__*/", (ASSETS / "app.css").read_text())
                .replace("/*__JS__*/", (ASSETS / "app.js").read_text())
                .replace("__TITLE__", f"Review · {pr['repo'].split('/')[-1]} #{pr['number']}")
                .replace("__DATA__", payload))
    out = Path(args.out).expanduser() if args.out else d / "index.html"
    out.write_text(html)
    print(f"Wrote {out} ({out.stat().st_size // 1024} kB): {len(pr['files'])} files, "
          f"+{pr['additions']} -{pr['deletions']}, {len(analysis.get('story') or [])} story steps, "
          f"{len(analysis.get('diagrams') or [])} diagrams, {len(analysis.get('risks') or [])} risks")
    if problems:
        print(f"\n{len(problems)} problem(s) in analysis.json, shown on the page too. Fix them and render again:")
        for p in problems:
            print(f"  ! {p}")
    else:
        print("analysis.json: no problems")
    if args.open:
        opener = "open" if sys.platform == "darwin" else ("start" if sys.platform == "win32" else "xdg-open")
        subprocess.run([opener, str(out)], shell=sys.platform == "win32", check=False)


if __name__ == "__main__":
    main()
