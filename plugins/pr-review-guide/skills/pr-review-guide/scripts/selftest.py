#!/usr/bin/env python3
"""Offline self-test for pr-review-guide: no network, no gh, no GitHub account.

  python3 selftest.py        # prints OK, exits 1 on the first failure

Covers the diff parser (statuses, renames, line numbers, binary, no-newline
markers), file categories, render.py's validation of analysis.json (good and
broken), and the safety of the data embedded in the page.
"""
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import collect_pr  # noqa: E402

DIFF = """diff --git a/src/app/config.py b/src/app/config.py
index 1111111..2222222 100644
--- a/src/app/config.py
+++ b/src/app/config.py
@@ -10,6 +10,7 @@ import re

 DEFAULT = "a"
-LIMIT = 10
+LIMIT = 20
+TIMEOUT = 30

 def load():
     return DEFAULT
@@ -40,3 +41,3 @@ def save(x):
     x = x.strip()
-    return x
+    return x.lower()

diff --git a/tests/test_config.py b/tests/test_config.py
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/tests/test_config.py
@@ -0,0 +1,3 @@
+from app.config import LIMIT
+def test_limit():
+    assert LIMIT == 20
\\ No newline at end of file
diff --git a/docs/old.md b/docs/new.md
similarity index 90%
rename from docs/old.md
rename to docs/new.md
index 4444444..5555555 100644
--- a/docs/old.md
+++ b/docs/new.md
@@ -1,2 +1,2 @@
 # Title
-</script><b>old</b>
+</script><b>new</b>
diff --git a/uv.lock b/uv.lock
deleted file mode 100644
index 6666666..0000000
--- a/uv.lock
+++ /dev/null
@@ -1,2 +0,0 @@
-version = 1
-revision = 3
diff --git a/img/logo.png b/img/logo.png
index 7777777..8888888 100644
Binary files a/img/logo.png and b/img/logo.png differ
"""

GOOD = {
    "verdict": {"recommendation": "approve-with-nits", "headline": "Raises the limit; adds a timeout", "why": "Small.",
                "confidence": "high"},
    "summary": {"tldr": "Limit 10 → 20.", "what_changed": ["Limit doubled"]},
    "claims": [{"claim": "Doubles the limit", "status": "verified", "evidence": "diff",
                "ref": {"file": "src/app/config.py", "side": "new", "start": 12, "end": 13}}],
    "story": [
        {"title": "The new limit", "body": "Up to 20.", "ref": {"file": "src/app/config.py", "side": "new", "start": 12, "end": 13}},
        {"title": "The old limit", "body": "Was 10.", "ref": {"file": "src/app/config.py", "side": "old", "start": 12, "end": 12}},
        {"title": "A test", "body": "Pins it.", "ref": {"file": "tests/test_config.py", "side": "new", "start": 1, "end": 3}},
    ],
    "reading_order": [{"file": p, "attention": "read"} for p in
                      ["src/app/config.py", "tests/test_config.py", "docs/new.md", "uv.lock", "img/logo.png"]],
    "risks": [{"title": "Slow", "severity": "low", "detail": "d"}],
    "quiz": [{"question": "q", "options": ["a", "b"], "answer": 1, "explain": "e"}],
    "try_it": {"title": "t", "rows": [{"input": "10", "before": "10", "after": "20"}]},
    "diagrams": [{"title": "d", "mermaid": "flowchart LR\n  A --> B"}],
}

failures = []


def check(cond, msg):
    if not cond:
        failures.append(msg)


