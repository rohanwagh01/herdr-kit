// NOTICE: modified from Herdr's "files" mod, version 0.1.13 (Apache License 2.0).
// Changed for herdr-kit; see NOTICE and LICENSE in the repository root.
// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window } from "herdr";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const BASE_CANDIDATES = ["origin/main", "origin/master", "main", "master"];

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

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

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {}; this.untracked = new Set();
    this.mode = "file"; this.diff = []; this.diffWidth = 0; this.base = null; this.baseName = null;
    this.filter = false; this.filterClosed = new Set();
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.folderMarks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {}, untracked = new Set();
        let base = null, baseName = null;
        if (top?.code === 0) {
          const repo = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd, on }).catch(() => null);
          // Committed-but-unpushed work: everything on this branch against its base.
          for (const cand of BASE_CANDIDATES) {
            const r = await git(["rev-parse", "--verify", "-q", cand]);
            if (r?.code === 0) { const mb = await git(["merge-base", "HEAD", cand]); if (mb?.code === 0) { base = mb.stdout.trim(); baseName = cand; } break; }
          }
          if (base) {
            const ns = await git(["diff", base, "--name-status", "-z", "--no-renames"]);
            if (ns?.code === 0) { const tok = ns.stdout.split("\0"); for (let i = 0; i + 1 < tok.length; i += 2) if (tok[i] && tok[i + 1]) marks[`${repo}/${tok[i + 1]}`] = tok[i][0] === "A" ? "A" : tok[i][0] === "D" ? "D" : "M"; }
          }
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2), full = `${repo}/${entry.slice(3)}`;
            if (xy === "??") untracked.add(full);
            marks[full] = xy === "??" || (xy.includes("A") && !marks[full]) ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : marks[full] ?? "M";
          }
        }
        if (!this.current(context)) return;
        // Folders carry the status of what is inside: U beats M; all-added is A, all-deleted is D.
        const folderMarks = {};
        for (const [full, mark] of Object.entries(marks)) {
          const parts = full.split("/");
          for (let i = parts.length - 1; i > 0; i--) {
            const dir = parts.slice(0, i).join("/"), cur = folderMarks[dir];
            folderMarks[dir] = !cur ? mark : cur === mark ? cur : (cur === "U" || mark === "U") ? "U" : "M";
          }
        }
        this.marks = marks; this.folderMarks = folderMarks; this.untracked = untracked; this.base = base; this.baseName = baseName; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  // Syntax colors for the editor: GitHub's palette, light or dark by theme background.
  syntaxColors(t) {
    const p = PALETTE[isDark(t.background) ? "dark" : "light"];
    return { keyword: p.keyword, string: p.string, comment: p.comment, function: p.function, type: p.type, number: p.number, constant: p.constant, boolean: p.constant, "string.escape": p.decorator, variable: t.foreground, operator: t.foreground, punctuation: t.dim };
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null; this.diff = []; this.diffWidth = 0; this.diffStat = null; this.diffError = null;
    if (!path || !cx) return;
    const mark = this.marks[`${this.root}/${path}`];
    if (mark && this.mode !== "plain") this.loadDiff(path, cx, this.mode === "file");
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: this.syntaxColors(t) });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  // The file's diff against the branch base (origin/main merge-base), so committed
  // but unpushed work shows too. Untracked files show whole as added.
  // `full` shows the whole file with the changed lines tinted (git diff -U999999);
  // otherwise only the hunks.
  loadDiff(path, cx, full = false) {
    const context = this.context, root = this.root, on = this.on, mark = this.marks[`${root}/${path}`], limit = full ? 6000 : 1500;
    this.diff = []; this.diffError = null; this.diffStat = null;
    cx.spawn(async cx => {
      try {
        let lines;
        if (mark === "A" && this.untracked.has(`${root}/${path}`)) {
          const text = await readTextFile(`${root}/${path}`, { on });
          if (text === null || text.includes("\0")) throw new Error("no text diff");
          const body = text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, limit);
          lines = [`@@ -0,0 +1,${body.length} @@`, ...body.map(l => `+${l}`)];
        } else {
          const against = this.base ? [this.base] : ["HEAD"];
          const r = await exec("git", [...READ, "diff", ...against, ...(full ? ["-U999999"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
          if (r.code !== 0) throw new Error(r.stderr);
          const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex(l => l.startsWith("@@"));
          lines = first < 0 ? ["No text diff available"] : all.slice(first);
        }
        if (this.file !== path || !this.current(context)) return;
        if (lines.length > limit) lines = [...lines.slice(0, limit), `… ${lines.length - limit} more lines not shown`];
        lines = lines.map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line);
        this.diff = diffRows(lines, langOf(path));
        this.diffWidth = Math.max(300, ...lines.map(line => line.length * 7 + 50));
        this.diffStat = { add: this.diff.filter(r => r.kind === "+").length, del: this.diff.filter(r => r.kind === "-").length };
      } catch (e) { if (this.file === path && this.current(context)) this.diffError = `Cannot show this diff: ${e}`; }
      finally { cx.notify(); }
    });
  }

  setMode(mode, cx) {
    if (this.mode === mode) return;
    this.mode = mode;
    if (mode !== "plain" && this.file && this.marks[`${this.root}/${this.file}`]) this.loadDiff(this.file, cx, mode === "file");
    cx.notify();
  }

  diffRow({ kind, number, text, spans }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    const pal = PALETTE[isDark(t.background) ? "dark" : "light"];
    const body = spans && spans.length
      ? h_flex().flex_1().min_w(0).overflow_hidden().children(spans.map((s) => div().flex_none().whitespace_nowrap().when(Boolean(s.kind), (e) => e.text_color(pal[s.kind] ?? t.foreground)).child(s.text)))
      : div().flex_1().min_w(0).truncate().child(text);
    const dark = isDark(t.background), addBg = dark ? "#2ea04340" : "#dafbe1", delBg = dark ? "#f8514940" : "#ffebe9";
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(addBg)).when(kind === "-", (e) => e.bg(delBg))
      .child(div().w(30).flex_none().text_right().text_color(kind === "+" ? (dark ? "#3fb950" : "#1a7f37") : kind === "-" ? (dark ? "#f85149" : "#cf222e") : t.dim).child(number === undefined ? "" : String(number)))
      .child(body);
  }

  diffView(t) {
    return div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
      .child(div().id("files-diff-x").size_full().overflow_x_scrollbar()
        .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("files-diff", this.diff.length, 20, (i) => String(i),
          (range) => this.diff.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
      .child(Scrollbar.vertical("files-diff").viewport_from_layout().absolute().inset_0())
      .when(!this.diff.length, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child(this.diffError || "Loading diff…")));
  }

  // "Changes only": a tree built from the marks under the shown folder, every
  // changed folder expanded (click a folder to fold it), nothing else shown.
  filteredRows(t) {
    const root = `${this.root}/`, tree = { dirs: new Map(), files: [] };
    for (const [full, mark] of Object.entries(this.marks)) {
      if (!full.startsWith(root)) continue;
      const parts = full.slice(root.length).split("/"); let node = tree;
      for (const part of parts.slice(0, -1)) { if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] }); node = node.dirs.get(part); }
      node.files.push({ name: parts[parts.length - 1], mark });
    }
    const out = [], color = (m) => m === "A" ? t.ansi2 : m === "D" || m === "U" ? t.ansi1 : t.blocked;
    const walk = (node, prefix, depth) => {
      if (out.length >= TOTAL || depth > 40) return;
      for (const name of [...node.dirs.keys()].sort((a, b) => a.localeCompare(b))) {
        const path = prefix ? `${prefix}/${name}` : name, open = !this.filterClosed.has(path), mark = this.folderMarks?.[`${this.root}/${path}`];
        out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
          .on_click((_e, cx) => { if (open) this.filterClosed.add(path); else this.filterClosed.delete(path); cx.notify(); })
          .child(svg(`mods/files-cos/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim))
          .child(svg("mods/files-cos/folder.svg").size(14).flex_none().text_color(t.muted))
          .child(div().flex_1().min_w(0).truncate().child(name))
          .when(Boolean(mark), el => el.child(div().text_size(11).opacity(0.7).text_color(color(mark)).child(mark))));
        if (open) walk(node.dirs.get(name), path, depth + 1);
      }
      for (const f of node.files.sort((a, b) => a.name.localeCompare(b.name))) {
        const path = prefix ? `${prefix}/${f.name}` : f.name;
        out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
          .on_click((_e, cx) => this.show(path, cx))
          .child(div().w(12).flex_none())
          .child(svg("mods/files-cos/file.svg").size(14).flex_none().text_color(t.muted))
          .child(div().flex_1().min_w(0).truncate().child(f.name))
          .child(div().text_size(11).text_color(color(f.mark)).child(f.mark)));
      }
    };
    walk(tree, "", 0);
    return out;
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = entry.dir ? this.folderMarks?.[`${this.root}/${path}`] : this.marks[`${this.root}/${path}`];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .child(entry.dir ? svg(`mods/files-cos/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/files-cos/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).when(entry.dir, e => e.opacity(0.7)).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme(), mark = this.file ? this.marks[`${this.root}/${this.file}`] : null;
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? ""))
        .when(!this.file && Boolean(this.root), el => el.child(div().id("files-filter").px(8).py(2).rounded(6).border_1().border_color(this.filter ? t.accent : t.border).text_size(11).cursor_pointer()
          .bg(this.filter ? t.selected : t.background).text_color(this.filter ? t.foreground : t.muted).hover(s => s.bg(t.hover))
          .on_click((_e, cx) => { this.filter = !this.filter; cx.notify(); })
          .tooltip("Show only changed files and the folders that hold them, all expanded")
          .child(this.filter ? `Changes only · ${Object.keys(this.marks).filter(k => k.startsWith(this.root + "/")).length}` : "Changes only")))
        .when(Boolean(this.file && mark), el => el
          .when(Boolean(this.diffStat) && this.mode !== "plain", e => e.child(div().text_size(11).text_color(t.ansi2).child(`+${this.diffStat.add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${this.diffStat.del}`)))
          .child(h_flex().flex_none().rounded(6).border_1().border_color(t.border).overflow_hidden().text_size(11)
            .children([["plain", "File"], ["file", "File + diff"], ["diff", this.base ? `Diff vs ${this.baseName.replace("origin/", "")}` : "Diff only"]].map(([mode, label]) =>
              div().id(`files-mode-${mode}`).px(8).py(2).cursor_pointer().when(this.mode === mode, e => e.bg(t.selected)).when(this.mode !== mode, e => e.text_color(t.muted)).hover(s => s.bg(t.hover)).on_click((_e, cx) => this.setMode(mode, cx)).child(label))))))
      .when(!this.file && this.filter, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.filteredRows(t))
        .when(!Object.keys(this.marks).some(k => k.startsWith(this.root + "/")), el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.base ? `No changes under this folder vs ${this.baseName}` : "No changes under this folder")))))
      .when(!this.file && !this.filter, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file) && Boolean(mark) && this.mode !== "plain", el => el.child(this.diffView(t)))
      .when(Boolean(this.file) && !(Boolean(mark) && this.mode !== "plain"), el => el.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
