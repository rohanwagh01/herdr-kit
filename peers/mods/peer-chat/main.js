// Peers: a messaging view for one space.
// One page. It opens on the peers list (your contact card, Add peer, the social toggle for
// this space, and every peer with an unread count). Tap a peer to open the conversation:
// messages oldest at the top, newest at the bottom, yours on the right. The composer sends
// plain chat by default (text the other person reads; never given to an agent). The
// "agent read" toggle sends the message for their agent instead; their side holds it for
// Allow unless they marked you auto. Incoming agent messages show inline with an agent
// picker, Allow and Dismiss. The pane is opened with props {space: '<space id>'}.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, home, readTextFile, watchFolder, exec, props, spaces, terminals, focused, notify } from "herdr";

const PEER_DIR = () => `${home()}/.herdr/peer`;
const PEERS_FILE = () => `${PEER_DIR()}/peers.json`;
const MSG_DIR = () => `${home()}/.herdr/messages`;
const MSG_FILE = () => `${MSG_DIR()}/log.jsonl`;
const INTAKE_DIR = () => `${home()}/.herdr/intake`;
const INBOX_FILE = () => `${INTAKE_DIR()}/inbox.jsonl`;
const REQ_FILE = () => `${INTAKE_DIR()}/requests.jsonl`;
const HC = () => `${home()}/.herdr/bin/hc`;
const TAILSCALE = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const MAX = 800;

const pad = (n) => String(n).padStart(2, "0");
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
function when(ms) {
  const d = new Date(ms), now = new Date();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return sameDay(d, now) ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}
function dayLabel(ms) {
  const d = new Date(ms), now = new Date();
  if (sameDay(d, now)) return "Today";
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return "Yesterday";
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}
// Strip our own headers from a message text: Subject line, Herdr-Kind line, the "[peer] " tag.
function clean(text) {
  let raw = String(text ?? "");
  raw = raw.replace(/^[ \t]*herdr-kind[ \t]*:[^\n]*\n?/gim, "");
  const m = /^\s*subject\s*:\s*([^\n]*)\n?/i.exec(raw);
  let subject = null, body = raw;
  if (m) { subject = m[1].replace(/^\[[^\]]+\]\s*/, "").trim(); body = raw.slice(m[0].length); }
  body = body.replace(/^\s*\n/, "").trim();
  if (subject && body && body.startsWith(subject)) subject = null; // subject repeated in body
  return { subject, body };
}
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const localId = (id) => String(id ?? "").split("/").pop();
const sameSpace = (a, b) => a != null && b != null && (String(a) === String(b) || localId(a) === localId(b));
const isPending = (r) => !r.status || r.status === "queued";

export default class PeerChat extends View {
  init(_props, cx) {
    this.peer = null;              // open conversation, or null for the peers list
    this.peers = {};               // name -> {login, ip, port, auto_agent}
    this.log = [];                 // our outbound rows from log.jsonl
    this.inbox = [];               // inbound rows (merged by id)
    this.requests = [];            // held RPCs (merged by id)
    this.spaceId = null;
    this.me = null;
    this.agentRead = false;        // composer: send for their agent instead of plain chat
    this.text = InputState.new({ value: "", placeholder: "Message. Enter sends." });
    this.text.on("change", (_e, cx) => cx.notify());
    this.text.on("submit", (_e, cx) => this.send(cx));
    this.newPeer = InputState.new({ value: "", placeholder: "Coworker login or tailnet hostname" });
    this.newPeer.on("change", (_e, cx) => cx.notify());
    this.newPeer.on("submit", (_e, cx) => this.addPeer(cx));
    this.addResult = null;
    this.sendResult = null;
    this.socialResult = null;
    this.picks = new Map();        // inbox id -> picked agent
    this.pickerOpen = new Set();
    this.rowResults = new Map();
    this.lastSeen = new Map();     // peer -> ts of the newest row seen while the conversation was open
    this.seenInbox = new Set();
    this.primed = false;
    this.load(cx);
    cx.timer.every(4000, (cx) => this.load(cx));
    for (const [dir, fn] of [[MSG_DIR, "loadLog"], [PEER_DIR, "loadPeers"], [INTAKE_DIR, "loadInbox"]]) {
      cx.spawn(async (cx) => {
        for (;;) {
          try { await watchFolder(dir()); } catch { return; }
          this[fn](cx);
        }
      });
    }
  }

