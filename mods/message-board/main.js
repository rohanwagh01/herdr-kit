// Message board: every `hc send` between agents, newest first, for the open tab
// (its panes, terminals labeled for it, and the sub-agents they started), for all, or the
// blasts (`hc blast`: one message to every agent), which the Blasts tab can also compose.
// The log is written by the hc wrapper in ~/.herdr/bin/hc as ~/.herdr/messages/log.jsonl.
// Each row shows the message's subject (a "Subject: ..." first line, else the first
// couple of lines of the text); clicking a row expands it to the full message.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, terminals, theme, home, readTextFile, watchFolder, exec, shared, setShared } from "herdr";

const setSharedDismiss = () => setShared("restart.status", { ...(shared("restart.status") ?? {}), dismissed: true });

const DIR = () => `${home()}/.herdr/messages`;
const FILE = () => `${DIR()}/log.jsonl`;
const MAX = 500; // the newest lines kept in memory

const pad = (n) => String(n).padStart(2, "0");
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
function when(ms) {
  const d = new Date(ms), now = new Date();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return sameDay(d, now) ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

const SUBJECT_MAX = 180; // characters of subject shown when collapsed

// Split a message into { subject, body }. Agents put "Subject: <summary>" as the first
// line(s), ended by a blank line (see the herdr skill). Older messages without one get
// their first couple of lines as the subject and the whole text as the body.
function split(text) {
  const raw = String(text ?? "");
  const m = /^\s*subject\s*:\s*([\s\S]*?)(?:\n[ \t]*\n|$)/i.exec(raw);
  if (m) {
    const subject = m[1].replace(/\s+/g, " ").trim();
    const body = raw.slice(m[0].length).trim();
    return { subject, body, explicit: true };
  }
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const subject = lines.slice(0, 2).join(" ");
  return { subject, body: raw.trim(), explicit: false };
}
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "\u2026" : s);

