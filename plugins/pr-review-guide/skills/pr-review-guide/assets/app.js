/* pr-review-guide page script. Data: #data (pr.json + analysis.json + warnings). No network calls. */
(function () {
  "use strict";
  const DATA = JSON.parse(document.getElementById("data").textContent);
  const PR = DATA.pr, A = DATA.analysis || {}, WARN = DATA.warnings || [];
  const FILES = PR.files || [];
  const byPath = new Map(FILES.map(f => [f.path, f]));
  const KEY = "prg:" + PR.repo + "#" + PR.number + "@" + String(PR.head_sha || "").slice(0, 10);
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));

  // ------------------------------------------------------------ storage (per viewer, optional)
  function load(k, def) { try { const v = localStorage.getItem(KEY + ":" + k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
  function save(k, v) { try { localStorage.setItem(KEY + ":" + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }

  // ------------------------------------------------------------ text helpers
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function inline(s) {
    let t = esc(s);
    const codes = [];
    t = t.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return "\u0000" + (codes.length - 1) + "\u0000"; });
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
    t = t.replace(/(^|[\s(])#(\d+)\b/g, (m, pre, n) => pre + '<a href="https://github.com/' + esc(PR.repo) + '/issues/' + n + '" target="_blank" rel="noopener">#' + n + "</a>");
    return t.replace(/\u0000(\d+)\u0000/g, (_, i) => "<code>" + codes[+i] + "</code>");
  }
  function md(s) {
    if (!s) return "";
    const blocks = String(s).trim().split(/\n\s*\n/);
    return '<div class="md">' + blocks.map(b => {
      const lines = b.split("\n");
      if (lines.every(l => /^\s*[-*] /.test(l))) return "<ul>" + lines.map(l => "<li>" + inline(l.replace(/^\s*[-*] /, "")) + "</li>").join("") + "</ul>";
      return "<p>" + lines.map(inline).join("<br>") + "</p>";
    }).join("") + "</div>";
  }
  const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");

  // ------------------------------------------------------------ word diff
  function tokens(s) { return s.match(/\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g) || []; }
  function wordDiff(a, b) {
    const x = tokens(a), y = tokens(b);
    if (x.length * y.length > 60000) return null;
    const m = x.length, n = y.length, dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
    for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--)
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const same = dp[0][0];
    const sig = (arr) => arr.filter(t => /\S/.test(t)).length || 1;
    if (same / Math.max(x.length, y.length, 1) < 0.5 || same < sig(x) / 3) return null;
    let i = 0, j = 0, oa = "", nb = "";
    while (i < m || j < n) {
      if (i < m && j < n && x[i] === y[j]) { oa += esc(x[i]); nb += esc(y[j]); i++; j++; }
      else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) { nb += "<ins>" + esc(y[j]) + "</ins>"; j++; }
      else { oa += "<del>" + esc(x[i]) + "</del>"; i++; }
    }
    return [oa.replace(/<\/del><del>/g, ""), nb.replace(/<\/ins><ins>/g, "")];
  }
  const pairCache = new WeakMap();
  function hunkPairs(h) {
    if (pairCache.has(h)) return pairCache.get(h);
    const out = new Map(), L = h.lines;
    let i = 0;
    while (i < L.length) {
      if (L[i][0] !== "-") { i++; continue; }
      let d = i; while (d < L.length && L[d][0] === "-") d++;
      let a = d; while (a < L.length && L[a][0] === "+") a++;
      const nd = d - i, na = a - d;
      for (let k = 0; k < Math.min(nd, na); k++) {
        const r = wordDiff(L[i + k][3], L[d + k][3]);
        if (r) { out.set(i + k, r[0]); out.set(d + k, r[1]); }
      }
      i = a;
    }
    pairCache.set(h, out);
    return out;
  }

  // ------------------------------------------------------------ code rendering
  function inRange(line, ref) {
    if (!ref) return false;
    const n = ref.side === "old" ? line[1] : line[2];
    return n != null && n >= ref.start && n <= (ref.end == null ? ref.start : ref.end);
  }
  function lineHtml(h, idx, ref) {
    const l = h.lines[idx], t = l[0];
    const cls = (t === "+" ? "add" : t === "-" ? "del" : "ctx") + (inRange(l, ref) ? " hl" : "");
    const pairs = hunkPairs(h);
    const body = pairs.has(idx) ? pairs.get(idx) : esc(l[3]);
    return '<div class="ln ' + cls + '" data-o="' + (l[1] == null ? "" : l[1]) + '" data-n="' + (l[2] == null ? "" : l[2]) + '">' +
      '<span class="no o">' + (l[1] == null ? "" : l[1]) + '</span><span class="no">' + (l[2] == null ? "" : l[2]) + "</span>" +
      '<span class="sig">' + (t === " " ? "" : t === "-" ? "−" : "+") + "</span><code>" + (body || " ") + "</code></div>";
  }
  function fileCode(f, ref, opts) {
    opts = opts || {};
    let html = "";
    if (f.binary) return '<div class="gap-row">Binary file, not shown.</div>';
    if (!f.hunks.length) return '<div class="gap-row">No line changes (mode change or rename only).</div>';
    f.hunks.forEach((h, hi) => {
      let lo = 0, hiIdx = h.lines.length - 1;
      if (opts.excerpt) {
        const hit = h.lines.map((l, i) => inRange(l, ref) ? i : -1).filter(i => i >= 0);
        if (!hit.length) return;
        lo = Math.max(0, hit[0] - 2); hiIdx = Math.min(h.lines.length - 1, hit[hit.length - 1] + 2);
      } else {
        html += '<div class="hunk-head">@@ −' + h.old_start + " +" + h.new_start + (h.context ? " · " + esc(h.context) : "") + "</div>";
      }
      for (let i = lo; i <= hiIdx; i++) html += lineHtml(h, i, ref);
      if (opts.excerpt && hi < f.hunks.length - 1) html += "";
    });
    if (f.truncated && !opts.excerpt) html += '<div class="gap-row">Diff truncated here; the rest is on GitHub.</div>';
    return '<div class="code' + (ref && !opts.excerpt ? " focus" : "") + '">' + html + "</div>";
  }
  function refLabel(ref) {
    if (!ref) return "";
    const e = ref.end != null && ref.end !== ref.start ? "–" + ref.end : "";
    return ref.file + ":" + (ref.side === "old" ? "old " : "") + ref.start + e;
  }
  function refLink(ref, text) {
    if (!ref) return "";
    return '<a class="reflink" data-ref="' + esc(JSON.stringify(ref)) + '">' + esc(text || refLabel(ref)) + "</a>";
  }

  // ------------------------------------------------------------ chips
  const CAT_COLOR = { source: "#3b6fd8", test: "#2f9e62", migration: "#b0467a", config: "#c98a12", ci: "#7a5cc8", docs: "#5b8fa3", lockfile: "#9aa3ae", generated: "#b7bec7", binary: "#c4c9cf" };
  const REC = { "approve": ["ok", "Approve"], "approve-with-nits": ["ok", "Approve with nits"], "request-changes": ["bad", "Request changes"], "needs-discussion": ["warn", "Needs discussion"] };
  const CLAIM = { verified: ["ok", "Verified"], partly: ["warn", "Partly"], unverified: ["", "Unverified"], contradicted: ["bad", "Contradicted"] };
  const SEV = { high: "bad", medium: "warn", low: "" };
  const ATT = { read: ["accent", "Read"], glance: ["", "Glance"], skip: ["", "Skip"] };
  const chip = (cls, text) => '<span class="chip ' + (cls || "") + '">' + esc(text) + "</span>";
  const statusChip = f => chip(f.status === "added" ? "ok" : f.status === "removed" ? "bad" : f.status === "renamed" ? "warn" : "", f.status);
  const nums = f => '<span class="nums"><span class="add">+' + f.additions + '</span> <span class="del">−' + f.deletions + "</span></span>";

  // ------------------------------------------------------------ header, warnings, footer
  $("#brand").innerHTML = esc(PR.repo) + " <span>#" + PR.number + "</span>";
  if (WARN.length) {
    $("#warnings").innerHTML = '<div class="banner"><details><summary><strong>' + plural(WARN.length, "problem") +
      " in the analysis</strong>: some references may point at the wrong lines.</summary><ul>" +
      WARN.map(w => "<li>" + esc(w) + "</li>").join("") + "</ul></details></div>";
  }
  $("#foot").innerHTML = "Diff and metadata from " + esc(PR.diff_source) + " at " + esc(String(PR.head_sha || "").slice(0, 9)) +
    ". Verdict, story, risks, notes and quiz are Claude's analysis. Page built " + esc(DATA.generated_at) + ".";

  // ------------------------------------------------------------ summary tab
  function renderSummary() {
    const v = A.verdict || {}, s = A.summary || {};
    const rec = REC[v.recommendation] || ["", v.recommendation || "No verdict"];
    const checks = PR.checks || [];
    const cOk = checks.filter(c => c.result === "success").length, cBad = checks.filter(c => c.result === "failure").length, cPend = checks.filter(c => c.result === "pending").length;
    const stateCls = { merged: "accent", open: "ok", closed: "bad", draft: "" }[PR.state] || "";
    const byCat = {};
    FILES.forEach(f => { byCat[f.category] = (byCat[f.category] || 0) + f.additions + f.deletions; });
    const total = Object.values(byCat).reduce((a, b) => a + b, 0) || 1;
    const cats = Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a]);
    let h = '<div class="narrow stack">';
    h += '<div class="hero"><div class="hero-meta">' + chip(stateCls, PR.state) +
      ((PR.agent_written || A.agent_written) ? '<span class="chip warn" title="' + esc((PR.agent_evidence || []).concat(A.agent_written_why ? [A.agent_written_why] : []).join("; ")) + '">Agent-written</span>' : "") +
      '<span class="mono">' + esc(PR.base) + " ← " + esc(PR.head) + "</span><span>by " + esc(PR.author) + "</span>" +
      '<a href="' + esc(PR.url) + '" target="_blank" rel="noopener">Open on GitHub ↗</a></div>' +
      "<h1>" + esc(PR.title) + "</h1></div>";
    h += '<div class="card verdict ' + esc(v.recommendation || "") + '"><div class="verdict-top"><span class="eyebrow">Verdict</span>' + chip(rec[0], rec[1]) +
      (v.confidence ? chip("", v.confidence + " confidence") : "") + '<span class="mine">Claude\'s analysis</span></div>' +
      '<div class="headline">' + inline(v.headline || "") + "</div>" + md(v.why) +
      (v.confidence_note ? '<div class="small muted">' + inline(v.confidence_note) + "</div>" : "") + "</div>";
    h += '<div class="stats">' +
      stat(FILES.length, "files changed", "") +
      stat('<span class="add">+' + PR.additions + '</span> <span class="del">−' + PR.deletions + "</span>", "lines", "") +
      stat(PR.commits.length, plural(PR.commits.length, "commit").replace(/^\d+ /, ""), "") +
      stat(checks.length ? cOk + "/" + checks.length : "—", "CI checks passed", cBad ? cBad + " failed" : cPend ? cPend + " pending" : "") +
      stat("~" + PR.read_minutes + " min", "to read the diff", "rough, by file type") +
      (A.summary && A.summary.key_numbers || []).map(k => stat(esc(k.value), esc(k.label), esc(k.note || ""))).join("") + "</div>";
    if (s.tldr) h += '<div class="card"><div class="section-head"><h2>In short</h2><span class="mine">Claude\'s analysis</span></div>' + md(s.tldr) + "</div>";
    h += '<div class="two-col">';
    h += '<div class="card"><h3>Why</h3>' + md(s.why || "—") + "</div>";
    h += '<div class="card"><h3>What changes</h3>' + md((s.what_changed || []).map(x => "- " + x).join("\n")) +
      (s.impact ? '<div class="small muted" style="margin-top:8px"><strong>Impact:</strong> ' + inline(s.impact) + "</div>" : "") + "</div>";
    h += "</div>";
    h += '<div class="card"><h3>Where the lines are</h3><div class="compo-bar">' + cats.map(c => '<span style="width:' + (byCat[c] / total * 100) + "%;background:" + (CAT_COLOR[c] || "#999") + '" title="' + esc(c) + '"></span>').join("") +
      '</div><div class="legend">' + cats.map(c => "<span><i style=\"background:" + (CAT_COLOR[c] || "#999") + '"></i>' + esc(c) + " · " + byCat[c] + "</span>").join("") + "</div></div>";
    if ((A.claims || []).length) {
      h += '<div class="card"><div class="section-head"><h2>Claims check</h2><span class="small muted">What the PR says, checked against the diff and CI</span></div><table class="claims"><tbody>' +
        A.claims.map(c => { const st = CLAIM[c.status] || ["", c.status]; return "<tr><td>" + chip(st[0], st[1]) + "</td><td>" + inline(c.claim) +
          '<div class="ev">' + inline(c.evidence || "") + (c.ref ? " · " + refLink(c.ref) : "") + "</div></td></tr>"; }).join("") + "</tbody></table></div>";
    }
    if (checks.length) {
      h += '<div class="card"><h3>CI</h3><div class="ci-list">' + checks.map(c => {
        const cls = { success: "ok", failure: "bad", pending: "warn" }[c.result] || "";
        return '<a href="' + esc(c.url || PR.url) + '" target="_blank" rel="noopener">' + chip(cls, (c.workflow ? c.workflow + " / " : "") + c.name) + "</a>";
      }).join("") + "</div></div>";
    }
    if ((PR.linked_issues || []).length) {
      h += '<div class="card"><h3>Linked issues and PRs</h3><div class="linked">' + PR.linked_issues.map(i =>
        '<a href="' + esc(i.url) + '" target="_blank" rel="noopener"><span class="num">#' + i.number + "</span><span>" + esc(i.title) + "</span>" + chip(i.state === "open" ? "ok" : "", i.kind + " · " + i.state) + "</a>").join("") + "</div></div>";
    }
    if ((A.questions_for_author || []).length) {
      h += '<div class="card"><h3>Questions for the author</h3><ol class="qlist">' + A.questions_for_author.map(q => "<li>" + inline(q) + "</li>").join("") + "</ol></div>";
    }
    if (PR.body) h += '<details class="card"><summary><strong>PR description</strong> <span class="small muted">as written by the author</span></summary><div style="margin-top:10px">' + md(PR.body) + "</div></details>";
    h += "</div>";
    $("#tab-summary").innerHTML = h;
  }
  function stat(v, l, n) { return '<div class="stat"><div class="v">' + v + '</div><div class="l">' + l + "</div>" + (n ? '<div class="n">' + n + "</div>" : "") + "</div>"; }

  // ------------------------------------------------------------ walkthrough tab
  let activeStep = -1;
  function renderWalk() {
    const story = A.story || [];
    if (!story.length) { $("#tab-walkthrough").innerHTML = '<div class="narrow card muted">No walkthrough in this analysis.</div>'; return; }
    let h = '<div class="walk"><div class="steps">';
    story.forEach((s, i) => {
      const f = s.ref && byPath.get(s.ref.file);
      h += '<article class="step" data-i="' + i + '" id="step-' + (i + 1) + '"><div class="step-num">Step ' + (i + 1) + " / " + story.length + "</div><h3>" + inline(s.title) + "</h3>" + md(s.body) +
        (s.ref ? '<div class="where">' + esc(refLabel(s.ref)) + "</div>" : "") +
        (s.more ? '<details class="more"><summary>' + inline(s.more_title || "More detail") + "</summary>" + md(s.more) + "</details>" : "") +
        (f ? '<div class="excerpt">' + fileCode(f, s.ref, { excerpt: true }) + "</div>" : "") + "</article>";
    });
    h += '</div><aside class="panel" aria-live="polite"><div class="progress"><span id="walk-prog"></span></div><div class="panel-head" id="panel-head"></div><div class="panel-body" id="panel-body"></div></aside></div>';
    $("#tab-walkthrough").innerHTML = h;
    $$(".step").forEach(el => el.addEventListener("click", e => {
      if (e.target.closest("a, summary, details")) return;
      const i = +el.dataset.i; setStep(i);
      el.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
    }));
    activeStep = -1; setStep(0);
  }
  let panelFile = null;
  function setStep(i) {
    const story = A.story || [];
    if (i === activeStep || !story[i]) return;
    activeStep = i;
    $$(".step").forEach(el => el.classList.toggle("active", +el.dataset.i === i));
    const s = story[i], f = s.ref && byPath.get(s.ref.file);
    $("#walk-prog").style.width = ((i + 1) / story.length * 100) + "%";
    const head = $("#panel-head"), body = $("#panel-body");
    if (!f) { head.innerHTML = '<span class="path muted">No code for this step</span>'; body.innerHTML = ""; panelFile = null; return; }
    head.innerHTML = '<span class="path">' + esc(f.path) + "</span>" + chip("", f.category) + nums(f) +
      ' <a class="reflink" data-ref="' + esc(JSON.stringify(s.ref)) + '">Open in diff</a>';
    if (panelFile !== f.path) { body.innerHTML = fileCode(f, s.ref); panelFile = f.path; }
    else {
      $$(".ln", body).forEach(el => {
        const n = s.ref.side === "old" ? el.dataset.o : el.dataset.n;
        el.classList.toggle("hl", n !== "" && +n >= s.ref.start && +n <= (s.ref.end == null ? s.ref.start : s.ref.end));
      });
    }
    const first = $(".ln.hl", body);
    if (first) body.scrollTop = Math.max(0, first.offsetTop - body.clientHeight / 3);
  }
  function onScroll() {
    if (currentTab !== "walkthrough") return;
    const steps = $$(".step");
    if (!steps.length) return;
    const mark = window.innerHeight * 0.42;
    let idx = 0;
    if (window.scrollY > 40) steps.forEach((el, i) => { if (el.getBoundingClientRect().top <= mark) idx = i; });
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) idx = steps.length - 1;
    setStep(idx);
  }
  let ticking = false;
  window.addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(() => { ticking = false; onScroll(); }); } }, { passive: true });

  // ------------------------------------------------------------ map tab
  function renderMap() {
    const ro = A.reading_order || [];
    const notes = A.file_notes || {};
    let h = '<div class="narrow stack">';
    (A.diagrams || []).forEach((d, i) => {
      h += '<div class="card"><div class="section-head"><h2>' + inline(d.title || "Diagram") + '</h2><span class="mine">Claude\'s analysis</span></div>' +
        (d.caption ? '<p class="muted small" style="margin-top:0">' + inline(d.caption) + "</p>" : "") +
        '<div class="diagram" id="diagram-' + i + '"><pre class="mermaid-src">' + esc(d.mermaid) + "</pre></div></div>";
    });
    const list = ro.length ? ro : FILES.map(f => ({ file: f.path, attention: ["lockfile", "generated", "binary"].includes(f.category) ? "skip" : "read", why: "" }));
    h += '<div class="card"><div class="section-head"><h2>Reading order</h2><span class="small muted">' +
      (ro.length ? "Dependencies first, each test after its code" : "No order in the analysis; files as GitHub lists them") + "</span></div><div class=\"reading\">";
    list.forEach((r, i) => {
      const f = byPath.get(r.file); if (!f) return;
      const att = ATT[r.attention] || ["", r.attention];
      h += '<div class="ro ' + esc(r.attention) + '"><div class="ro-n">' + (i + 1) + '</div><div><a class="path reflink" data-ref="' + esc(JSON.stringify({ file: f.path })) + '">' + esc(f.path) + "</a>" +
        '<div class="small muted">' + inline(r.why || notes[f.path] || "") + '</div></div><div class="ro-side">' + chip(att[0], att[1]) + nums(f) + "<span class=\"small muted\">" + esc(f.category) + "</span></div></div>";
    });
    h += "</div></div></div>";
    $("#tab-map").innerHTML = h;
    mermaidDone = false;
  }
  let mermaidDone = false;
  function isDark() {
    const t = document.documentElement.dataset.theme;
    return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  }
  async function renderMermaid() {
    if (mermaidDone || !(A.diagrams || []).length) return;
    if (!window.mermaid) { window.addEventListener("load", () => { if (currentTab === "map") renderMermaid(); }, { once: true }); return; }
    mermaidDone = true;
    try { window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: isDark() ? "dark" : "neutral", fontFamily: "Inter, system-ui, sans-serif" }); }
    catch (e) { return; }
    for (let i = 0; i < A.diagrams.length; i++) {
      const box = $("#diagram-" + i); if (!box) continue;
      try {
        const out = await window.mermaid.render("mmd-" + i + "-" + Date.now(), A.diagrams[i].mermaid);
        box.innerHTML = out.svg;
      } catch (e) {
        box.innerHTML = '<pre class="mermaid-src">' + esc(A.diagrams[i].mermaid) + '</pre><div class="small" style="color:var(--bad)">Diagram did not parse: ' + esc(e.message || e) + "</div>";
      }
    }
  }

  // ------------------------------------------------------------ risks + checklist tab
  function renderRisks() {
    const risks = (A.risks || []).slice().sort((a, b) => ["high", "medium", "low"].indexOf(a.severity) - ["high", "medium", "low"].indexOf(b.severity));
    const checks = A.checklist || [];
    const done = load("checklist", {});
    let h = '<div class="narrow stack">';
    h += '<div><div class="section-head"><h2>Risks</h2><span class="mine">Claude\'s analysis</span></div>';
    if (!risks.length) h += '<div class="card muted">No specific risks found.</div>';
    h += '<div class="stack" style="gap:12px">' + risks.map(r => '<div class="card risk ' + esc(r.severity) + '"><div class="row">' + chip(SEV[r.severity], r.severity) +
      "<strong>" + inline(r.title) + "</strong></div>" + md(r.detail) +
      (r.catch ? '<div class="catch"><strong>What would catch it:</strong> ' + inline(r.catch) + "</div>" : "") +
      (r.ref ? '<div class="small">' + refLink(r.ref) + "</div>" : "") + "</div>").join("") + "</div></div>";
    if (checks.length) {
      h += '<div class="card"><div class="section-head"><h2>Before you merge</h2><span class="small muted" id="check-count"></span></div><div class="meter"><span id="check-meter"></span></div><div style="margin-top:8px">' +
        checks.map((c, i) => '<div class="check-item' + (done[i] ? " done" : "") + '"><input type="checkbox" id="chk-' + i + '" data-i="' + i + '"' + (done[i] ? " checked" : "") + '><label for="chk-' + i + '" class="txt">' + inline(c.item) +
          (c.why ? '<div class="small muted">' + inline(c.why) + "</div>" : "") + (c.ref ? '<div class="small">' + refLink(c.ref) + "</div>" : "") + "</label></div>").join("") + "</div></div>";
    }
    h += '<div class="card"><div class="section-head"><h2>Review notes</h2><span class="small muted">Copy and post them yourself; this page never writes to GitHub</span></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" id="copy-notes" type="button">Copy review notes</button><span class="small muted" id="copy-status" role="status"></span></div>' +
      '<textarea class="notes" id="notes" spellcheck="false" aria-label="Review notes"></textarea></div>';
    h += "</div>";
    $("#tab-risks").innerHTML = h;
    $$("#tab-risks input[type=checkbox]").forEach(cb => cb.addEventListener("change", () => {
      const d = load("checklist", {}); d[cb.dataset.i] = cb.checked; save("checklist", d);
      cb.closest(".check-item").classList.toggle("done", cb.checked); updateChecks();
    }));
    $("#copy-notes").addEventListener("click", () => {
      const ta = $("#notes"); const text = ta.value;
      const ok = () => { $("#copy-status").textContent = "Copied"; setTimeout(() => { $("#copy-status").textContent = ""; }, 2000); };
      const fallback = () => { ta.focus(); ta.select(); $("#copy-status").textContent = "Selected: press ⌘C / Ctrl+C"; };
      try { navigator.clipboard.writeText(text).then(ok, fallback); } catch (e) { fallback(); }
    });
    updateChecks();
  }
  function updateChecks() {
    const checks = A.checklist || [], d = load("checklist", {});
    const n = checks.filter((_, i) => d[i]).length;
    if ($("#check-count")) { $("#check-count").textContent = n + " of " + checks.length + " checked"; $("#check-meter").style.width = (checks.length ? n / checks.length * 100 : 0) + "%"; }
    const ta = $("#notes"); if (!ta) return;
    const lines = [];
    const rec = REC[(A.verdict || {}).recommendation];
    if (rec) lines.push("**" + rec[1] + "**" + ((A.verdict || {}).headline ? ": " + A.verdict.headline : ""), "");
    if (checks.length) { lines.push("Checked before merge:"); checks.forEach((c, i) => lines.push("- [" + (d[i] ? "x" : " ") + "] " + c.item)); lines.push(""); }
    const qs = A.questions_for_author || [];
    if (qs.length) { lines.push("Questions:"); qs.forEach((q, i) => lines.push((i + 1) + ". " + q)); }
    ta.value = lines.join("\n").trim();
  }

  // ------------------------------------------------------------ learn tab
  function renderLearn() {
    const concepts = A.concepts || [], quiz = A.quiz || [], tryIt = A.try_it;
    let h = '<div class="narrow stack">';
    if (tryIt && (tryIt.rows || []).length) {
      const hasBefore = tryIt.rows.some(r => r.before != null);
      h += '<div class="card"><div class="section-head"><h2>' + inline(tryIt.title || "Try it") + '</h2><span class="mine">Worked out from the code by Claude</span></div>' +
        '<label class="small muted" for="try-in">' + esc(tryIt.input_label || "Input") + '</label><select id="try-in" class="try-select">' +
        tryIt.rows.map((r, i) => '<option value="' + i + '">' + esc(r.input) + "</option>").join("") + "</select>" +
        '<div class="try-out">' + (hasBefore ? '<div class="try-cell del"><div class="eyebrow">' + esc(tryIt.before_label || "Before") + '</div><code id="try-before"></code></div>' : "") +
        '<div class="try-cell add"><div class="eyebrow">' + esc(tryIt.after_label || "After") + '</div><code id="try-after"></code></div></div><div class="small muted" id="try-note"></div></div>';
    }
    if (concepts.length) {
      h += '<div><div class="section-head"><h2>Concepts in this PR</h2><span class="mine">Claude\'s analysis</span></div><div class="concepts">' +
        concepts.map(c => '<div class="card concept"><h3>' + esc(c.term) + '</h3><div class="short">' + inline(c.short || "") + "</div>" + md(c.explain) +
          (c.link ? '<div class="small" style="margin-top:8px"><a href="' + esc(c.link) + '" target="_blank" rel="noopener">Read more ↗</a></div>' : "") + "</div>").join("") + "</div></div>";
    }
    if (quiz.length) {
      h += '<div class="card"><div class="section-head"><h2>Check your understanding</h2><span class="score" id="quiz-score"></span></div><div class="stack" style="gap:22px">' +
        quiz.map((q, i) => '<div class="quiz-q" data-q="' + i + '"><div><strong>' + (i + 1) + ".</strong> " + inline(q.question) + '</div><div class="quiz-opts">' +
          (q.options || []).map((o, j) => '<button type="button" class="quiz-opt" data-j="' + j + '">' + inline(o) + "</button>").join("") +
          '</div><div class="quiz-explain" hidden>' + md(q.explain) + "</div></div>").join("") +
        '</div><div style="margin-top:14px"><button class="btn" id="quiz-reset" type="button">Start over</button></div></div>';
    }
    if (!concepts.length && !quiz.length && !(tryIt && (tryIt.rows || []).length)) h +='<div class="card muted">Nothing to learn here: the analysis has no concepts or quiz.</div>';
    h += "</div>";
    $("#tab-learn").innerHTML = h;
    const sel = $("#try-in");
    if (sel) {
      const show = () => {
        const r = tryIt.rows[+sel.value] || {};
        if ($("#try-before")) $("#try-before").textContent = r.before == null ? "(new behaviour)" : r.before;
        $("#try-after").textContent = r.after == null ? "" : r.after;
        $("#try-note").innerHTML = inline(r.note || "");
      };
      sel.addEventListener("change", show); show();
    }
    const answers = load("quiz", {});
    $$(".quiz-q").forEach(qel => {
      const i = +qel.dataset.q;
      if (answers[i] != null) markQuiz(qel, i, answers[i]);
      $$(".quiz-opt", qel).forEach(b => b.addEventListener("click", () => {
        const a = load("quiz", {}); a[i] = +b.dataset.j; save("quiz", a); markQuiz(qel, i, +b.dataset.j); quizScore();
      }));
    });
    const reset = $("#quiz-reset");
    if (reset) reset.addEventListener("click", () => { save("quiz", {}); renderLearn(); });
    quizScore();
  }
  function markQuiz(qel, i, j) {
    const right = (A.quiz[i] || {}).answer;
    $$(".quiz-opt", qel).forEach(b => { const k = +b.dataset.j; b.disabled = true; if (k === right) b.classList.add("right"); else if (k === j) b.classList.add("wrong"); });
    $(".quiz-explain", qel).hidden = false;
  }
  function quizScore() {
    const el = $("#quiz-score"); if (!el) return;
    const a = load("quiz", {}), q = A.quiz || [];
    const answered = Object.keys(a).length, right = Object.keys(a).filter(i => q[i] && q[i].answer === a[i]).length;
    el.textContent = answered ? right + " / " + answered + " right" : q.length + " questions";
  }

  // ------------------------------------------------------------ diff tab
  function renderDiff() {
    const notes = A.file_notes || {};
    const viewed = load("viewed", {});
    let rail = "", body = "";
    FILES.forEach((f, i) => {
      const startClosed = ["lockfile", "generated", "binary"].includes(f.category) || f.status === "removed" || (f.additions + f.deletions) > 600 || viewed[f.path];
      const short = f.path.length > 34 ? "…" + f.path.slice(-33) : f.path;
      rail += '<a href="#diff" data-file="' + i + '" class="' + (viewed[f.path] ? "viewed" : "") + '"><span class="p" title="' + esc(f.path) + '">' + esc(short) + "</span>" + nums(f) + "</a>";
      body += '<div class="file' + (startClosed ? "" : " open") + (viewed[f.path] ? " viewed" : "") + '" id="file-' + i + '" data-i="' + i + '">' +
        '<div class="file-head"><span class="tw">▸</span>' + statusChip(f) + '<span class="path">' + (f.old_path ? esc(f.old_path) + " → " : "") + esc(f.path) + "</span>" +
        chip("", f.category) + nums(f) + '<label class="viewed-box"><input type="checkbox" class="viewed-cb"' + (viewed[f.path] ? " checked" : "") + "> Viewed</label>" +
        '<a href="' + esc(f.github_url) + '" target="_blank" rel="noopener" class="small">GitHub ↗</a></div>' +
        (notes[f.path] ? '<div class="file-note">' + inline(notes[f.path]) + "</div>" : "") +
        '<div class="file-body"' + (startClosed ? " hidden" : "") + "></div></div>";
    });
    $("#tab-diff").innerHTML = '<div class="diff-layout"><nav class="rail" aria-label="Files">' + rail + '</nav><div><div class="toolbar"><button class="btn" id="exp-all" type="button">Expand all</button><button class="btn" id="col-all" type="button">Collapse all</button>' +
      '<span class="small muted">' + plural(FILES.length, "file") + ' · lockfiles, generated and viewed files start collapsed</span></div>' + body + "</div></div>";
    $$("#tab-diff .file").forEach(el => { if (el.classList.contains("open")) fillFile(el); });
    $$("#tab-diff .file-head").forEach(hd => hd.addEventListener("click", e => {
      if (e.target.closest("a, label, input")) return;
      toggleFile(hd.parentElement);
    }));
    $$("#tab-diff .viewed-cb").forEach(cb => cb.addEventListener("change", () => {
      const el = cb.closest(".file"), f = FILES[+el.dataset.i], v = load("viewed", {});
      v[f.path] = cb.checked; save("viewed", v);
      el.classList.toggle("viewed", cb.checked);
      $('.rail a[data-file="' + el.dataset.i + '"]').classList.toggle("viewed", cb.checked);
      if (cb.checked && el.classList.contains("open")) toggleFile(el, false);
    }));
    $$("#tab-diff .rail a").forEach(a => a.addEventListener("click", e => { e.preventDefault(); openFile(+a.dataset.file); }));
    $("#exp-all").addEventListener("click", () => $$("#tab-diff .file").forEach(el => toggleFile(el, true)));
    $("#col-all").addEventListener("click", () => $$("#tab-diff .file").forEach(el => toggleFile(el, false)));
  }
  function fillFile(el) { const b = $(".file-body", el); if (!b.dataset.filled) { b.innerHTML = fileCode(FILES[+el.dataset.i], null); b.dataset.filled = "1"; } }
  function toggleFile(el, open) {
    const want = open == null ? !el.classList.contains("open") : open;
    el.classList.toggle("open", want);
    $(".file-body", el).hidden = !want;
    if (want) fillFile(el);
  }
  function openFile(i, ref) {
    const el = $("#file-" + i); if (!el) return;
    toggleFile(el, true);
    let target = el;
    if (ref && ref.start != null) {
      const attr = ref.side === "old" ? "data-o" : "data-n";
      const end = ref.end == null ? ref.start : ref.end;
      const lines = $$(".ln", el).filter(l => { const n = l.getAttribute(attr); return n !== "" && +n >= ref.start && +n <= end; });
      lines.forEach(l => { l.classList.remove("flash"); void l.offsetWidth; l.classList.add("flash"); });
      if (lines[0]) target = lines[0];
    }
    target.scrollIntoView({ block: target === el ? "start" : "center" });
  }

  // ------------------------------------------------------------ references → diff
  document.addEventListener("click", e => {
    const a = e.target.closest(".reflink[data-ref]"); if (!a) return;
    e.preventDefault();
    let ref; try { ref = JSON.parse(a.dataset.ref); } catch (err) { return; }
    const i = FILES.findIndex(f => f.path === ref.file); if (i < 0) return;
    showTab("diff");
    requestAnimationFrame(() => openFile(i, ref));
  });

  // ------------------------------------------------------------ tabs + theme
  const TABS = ["summary", "walkthrough", "map", "risks", "learn", "diff"];
  const rendered = {};
  const RENDER = { summary: renderSummary, walkthrough: renderWalk, map: renderMap, risks: renderRisks, learn: renderLearn, diff: renderDiff };
  let currentTab = null;
  function showTab(name) {
    if (!TABS.includes(name)) name = "summary";
    if (!rendered[name]) { RENDER[name](); rendered[name] = true; }
    $$(".tab").forEach(s => { s.hidden = s.dataset.tab !== name; });
    $$("#tabs a").forEach(a => a.classList.toggle("active", a.dataset.tab === name));
    const changed = currentTab !== name;
    currentTab = name;
    if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
    if (changed) window.scrollTo(0, 0);
    if (name === "map") renderMermaid();
    if (name === "walkthrough") onScroll();
  }
  $$("#tabs a").forEach(a => a.addEventListener("click", e => { e.preventDefault(); showTab(a.dataset.tab); }));
  window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));

  function applyTheme(t) {
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    mermaidDone = false;
    if (rendered.map) { renderMap(); if (currentTab === "map") renderMermaid(); }
  }
  let theme = null; try { theme = localStorage.getItem("prg:theme"); } catch (e) { /* none */ }
  if (theme) document.documentElement.dataset.theme = theme;
  $("#theme-btn").addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    try { localStorage.setItem("prg:theme", next); } catch (e) { /* none */ }
    applyTheme(next);
  });

  // keyboard: j/k move through walkthrough steps
  document.addEventListener("keydown", e => {
    if (currentTab !== "walkthrough" || e.target.closest("input, textarea") || e.metaKey || e.ctrlKey) return;
    const steps = $$(".step"); if (!steps.length) return;
    let i = activeStep;
    if (e.key === "j" || e.key === "ArrowDown" && e.altKey) i = Math.min(steps.length - 1, i + 1);
    else if (e.key === "k" || e.key === "ArrowUp" && e.altKey) i = Math.max(0, i - 1);
    else return;
    e.preventDefault(); setStep(i); steps[i].scrollIntoView({ block: "center" });
  });

  showTab(location.hash.slice(1) || "summary");
})();