def test_parser():
    files = collect_pr.parse_diff(DIFF)
    by = {f["path"]: f for f in files}
    check(len(files) == 5, f"expected 5 files, got {len(files)}")
    cfg = by.get("src/app/config.py", {})
    check(cfg.get("status") == "modified" and cfg.get("additions") == 3 and cfg.get("deletions") == 2,
          f"config.py stats wrong: {cfg.get('status')} +{cfg.get('additions')} -{cfg.get('deletions')}")
    h0 = cfg["hunks"][0]["lines"]
    check(["-", 12, None, "LIMIT = 10"] in h0, "old line 12 should be the removed LIMIT")
    check(["+", None, 13, "TIMEOUT = 30"] in h0, "new line 13 should be the added TIMEOUT")
    check(cfg["hunks"][1]["new_start"] == 41, "second hunk should start at new line 41")
    t = by.get("tests/test_config.py", {})
    check(t.get("status") == "added" and t.get("additions") == 3 and t.get("old_path") is None, "new test file wrong")
    r = by.get("docs/new.md", {})
    check(r.get("status") == "renamed" and r.get("old_path") == "docs/old.md", "rename not detected")
    d = by.get("uv.lock", {})
    check(d.get("status") == "removed" and d.get("deletions") == 2, "deleted lockfile wrong")
    check(by.get("img/logo.png", {}).get("binary") is True, "binary file not flagged")
    cats = {f["path"]: collect_pr.categorize(f) for f in files}
    check(cats == {"src/app/config.py": "source", "tests/test_config.py": "test", "docs/new.md": "docs",
                   "uv.lock": "lockfile", "img/logo.png": "binary"}, f"categories wrong: {cats}")
    for p, c in {"backend/alembic/versions/011_x.py": "migration", ".github/workflows/ci.yml": "ci",
                 "web/src/app.spec.ts": "test", "Makefile": "config", "dist/app.min.js": "generated"}.items():
        got = collect_pr.categorize({"path": p, "binary": False})
        check(got == c, f"categorize({p}) = {got}, expected {c}")
    return files


def write_pr(d: Path, files):
    for f in files:
        f["category"] = collect_pr.categorize(f)
        f["github_url"] = "https://github.com/o/r/pull/1/files"
        f["read_minutes"] = 1
    pr = {"repo": "o/r", "number": 1, "title": "t", "url": "https://github.com/o/r/pull/1", "author": "a",
          "state": "open", "base": "main", "head": "x", "base_sha": "0" * 40, "head_sha": "1" * 40, "body": "",
          "labels": [], "agent_written": False, "agent_evidence": [], "commits": [], "checks": [], "reviews": [],
          "comment_count": 0, "linked_issues": [], "diff_source": "selftest", "additions": 0, "deletions": 0,
          "read_minutes": 1, "files": files}
    (d / "pr.json").write_text(json.dumps(pr))


def render(d: Path):
    return subprocess.run([sys.executable, str(HERE / "render.py"), str(d)], capture_output=True, text=True)


def test_render(files):
    tmp = Path(tempfile.mkdtemp(prefix="prg-selftest-"))
    try:
        write_pr(tmp, files)
        (tmp / "analysis.json").write_text(json.dumps(GOOD))
        r = render(tmp)
        check(r.returncode == 0 and "no problems" in r.stdout, f"good analysis should pass:\n{r.stdout}{r.stderr}")
        page = (tmp / "index.html").read_text()
        check(page.count("</script>") == 3, f"embedded data must not close the page's scripts "
                                            f"(found {page.count('</script>')} closing tags, expected 3)")
        check("/*__" not in page and "__DATA__" not in page, "template placeholders left in the page")
        bad = json.loads(json.dumps(GOOD))
        bad["story"][0]["ref"]["start"] = 500
        bad["story"][0]["ref"]["end"] = 501
        bad["story"][1]["ref"]["file"] = "nope.py"
        bad["risks"][0]["severity"] = "critical"
        bad["reading_order"].pop()
        bad["quiz"][0]["answer"] = 5
        bad["try_it"]["rows"][0].pop("after")
        bad["file_notes"] = {"ghost.py": "x"}
        (tmp / "analysis.json").write_text(json.dumps(bad))
        out = render(tmp).stdout
        for needle in ["not in the diff", "'nope.py' is not in this PR", "severity = 'critical'",
                       "leaves out: img/logo.png", "quiz[0]", "try_it.rows[0]", "file_notes: 'ghost.py'"]:
            check(needle in out, f"broken analysis: expected a problem mentioning {needle!r}")
        node = shutil.which("node")
        if node:
            r = subprocess.run([node, "--check", str(HERE.parent / "assets" / "app.js")], capture_output=True, text=True)
            check(r.returncode == 0, f"app.js does not parse: {r.stderr}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    files = test_parser()
    test_render(files)
    if failures:
        print("FAIL")
        for f in failures:
            print("  -", f)
        sys.exit(1)
    print("OK")


if __name__ == "__main__":
    main()
