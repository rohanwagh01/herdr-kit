// NOTICE: modified from Herdr's "changes" mod, version 0.1.13 (Apache License 2.0).
// Changed for herdr-kit; see NOTICE and LICENSE in the repository root.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings } from "herdr";

// Changes (Chief of Staff clone). Scopes instead of uncommitted only:
//   all          every local change on this branch against its base (origin/main),
//                committed or not, including untracked files
//   uncommitted  the working tree against HEAD (what the shipped mod showed)
//   commit <sha> one commit ahead of the base, in git log order, capped at MAX_COMMITS
//   pr <n>       every commit of one GitHub PR whose head is on this branch
// Commits that belong to an open PR are boxed under "owner/repo #n". Implementers
// commit as they go and only push/PR on the owner's go-ahead, so "all" matches what
// the agents have actually done.

const MAX_COMMITS = 15;
const BASE_CANDIDATES = ["origin/main", "origin/master", "main", "master"];
const PR_TTL = 90000; // ms between `gh pr list` calls per repo

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const SHOW = ["--no-ext-diff", "--no-textconv", "--no-color"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
const scopeKey = (s) => s.kind === "commit" ? `commit:${s.sha}` : s.kind === "pr" ? `pr:${s.number}` : s.kind;
const mono = () => settings().font_family ?? "JetBrains Mono";

// ---------------------------------------------------------------- syntax colors
// GitHub-like token colors, light and dark, picked from the theme background.
const PALETTE = {
  light: { keyword: "#cf222e", string: "#0a3069", comment: "#6e7781", number: "#0550ae", constant: "#0550ae", builtin: "#0550ae", function: "#8250df", decorator: "#116329", type: "#953800", property: "#0550ae" },
  dark: { keyword: "#ff7b72", string: "#a5d6ff", comment: "#8b949e", number: "#79c0ff", constant: "#79c0ff", builtin: "#79c0ff", function: "#d2a8ff", decorator: "#7ee787", type: "#ffa657", property: "#79c0ff" },
};
function isDark(hex) {
  const m = /^#?([0-9a-f]{6})/i.exec(hex || "");
  if (!m) return true;
  const n = parseInt(m[1], 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128;
}
const words = (list) => new Set(list.split(" "));
const CLIKE_KW = "break case catch class const continue debugger default delete do else enum export extends finally for function if implements import in instanceof interface let new package private protected public return static super switch this throw try typeof var void while with yield async await of as from type declare readonly namespace abstract keyof satisfies";
const LANGS = {
  python: { keywords: words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case"), constants: words("True False None self cls"), builtins: words("print len range str int float bool list dict set tuple isinstance hasattr getattr setattr type object super Exception ValueError TypeError KeyError RuntimeError enumerate zip map filter sorted reversed any all min max sum abs open input repr format iter next property staticmethod classmethod"), line: "#", triple: true, decorator: true, defs: words("def class"), types: true },
  js: { keywords: words(CLIKE_KW), constants: words("true false null undefined NaN Infinity this"), builtins: words("console window document Promise Array Object String Number Boolean Map Set JSON Math Date Error RegExp Symbol require module exports"), line: "//", block: ["/*", "*/"], template: true, decorator: true, defs: words("function class"), types: true },
  rust: { keywords: words("as break const continue crate else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while async await dyn"), constants: words("true false None Some Ok Err"), builtins: words("Vec String Option Result Box Rc Arc HashMap HashSet i32 i64 u8 u32 u64 usize f32 f64 bool str char"), line: "//", block: ["/*", "*/"], defs: words("fn struct enum trait mod"), types: true },
  go: { keywords: words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var"), constants: words("true false nil iota"), builtins: words("string int int64 float64 bool byte rune error make new len cap append copy delete panic recover print println"), line: "//", block: ["/*", "*/"], defs: words("func type"), types: true },
  shell: { keywords: words("if then else elif fi for while do done case esac in function return exit export local readonly set unset source alias cd echo"), constants: words("true false"), builtins: words("hc git gh python3 cd ls rm mkdir cat grep sed awk curl sh bash zsh"), line: "#" },
  sql: { keywords: words("select from where and or not in is null as join left right inner outer on group by order having limit offset insert into values update set delete create table alter drop index primary key references unique default constraint begin commit rollback with returning distinct union all exists between like case when then else end"), constants: words("true false null"), builtins: words("count sum avg min max coalesce now"), line: "--", block: ["/*", "*/"], caseless: true },
  yaml: { keywords: new Set(), constants: words("true false null yes no ~"), builtins: new Set(), line: "#", keyProp: true },
  toml: { keywords: new Set(), constants: words("true false"), builtins: new Set(), line: "#", keyProp: true },
  json: { keywords: new Set(), constants: words("true false null"), builtins: new Set(), keyProp: true },
  markdown: { keywords: new Set(), constants: new Set(), builtins: new Set(), md: true },
};
const EXT = { py: "python", pyi: "python", js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "js", tsx: "js", rs: "rust", go: "go", sh: "shell", bash: "shell", zsh: "shell", sql: "sql", yaml: "yaml", yml: "yaml", toml: "toml", json: "json", md: "markdown" };
const langOf = (path) => { const base = (path || "").split("/").pop() || ""; if (/^(Dockerfile|Makefile)$/.test(base)) return "shell"; return EXT[(base.split(".").pop() || "").toLowerCase()] ?? null; };
const TRIPLE = ['"""', "'''"];

// Splits one source line into colored spans; `state` carries an open block
// comment or triple-quoted string from the previous line.
function tokenize(text, cfg, state) {
  const spans = [], n = text.length;
  let i = 0, prevWord = "";
  const push = (end, kind) => { if (end > i) { spans.push({ text: text.slice(i, end), kind }); i = end; } };
  while (i < n) {
    if (state) {
      const at = text.indexOf(state.close, i);
      if (at < 0) { push(n, state.kind); return { spans, state }; }
      push(at + state.close.length, state.kind); state = null; continue;
    }
    const ch = text[i], rest = text.slice(i);
    if (cfg.md) {
      if (i === 0 && /^#{1,6}\s/.test(rest)) { push(n, "keyword"); break; }
      if (ch === "`") { const m = /^`[^`]*`/.exec(rest); if (m) { push(i + m[0].length, "string"); continue; } }
      if (i === 0 && /^[-*+]\s/.test(rest)) { push(i + 1, "keyword"); continue; }
      const m = /^[^`]+/.exec(rest); push(i + (m ? m[0].length : 1), ""); continue;
    }
    if (/\s/.test(ch)) { const m = /^\s+/.exec(rest); push(i + m[0].length, ""); continue; }
    if (cfg.line && rest.startsWith(cfg.line)) { push(n, "comment"); break; }
    if (cfg.block && rest.startsWith(cfg.block[0])) {
      const at = text.indexOf(cfg.block[1], i + cfg.block[0].length);
      if (at < 0) { push(n, "comment"); state = { kind: "comment", close: cfg.block[1] }; break; }
      push(at + cfg.block[1].length, "comment"); continue;
    }
    const triple = cfg.triple ? TRIPLE.find((q) => rest.startsWith(q)) : null;
    if (triple) {
      const at = text.indexOf(triple, i + 3);
      if (at < 0) { push(n, "string"); state = { kind: "string", close: triple }; break; }
      push(at + 3, "string"); continue;
    }
    if (ch === '"' || ch === "'" || (cfg.template && ch === "`")) {
      let j = i + 1;
      while (j < n && text[j] !== ch) { if (text[j] === "\\") j++; j++; }
      push(Math.min(n, j + 1), "string"); continue;
    }
    if (cfg.decorator && ch === "@") { const m = /^@[\w.]+/.exec(rest); if (m) { push(i + m[0].length, "decorator"); continue; } }
    if (/[0-9]/.test(ch) || (ch === "." && /^\.[0-9]/.test(rest))) { const m = /^(0[xXbBoO][0-9a-fA-F_]+|[0-9][0-9_]*(\.[0-9_]+)?([eE][+-]?[0-9]+)?)[a-zA-Z]*/.exec(rest) || /^\.[0-9]+/.exec(rest); push(i + m[0].length, "number"); continue; }
    if (/[A-Za-z_$]/.test(ch)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(rest), word = m[0], w = cfg.caseless ? word.toLowerCase() : word;
      const after = text.slice(i + word.length), nextNonSpace = (/^\s*(\S)/.exec(after) || [])[1] || "";
      let kind = "";
      if (cfg.keyProp && nextNonSpace === ":") kind = "property";
      else if (cfg.keywords.has(w)) kind = "keyword";
      else if (cfg.constants.has(w)) kind = "constant";
      else if (cfg.defs && cfg.defs.has(prevWord)) kind = "function";
      else if (nextNonSpace === "(") kind = "function";
      else if (cfg.builtins.has(w)) kind = "builtin";
      else if (cfg.types && /^[A-Z][a-z]/.test(word)) kind = "type";
      prevWord = w; push(i + word.length, kind); continue;
    }
    prevWord = "";
    push(i + 1, "");
  }
  return { spans, state };
}

// Numbers each diff line once and colors its tokens, so a frame only draws
// the rows on screen. Block comments and docstrings carry across lines.
function diffRows(lines, lang) {
  const cfg = lang ? LANGS[lang] : null;
  let old = 0, next = 0, state = null;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0], body = line.slice(1) || " ";
    let row;
    if (kind === "-") row = { kind, number: old++, text: body };
    else if (kind === "+") row = { kind, number: next++, text: body };
    else if (kind === " ") { old++; row = { kind, number: next++, text: body }; }
    else row = { kind: "", text: line };
    if (cfg && row.kind) { const r = tokenize(row.text, cfg, state); row.spans = r.spans; state = r.state; }
    return row;
  });
}

// "a\tb\tpath\0..." → { path: { add, del, binary } }
function parseNumstat(stdout, into = {}) {
  for (const entry of stdout.split("\0")) {
    const [a, d, ...parts] = entry.split("\t");
    if (!parts.length) continue;
    const path = parts.join("\t"), old = into[path] ?? { add: 0, del: 0 };
    into[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
  }
  return into;
}

// "M\0path\0A\0path\0..." (no renames) → [{ path, status }]
function parseNameStatus(stdout) {
  const tokens = stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const status = tokens[i][0], path = tokens[i + 1];
    if (status && path) out.push({ path, status: status === "U" ? "U" : status === "D" ? "D" : status === "A" ? "A" : "M" });
  }
  return out;
}

// https://github.com/owner/repo/pull/12 → "owner/repo"
const repoOf = (url) => (/github\.com\/([^/]+\/[^/]+)\/pull\//.exec(url || "") || [])[1] ?? "";

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.rows = []; this.diffWidth = 0; this.message = ""; this.handle = cx.focus_handle();
    this.scope = { kind: "all" }; this.commits = []; this.moreCommits = false; this.base = null; this.baseName = null;
    this.prs = []; this.prCache = {}; // root → { at, prs }
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  reset() {
    this.root = null; this.files = []; this.open = null; this.commits = []; this.moreCommits = false; this.base = null; this.baseName = null; this.prs = [];
    this.scope = { kind: "all" }; this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null;
    this.watched = null; this.closed = false; this.limited = false;
  }

  // Open PRs whose head commit is one of this branch's commits ahead of the base.
  // Each gets its commit range: from the previous PR head in the stack (or the base) to its head.
  async loadPrs(root, on, git, base, shas) {
    const cached = this.prCache[root];
    let prs = cached?.prs;
    if (!cached || Date.now() - cached.at > PR_TTL) {
      const r = await exec("gh", ["pr", "list", "--state", "open", "--author", "@me", "--limit", "100", "--json", "number,title,url,headRefName,headRefOid,isDraft"], { cwd: root, on }).catch(() => null);
      let list = [];
      if (r && r.code === 0) { try { list = JSON.parse(r.stdout); } catch { list = []; } }
      prs = Array.isArray(list) ? list : [];
      this.prCache[root] = { at: Date.now(), prs };
    }
    const onBranch = prs.filter((p) => shas.includes(p.headRefOid));
    if (!onBranch.length) return [];
    // Oldest head first, so each PR's range starts where the previous one ends.
    onBranch.sort((a, b) => shas.indexOf(b.headRefOid) - shas.indexOf(a.headRefOid));
    const out = []; let from = base;
    for (const p of onBranch) {
      const rl = await git(["rev-list", `${from}..${p.headRefOid}`]);
      const commits = rl.code === 0 ? rl.stdout.split("\n").filter(Boolean) : [];
      out.push({ number: p.number, title: p.title, url: p.url, repo: repoOf(p.url), draft: p.isDraft, from, to: p.headRefOid, head: p.headRefName, commits: new Set(commits) });
      from = p.headRefOid;
    }
    return out;
  }

  // Files changed in the current scope, with +/- counts. Untracked files only
  // belong to the working-tree scopes (all, uncommitted).
  async listFiles(git, scope, statusOut, hasHead) {
    const stats = {}, byPath = new Map(), files = [];
    const push = (path, status, fresh = false) => {
      if (byPath.has(path)) return;
      const f = { path, status, fresh, add: 0, del: 0 }; byPath.set(path, f); files.push(f);
    };
    const range = scope.kind === "commit" ? ["show", "--format=", scope.sha] : scope.kind === "pr" ? ["diff", scope.from, scope.to] : scope.kind === "all" && this.base ? ["diff", this.base] : null;
    if (range) {
      const [ns, num] = await Promise.all([git([...range, "--name-status", "-z", "--no-renames"]), git([...range, "--numstat", "-z", "--no-renames"])]);
      if (ns.code !== 0) throw new Error(ns.stderr);
      if (num.code === 0) parseNumstat(num.stdout, stats);
      for (const e of parseNameStatus(ns.stdout)) push(e.path, e.status);
      if (scope.kind === "all") for (const entry of statusOut.split("\0").filter(Boolean)) if (entry.slice(0, 2) === "??") push(entry.slice(3), "A", true);
    } else {
      const results = hasHead ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
      for (const result of results) { if (result.code !== 0) throw new Error(result.stderr); parseNumstat(result.stdout, stats); }
      for (const entry of statusOut.split("\0").filter(Boolean)) {
        const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
        const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
        push(path, conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M", fresh);
      }
    }
    for (const f of files) { const s = stats[f.path]; if (s) { f.add = s.add; f.del = s.del; f.binary = s.binary; } }
    this.limited = files.length > 1000;
    return files.slice(0, 1000);
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) { this.context = context; this.reset(); }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.commits = []; this.prs = []; this.setLines([]); this.open = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]), hasHead = head.code === 0;

        // Base: the merge-base with the first candidate branch that exists.
        let base = null, baseName = null, commits = [], more = false, prs = [];
        if (hasHead) {
          for (const cand of BASE_CANDIDATES) {
            const r = await git(["rev-parse", "--verify", "-q", cand]);
            if (r.code === 0) {
              const mb = await git(["merge-base", "HEAD", cand]);
              if (mb.code === 0) { base = mb.stdout.trim(); baseName = cand; }
              break;
            }
          }
          if (base) {
            // git log order, newest first. Fetch a longer tail so PR heads deeper in a stack still match.
            const log = await git(["log", "--format=%H%x1f%h%x1f%s%x1f%ar", "-n", "200", `${base}..HEAD`]);
            if (log.code === 0) {
              const all = log.stdout.split("\n").filter(Boolean).map((l) => { const [sha, short, subject, when] = l.split("\x1f"); return { sha, short, subject, when }; });
              commits = all.slice(0, MAX_COMMITS); more = all.length > MAX_COMMITS;
              prs = await this.loadPrs(root, on, git, base, all.map((c) => c.sha));
            }
          }
        }
        if (key() !== context) return;
        this.base = base; this.baseName = baseName; this.commits = commits; this.moreCommits = more; this.prs = prs;
        if (this.scope.kind === "commit" && !commits.some((c) => c.sha === this.scope.sha)) this.scope = { kind: "all" };
        if (this.scope.kind === "pr") { const p = prs.find((p) => p.number === this.scope.number); if (!p) this.scope = { kind: "all" }; else this.scope = { ...this.scope, from: p.from, to: p.to }; }

        const files = await this.listFiles(git, this.scope, status.stdout, hasHead);
        if (key() !== context) return;
        this.root = root; this.on = on; this.hasHead = hasHead; this.files = files; this.error = null;
        this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && files.length) this.open = files[0].path;
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on, scope = this.scope;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const args = scope.kind === "commit" ? ["show", scope.sha, "--format=", ...SHOW, "--", path]
        : scope.kind === "pr" ? ["diff", scope.from, scope.to, ...SHOW, "--", path]
        : scope.kind === "all" && this.base ? ["diff", this.base, ...SHOW, "--", path]
        : ["diff", ...(this.hasHead ? ["HEAD"] : []), ...SHOW, "--", path];
      const r = await exec("git", [...READ, ...args], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && this.open === path && scopeKey(this.scope) === scopeKey(scope)) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    this.rows = diffRows(lines, langOf(this.open));
    this.diffWidth = Math.max(300, ...lines.map(line => line.length * 7 + 50));
  }

  pickScope(scope, cx) {
    if (scopeKey(scope) === scopeKey(this.scope)) return;
    this.scope = scope; this.files = []; this.open = null; this.closed = false; this.setLines([]); this.note = null;
    this.loading = false; this.refresh(cx);
    cx.notify();
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path; this.setLines([]); this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (key() === context && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  diffRow({ kind, number, text, spans }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    const pal = PALETTE[isDark(t.background) ? "dark" : "light"];
    const body = spans && spans.length
      ? h_flex().flex_1().min_w(0).overflow_hidden().children(spans.map((s) => div().flex_none().whitespace_nowrap().when(Boolean(s.kind), (e) => e.text_color(pal[s.kind] ?? t.foreground)).child(s.text)))
      : div().flex_1().min_w(0).truncate().child(text);
    // GitHub's diff line backgrounds: opaque tints on light, 25% tints on dark.
    const dark = isDark(t.background), addBg = dark ? "#2ea04340" : "#dafbe1", delBg = dark ? "#f8514940" : "#ffebe9";
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(addBg)).when(kind === "-", (e) => e.bg(delBg))
      .child(div().w(30).flex_none().text_right().text_color(kind === "+" ? (dark ? "#3fb950" : "#1a7f37") : kind === "-" ? (dark ? "#f85149" : "#cf222e") : t.dim).child(number === undefined ? "" : String(number)))
      .child(body);
  }

  scopeRow(id, selected, label, detail, t, onClick) {
    return h_flex().id(id).h(26).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(selected, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click(onClick)
      .child(div().flex_none().child(label))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).text_size(11).child(detail));
  }

  commitRow(c, sk, t) {
    return h_flex().id(`scope-${c.sha}`).h(24).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(sk === `commit:${c.sha}`, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.pickScope({ kind: "commit", sha: c.sha, short: c.short }, cx))
      .child(div().flex_none().font_family(mono()).text_size(11).text_color(t.accent).child(c.short))
      .child(div().flex_1().min_w(0).truncate().text_size(12).child(c.subject))
      .child(div().flex_none().text_size(10).text_color(t.dim).child(c.when));
  }

  // Commits in log order; a run of commits that belong to one PR is boxed under the PR header.
  commitBlocks(sk, t) {
    const blocks = [];
    for (const c of this.commits) {
      const pr = this.prs.find((p) => p.commits.has(c.sha)) ?? null;
      const last = blocks[blocks.length - 1];
      if (last && last.pr === pr) last.commits.push(c); else blocks.push({ pr, commits: [c] });
    }
    return blocks.map((b) => {
      if (!b.pr) return v_flex().flex_none().children(b.commits.map((c) => this.commitRow(c, sk, t)));
      const p = b.pr, selected = sk === `pr:${p.number}`;
      return v_flex().id(`pr-${p.number}`).flex_none().mx(2).my(3).rounded(8).border_1().border_color(selected ? t.accent : t.border).overflow_hidden()
        .child(h_flex().h(26).flex_none().px(8).gap(6).items_center().cursor_pointer().bg(selected ? t.selected : t.raised).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.pickScope({ kind: "pr", number: p.number, from: p.from, to: p.to, short: `#${p.number}` }, cx))
          .child(div().flex_none().text_size(11).font_semibold().child(`${p.repo} #${p.number}`))
          .when(p.draft, (e) => e.child(div().flex_none().px(4).rounded(4).border_1().border_color(t.border).text_size(9).text_color(t.dim).child("draft")))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(p.title))
          .child(div().flex_none().text_size(10).text_color(t.dim).child(`${p.commits.size} commit${p.commits.size === 1 ? "" : "s"}`)))
        .child(v_flex().flex_none().p(2).children(b.commits.map((c) => this.commitRow(c, sk, t))));
    });
  }

  emptyText() {
    if (this.error) return this.error;
    if (this.loading) return "Loading changes…";
    if (!this.root) return "No folder";
    if (this.scope.kind === "commit") return "Empty commit";
    if (this.scope.kind === "pr") return "No changes in this PR";
    if (this.scope.kind === "all") return this.base ? `No local changes against ${this.baseName}` : "No uncommitted changes";
    return "No uncommitted changes";
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    const sk = scopeKey(this.scope), showCommitBox = this.scope.kind === "all" || this.scope.kind === "uncommitted";
    const scopeLabel = this.scope.kind === "commit" ? `commit ${this.scope.short}` : this.scope.kind === "pr" ? `PR ${this.scope.short}` : this.scope.kind === "all" ? (this.base ? `vs ${this.baseName}` : "all local") : "uncommitted";
    const prRows = this.prs.filter((p) => this.commits.some((c) => p.commits.has(c.sha))).length;
    const scopeHeight = 12 + 2 * 26 + this.commits.length * 24 + prRows * 34 + ((this.moreCommits || (this.base && !this.commits.length)) ? 26 : 0);
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`))
        .child(div().text_size(10).text_color(t.dim).truncate().child(scopeLabel))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)))
      // Scope list: all local, uncommitted, then the commits ahead of the base (PR commits boxed).
      .child(v_flex().id("changes-scopes").flex_none().h(Math.min(260, scopeHeight)).overflow_y_scrollbar().p(6).border_b(1).border_color(t.border)
        .child(this.scopeRow("scope-all", sk === "all", "All local changes", this.base ? `everything on this branch vs ${this.baseName}` : "committed + uncommitted", t, (_e, cx) => this.pickScope({ kind: "all" }, cx)))
        .child(this.scopeRow("scope-uncommitted", sk === "uncommitted", "Uncommitted changes", "working tree vs HEAD", t, (_e, cx) => this.pickScope({ kind: "uncommitted" }, cx)))
        .children(this.commitBlocks(sk, t))
        .when(this.moreCommits, (e) => e.child(div().px(8).h(26).flex().items_center().text_size(11).text_color(t.dim).child(`Showing the newest ${MAX_COMMITS} commits ahead of ${this.baseName}`)))
        .when(Boolean(this.base) && !this.commits.length, (e) => e.child(div().px(8).h(26).flex().items_center().text_size(11).text_color(t.dim).child(`No commits ahead of ${this.baseName}`))))
      .child(v_flex().id("changes-list").flex_none().h(Math.min(180, Math.max(44, this.files.length * 28 + 12))).overflow_y_scrollbar().p(6).border_b(1).border_color(t.border).children(this.files.map((f) => {
        const parts = f.path.split("/"), name = parts.pop();
        return h_flex().id(`change-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.path, cx))
          .child(div().w(14).text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
          .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
          .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
      })).when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.emptyText()))))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(div().flex_1().min_h(0).relative().font_family(mono()).text_size(11)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .when(showCommitBox, (el) => el.child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit"))));
  }
}