export default class MessageBoard extends View {
  init(_props, cx) {
    this.messages = [];
    const saved = localStorage.getItem("board.scope");
    this.scope = saved === "all" || saved === "blasts" ? saved : "tab";
    this.subject = InputState.new({ value: "", placeholder: "Subject: one or two lines every agent should see" });
    this.body = InputState.new({ value: "", placeholder: "Message (optional). Enter sends." });
    this.subject.on("change", (_e, cx) => cx.notify());
    this.body.on("change", (_e, cx) => cx.notify());
    this.body.on("submit", (_e, cx) => this.blast(cx));
    this.sending = false;
    this.result = null; // last blast's outcome, shown under the composer
    this.open = new Set(); // keys of expanded messages
    this.load(cx);
    cx.timer.every(5000, (cx) => this.load(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        try { await watchFolder(DIR()); } catch { return; } // no folder yet: the timer covers it
        this.load(cx);
      }
    });
  }

  load(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const text = (await readTextFile(FILE())) ?? "";
        const out = [];
        for (const line of text.split("\n").filter(Boolean).slice(-MAX)) {
          try { out.push(JSON.parse(line)); } catch {}
        }
        this.messages = out;
      } catch {
        this.messages = [];
      }
      this.loading = false;
      cx.notify();
    });
  }

  // The terminals that belong to a tab: its panes, terminals labeled for it, and
  // whatever those started (sub-agents), recursively.
  members(tab, ts) {
    const set = new Set();
    for (const p of panes()) if (p.tab === tab.id && p.terminal) set.add(p.terminal);
    for (const t of ts) if (t.labels?.["herdr.tab"] === tab.id) set.add(t.address);
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of ts) if (t.parent && set.has(t.parent) && !set.has(t.address)) { set.add(t.address); grew = true; }
    }
    return set;
  }

  // `hc send` takes an address or a name; the board works in addresses.
  resolve(to, ts) {
    if (!to) return null;
    return ts.find((t) => t.name === to)?.address ?? to;
  }

  label(addr, ts) {
    if (!addr) return "you";
    const t = ts.find((x) => x.address === addr);
    const who = t?.name ?? t?.labels?.role ?? t?.program?.name ?? null;
    return who ? `${addr} ${who}` : addr;
  }

  setScope(scope, cx) {
    this.scope = scope;
    localStorage.setItem("board.scope", scope);
    cx.notify();
  }

  blast(cx) {
    const subject = this.subject.value().trim(), body = this.body.value().trim();
    if (this.sending || !subject) return;
    const text = body ? `Subject: ${subject}\n\n${body}` : `Subject: ${subject}`;
    this.sending = true; this.result = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const out = await exec(`${home()}/.herdr/bin/hc`, ["blast", text]);
        let r = null;
        try { r = JSON.parse(String(out?.stdout ?? out ?? "").trim().split("\n").pop()); } catch {}
        this.result = r?.blast ? r : { error: String(out?.stderr ?? out?.stdout ?? "no reply from hc blast").slice(0, 200) };
        if (r?.blast) { this.subject.set_value(""); this.body.set_value(""); }
      } catch (e) {
        this.result = { error: String(e?.message ?? e).slice(0, 200) };
      }
      this.sending = false;
      this.load(cx);
    });
  }

  // The tab bar's Restart all button shares its progress as "restart.status".
  restartSummary() {
    const st = shared("restart.status") ?? {};
    if (st.running) return `Restarting every agent\u2026 started ${when(st.started)}`;
    if (!st.summary || st.dismissed) return null;
    const list = st.result?.restart ?? [];
    const ok = list.filter((x) => x.restarted && x.resumed !== false && !x.error);
    const moved = ok.filter((x) => x.new_terminal).map((x) => `${x.terminal}\u2192${x.new_terminal}`);
    const bad = list.filter((x) => !ok.includes(x));
    return `${st.summary}${moved.length ? ` (moved: ${moved.join(", ")})` : ""}`
      + (bad.length ? `: ${bad.map((x) => `${x.terminal} ${x.skip ?? x.error ?? "not restarted"}`).join("; ")}` : "");
  }

  key(m) { return `${m.ts}|${m.from ?? ""}|${m.to ?? ""}`; }

  toggle(m, cx) {
    const k = this.key(m);
    if (this.open.has(k)) this.open.delete(k); else this.open.add(k);
    cx.notify();
  }

  render() {
    const t = theme();
    const ts = terminals();
    const space = spaces().find((s) => s.active);
    const tab = space?.tabs?.find((c) => c.active) ?? null;
    const mine = tab ? this.members(tab, ts) : new Set();
    const all = this.scope === "all", blasts = this.scope === "blasts";
    const rows = this.messages
      .map((m) => ({ ...m, toAddr: m.blast ? "*" : this.resolve(m.to, ts) }))
      // Blasts tab: real blasts only; freeze, unfreeze, restart and title records stay off the board.
      .filter((m) => blasts ? m.blast && !m.kind : !m.blast && !m.kind && (all || mine.has(m.from) || mine.has(m.toAddr)))
      .reverse();
    const tabName = tab ? (tab.named ? tab.name : `tab ${tab.index}`) : "this tab";

    const pill = (id, text, on, action) => div().id(id).px(8).py(2).rounded(10).text_size(11).cursor_pointer()
      .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(on ? t.selected : t.hover).text_color(t.foreground))
      .on_click((_e, cx) => action(cx)).child(text);

    const header = h_flex().h(36).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(svg("mods/message-board/board.svg").size(14).flex_none().text_color(t.muted))
      .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child("Message board"))
      .child(div().flex_1())
      .child(div().text_size(11).text_color(t.dim).child(`${rows.length}`))
      .child(h_flex().gap(2).p(2).rounded(12).bg(t.chrome)
        .child(pill("board-scope-tab", "This tab", !all, (cx) => this.setScope("tab", cx)))
        .child(pill("board-scope-all", "All", all, (cx) => this.setScope("all", cx)))
        .child(pill("board-scope-blasts", "Blasts", blasts, (cx) => this.setScope("blasts", cx))));

    const row = (m, i) => {
      const out = mine.has(m.from), inn = mine.has(m.toAddr);
      const { subject, body, explicit } = split(m.text);
      const isOpen = this.open.has(this.key(m));
      const more = explicit ? body.length > 0 : body.length > subject.length;
      return v_flex().id(`msg-${i}`).flex_none().gap(4).p(9).rounded(8).bg(t.surface).border(1).border_color(t.border)
        .when(more, (el) => el.cursor_pointer().hover((s) => s.border_color(t.input)))
        .on_click((_e, cx) => { if (more) this.toggle(m, cx); })
        .child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
          .child(div().flex_none().font_semibold().text_color(out ? t.accent : t.muted).child(this.label(m.from, ts)))
          .child(div().flex_none().child("\u2192"))
          .child(div().min_w(0).truncate().font_semibold().text_color(inn ? t.accent : t.muted)
            .child(m.blast
              ? `${m.kind === "freeze" ? "\u2744 froze" : m.kind === "unfreeze" ? "unfroze" : "all agents"}${m.scope ? ` ${m.scope}` : ""} (${(m.sent ?? []).length}${(m.failed ?? []).length ? `, ${m.failed.length} not delivered` : ""}${(m.frozen ?? []).length ? `, ${m.frozen.length} frozen` : ""})`
              : this.label(m.toAddr, ts)))
          .when(Boolean(m.blocked), (el) => el.child(div().flex_none().px(5).rounded(4).bg(t.blocked + "26").text_color(t.blocked).child(`not delivered: ${m.reason ?? m.blocked}`)))
          .child(div().flex_1())
          .child(div().flex_none().child(when(m.ts)))
          .when(more, (el) => el.child(div().flex_none().w(10).text_center().text_color(t.muted).child(isOpen ? "\u25BE" : "\u25B8"))))
        .child(div().text_size(12.5).font_semibold().text_color(t.foreground).whitespace_normal()
          .child(isOpen ? subject : clip(subject, SUBJECT_MAX)))
        .when(isOpen && explicit && body.length > 0, (el) => el.child(
          div().mt(2).pt(6).border_t(1).border_color(t.border).text_size(12.5).text_color(t.foreground).whitespace_normal().child(body)))
        .when(isOpen && !explicit, (el) => el.child(
          div().mt(2).pt(6).border_t(1).border_color(t.border).text_size(12.5).text_color(t.foreground).whitespace_normal().child(body)))
        .when(isOpen && m.blast, (el) => el.child(
          div().text_size(11).text_color(t.dim).whitespace_normal().child(
            `Delivered: ${(m.sent ?? []).map((a) => this.label(a, ts)).join(", ") || "none"}`
            + ((m.failed ?? []).length ? ` \u00b7 Not delivered: ${m.failed.map((f) => `${this.label(f.to, ts)} (${f.reason})`).join(", ")}` : "")
            + ((m.frozen ?? []).length ? ` \u00b7 Skipped, frozen: ${m.frozen.map((f) => `${this.label(f.to, ts)} (${f.reason})`).join(", ")}` : ""))));
    };

    // The Blasts tab's composer: Subject + message, sent to every agent with `hc blast`.
    const field = (state, id) => Input.new(state).id(id).h(30).px(8).rounded(7).border(1).border_color(t.input)
      .bg(t.background).text_size(12.5).text_color(t.foreground);
    const canSend = !this.sending && this.subject.value().trim().length > 0;
    const r = this.result;
    const composer = v_flex().flex_none().gap(6).p(10).border_b(1).border_color(t.border).bg(t.chrome)
      .child(field(this.subject, "blast-subject"))
      .child(field(this.body, "blast-body"))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(11).text_color(r?.error ? t.blocked : t.dim).whitespace_normal().child(
          this.sending ? "Sending to every agent\u2026"
          : r?.error ? `Blast failed: ${r.error}`
          : r ? `Sent to ${r.sent.length} agent${r.sent.length === 1 ? "" : "s"}${r.failed.length ? `; not delivered: ${r.failed.map((f) => `${f.to} (${f.reason})`).join(", ")}` : ""}`
          : "Goes to every live agent on this core and is logged here."))
        .child(div().id("blast-send").flex_none().px(12).py(5).rounded(8).text_size(12).font_semibold().cursor_pointer()
          .bg(canSend ? t.solid : t.raised).text_color(canSend ? t.solid_foreground : t.dim)
          .when(canSend, (el) => el.hover((s) => s.opacity(0.88)))
          .on_click((_e, cx) => this.blast(cx)).child("Send blast")));

    const empty = v_flex().flex_1().items_center().justify_center().gap(6).px(24).text_size(12).text_color(t.dim)
      .child(svg("mods/message-board/board.svg").size(22).text_color(t.dim))
      .child(div().text_color(t.muted).child(blasts ? "No blasts yet" : all ? "No messages yet" : `No messages for ${tabName} yet`))
      .child(div().whitespace_normal().text_center().child(blasts
        ? "A blast goes to every agent at once: compose one above, or run `hc blast \"Subject: ...\"` from any terminal."
        : "Messages sent with `hc send` by or to the terminals in a tab appear here. Click a message to expand it."));

    const restartLine = this.restartSummary();
    return v_flex().size_full().min_h(0).bg(t.background)
      .child(header)
      .when(Boolean(restartLine), (el) => el.child(h_flex().flex_none().px(12).py(5).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome)
        .when(Boolean(shared("restart.status")?.running), (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900)))
        .child(div().flex_1().text_size(11).whitespace_normal().text_color(shared("restart.status")?.result?.error ? t.blocked : t.muted).child(restartLine))
        .when(!shared("restart.status")?.running, (el) => el.child(div().id("board-restart-dismiss").flex_none().text_size(11).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click(() => setSharedDismiss()).child("\u00d7")))))
      .when(blasts, (el) => el.child(composer))
      .child(rows.length
        ? v_flex().flex_1().min_h(0).p(10).gap(8).overflow_y_scrollbar().children(rows.map(row))
        : empty);
  }
}
