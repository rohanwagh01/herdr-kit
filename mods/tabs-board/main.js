// NOTICE: modified from Herdr's "tabs" mod, version 0.1.12 (Apache License 2.0).
// Changed for herdr-kit; see NOTICE and LICENSE in the repository root.
import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import * as fs from "fs/promises";
// Debug log beside the app config (herdr-app home); resolved lazily because home() comes from the herdr import below.
const LOGF = () => `${home()}/.config/herdr-app/tabs-board-debug.log`;
const dbgLines = [];
const dbg = (m) => { try { dbgLines.push(`${new Date().toISOString()} ${m}`); const r = fs.writeFile?.(LOGF(), dbgLines.join("\n") + "\n"); if (r && r.catch) r.catch(() => {}); } catch {} };
dbg("module loaded");
try { if (shared("restart.status")?.result?.error) setShared("restart.status", {}); } catch {}
import { spaces, panes, focused, terminals, run, openOverlay, theme, window, shared, setShared, layout, settings, exec, home, notify, readTextFile } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Restart all: first click arms for 6 s, second click runs `hc restart --all` (every live agent,
// resumed; parked/frozen ones are skipped). Progress and result are shared as "restart.status" so
// the Board can show them, and the result is also posted as a toast.
const RESTART_OUT = () => `${home()}/.herdr/restart/last.json`;
const RESTART_LOCK = () => `${home()}/.herdr/frozen/lock`;

// scope: "all" (every agent on the core) or "tab" (the shown tab's agents). Each has its own arm state.
function restartAll(self, cx, scope = "all") {
  const st = shared("restart.status") ?? {};
  dbg(`click ${scope}: arming=${self.arming} running=${st.running}`);
  if (st.running) return;
  if (self.arming !== scope) {
    self.arming = scope; cx.notify();
    cx.timer.after(20000, (cx) => { if (self.arming === scope) { self.arming = null; cx.notify(); } });
    return;
  }
  self.arming = null;
  const space = spaces().find((s) => s.active), tab = space?.tabs?.find((c) => c.active);
  if (scope === "tab" && !tab) return;
  const hcArgs = scope === "tab" ? `restart --tab ${tab.id}` : scope === "revive" ? "revive --all" : "restart --all";
  dbg(`starting detached ${hcArgs}`);
  setShared("restart.status", { running: true, started: Date.now(), scope, tab: tab?.id });
  cx.spawn(async (cx) => {
    // `exec` stops anything after 30 s; a full restart takes minutes. Run it detached and watch its
    // result file. The lock file says whether it is still going.
    try {
      dbg("exec sh");
      await exec("sh", ["-c", `mkdir -p "$HOME/.herdr/restart" && : > "$HOME/.herdr/restart/last.json" && (nohup "$HOME/.herdr/bin/hc" ${hcArgs} > "$HOME/.herdr/restart/last.json" 2>&1 &)`]);
    } catch (e) {
      dbg(`exec failed: ${e?.message ?? e}`);
      finishRestart({ error: String(e?.message ?? e).slice(0, 200) });
      return;
    }
    dbg("exec returned; polling");
    const started = Date.now();
    for (;;) {
      await new Promise((r) => cx.timer.after(4000, r));
      let text = "";
      try { text = (await readTextFile(RESTART_OUT())) ?? ""; } catch {}
      const last = text.trim().split("\n").pop();
      if (last && last.startsWith("{")) {
        try { finishRestart(JSON.parse(last)); return; } catch {}
      }
      let lock = null;
      try { lock = await readTextFile(RESTART_LOCK()); } catch {}
      if (!lock && Date.now() - started > 20000) { finishRestart({ error: text.trim().slice(-200) || "restart ended without a result; see ~/.herdr/restart/last.json" }); return; }
      if (Date.now() - started > 30 * 60 * 1000) { finishRestart({ error: "still running after 30 min; check hc restart from a shell" }); return; }
    }
  });
}

function finishRestart(res) {
  const list = res.restart ?? res.revive ?? [];
  const ok = list.filter((x) => x.restarted && x.resumed !== false && !x.error);
  const bad = list.filter((x) => !ok.includes(x));
  const scope = shared("restart.status")?.scope ?? "all";
  const acted = list.filter((x) => !x.skip);
  const summary = res.error ? `${scope === "revive" ? "Revive" : "Restart"} failed: ${res.error}`
    : scope === "revive" ? `Revived ${ok.length} of ${acted.length}` + (bad.filter((x) => !x.skip).length ? `; check ${bad.filter((x) => !x.skip).map((x) => x.terminal).join(", ")}` : "")
    : `Restarted ${ok.length} of ${list.length}${scope === "tab" ? " in this tab" : ""}` + (bad.length ? `; check ${bad.map((x) => x.terminal).join(", ")}` : "");
  setShared("restart.status", { running: false, finished: Date.now(), result: res, summary, scope });
  notify({ title: scope === "tab" ? "Restart tab" : scope === "revive" ? "Revive" : "Restart all", body: summary, level: res.error || bad.length ? "warning" : "success", timeout: 12000,
    action: { name: "layout.select", args: { stack: "panel-body", child: "board" } } });
}

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    // After a Herdr restart the core comes back with every terminal as a shell. The fleet snapshot
    // (~/.herdr/fleet/snapshot.json, written by `hc snapshot`) says which agent belongs in each one;
    // when any of those terminals is live with no agent, the Revive button appears.
    this.reviveNeeded = [];
    const checkRevive = (cx) => cx.spawn(async (cx) => {
      let snap = null;
      try { snap = JSON.parse((await readTextFile(`${home()}/.herdr/fleet/snapshot.json`)) ?? "null"); } catch {}
      let frozen = {};
      try { frozen = JSON.parse((await readTextFile(`${home()}/.herdr/frozen/state.json`)) ?? "{}")?.agents ?? {}; } catch {}
      // `hc snapshot` decides from each terminal's foreground program (the window only sees agents, not
      // a plain service like the dispatch poller); the list is at most a minute old.
      const live = new Set(terminals().map((x) => x.address));
      const need = (snap?.needs_revive ?? []).filter((addr) => live.has(addr) && !frozen[addr]);
      if (need.join() !== this.reviveNeeded.join()) { this.reviveNeeded = need; setShared("revive.needed", need); cx.notify(); }
    });
    checkRevive(cx);
    cx.timer.every(10000, checkRevive);
    this.lastPx = Object.values(this.panels).map(v => v && typeof v === "object" ? v.px : null).filter(Boolean).pop() ?? null;
  }

  // The side panel is remembered per tab (space/tab): which panel is open, or
  // closed, and how wide it is. Switching tabs restores that tab's choice; a tab
  // never seen starts closed at the last width used. Opening, closing, picking a
  // panel or dragging its edge records the new choice for the shown tab.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const tab = space.tabs?.find(c => c.active)?.id ?? focused()?.tab ?? null;
    const key = tab ? `${space.id}/${tab}` : space.id;
    const now = panel.hidden ? null : body?.active ?? null, px = panel.size?.px ?? null;
    const entry = (v) => (v && typeof v === "object") ? v : { open: v ?? null, px: null };
    if (key !== this.panelKey) {
      const first = this.panelKey === undefined;
      this.panelKey = key; this.pending = null;
      // Old per-space records seed a tab the first time it is shown.
      const known = key in this.panels || space.id in this.panels;
      if (!(first && !known)) {
        const stored = entry(this.panels[key] ?? this.panels[space.id]);
        const want = enabled.includes(stored.open) ? stored.open : null, wantPx = stored.px ?? this.lastPx ?? null;
        const needSize = want && wantPx && Math.abs((px ?? 0) - wantPx) > 1;
        if (want !== now || needSize) {
          this.pending = { want, px: want ? wantPx : null, until: Date.now() + 1200 };
          if (want) {
            run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" });
            if (wantPx) run("layout.resize", { id: "panel", px: wantPx });
          } else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      const landed = this.pending.want === now && (!this.pending.px || Math.abs((px ?? 0) - this.pending.px) <= 1);
      if (!landed && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    const cur = entry(this.panels[key]), keepPx = now ? px : cur.px ?? px;
    if (now) this.lastPx = px;
    if (cur.open === now && (cur.px === keepPx || (cur.px != null && keepPx != null && Math.abs(cur.px - keepPx) <= 1))) return;
    this.panels[key] = { open: now, px: keepPx };
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu-cos", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    // The Board (message board) panel is always offered, beside the person's chosen panels.
    const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), "board"];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .children([...(this.reviveNeeded.length ? ["revive"] : []), "tab", "all"].map((scope) => {
        const st = shared("restart.status") ?? {};
        const armed = this.arming === scope, running = st.running && st.scope === scope;
        const label = armed ? (scope === "tab" ? "Confirm: restart this tab's agents? Click again (20 s)" : scope === "revive" ? `Confirm: revive ${this.reviveNeeded.length} agents from the snapshot? Click again (20 s)` : "Confirm: restart all agents? Click again (20 s)")
          : running ? (scope === "revive" ? "Reviving\u2026" : "Restarting\u2026") : scope === "tab" ? "Restart tab" : scope === "revive" ? `Revive ${this.reviveNeeded.length}` : "Restart all";
        return h_flex().id(`restart-${scope}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(12)
          .bg(armed ? t.blocked : scope === "revive" ? t.selected : t.chrome).text_color(armed ? "#ffffff" : st.running ? t.dim : scope === "revive" ? t.foreground : t.muted)
          .when(!st.running, el => el.hover(s => s.bg(armed ? t.blocked : t.hover)).cursor_pointer())
          .on_mouse_down("left", stop).on_click((_e, cx) => restartAll(this, cx, scope))
          .tooltip(scope === "tab" ? "Restart the agents in the shown tab, conversations resumed. Click, then click again within 20 s."
            : scope === "revive" ? `Herdr restarted and these terminals lost their agents: ${this.reviveNeeded.join(", ")}. Relaunch each in place from the fleet snapshot with its conversation. Click, then click again within 20 s.`
            : "Restart every agent on this core, conversations resumed (picks up updates). Click, then click again within 20 s.")
          .child(running ? svg("mods/workspace-chrome/spinner.svg").size(14).spin(900) : svg("mods/workspace-chrome/clock.svg").size(14))
          .child(label);
      }))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .child(panelButton("board", "Board", "mods/message-board/board.svg").tooltip("Message board: every hc send by or to this tab"))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs-board/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs-board/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs-board/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