  space() {
    if (this.spaceId) return this.spaceId;
    const p = props() ?? {};
    this.spaceId = p.space ?? focused()?.space ?? spaces().find((s) => s.active)?.id ?? null;
    return this.spaceId;
  }
  spaceName() { const id = this.space(); return spaces().find((s) => s.id === id)?.name ?? id ?? "this space"; }

  load(cx) { this.loadPeers(cx); this.loadLog(cx); this.loadInbox(cx); }

  loadPeers(cx) {
    cx.spawn(async (cx) => {
      try { this.peers = JSON.parse((await readTextFile(PEERS_FILE())) ?? "{}"); } catch { this.peers = {}; }
      if (!this.me) {
        try {
          const out = await exec(TAILSCALE, ["status", "--json"]);
          const st = JSON.parse(String(out?.stdout ?? out ?? "{}"));
          const self = st.Self ?? {};
          this.me = { login: st.User?.[String(self.UserID)]?.LoginName ?? null,
                      host: (self.DNSName ?? self.HostName ?? "").replace(/\.$/, ""),
                      ip: (self.TailscaleIPs ?? [])[0] ?? null };
        } catch { this.me = { login: null, host: null, ip: null }; }
      }
      cx.notify();
    });
  }

  loadLog(cx) {
    cx.spawn(async (cx) => {
      try {
        const text = (await readTextFile(MSG_FILE())) ?? "";
        const out = [];
        for (const line of text.split("\n").filter(Boolean).slice(-MAX)) {
          try { const r = JSON.parse(line); if (r && r.peer && r.dir === "out") out.push(r); } catch {}
        }
        this.log = out;
      } catch { this.log = []; }
      cx.notify();
    });
  }

