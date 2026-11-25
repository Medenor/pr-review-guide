#!/usr/bin/env python3
"""Collect a GitHub pull request into pr.json for the pr-review-guide skill.

Read-only: it runs `gh` (and `git fetch`/`git diff` with --repo-dir) and never
posts, pushes or changes a working tree.

  collect_pr.py collect <PR url | number> [--repo owner/name] [--repo-dir PATH] --out DIR
  collect_pr.py show DIR/pr.json <path> [--from N --to M]

`collect` writes DIR/pr.json and prints an outline: every file with its
category, +/- and the first new line of each hunk. `show` prints one file's
diff with old and new line numbers, the numbers analysis.json refers to.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

PR_FIELDS = (
    "number,title,url,author,state,isDraft,baseRefName,headRefName,baseRefOid,headRefOid,"
    "createdAt,mergedAt,closedAt,body,labels,additions,deletions,changedFiles,commits,"
    "statusCheckRollup,reviews,comments,closingIssuesReferences"
)
MAX_LINES_PER_FILE = 4000
MAX_LINKED = 6
HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$")

LOCKFILES = {
    "uv.lock", "poetry.lock", "pipfile.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "bun.lockb", "bun.lock", "cargo.lock", "go.sum", "gemfile.lock", "composer.lock", "mix.lock",
    "packages.lock.json", "flake.lock", "pubspec.lock",
}
# lines a reader gets through per minute, by category; 0 = not counted (skimmed or skipped)
READ_RATE = {"source": 20, "migration": 15, "test": 30, "config": 40, "ci": 40, "docs": 60,
             "lockfile": 0, "generated": 0, "binary": 0}
AGENT_MARKERS = re.compile(
    r"generated with \[?claude code|claude\.ai/code|noreply@anthropic\.com|co-authored-by: claude|"
    r"codex|copilot-swe-agent|devin-ai|cursor agent|openhands|\[bot\]", re.I)


def run(cmd: list[str], cwd: str | None = None, check: bool = True) -> subprocess.CompletedProcess:
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if check and r.returncode != 0:
        sys.exit(f"command failed: {' '.join(cmd)}\n{r.stderr.strip()}")
    return r


def gh_json(args: list[str]):
    return json.loads(run(["gh", *args]).stdout)


# ---------------------------------------------------------------- target

def resolve_target(target: str, repo: str | None) -> tuple[str, int]:
    m = re.match(r"https?://github\.com/([^/]+/[^/]+)/pull/(\d+)", target)
    if m:
        return m.group(1), int(m.group(2))
    m = re.match(r"^#?(\d+)$", target.strip())
    if not m:
        sys.exit(f"not a PR number or github.com pull URL: {target}")
    if not repo:
        repo = gh_json(["repo", "view", "--json", "nameWithOwner"])["nameWithOwner"]
    return repo, int(m.group(1))


# ---------------------------------------------------------------- diff parsing

def _strip_prefix(p: str) -> str:
    p = p.strip()
    if p.startswith('"') and p.endswith('"'):
        p = p[1:-1].encode().decode("unicode_escape")
    return p[2:] if p[:2] in ("a/", "b/") else p


def parse_diff(text: str) -> list[dict]:
    files: list[dict] = []
    cur = hunk = None
    left_old = left_new = 0
    for line in text.splitlines():
        if line.startswith("diff --git "):
            m = re.match(r'diff --git (".*?"|\S+) (".*?"|\S+)$', line)
            a, b = (m.group(1), m.group(2)) if m else ("", line[11:])
            cur = {"path": _strip_prefix(b), "old_path": _strip_prefix(a), "status": "modified",
                   "binary": False, "hunks": []}
            files.append(cur)
            hunk = None
            continue
        if cur is None:
            continue
        if hunk is not None and (left_old > 0 or left_new > 0) and (line == "" or line[0] in " +-\\"):
            if line.startswith("\\"):
                continue
            t = line[0] if line else " "
            body = line[1:]
            if t == " ":
                hunk["lines"].append([" ", hunk["_o"], hunk["_n"], body])
                hunk["_o"] += 1; hunk["_n"] += 1; left_old -= 1; left_new -= 1
            elif t == "-":
                hunk["lines"].append(["-", hunk["_o"], None, body])
                hunk["_o"] += 1; left_old -= 1
            else:
                hunk["lines"].append(["+", None, hunk["_n"], body])
                hunk["_n"] += 1; left_new -= 1
            continue
        hm = HUNK_RE.match(line)
        if hm:
            o, ol, n, nl, ctx = hm.groups()
            ol = 1 if ol is None else int(ol)
            nl = 1 if nl is None else int(nl)
            hunk = {"old_start": int(o), "old_lines": ol, "new_start": int(n), "new_lines": nl,
                    "context": ctx, "lines": [], "_o": int(o), "_n": int(n)}
            cur["hunks"].append(hunk)
            left_old, left_new = ol, nl
            continue
        if line.startswith("new file mode"):
            cur["status"] = "added"
        elif line.startswith("deleted file mode"):
            cur["status"] = "removed"
        elif line.startswith("rename from "):
            cur["old_path"] = line[12:]; cur["status"] = "renamed"
        elif line.startswith("rename to "):
            cur["path"] = line[10:]
        elif line.startswith("--- ") and line[4:] != "/dev/null":
            cur["old_path"] = _strip_prefix(line[4:])
        elif line.startswith("+++ ") and line[4:] != "/dev/null":
            cur["path"] = _strip_prefix(line[4:])
        elif line.startswith("Binary files") or line.startswith("GIT binary patch"):
            cur["binary"] = True
    for f in files:
        for h in f["hunks"]:
            h.pop("_o", None); h.pop("_n", None)
        f["additions"] = sum(1 for h in f["hunks"] for l in h["lines"] if l[0] == "+")
        f["deletions"] = sum(1 for h in f["hunks"] for l in h["lines"] if l[0] == "-")
        if f["old_path"] == f["path"] or f["status"] == "added":
            f["old_path"] = None
        total = sum(len(h["lines"]) for h in f["hunks"])
        f["truncated"] = False
        if total > MAX_LINES_PER_FILE:
            kept, n = [], 0
            for h in f["hunks"]:
                if n >= MAX_LINES_PER_FILE:
                    break
                kept.append(h); n += len(h["lines"])
            f["hunks"] = kept
            f["truncated"] = True
    return files


def categorize(f: dict) -> str:
    p = f["path"]
    low = p.lower()
    name = low.rsplit("/", 1)[-1]
    if f["binary"]:
        return "binary"
    if name in LOCKFILES:
        return "lockfile"
    if re.search(r"(\.min\.(js|css)$|(^|/)(dist|build|vendor|__snapshots__)/|\.snap$|\.pb\.go$|_pb2\.py$|\.generated\.)", low):
        return "generated"
    if re.search(r"(^|/)(migrations?|alembic/versions)/", low):
        return "migration"
    if re.search(r"(^|/)(tests?|__tests__|spec|e2e)/|(^|/)test_[^/]*$|_test\.[a-z]+$|\.(test|spec)\.[a-z]+$|conftest\.py$", low):
        return "test"
    if low.startswith(".github/") or re.search(r"(^|/)(\.gitlab-ci\.yml|\.circleci/|jenkinsfile|azure-pipelines\.yml)", low):
        return "ci"
    if re.search(r"\.(md|mdx|rst|txt|adoc)$", low) or low.startswith("docs/"):
        return "docs"
    if re.search(r"\.(toml|ya?ml|json|ini|cfg|conf|env\.example|lock)$|(^|/)(makefile|dockerfile|docker-compose[^/]*|\.editorconfig|\.gitignore|\.dockerignore)$", low):
        return "config"
    return "source"


def get_diff(repo: str, number: int, meta: dict, repo_dir: str | None) -> tuple[str, str]:
    """Return (unified diff, description of the source)."""
    if repo_dir:
        ref = f"refs/pr-review/{number}"
        run(["git", "fetch", "-q", "origin", f"pull/{number}/head:{ref}", "--force"], cwd=repo_dir)
        run(["git", "fetch", "-q", "origin", meta["baseRefName"]], cwd=repo_dir)
        base = run(["git", "merge-base", ref, f"origin/{meta['baseRefName']}"], cwd=repo_dir).stdout.strip()
        diff = run(["git", "diff", "-M", "--no-color", f"{base}..{ref}"], cwd=repo_dir).stdout
        return diff, f"git diff {base[:9]}..{ref} in {repo_dir}"
    r = run(["gh", "pr", "diff", str(number), "-R", repo, "--color", "never"], check=False)
    if r.returncode != 0:
        sys.exit("gh pr diff failed (GitHub refuses diffs over 300 files or 20,000 lines).\n"
                 f"{r.stderr.strip()}\nRe-run with --repo-dir <local clone of {repo}>.")
    return r.stdout, "GitHub API (gh pr diff)"


# ---------------------------------------------------------------- metadata

def norm_check(c: dict) -> dict:
    if c.get("__typename") == "StatusContext":
        state = (c.get("state") or "").lower()
        result = {"success": "success", "failure": "failure", "error": "failure"}.get(state, "pending")
        return {"name": c.get("context"), "workflow": None, "result": result, "url": c.get("targetUrl")}
    status = (c.get("status") or "").upper()
    concl = (c.get("conclusion") or "").upper()
    if status != "COMPLETED":
        result = "pending"
    else:
        result = {"SUCCESS": "success", "FAILURE": "failure", "TIMED_OUT": "failure", "CANCELLED": "cancelled",
                  "SKIPPED": "skipped", "NEUTRAL": "neutral", "ACTION_REQUIRED": "failure",
                  "STARTUP_FAILURE": "failure", "STALE": "neutral"}.get(concl, "neutral")
    return {"name": c.get("name"), "workflow": c.get("workflowName"), "result": result, "url": c.get("detailsUrl")}


def linked_issues(repo: str, number: int, meta: dict) -> list[dict]:
    nums: list[int] = [i["number"] for i in meta.get("closingIssuesReferences") or []]
    for m in re.finditer(r"(?<![\w/])#(\d+)\b", meta.get("body") or ""):
        n = int(m.group(1))
        if n != number and n not in nums:
            nums.append(n)
    out = []
    for n in nums[:MAX_LINKED]:
        r = run(["gh", "api", f"repos/{repo}/issues/{n}"], check=False)
        if r.returncode != 0:
            continue
        j = json.loads(r.stdout)
        out.append({"number": n, "title": j.get("title"), "state": j.get("state"),
                    "kind": "pull request" if j.get("pull_request") else "issue",
                    "url": j.get("html_url"), "body": (j.get("body") or "")[:1500]})
    return out


def collect(args) -> None:
    repo, number = resolve_target(args.target, args.repo)
    meta = gh_json(["pr", "view", str(number), "-R", repo, "--json", PR_FIELDS])
    diff, source = get_diff(repo, number, meta, args.repo_dir)
    files = parse_diff(diff)
    pr_url = meta["url"]
    for f in files:
        f["category"] = categorize(f)
        f["github_url"] = f"{pr_url}/files#diff-{hashlib.sha256(f['path'].encode()).hexdigest()}"
        rate = READ_RATE[f["category"]]
        f["read_minutes"] = round((f["additions"] + f["deletions"]) / rate, 1) if rate else 0
    commits = [{"sha": c["oid"], "headline": c.get("messageHeadline"),
                "authors": [a.get("login") or a.get("name") for a in c.get("authors") or []],
                "agent": bool(AGENT_MARKERS.search((c.get("messageBody") or "") + " " +
                                                   " ".join(a.get("email") or "" for a in c.get("authors") or [])))}
               for c in meta.get("commits") or []]
    author = (meta.get("author") or {}).get("login")
    agent_evidence = []
    if AGENT_MARKERS.search(meta.get("body") or ""):
        agent_evidence.append("PR body names an AI coding tool")
    if any(c["agent"] for c in commits):
        agent_evidence.append("commits co-authored by an AI agent")
    if author and (author.endswith("[bot]") or (meta.get("author") or {}).get("is_bot")):
        agent_evidence.append("opened by a bot account")
    checks = [norm_check(c) for c in meta.get("statusCheckRollup") or []]
    pr = {
        "repo": repo, "number": number, "title": meta["title"], "url": pr_url, "author": author,
        "state": "draft" if meta.get("isDraft") and meta["state"] == "OPEN" else meta["state"].lower(),
        "base": meta["baseRefName"], "head": meta["headRefName"],
        "base_sha": meta.get("baseRefOid"), "head_sha": meta.get("headRefOid"),
        "created_at": meta.get("createdAt"), "merged_at": meta.get("mergedAt"), "closed_at": meta.get("closedAt"),
        "body": meta.get("body") or "", "labels": [l["name"] for l in meta.get("labels") or []],
        "agent_written": bool(agent_evidence), "agent_evidence": agent_evidence,
        "commits": commits, "checks": checks,
        "reviews": [{"author": (r.get("author") or {}).get("login"), "state": r.get("state"),
                     "body": (r.get("body") or "")[:800]} for r in meta.get("reviews") or []],
        "comment_count": len(meta.get("comments") or []),
        "linked_issues": linked_issues(repo, number, meta),
        "diff_source": source,
        "additions": sum(f["additions"] for f in files), "deletions": sum(f["deletions"] for f in files),
        "read_minutes": round(sum(f["read_minutes"] for f in files)),
        "files": files,
    }
    out = Path(args.out).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    (out / "pr.json").write_text(json.dumps(pr, ensure_ascii=False))
    print_outline(pr, out / "pr.json")


def print_outline(pr: dict, path: Path) -> None:
    ok = sum(c["result"] == "success" for c in pr["checks"])
    bad = sum(c["result"] == "failure" for c in pr["checks"])
    pend = sum(c["result"] == "pending" for c in pr["checks"])
    print(f"#{pr['number']} {pr['title']}  [{pr['state']}]  by {pr['author']}  {pr['base']} <- {pr['head']}")
    print(f"agent-written: {'yes (' + '; '.join(pr['agent_evidence']) + ')' if pr['agent_written'] else 'no sign of it'}")
    print(f"{len(pr['files'])} files  +{pr['additions']} -{pr['deletions']}  commits {len(pr['commits'])}  "
          f"CI {ok} passed, {bad} failed, {pend} pending  ~{pr['read_minutes']} min to read")
    if pr["linked_issues"]:
        print("linked: " + ", ".join(f"#{i['number']} {i['title']}" for i in pr["linked_issues"]))
    print()
    for f in pr["files"]:
        st = {"added": "A", "removed": "D", "renamed": "R", "modified": "M"}[f["status"]]
        name = f"{f['old_path']} -> {f['path']}" if f["old_path"] else f["path"]
        hunks = ", ".join(f"+{h['new_start']}" if h["new_lines"] else f"-{h['old_start']}" for h in f["hunks"])
        extra = " (truncated)" if f["truncated"] else ""
        print(f"  {st} {name}  [{f['category']}]  +{f['additions']} -{f['deletions']}  hunks: {hunks or '-'}{extra}")
    print(f"\nWrote {path}")


def show(args) -> None:
    pr = json.loads(Path(args.pr_json).expanduser().read_text())
    f = next((x for x in pr["files"] if x["path"] == args.path), None)
    if not f:
        sys.exit(f"{args.path} is not in this PR. Files: " + ", ".join(x["path"] for x in pr["files"]))
    print(f"{f['path']}  [{f['category']}, {f['status']}]  +{f['additions']} -{f['deletions']}")
    for h in f["hunks"]:
        print(f"@@ -{h['old_start']},{h['old_lines']} +{h['new_start']},{h['new_lines']} @@ {h['context']}")
        for t, o, n, text in h["lines"]:
            num = n if n is not None else o
            if args.from_ is not None and (num is None or num < args.from_):
                continue
            if args.to is not None and num is not None and num > args.to:
                continue
            print(f"{'' if o is None else o:>5} {'' if n is None else n:>5} {t} {text}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("collect", help="fetch a PR into DIR/pr.json and print its outline")
    c.add_argument("target", help="PR number or https://github.com/owner/repo/pull/N")
    c.add_argument("--repo", help="owner/name when target is a number (default: the repo in the current folder)")
    c.add_argument("--repo-dir", help="local clone to diff from instead of the GitHub API (for very large PRs)")
    c.add_argument("--out", required=True, help="output folder, e.g. ~/pr-reviews/owner-repo-130")
    s = sub.add_parser("show", help="print one file's diff with old/new line numbers")
    s.add_argument("pr_json")
    s.add_argument("path")
    s.add_argument("--from", dest="from_", type=int)
    s.add_argument("--to", type=int)
    args = ap.parse_args()
    collect(args) if args.cmd == "collect" else show(args)


if __name__ == "__main__":
    main()