  mergeJsonl(text) {
    const byId = new Map();
    for (const line of String(text ?? "").split("\n").filter(Boolean)) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (!row || !row.id) continue;
      const prev = byId.get(row.id) ?? {};
      byId.set(row.id, { ...prev, ...row, ts: prev.ts ?? row.ts, updated: row.ts });
    }
    return [...byId.values()];
  }

  loadInbox(cx) {
    cx.spawn(async (cx) => {
      try { this.inbox = this.mergeJsonl(await readTextFile(INBOX_FILE())); } catch { this.inbox = []; }
      try { this.requests = this.mergeJsonl(await readTextFile(REQ_FILE())); } catch { this.requests = []; }
      this.noteNew();
      cx.notify();
    });
  }

  // Toast once per new inbound row for this space (not on the first load).
  noteNew() {
    const sid = this.space();
    const fresh = this.inbox.filter((r) => (r.space == null || sameSpace(r.space, sid)) && !this.seenInbox.has(r.id));
    if (this.primed) {
      for (const r of fresh) {
        if (r.from === this.peer) continue; // already looking at it
        const { subject, body } = clean(r.text ?? r.body ?? "");
        notify({ title: `${r.from ?? "peer"}${r.kind === "agent" ? " (for an agent)" : ""}`,
                 body: clip(subject ?? body ?? "", 140) || undefined,
                 action: { name: "space.select", args: { id: sid } } });
      }
    }
    for (const r of fresh) this.seenInbox.add(r.id);
    this.primed = true;
  }

  // ---- data for one conversation --------------------------------------------------------
  spaceTerminalAddrs() {
    const sid = this.space();
    return new Set(terminals().filter((t) => sameSpace(t.labels?.["herdr.space"], sid)).map((t) => t.address));
  }
  spaceAgents() {
    const sid = this.space();
    return terminals()
      .filter((t) => sameSpace(t.labels?.["herdr.space"], sid) && t.state !== "finished" && (t.status || t.agent) && !t.program?.shell)
      .sort((a, b) => (a.created_ms ?? 0) - (b.created_ms ?? 0));
  }
  agentName(t) { return t.name || t.program?.name || t.agent || t.address; }

  conversation(name) {
    const sid = this.space();
    const addrs = this.spaceTerminalAddrs();
    const inbound = this.inbox
      .filter((r) => r.from === name && (r.space == null || sameSpace(r.space, sid)))
      .map((r) => ({ ...r, dir: "in" }));
    const outbound = this.log
      .filter((r) => r.peer === name && (addrs.has(r.from) || r.from == null || r.from === ""))
      .map((r) => ({ ...r, id: r.id ?? `out-${r.ts}`, dir: "out" }));
    const held = this.requests
      .filter((r) => r.from === name && r.status === "pending")
      .map((r) => ({ ...r, dir: "in", request: true }));
    return [...inbound, ...outbound, ...held].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  }

  unread(name) {
    const seen = this.lastSeen.get(name) ?? 0;
    return this.conversation(name).filter((m) => m.dir === "in" && (m.ts ?? 0) > seen).length;
  }

  pickFor(r, agents) {
    const picked = this.picks.get(r.id);
    if (picked && (agents.some((a) => a.address === picked) || picked === r.to)) return picked;
    if (r.to && agents.some((a) => a.address === r.to)) return r.to;
    if (r.to && r.space == null) return r.to;
    return agents[0]?.address ?? null;
  }

  // ---- actions -------------------------------------------------------------------------
  openPeer(name, cx) {
    this.peer = name;
    const conv = this.conversation(name);
    this.lastSeen.set(name, conv.length ? conv[conv.length - 1].ts ?? Date.now() : Date.now());
    cx.notify();
  }
  back(cx) {
    if (this.peer) { const conv = this.conversation(this.peer); this.lastSeen.set(this.peer, conv.length ? conv[conv.length - 1].ts ?? Date.now() : Date.now()); }
    this.peer = null; cx.notify();
  }

  send(cx) {
    const body = this.text.value().trim();
    if (!body || !this.peer || this.sending) return;
    const first = body.split("\n")[0];
    const subject = clip(first, 80);
    const text = body === first ? `Subject: ${subject}` : `Subject: ${subject}\n\n${body}`;
    const args = ["send", this.agentRead ? "--agent" : "--chat", this.peer, text];
    this.sending = true; this.sendResult = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const out = await exec(HC(), args);
        const s = String(out?.stdout ?? out ?? "").trim();
        let r = null; try { r = JSON.parse(s.split("\n").pop()); } catch {}
        if (r?.error) this.sendResult = { error: r.error.message ?? JSON.stringify(r.error) };
        else { this.text.set_value(""); }
      } catch (e) {
        this.sendResult = { error: String(e?.message ?? e).slice(0, 200) };
      }
      this.sending = false;
      this.loadLog(cx);
    });
  }

  run(cx, key, args) {
    cx.spawn(async (cx) => {
      try {
        const out = await exec(HC(), args);
        const raw = String(out?.stdout ?? out ?? "").trim();
        let r = null; try { r = JSON.parse(raw.split("\n").pop()); } catch {}
        const word = r?.error ? null
          : r?.delivered === true ? `delivered to ${r.to}`
          : r?.delivered === false ? `delivery to ${r.to} failed`
          : r?.dismissed ? "dismissed"
          : r?.approved ? (r.ok ? "approved and run" : "approved but failed")
          : r?.denied ? "denied"
          : r?.auto_agent != null ? `auto agent ${r.auto_agent ? "on" : "off"}`
          : null;
        this.rowResults.set(key, r?.error ? { error: String(r.error).slice(0, 240) } : { output: word ?? raw.slice(0, 160) });
      } catch (e) {
        this.rowResults.set(key, { error: String(e?.message ?? e).slice(0, 240) });
      }
      this.loadInbox(cx); this.loadPeers(cx);
    });
  }
  addPeer(cx) {
    const who = this.newPeer.value().trim();
    if (!who || this.adding) return;
    this.adding = true; this.addResult = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const out = await exec(HC(), ["peer", "add", who]);
        const s = String(out?.stdout ?? out ?? "").trim();
        let r = null; try { r = JSON.parse(s.split("\n").pop()); } catch {}
        this.addResult = r?.error ? { error: r.error } : { output: r?.peer ? `added ${r.peer} (${r.login ?? who})` : s.slice(0, 160) };
        if (!r?.error) this.newPeer.set_value("");
      } catch (e) { this.addResult = { error: String(e?.message ?? e).slice(0, 160) }; }
      this.adding = false; this.loadPeers(cx);
    });
  }
  social(cx) {
    cx.spawn(async (cx) => {
      try { const out = await exec(HC(), ["social", this.space()]); this.socialResult = { output: String(out?.stdout ?? out ?? "").trim().slice(0, 160) }; }
      catch (e) { this.socialResult = { error: String(e?.message ?? e).slice(0, 160) }; }
      cx.notify();
    });
  }

  // ---- render --------------------------------------------------------------------------
  render() {
    const t = theme();
    return v_flex().size_full().min_h(0).bg(t.background)
      .child(this.peer ? this.renderChat(t) : this.renderList(t));
  }

  button(t, id, label, action, opts = {}) {
    const primary = !!opts.primary;
    return div().id(id).flex_none().px(10).py(4).rounded(6).text_size(11).font_semibold().cursor_pointer()
      .bg(primary ? t.accent : t.raised).text_color(primary ? (t.on_accent ?? t.background) : t.foreground)
      .hover((s) => s.bg(primary ? t.accent : t.hover))
      .on_click((_e, cx) => action(cx)).child(label);
  }

  renderList(t) {
    const sid = this.space();
    const socialOn = terminals().some((x) => sameSpace(x.labels?.social, sid) && x.state !== "finished");
    const me = this.me ?? {};
    const known = new Set(Object.keys(this.peers));
    for (const r of this.inbox) if (r.from) known.add(r.from);
    for (const r of this.log) if (r.peer) known.add(r.peer);
    const names = [...known].sort((a, b) => {
      const la = this.conversation(a).slice(-1)[0]?.ts ?? 0, lb = this.conversation(b).slice(-1)[0]?.ts ?? 0;
      return lb - la; // most recent conversation first
    });

    const header = h_flex().h(36).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(svg("mods/peer-chat/board.svg").size(14).flex_none().text_color(t.muted))
      .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(`Peers: ${this.spaceName()}`))
      .child(div().flex_1())
      .child((() => {
        const d = terminals().find((x) => x.name === "peerd" && x.state !== "finished");
        return div().text_size(10.5).text_color(d ? t.dim : (socialOn ? (t.danger ?? t.foreground) : t.dim))
          .child(d ? `listening ${me.ip ? me.ip + ":7477" : ""}` : (socialOn ? "daemon not running" : "daemon off"));
      })())
      .child(div().text_size(11).text_color(socialOn ? t.foreground : t.dim).child(socialOn ? "Social: on" : "Social: off"))
      .child(this.button(t, "social-toggle", socialOn ? "Stop social" : "Make social", (cx) => this.social(cx)));

    const meCard = v_flex().gap(2).p(10).rounded(8).bg(t.surface).border(1).border_color(t.border)
      .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child("You"))
      .child(div().text_size(11).text_color(t.dim).child([me.login ?? "tailscale login unknown", me.host, me.ip ? `${me.ip}:7477` : null].filter(Boolean).join("  ·  ")))
      .child(div().text_size(11).text_color(t.dim).whitespace_normal().child(
        me.login ? `Teammates add you with:  hc peer add ${me.login}` : "Install Tailscale and sign in so peers can identify you."));

    const ar = this.addResult, sr = this.socialResult;
    const addField = Input.new(this.newPeer).id("new-peer").h(28).px(8).rounded(7).border(1).border_color(t.input).bg(t.background).text_size(12).text_color(t.foreground);
    const addRow = v_flex().gap(4)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().child(addField))
        .child(this.button(t, "add-peer", this.adding ? "Adding…" : "Add peer", (cx) => this.addPeer(cx), { primary: true })))
      .when(!!ar, (el) => el.child(div().text_size(11).px(4).whitespace_normal().text_color(ar?.error ? (t.danger ?? t.foreground) : t.dim).child(ar?.error ? `Error: ${ar.error}` : ar?.output ?? "")))
      .when(!!sr, (el) => el.child(div().text_size(11).px(4).whitespace_normal().text_color(sr?.error ? (t.danger ?? t.foreground) : t.dim).child(sr?.error ? `Error: ${sr.error}` : sr?.output ?? "")));

    const peerRow = (name) => {
      const p = this.peers[name] ?? {};
      const shown = p.self || name === "self" ? "you (web test)" : name;
      const conv = this.conversation(name);
      const last = conv[conv.length - 1];
      const unread = this.unread(name);
      const preview = last ? clean(last.text ?? last.body ?? last.subject ?? "") : null;
      return h_flex().id(`peer-${name}`).gap(10).p(10).rounded(8).cursor_pointer().items_center()
        .bg(t.surface).border(1).border_color(t.border).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.openPeer(name, cx))
        .child(div().flex_none().size(28).rounded(14).bg(t.raised).flex().items_center().justify_center()
          .child(div().text_size(12).font_semibold().text_color(t.foreground).child(name.slice(0, 1).toUpperCase())))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(h_flex().gap(6).items_center()
            .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(shown))
            .when(!!p.auto_agent, (el) => el.child(div().px(5).rounded(4).text_size(9.5).bg(t.raised).text_color(t.dim).child("auto agent")))
            .when(!this.peers[name], (el) => el.child(div().px(5).rounded(4).text_size(9.5).bg(t.raised).text_color(t.dim).child("not saved")))
            .child(div().flex_1())
            .child(div().text_size(10.5).text_color(t.dim).child(last ? when(last.ts) : "")))
          .child(div().text_size(11).text_color(t.dim).truncate().child(
            preview ? `${last.dir === "out" ? "You: " : ""}${clip((preview.subject ?? preview.body ?? ""), 90)}` : (p.login ?? ""))))
        .when(unread > 0, (el) => el.child(div().flex_none().px(6).py(1).rounded(9).bg(t.accent).text_size(10.5).font_semibold().text_color(t.on_accent ?? t.background).child(String(unread))));
    };

    return v_flex().size_full().min_h(0)
      .child(header)
      .child(v_flex().flex_1().min_h(0).p(10).gap(10).overflow_y_scrollbar()
        .child(meCard)
        .child(v_flex().gap(6)
          .child(div().text_size(11).font_semibold().text_color(t.dim).px(2).child("Peers"))
          .child(addRow)
          .when(names.length === 0, (el) => el.child(div().p(8).text_size(12).text_color(t.dim).child("No peers yet. Add one above or run hc peer add <login>.")))
          .children(names.map(peerRow))));
  }

  renderChat(t) {
    const name = this.peer;
    const p = this.peers[name] ?? {};
    const agents = this.spaceAgents();
    const conv = this.conversation(name);

    const header = h_flex().h(36).flex_none().px(8).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().id("back").px(8).py(3).rounded(6).text_size(12).cursor_pointer().text_color(t.foreground).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.back(cx)).child("← Peers"))
      .child(v_flex().min_w(0)
        .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(p.self || name === "self" ? "you (web test)" : name))
        .child(div().text_size(10.5).text_color(t.dim).child(p.login ?? "")))
      .child(div().flex_1())
      .child(div().text_size(10.5).text_color(t.dim).child(p.auto_agent ? "agent messages go straight to your default agent" : "agent messages wait for your Allow"))
      .child(this.button(t, "auto-agent", p.auto_agent ? "Auto agent: on" : "Auto agent: off",
        (cx) => this.run(cx, `auto-${name}`, ["peer", "allow-agent", name, p.auto_agent ? "off" : "on"])));

    const bubble = (m, i) => {
      const out = m.dir === "out";
      const { subject, body } = clean(m.text ?? m.body ?? m.subject ?? "");
      const forAgent = m.kind === "agent" || m.request;
      const res = this.rowResults.get(m.id);
      const pending = !out && !m.request && m.kind === "agent" && isPending(m);
      const picked = pending ? this.pickFor(m, agents) : null;
      const pickedT = agents.find((a) => a.address === picked);
      const statusLine = out
        ? (m.kind === "agent" ? "for their agent" : "")
        : m.request ? "wants to run something on your machine"
        : m.kind !== "agent" ? ""
        : m.status === "delivered" ? `→ ${m.delivered_to ?? "agent"}${m.auto ? " (auto)" : ""}`
        : m.status === "dismissed" ? "dismissed"
        : m.status === "failed" ? "delivery failed"
        : "waiting for you";

      const card = v_flex().max_w_3_5().gap(4).px(10).py(7).rounded(10)
        .bg(out ? t.accent : (forAgent ? t.raised : t.surface))
        .border(1).border_color(out ? t.accent : (pending ? t.accent : t.border))
        .text_color(out ? (t.on_accent ?? t.background) : t.foreground)
        .when(!!subject && !!body, (el) => el.child(div().text_size(12).font_semibold().whitespace_normal().child(subject)))
        .child(div().text_size(12.5).whitespace_normal().child(body || subject || "(empty)"))
        .child(h_flex().gap(6).items_center()
          .child(div().text_size(10).text_color(out ? (t.on_accent ?? t.background) : t.dim).child(when(m.ts)))
          .when(!!forAgent, (el) => el.child(div().px(5).rounded(4).text_size(9.5).bg(out ? t.raised : t.chrome).text_color(out ? t.foreground : t.dim).child("agent")))
          .when(!!statusLine, (el) => el.child(div().text_size(10).text_color(out ? (t.on_accent ?? t.background) : t.dim).child(statusLine))))
        // inline Allow / Dismiss for pending agent messages
        .when(pending, (el) => el.child(v_flex().gap(4).pt(2)
          .child(h_flex().gap(6).items_center()
            .child(div().text_size(11).text_color(t.dim).child("to"))
            .child(div().id(`pick-${m.id}`).px(8).py(3).rounded(6).text_size(11).cursor_pointer().bg(t.chrome).text_color(t.foreground).hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => { if (this.pickerOpen.has(m.id)) this.pickerOpen.delete(m.id); else this.pickerOpen.add(m.id); cx.notify(); })
              .child(pickedT ? `${pickedT.address} ${this.agentName(pickedT)}` : (picked ?? "no agent in this space")))
            .child(this.button(t, `allow-${m.id}`, "Allow", (cx) => this.run(cx, m.id, ["inbox", "allow", m.id, ...(picked ? ["--to", picked] : [])]), { primary: true }))
            .child(this.button(t, `dismiss-${m.id}`, "Dismiss", (cx) => this.run(cx, m.id, ["inbox", "dismiss", m.id]))))
          .when(this.pickerOpen.has(m.id), (el) => el.child(v_flex().gap(2).p(4).rounded(6).bg(t.chrome)
            .children(agents.map((a) => div().id(`pick-${m.id}-${a.address}`).px(8).py(3).rounded(5).text_size(11).cursor_pointer()
              .bg(a.address === picked ? t.selected : t.chrome).text_color(t.foreground).hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => { this.picks.set(m.id, a.address); this.pickerOpen.delete(m.id); cx.notify(); })
              .child(`${a.address}  ${this.agentName(a)}`)))))))
        // inline Approve / Deny for held RPCs
        .when(!!m.request, (el) => el.child(h_flex().gap(6).pt(2)
          .child(div().text_size(11).text_color(t.dim).child(`${m.method ?? m.kind}`))
          .child(this.button(t, `approve-${m.id}`, "Approve", (cx) => this.run(cx, m.id, ["approve", m.id]), { primary: true }))
          .child(this.button(t, `deny-${m.id}`, "Deny", (cx) => this.run(cx, m.id, ["deny", m.id])))))
        .when(!!res, (el) => el.child(div().text_size(10.5).whitespace_normal().text_color(res?.error ? (t.danger ?? t.foreground) : t.dim).child(res?.error ? `Error: ${res.error}` : res?.output ?? "")));

      const row = h_flex().w_full().child(out ? div().flex_1() : div().w(0)).child(card).child(out ? div().w(0) : div().flex_1());
      const prev = conv[i - 1];
      const newDay = !prev || !sameDay(new Date(prev.ts ?? 0), new Date(m.ts ?? 0));
      return v_flex().gap(6).children([
        ...(newDay ? [h_flex().justify_center().child(div().px(8).py(2).rounded(8).bg(t.chrome).text_size(10).text_color(t.dim).child(dayLabel(m.ts ?? Date.now())))] : []),
        row,
      ]);
    };

    const sr = this.sendResult;
    const field = Input.new(this.text).id("chat-text").h(32).px(10).rounded(8).border(1).border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground);
    const composer = v_flex().flex_none().gap(6).p(10).border_t(1).border_color(t.border).bg(t.chrome)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().child(field))
        .child(div().id("agent-read").px(8).py(4).rounded(6).text_size(11).cursor_pointer()
          .bg(this.agentRead ? t.accent : t.raised).text_color(this.agentRead ? (t.on_accent ?? t.background) : t.foreground)
          .hover((s) => s.bg(this.agentRead ? t.accent : t.hover))
          .on_click((_e, cx) => { this.agentRead = !this.agentRead; cx.notify(); })
          .child(this.agentRead ? "✓ agent read" : "agent read"))
        .child(this.button(t, "send", this.sending ? "Sending…" : "Send", (cx) => this.send(cx), { primary: true })))
      .child(div().text_size(10.5).px(2).text_color(sr?.error ? (t.danger ?? t.foreground) : t.dim).whitespace_normal().child(
        sr?.error ? `Error: ${sr.error}` : this.agentRead
          ? `Sent for ${name}'s agent. Their side holds it for Allow unless they marked you auto.`
          : `Plain text to ${name}. Shown in their conversation, never given to an agent.`));

    return v_flex().size_full().min_h(0)
      .child(header)
      .child(v_flex().flex_1().min_h(0).p(10).gap(8).overflow_y_scrollbar()
        .when(conv.length === 0, (el) => el.child(div().p(12).text_size(12).text_color(t.dim).text_center().child(`No messages with ${name} yet.`)))
        .children(conv.map(bubble)))
      .child(composer);
  }
}
