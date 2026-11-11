"""send/blast/freeze/unfreeze/frozen for the hc wrapper. See ~/.herdr/bin/hc."""
import json, os, subprocess, sys, time

REAL = os.environ.get("HC_REAL") or os.path.expanduser("~/.local/bin/hc")
BOARD = os.environ.get("HC_BOARD_DIR") or os.path.expanduser("~/.herdr/messages")
FROZEN = os.environ.get("HC_FROZEN") or os.path.expanduser("~/.herdr/frozen/state.json")
SHARE = os.environ.get("HC_SHARE") or os.path.expanduser("~/.herdr/share/state.json")
PEER_DIR = os.path.expanduser("~/.herdr/peer")
PEERS_FILE = os.path.join(PEER_DIR, "peers.json")
CLOUD_FILE = os.path.join(PEER_DIR, "cloud.json")
ME_FILE = os.path.join(PEER_DIR, "me.json")
ME = os.environ.get("HC_TERMINAL_ID") or None

# ---------------------------------------------------------------- kit config (herdr-kit)
KIT_FILE = os.environ.get("HC_KIT") or os.path.expanduser("~/.herdr/kit.json")

def load_kit():
    """~/.herdr/kit.json, written by herdr-kit's install.sh: owner name, org domain, which add-ons
    are installed. Everything here has a safe default so the wrapper works without the file."""
    try:
        with open(KIT_FILE) as f: return json.load(f)
    except Exception: return {}

KIT = load_kit()
OWNER = KIT.get("owner") or "the owner"
PEER_COMMANDS = ("social", "inbox", "approve", "deny", "requests", "peer", "intake", "share", "unshare", "shared")
def sender():
    return ME or f"{OWNER}'s shell"

def real(*args):
    return subprocess.run([REAL, *args], capture_output=True, text=True)

def jout(r):
    for chunk in (r.stdout, r.stderr):
        try: return json.loads((chunk or "").strip())
        except Exception: pass
    return {}

def out(obj, code=0):
    print(json.dumps(obj, ensure_ascii=False)); sys.exit(code)

def load_peers():
    try:
        with open(PEERS_FILE) as f: return json.load(f)
    except Exception: return {}

def load_cloud():
    try:
        with open(CLOUD_FILE) as f: return json.load(f)
    except Exception: return {}

def load_me():
    try:
        with open(ME_FILE) as f: return json.load(f)
    except Exception: return {}

def save_me(d):
    os.makedirs(PEER_DIR, exist_ok=True)
    tmp = ME_FILE + ".tmp"
    with open(tmp, "w") as f: json.dump(d, f, indent=1)
    os.replace(tmp, ME_FILE)

def my_login():
    """Cached Tailscale whois login for this machine."""
    me = load_me()
    if me.get("login"):
        return me["login"]
    try:
        r = subprocess.run(["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "ip", "-4"], capture_output=True, text=True, timeout=5)
        ip = r.stdout.strip().split("\n")[0]
        if ip:
            r2 = subprocess.run(["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "whois", "--json", ip], capture_output=True, text=True, timeout=5)
            d = json.loads(r2.stdout or "{}")
            login = (d.get("UserProfile") or {}).get("LoginName")
            if login:
                save_me({"login": login, "ts": int(time.time() * 1000)})
                return login
    except Exception:
        pass
    return None

def find_intake_on_machine(machine):
    """Find the intake agent on a remote machine by name or intake=1 label."""
    r = real("get", f"{machine}/intake", "--json")
    if r.returncode == 0:
        try:
            d = json.loads(r.stdout.strip())
            if d.get("address"):
                return d["address"]
        except Exception:
            pass
    r = real("ls", "--json")
    try:
        d = json.loads(r.stdout.strip())
        for t in d.get("terminals", []):
            addr = t.get("address", "")
            if addr.startswith(machine + "/") and (t.get("name") == "intake" or (t.get("labels") or {}).get("intake") == "1"):
                return addr
    except Exception:
        pass
    return None

def resolve_peer(to):
    """Resolve a bare peer name to <name>/intake, or cloud:<name> to its terminal."""
    if not to:
        return to, None
    if to.startswith("cloud:"):
        name = to[6:]
        cloud = load_cloud()
        if name not in cloud:
            return None, {"kind": "no_cloud", "message": f"cloud:{name} not found in ~/.herdr/peer/cloud.json"}
        return cloud[name].get("terminal"), None
    if "/" not in to:
        peers = load_peers()
        if to in peers and peers[to].get("kind") == "web":
            return f"{to}/web", None  # a web peer: no core; cmd_send writes to their outbox
        try:
            machines = {m.get("name") for m in (jout(real("machine", "ls", "--json")) or {}).get("machines", [])}
        except Exception:
            machines = set()
        if to in peers or to in machines:
            # A person's address is their first visible (social) terminal; their daemon queues the
            # message in their inbox and they choose which agent gets it.
            r = real("ls", "--json")
            try:
                rows = [t for t in (jout(r) or {}).get("terminals", []) if t.get("address", "").startswith(to + "/")]
            except Exception:
                rows = []
            if not rows:
                return None, {"kind": "no_social", "message": f"{to} has no social space right now; ask them to run hc social <space>"}
            return rows[0]["address"], None
    return to, None

def log(rec):
    os.makedirs(BOARD, exist_ok=True)
    rec = {"ts": int(time.time() * 1000), "from": ME, "cwd": os.getcwd(), **rec}
    with open(os.path.join(BOARD, "log.jsonl"), "a") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")

def load_frozen():
    try:
        with open(FROZEN) as f: d = json.load(f)
        return {"spaces": d.get("spaces") or {}, "tabs": d.get("tabs") or {}, "agents": d.get("agents") or {}}
    except Exception:
        return {"spaces": {}, "tabs": {}, "agents": {}}

def save_frozen(d):
    os.makedirs(os.path.dirname(FROZEN), exist_ok=True)
    tmp = FROZEN + ".tmp"
    with open(tmp, "w") as f: json.dump(d, f, indent=1)
    os.replace(tmp, FROZEN)

def load_share():
    try:
        with open(SHARE) as f: d = json.load(f)
        return {"spaces": d.get("spaces") or {}, "tabs": d.get("tabs") or {}}
    except Exception:
        return {"spaces": {}, "tabs": {}}

def save_share(d):
    os.makedirs(os.path.dirname(SHARE), exist_ok=True)
    tmp = SHARE + ".tmp"
    with open(tmp, "w") as f: json.dump(d, f, indent=1)
    os.replace(tmp, SHARE)

HELD = os.path.join(os.path.dirname(FROZEN), "held.json")
def load_held():
    try:
        with open(HELD) as f: return json.load(f)
    except Exception: return {}
def save_held(h):
    os.makedirs(os.path.dirname(HELD), exist_ok=True)
    with open(HELD, "w") as f: json.dump(h, f, indent=1)

def terminals(*label_filters):
    args = ["ls", "--json"]
    for lf in label_filters: args += ["--label", lf]
    return jout(real(*args)).get("terminals", [])

AGENT_PROGRAMS = {"claude", "devin", "codex", "pi", "gemini", "aider", "goose", "amp", "opencode", "kiro"}

def is_agent(t):
    """An agent is a live terminal that reports a status, or whose foreground program is a known
    agent, or that carries a role label (an agent on an old build that reports no status)."""
    if t.get("state") != "live": return False
    if t.get("status"): return True
    info = jout(real("get", t["address"])) or {}
    fg = ((info.get("foreground") or {}).get("argv") or [""])[0].rsplit("/", 1)[-1]
    return fg in AGENT_PROGRAMS or bool((info.get("labels") or {}).get("role"))

def resolve(to):
    if not to: return to
    for t in terminals():
        if t.get("name") == to or t.get("address") == to: return t["address"]
    return to

def labels_of(addr):
    return (jout(real("get", addr)) or {}).get("labels") or {}

def frozen_reason(addr, fz, labels=None):
    if not (fz["spaces"] or fz["tabs"]): return None
    labels = labels if labels is not None else labels_of(addr)
    tb, sp = labels.get("herdr.tab"), labels.get("herdr.space")
    if tb in fz["tabs"]: return f"tab {fz['tabs'][tb].get('name') or tb}"
    if sp in fz["spaces"]: return f"space {fz['spaces'][sp].get('name') or sp}"
    return None

def positional(args, with_values=("--if", "--timeout")):
    pos, i = [], 0
    while i < len(args):
        a = args[i]
        if a == "--": pos.extend(args[i + 1:]); break
        if a in with_values: i += 2; continue
        if a.startswith("--"): i += 1; continue
        pos.append(a); i += 1
    return pos

NO_REPLY = "Blast: informational. Do not reply, do not run anything, print nothing but the single word Noted."

def with_no_reply(text):
    return text if NO_REPLY in text else text.rstrip() + "\n\n" + NO_REPLY

def refuse(kind, message, to=None, text=None, reason=None):
    if to is not None:
        log({"to": to, "text": text, "blocked": kind, "reason": reason})
    out({"error": {"kind": kind, "message": message}}, 1)

# ---------------------------------------------------------------- send
def with_kind(text, kind):
    """Peer messages carry 'Herdr-Kind: chat|agent' right after the Subject line (or first).
    chat = text for the person, shown in their conversation, never given to an agent.
    agent = for the other person's agent; their daemon holds it for Allow unless they marked us auto."""
    import re
    m = re.match(r"(\s*subject\s*:[^\n]*\n)", text, re.I)
    header = f"Herdr-Kind: {kind}\n"
    return text[:m.end()] + header + text[m.end():] if m else header + text

def cmd_send(args):
    hold = "--hold" in args
    if hold: args = [a for a in args if a != "--hold"]
    # --chat / --agent pick the peer message kind; default: an agent terminal sends agent, a person sends chat.
    kind = "agent" if "--agent" in args else "chat" if "--chat" in args else ("agent" if ME else "chat")
    args = [a for a in args if a not in ("--agent", "--chat")]
    pos = positional(args)
    if len(pos) >= 2:
        to, text = pos[0], " ".join(pos[1:])
        # Bare acknowledgements are noise: "Noted" belongs in the sender's own terminal, not in someone's input.
        import re
        if re.fullmatch(r"\s*(subject:\s*)?(noted|ack|acknowledged|ok|okay|received)[.!]?\s*", text, re.I):
            log({"to": to, "text": text, "blocked": "noise", "reason": "bare acknowledgement"})
            out({"sent": False, "dropped": "bare acknowledgement: print Noted in your own terminal instead of sending it"}, 0)
        # Resolve peer addressing before frozen checks
        resolved, err = resolve_peer(to)
        if err:
            refuse(err["kind"], err["message"], to, text)
        if resolved != to:
            to = resolved
            args = [a if a != pos[0] else to for a in args]
        # Build log extras for remote/cloud targets
        log_extra = {}
        if "/" in to:
            peer_name = to.split("/", 1)[0]
            log_extra["peer"] = peer_name
            log_extra["kind"] = kind
            text = with_kind(text, kind)
            flags = [a for a in args if a.startswith("--")]
            vals = []
            for i, a in enumerate(args):  # keep flag values (--if X, --timeout N)
                if a in ("--if", "--timeout") and i + 1 < len(args): vals.append(args[i + 1])
            args = [a for a in args if a.startswith("--") or a in vals] + [to, text]
            peers = load_peers()
            if peer_name in peers:
                log_extra["to_user"] = peers[peer_name].get("login")
        log_extra["from_user"] = my_login()
        log_extra["dir"] = "out"
        fz = load_frozen()
        if fz["spaces"] or fz["tabs"]:
            if ME:
                mine = frozen_reason(ME, fz)
                if mine:
                    refuse("frozen", f"You are frozen ({mine}) by {OWNER}: stop and wait. Messages from you are not delivered until you are unfrozen.", to, text, mine)
            why = frozen_reason(resolve(to), fz)
            if why and hold:
                held = load_held(); addr = resolve(to)
                held.setdefault(addr, []).append({"from": ME, "ts": int(time.time()), "text": text})
                save_held(held)
                log({"to": addr, "text": text, "held": True, "reason": why, **log_extra})
                out({"sent": False, "held": True, "to": addr, "queued": len(held[addr]), "delivered_when": f"{OWNER} unfreezes it"}, 0)
            if why:
                refuse("frozen", f"{to} is frozen ({why}) by {OWNER}: you cannot talk to it right now. It did not get your message. Add --hold to queue it for delivery when {OWNER} unfreezes it, try again later, or ask {OWNER}.", to, text, why)
        log({"to": to, "text": text, **log_extra})
        if to.endswith("/web"):
            peer_name = to[:-4]
            outdir = os.path.join(PEER_DIR, "outbox"); os.makedirs(outdir, exist_ok=True)
            with open(os.path.join(outdir, peer_name + ".jsonl"), "a") as f:
                f.write(json.dumps({"ts": int(time.time() * 1000), "from": ME or "owner", "to": peer_name,
                                    "kind": kind, "text": text}, ensure_ascii=False) + "\n")
            out({"sent": True, "to": to, "via": "outbox", "kind": kind}, 0)
    os.execv(REAL, [REAL, "send", *args])

# ---------------------------------------------------------------- blast
def cmd_blast(args):
    include_self = "--include-self" in args; dry = "--dry-run" in args
    include_devin = "--include-devin" in args
    pos = [a for a in args if not a.startswith("--")]
    if not pos: out({"error": {"message": 'usage: hc blast [--include-self] [--include-devin] [--dry-run] "text"'}}, 2)
    text = " ".join(pos); fz = load_frozen()
    text = with_no_reply(text)
    if ME and frozen_reason(ME, fz):
        refuse("frozen", f"You are frozen by {OWNER}: stop and wait. Blasts from you are not delivered until you are unfrozen.", "*", text, frozen_reason(ME, fz))
    sent, failed, frozen, skipped = [], [], [], []
    for t in terminals():
        a = t["address"]
        if (a == ME and not include_self) or not is_agent(t): continue
        # Devin spends minutes "thinking" on an informational message instead of
        # answering Noted, and the blast lands as a turn in the middle of its work.
        # Whoever works with a Devin relays what changes its task.
        if t.get("agent") == "devin" and not include_devin:
            skipped.append(a); continue
        why = frozen_reason(a, fz)
        if why: frozen.append({"to": a, "reason": why}); continue
        if dry: sent.append(a); continue
        r = real("send", a, text); err = (jout(r) or {}).get("error")
        if r.returncode == 0 and not err: sent.append(a)
        else: failed.append({"to": a, "reason": (err or {}).get("kind") or (err or {}).get("message") or (r.stderr.strip() or "error")[:80]})
    if not dry:
        log({"to": "*", "blast": True, "text": text, "sent": sent, "failed": failed, "frozen": frozen, "skipped_devin": skipped})
    out({"blast": True, "sent": sent, "failed": failed, "frozen": frozen, "skipped_devin": skipped, "dry_run": dry}, 0 if sent or not failed else 1)

# ---------------------------------------------------------------- freeze / unfreeze
def herdr_ls():
    """Space/tab listing from the Herdr app, for name resolution."""
    try:
        r = subprocess.run(["herdr-app", "ls"], capture_output=True, text=True, timeout=10)
        return json.loads(r.stdout or "{}")
    except Exception:
        return {}

def resolve_scope_ident(kind, ident):
    """Resolve a space/tab name to its id; return ident unchanged if it is already an id or not found."""
    prefix = "sp" if kind == "spaces" else "tb"
    if ident.startswith(prefix):
        return ident
    d = herdr_ls()
    for sp in d.get("spaces", []):
        if kind == "spaces" and (sp.get("name") or "").lower() == ident.lower():
            return sp["id"]
        for tb in sp.get("tabs", []):
            if kind == "tabs" and (tb.get("name") or "").lower() == ident.lower():
                return tb["id"]
    return ident

def scope_from(args, verb):
    kind = ident = name = None; dry = "--dry-run" in args
    it = iter(range(len(args)))
    pos = []
    for i in it:
        a = args[i]
        if a in ("--space", "--tab"): kind = a[2:] + "s"; ident = args[i + 1]; next(it, None)
        elif a == "--name": name = args[i + 1]; next(it, None)
        elif not a.startswith("--"): pos.append(a)
    if not kind or not ident:
        # Positional fallback: first arg is the scope id or name; prefix decides space vs tab.
        if pos:
            first = pos[0]
            kind = "spaces" if first.startswith("sp") else "tabs" if first.startswith("tb") else None
            if kind:
                ident = first
                name = " ".join(pos[1:]) or None
    if not kind or not ident:
        out({"error": {"message": f"usage: hc {verb} <space|tab id or name> [--name <label>] [--dry-run] | hc {verb} --space <id> | --tab <id> [--name <label>] [--dry-run]"}}, 2)
    ident = resolve_scope_ident(kind, ident)
    return kind, ident, name, dry

def agents_in(kind, ident):
    label = "herdr.space=" if kind == "spaces" else "herdr.tab="
    return [t for t in terminals(label + ident) if t["address"] != ME and is_agent(t)]

def notify_all(targets, text, interrupt):
    sent, failed = [], []
    for t in targets:
        a = t["address"]
        if interrupt and t.get("status") == "working": real("interrupt", a)
        if t.get("status") == "blocked":
            failed.append({"to": a, "reason": "blocked (permission prompt); will see the state when it resumes"}); continue
        r = real("send", a, text); err = (jout(r) or {}).get("error")
        if r.returncode == 0 and not err: sent.append(a)
        else: failed.append({"to": a, "reason": (err or {}).get("kind") or (r.stderr.strip() or "error")[:80]})
    return sent, failed

def cmd_freeze(args):
    if "--dry-run" not in args: take_lock("freeze")
    kind, ident, name, dry = scope_from(args, "freeze")
    fz = load_frozen(); what = f"{kind[:-1]} {name or ident}"
    targets = agents_in(kind, ident)
    if dry: out({"freeze": what, "dry_run": True, "would_park": [t["address"] for t in targets]})
    fz[kind][ident] = {"name": name, "ts": int(time.time() * 1000), "by": ME}
    save_frozen(fz)  # messages are refused from here on
    parked, failed = [], []
    for t in targets:
        a = t["address"]; plan = restart_plan(a)
        if plan.get("skip") or not plan.get("command"):
            if t.get("status") == "working": real("interrupt", a)
            real("send", a, f"Subject: FROZEN by {OWNER}: stop now and wait\n\n{OWNER} froze your {what}. Do nothing until an UNFROZEN message arrives.\n\n{NO_REPLY}")
            failed.append({"to": a, "reason": plan.get("skip") or "no relaunch command; told to stop instead"}); continue
        res = quit_only(a, plan)
        if res.get("quit"):
            fz.setdefault("agents", {})[a] = {**{k: plan.get(k) for k in ("program", "command", "argv", "session", "recreate", "name", "cwd", "labels", "parent", "title")}, "scope": {"kind": kind, "id": ident}}
            parked.append(a)
        else:
            failed.append({"to": a, "reason": res.get("error")})
    save_frozen(fz)
    log({"to": "*", "blast": True, "kind": "freeze", "scope": what, "text": f"Subject: froze {what}", "sent": parked, "failed": failed, "frozen": []})
    out({"freeze": what, "parked": parked, "failed": failed})

def cmd_unfreeze(args):
    if "--dry-run" not in args: take_lock("unfreeze")
    kind, ident, name, dry = scope_from(args, "unfreeze")
    fz = load_frozen(); entry = fz[kind].get(ident); what = f"{kind[:-1]} {name or (entry or {}).get('name') or ident}"
    mine = {a: p for a, p in (fz.get("agents") or {}).items() if p.get("scope") == {"kind": kind, "id": ident}}
    if dry: out({"unfreeze": what, "dry_run": True, "would_relaunch": list(mine), "was_frozen": entry is not None})
    fz[kind].pop(ident, None); save_frozen(fz)
    resumed, failed, delivered = [], [], []
    for a, plan in mine.items():
        res = relaunch_only(a, plan)
        target = res.get("new_terminal") or a
        if res.get("restarted"):
            resumed.append(target); ok = res.get("resumed", True)
            real("send", target, f"Subject: UNFROZEN at {time.strftime('%H:%M')}: you may resume; resumed={'yes' if ok else 'NO'}\n\n"
                 f"{OWNER} unfroze your {what}. You were parked (exited) while frozen and relaunched now{' with your conversation' if ok else ' COLD: re-read your labels, ticket and last report before acting'}. "
                 f"Run hc state <ticket> <role> (or ~/.herdr/bin/hc state ...) and read it first. Messages sent to you while frozen were dropped, except any marked HELD, which follow this note. Re-read your last instructions before continuing.\n\n{NO_REPLY}")
            held = load_held(); queue = held.pop(a, []); save_held(held)
            for m in queue:
                real("send", target, f"Subject: HELD while you were frozen (from {m.get('from') or 'unknown'} at {time.strftime('%H:%M', time.localtime(m.get('ts', 0)))})\n\n{m['text']}")
                log({"to": target, "text": m["text"], "from_held": m.get("from"), "kind": "held-delivery"})
            if queue: delivered.append({"to": target, "count": len(queue)})
        else:
            failed.append({"to": a, "reason": res.get("error") or res.get("skip")})
        fz = load_frozen(); fz.get("agents", {}).pop(a, None); save_frozen(fz)
    log({"to": "*", "blast": True, "kind": "unfreeze", "scope": what, "text": f"Subject: unfroze {what}", "sent": resumed, "failed": failed, "frozen": []})
    try: take_snapshot(force=True)
    except Exception: pass
    out({"unfreeze": what, "resumed": resumed, "failed": failed, "held_delivered": delivered, "was_frozen": entry is not None})

# ---------------------------------------------------------------- restart (Claude and Devin sessions)
SESSIONS = os.path.expanduser("~/.claude/sessions")

def claude_session(pid):
    """Claude Code records each running session as ~/.claude/sessions/<pid>.json."""
    try:
        with open(os.path.join(SESSIONS, f"{pid}.json")) as f: d = json.load(f)
    except Exception:
        return None
    for k in ("sessionId", "session_id", "id"):
        if isinstance(d.get(k), str): return d[k]
    return None

def devin_session(cwd, title):
    """Devin has no per-pid record; match the terminal title ("devin: <session title>", truncated)
    against `devin list --format json` in the terminal's folder. Exact match first; never guess on a tie."""
    try:
        r = subprocess.run(["devin", "list", "--format", "json"], cwd=cwd, capture_output=True, text=True, timeout=20)
        items = json.loads(r.stdout or "[]")
        if isinstance(items, dict): items = items.get("sessions") or []
    except Exception:
        return None, "devin list failed"
    want = (title or "").split(":", 1)[1].strip() if (title or "").startswith("devin:") else (title or "").strip()
    items = sorted(items, key=lambda x: -int(x.get("last_activity_at") or 0))
    if want:
        exact = [x for x in items if (x.get("title") or "").strip() == want]
        hits = exact or [x for x in items if (x.get("title") or "").strip().startswith(want.rstrip())]
        if len(hits) == 1: return hits[0]["id"], None
        if len(hits) > 1: return None, f"{len(hits)} Devin sessions in {cwd} share the title {want!r}; not guessing. Resume by hand with devin --resume <id>"
    return None, f"no Devin session titled like {want!r} in {cwd}"

def shell_quote(a):
    import shlex; return shlex.quote(a)

def restart_plan(addr, session_override=None):
    info = jout(real("get", addr)) or {}
    fg = info.get("foreground") or {}
    targv = info.get("argv") or []
    launched = None  # the authoritative launch argv, when Herdr or hc recorded one
    recreate = False
    if len(targv) >= 5 and targv[1] == "-lic" and targv[2].startswith('"$@"'):
        launched = targv[4:]  # Herdr's --argv: zsh -lic '"$@"; exec "$0" -li' <$0=zsh> <program...>; a shell stays after exit
    elif len(targv) >= 3 and targv[0].rsplit("/", 1)[-1] in ("sh", "bash", "zsh") and targv[1] == "-c":
        import shlex
        try: launched = shlex.split(targv[2])  # hc run with a template: `sh -c "devin ... --"`
        except ValueError: launched = None
        recreate = True  # no shell stays under it: when the agent exits the terminal ends
    elif targv and targv[0].rsplit("/", 1)[-1] in ("claude", "devin"):
        launched = targv[:]; recreate = True
    # The foreground argv that hc reports loses arguments with spaces (a system prompt, deny
    # patterns like "Bash(git push*)"), so it is only the fallback for a bare launch.
    argv = launched if launched else (fg.get("argv") or [])
    prog = (argv[0] if argv else "").rsplit("/", 1)[-1]
    if launched and prog == "claude":
        # Drop a first-message prompt given as the last positional (not the --append-system-prompt value).
        if len(argv) >= 2 and not argv[-1].startswith("-") and argv[-2] != "--append-system-prompt" and (len(argv[-1]) > 200 or "\n" in argv[-1]):
            argv = argv[:-1]
    plan = {"terminal": addr, "program": prog or None, "status": (info.get("status") or {}).get("state"),
            "cwd": (fg.get("cwd") if not recreate else None) or info.get("cwd"), "title": info.get("title"),
            "recreate": recreate, "name": info.get("name"), "state": info.get("state"), "parent": info.get("parent"),
            "labels": {k: v for k, v in (info.get("labels") or {}).items() if k in ("herdr.space", "herdr.tab", "role", "ticket")}}
    if prog not in ("claude", "devin"):
        plan["skip"] = "not a Claude or Devin session" if prog else "no foreground program"; return plan
    base = argv[:argv.index("--")] if "--" in argv else argv[:]  # drop a first prompt given after --
    if base and base[-1] == "--": base = base[:-1]
    if not launched:
        base = [a for a in base if a.startswith("-") or (len(a) <= 120 and "\n" not in a and " " not in a.strip())]
    # A previous resume in the launch line: take its id, then remove the pair so the new id is used.
    prev = None; cleaned = []; i = 0
    while i < len(base):
        if base[i] in ("--resume", "-r") and i + 1 < len(base) and not base[i + 1].startswith("-"):
            prev = base[i + 1]; i += 2; continue
        if base[i] in ("--resume", "-r"): i += 1; continue  # bare flag (picker): the id comes from the session file
        if base[i] in ("--continue", "-c"): i += 1; continue
        cleaned.append(base[i]); i += 1
    base = cleaned
    if session_override:
        plan["session"] = session_override; relaunch = base + ["--resume", session_override]
    elif prev:
        plan["session"] = prev; relaunch = base + ["--resume", prev]
    elif prog == "claude":
        sid = claude_session(fg.get("pid"))
        if not sid: plan["skip"] = "session id not found in ~/.claude/sessions"; return plan
        plan["session"] = sid; relaunch = base + ["--resume", sid]
    else:
        sid, note = devin_session(plan["cwd"], info.get("title"))
        if note: plan["note"] = note
        if not sid: plan["skip"] = note; return plan
        plan["session"] = sid; relaunch = base + ["--resume", sid]
    plan["argv"] = relaunch
    plan["command"] = " ".join(shell_quote(a) for a in relaunch)
    return plan

def wait_until(pred, seconds, step=0.5):
    end = time.time() + seconds
    while time.time() < end:
        if pred(): return True
        time.sleep(step)
    return False

def foreground_name(addr):
    fg = (jout(real("get", addr)) or {}).get("foreground") or {}
    return ((fg.get("argv") or [""])[0]).rsplit("/", 1)[-1]

KEY_NAMES = {" ": "space"}

def type_line(addr, text):
    keys = [KEY_NAMES.get(c, c) for c in text]
    for i in range(0, len(keys), 40):  # keep each hc call short
        real("keys", addr, *keys[i:i + 40])
    real("keys", addr, "enter")

def quit_only(addr, plan):
    """Stop and exit the agent, leaving its shell (or an ended terminal for sh -c launches)."""
    prog = plan["program"]
    if plan.get("state") != "live": return {**plan, "quit": True}
    if plan["status"] == "working": real("interrupt", addr); time.sleep(1.5)
    if plan["status"] == "blocked": real("keys", addr, "esc"); time.sleep(1.5)  # dismiss the permission prompt
    ended = (lambda: (jout(real("get", addr)) or {}).get("state") != "live") if plan.get("recreate") else (lambda: foreground_name(addr) != prog)
    state = lambda: ((jout(real("get", addr)) or {}).get("status") or {}).get("state")
    # Quit with raw keystrokes: `hc send` would wrap "/exit" in <hc> tags and deliver it as a message.
    # Only type at an idle prompt: while the agent is working, "/exit" is taken as text.
    for quit_cmd in ("/exit", "/quit", "/exit"):
        wait_until(lambda: state() != "working", 45)
        # A setup or update dialog (e.g. Claude's "Teach auto mode") swallows typed keys and does not
        # show as blocked: esc at an idle prompt is harmless and closes such dialogs.
        real("keys", addr, "esc"); time.sleep(1)
        real("keys", addr, "ctrl+u"); real("keys", addr, *list(quit_cmd), "enter")
        if wait_until(ended, 15): return {**plan, "quit": True}
        # It may have taken the command as a message and started a turn: let that finish before retrying.
        wait_until(lambda: state() != "working", 45)
    return {**plan, "quit": False, "error": f"{prog} did not exit on /exit or /quit"}

def do_recreate(addr, plan):
    """The terminal ended with the agent: remove it and start a new one with the same name, folder,
    labels and parent, running the resume command. The address changes; the parent is told."""
    if any(t["address"] == addr for t in terminals()): real("rm", addr)
    run_args = ["run", "--bg", "--json", "--no-notify", "--keep"]
    if plan.get("parent"): run_args += ["--parent", plan["parent"]]
    else: run_args += ["--no-parent"]
    if plan.get("name"): run_args += ["--name", plan["name"]]
    if plan.get("cwd"): run_args += ["--cwd", plan["cwd"]]
    for k, v in (plan.get("labels") or {}).items(): run_args += ["--label", f"{k}={v}"]
    run_args += ["--", *plan["argv"]]
    r = real(*run_args); res = jout(r) or {}
    new_addr = res.get("address") or res.get("terminal")
    if not new_addr:
        return {**plan, "error": f"hc run failed: {(res.get('error') or {}).get('message') or r.stderr.strip()[:160]}"}
    back = wait_until(lambda: bool((jout(real("get", new_addr)) or {}).get("status")), 60)
    # Tell whoever works with it: its parent, and the manager in the same tab (the parent is often the
    # Chief of Staff after an earlier recreate, which is not who needs the new address).
    tell = set()
    if plan.get("parent") and plan.get("parent") != ME: tell.add(plan["parent"])
    tab = (plan.get("labels") or {}).get("herdr.tab")
    if tab:
        for t in terminals("herdr.tab=" + tab):
            if t["address"] in (addr, new_addr): continue
            if labels_of(t["address"]).get("role") == "manager": tell.add(t["address"])
    for who in tell:
        real("send", who, f"Subject: {plan.get('name') or addr} restarted: now {new_addr} (was {addr}), same session\n\nFrom {sender()} via hc restart. Use {new_addr} or the name {plan.get('name') or ''}. No reply needed.")
    return {**plan, "restarted": back, "new_terminal": new_addr, **({} if back else {"error": f"{new_addr} reports no status yet; check it"})}

def relaunch_only(addr, plan):
    """Bring a quit agent back: type the command into its shell, or recreate the ended terminal."""
    if plan.get("recreate"):
        return do_recreate(addr, plan)
    prog = plan["program"]
    rdir = os.path.expanduser("~/.herdr/restart"); os.makedirs(rdir, exist_ok=True)
    script = os.path.join(rdir, f"{addr.replace('/', '_')}.sh")
    # The command goes in a script: keystrokes cannot carry quotes or uppercase reliably, and
    # `hc send` would wrap the command in <hc> tags. The typed line is short and lowercase.
    # The wrapper (hc blast/state/...) first on PATH for the relaunched agent: shells started before
    # the wrapper existed never see it otherwise.
    with open(script, "w") as f: f.write("#!/bin/sh\nexport PATH=\"$HOME/.herdr/bin:$PATH\"\nexec " + plan["command"] + "\n")
    real("keys", addr, "ctrl+u"); type_line(addr, f"sh {script}")
    back = wait_until(lambda: foreground_name(addr) == prog, 40)
    if not back:
        return {**plan, "restarted": False, "error": f"{prog} did not come back within 40s; check the terminal"}
    if prog == "claude" and plan.get("session"):
        pid = ((jout(real("get", addr)) or {}).get("foreground") or {}).get("pid")
        wait_until(lambda: claude_session(pid) is not None, 20)
        got = claude_session(pid)
        if got != plan["session"]:
            return {**plan, "restarted": True, "resumed": False, "error": f"resume did not take: new session {got}; the agent is cold"}
        plan["resumed"] = True
    if prog == "devin" and (plan.get("title") or "").strip():
        time.sleep(4)
        new_title = ((jout(real("get", addr)) or {}).get("title") or "").strip()
        if new_title.lower().startswith("devin:"): new_title = new_title[6:].strip()
        want_title = plan["title"].strip()
        if want_title.lower().startswith("devin:"): want_title = want_title[6:].strip()
        if new_title and new_title != want_title:
            return {**plan, "restarted": True, "error": f"title changed after resume: {plan['title']!r} -> {new_title!r}; check this is the right conversation"}
    return {**plan, "restarted": True}

def do_restart(addr, plan):
    res = quit_only(addr, plan)
    if not res.get("quit"): return res
    time.sleep(1.0)
    return relaunch_only(addr, plan)

def pre_notice(addr, plan, seconds=60):
    """Tell the agent, wait for it to go idle (never restart mid tool call), then proceed."""
    if plan.get("state") != "live" or plan.get("status") in (None, "blocked"): return
    real("send", addr, f"Subject: restart in {seconds}s: finish the current step and update your state file\n\nFrom {sender()} via hc restart. Run hc state <ticket> <role> \"<whole text>\" now (phase, peers, last instruction, open decisions, next step; if hc state is unknown, use ~/.herdr/bin/hc state). You will be relaunched with your conversation resumed. Do not start new tool calls after that. Reply with nothing but Noted.")
    state = lambda: ((jout(real("get", addr)) or {}).get("status") or {}).get("state")
    # The notice starts a turn: wait for it to begin (status flips to working), then for it to end.
    # Otherwise the quit keys land while the agent is busy and "/exit" becomes a message.
    wait_until(lambda: state() == "working", 10)
    wait_until(lambda: state() in ("idle", "done"), seconds)
    time.sleep(2)

def post_note(addr, res):
    target = res.get("new_terminal") or addr
    resumed = res.get("resumed", res.get("restarted"))
    real("send", target, f"Subject: you were restarted at {time.strftime('%H:%M')} by hc restart; resumed={'yes' if resumed else 'NO'}; same name, labels and folder\n\n"
         f"From {sender()}. Command: {res.get('command')}. {'Your conversation was resumed.' if resumed else 'Your conversation did NOT resume: you are cold. Re-read your labels (hc get $HC_TERMINAL_ID), your ticket, and your last report before acting.'} "
         f"Run hc state <ticket> <role> (or ~/.herdr/bin/hc state ...) and read it first. Messages sent to you during the restart were not delivered. Standing state: nothing has changed in your instructions unless a separate message says so. Reply with nothing but Noted.")

def cmd_restart(args):
    if "--dry-run" not in args: take_lock("restart")
    dry = "--dry-run" in args; everyone = "--all" in args; now = "--now" in args; quiet = "--quiet" in args
    session_override = None
    if "--session" in args:
        i = args.index("--session"); session_override = args[i + 1]; args = args[:i] + args[i + 2:]
    scope = None
    for flag in ("--tab", "--space"):
        if flag in args:
            i = args.index(flag); scope = (flag[2:] + "s", args[i + 1]); args = args[:i] + args[i + 2:]
    pos = [a for a in args if not a.startswith("--")]
    if not pos and not everyone and not scope: out({"error": {"message": "usage: hc restart <t>... [--session <id>] [--now] [--quiet] [--dry-run] | hc restart --all | --tab <id> | --space <id> [--dry-run]"}}, 2)
    fz = load_frozen(); targets = []
    if scope:
        for t in agents_in(*scope):
            if frozen_reason(t["address"], fz): continue
            if labels_of(t["address"]).get("restart") == "skip" and "--include-skipped" not in args: continue
            targets.append(t["address"])
    elif everyone:
        for t in terminals():
            if t["address"] == ME or not is_agent(t): continue
            if frozen_reason(t["address"], fz): continue  # parked: relaunched by unfreeze on the new binary
            # An agent labeled restart=skip (your operator agent: from the board button there is no caller
            # identity) is left out unless asked for by address or with --include-skipped.
            if labels_of(t["address"]).get("restart") == "skip" and "--include-skipped" not in args: continue
            targets.append(t["address"])
    else:
        targets = [resolve(p) for p in pos]
    results = []
    for a in targets:
        plan = restart_plan(a, session_override if len(targets) == 1 else None)
        if dry or plan.get("skip"): results.append(plan); continue
        if not now: pre_notice(a, plan)
        res = do_restart(a, plan)
        if res.get("restarted") and not quiet: post_note(a, res)
        results.append(res)
        log({"to": a, "kind": "restart", "text": f"Subject: restarted {a} to pick up updates\n\n{plan.get('command')}",
             "ok": bool(res.get("restarted")), "error": res.get("error")})
    if not dry:
        try: take_snapshot(force=True)
        except Exception: pass
    out({"restart": results, "dry_run": dry})

# ---------------------------------------------------------------- title (Devin session title)
def cmd_title(args):
    """hc title <t> [title]: set a Devin session's title with /rename, typed as keystrokes. Default title:
    the terminal's hc name, then its role label. Needs the Devin at its prompt (idle or done)."""
    pos = [a for a in args if not a.startswith("--")]
    if not pos: out({"error": {"message": "usage: hc title <t> [title]"}}, 2)
    addr = resolve(pos[0]); info = jout(real("get", addr)) or {}
    fg = info.get("foreground") or {}; prog = ((fg.get("argv") or [""])[0]).rsplit("/", 1)[-1]
    if prog != "devin": out({"error": {"kind": "unsupported", "message": f"{addr} runs {prog or 'nothing'}; titles apply to Devin sessions (Claude sessions resume by id already)"}}, 1)
    state = (info.get("status") or {}).get("state")
    if state in ("working", "blocked"): out({"error": {"kind": state, "message": f"{addr} is {state}; set the title when it is at its prompt"}}, 1)
    title = " ".join(pos[1:]).strip() or info.get("name") or (info.get("labels") or {}).get("role")
    if not title: out({"error": {"message": f"{addr} has no hc name or role label; give a title"}}, 2)
    real("keys", addr, "ctrl+u")
    type_line(addr, f"/rename {title}")
    time.sleep(3)
    new_title = ((jout(real("get", addr)) or {}).get("title") or "").strip()
    ok = title[:30] in new_title
    log({"to": addr, "kind": "title", "text": f"Subject: titled {addr} {title!r}", "ok": ok})
    out({"title": title, "terminal": addr, "applied": ok, "terminal_title": new_title}, 0 if ok else 1)

# ---------------------------------------------------------------- state (agent state files)
STATE_DIR = os.path.expanduser("~/.herdr/state")

def cmd_state(args):
    """hc state <ticket> <role> "<text>"  writes ~/.herdr/state/<ticket>/<role>.md (whole file, <= 60 lines).
    hc state <ticket> <role>             prints it.   hc state --list   lists all state files."""
    if "--list" in args:
        found = []
        for root, _d, files in os.walk(STATE_DIR):
            for f in files:
                if f.endswith(".md"): found.append(os.path.relpath(os.path.join(root, f), STATE_DIR))
        out({"state_files": sorted(found)})
    pos = [a for a in args if not a.startswith("--")]
    if len(pos) < 2: out({"error": {"message": 'usage: hc state <ticket> <role> ["<whole file text>"] | hc state --list'}}, 2)
    ticket, role = pos[0].upper() if pos[0].lower() != "master" else "MASTER", pos[1].lower()
    if not all(c.isalnum() or c in "-_" for c in ticket + role): out({"error": {"message": "ticket and role: letters, digits, - and _ only"}}, 2)
    path = os.path.join(STATE_DIR, ticket, f"{role}.md")
    if len(pos) == 2:
        try: print(open(path).read()); sys.exit(0)
        except FileNotFoundError: out({"error": {"kind": "missing", "message": f"no state file at {path}"}}, 1)
    text = " ".join(pos[2:]).strip()
    lines = text.splitlines()
    if len(lines) > 60: out({"error": {"message": f"state file is {len(lines)} lines; keep it under 60"}}, 2)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f: f.write(text.rstrip() + "\n" + f"\nupdated: {time.strftime('%Y-%m-%d %H:%M')} by {ME or 'shell'}\n")
    os.replace(tmp, path)
    out({"state": path, "lines": len(lines)})

# ---------------------------------------------------------------- one operation at a time
LOCK = os.path.expanduser("~/.herdr/frozen/lock")

def take_lock(what):
    """restart, freeze and unfreeze each move agents around; two at once would relaunch a parked
    agent or exit one mid-relaunch. Refuse if another operation holds the lock and is still alive."""
    try:
        with open(LOCK) as f: pid, held = f.read().split(":", 1)
        try: os.kill(int(pid), 0); alive = True
        except Exception: alive = False
        if alive: out({"error": {"kind": "busy", "message": f"another operation is running ({held.strip()}, pid {pid}); wait for it or stop it"}}, 1)
    except FileNotFoundError:
        pass
    except ValueError:
        pass
    os.makedirs(os.path.dirname(LOCK), exist_ok=True)
    with open(LOCK, "w") as f: f.write(f"{os.getpid()}:{what} by {ME or 'shell'} at {time.strftime('%H:%M:%S')}")
    import atexit; atexit.register(lambda: os.path.exists(LOCK) and os.remove(LOCK))

# ---------------------------------------------------------------- tint (terminal background per program)
TINT_DIR = os.path.expanduser("~/.herdr/tint")

def tty_of(pid):
    r = subprocess.run(["ps", "-o", "tty=", "-p", str(pid)], capture_output=True, text=True)
    t = r.stdout.strip()
    return None if not t or t == "??" else "/dev/" + t

def paint(tty, bg=None, fg=None, palette=None):
    """OSC 11 / 10 set the terminal's default background / foreground (111 / 110 reset); OSC 4 sets
    palette slots (104 resets them), e.g. slot 8 is the "dim" gray most TUIs use."""
    seq = (f"\033]11;{bg}\007" if bg else "\033]111\007") + (f"\033]10;{fg}\007" if fg else "\033]110\007")
    seq += "".join(f"\033]4;{i};{c}\007" for i, c in (palette or {}).items()) if palette else "\033]104\007"
    with open(tty, "w") as f: f.write(seq)

def cmd_tint(args):
    """hc tint --auto [--dry-run]: color every live Claude/Devin terminal by program (colors.json),
    reset terminals whose agent has gone back to a shell. hc tint <t> <bg> [fg] | hc tint <t> --reset."""
    try:
        with open(os.path.join(TINT_DIR, "colors.json")) as f: colors = json.load(f)
    except Exception:
        colors = {"claude": {"bg": "#f3eee4", "fg": "#1f2622"}, "devin": {"bg": "#0f3d2e", "fg": "#e8f0eb"}}
    state_path = os.path.join(TINT_DIR, "state.json")
    try:
        with open(state_path) as f: state = json.load(f)
    except Exception:
        state = {}
    dry = "--dry-run" in args
    pos = [a for a in args if not a.startswith("--")]
    if "--auto" not in args:
        if not pos: out({"error": {"message": "usage: hc tint --auto [--dry-run] | hc tint <t> <bg> [fg] | hc tint <t> --reset"}}, 2)
        addr = resolve(pos[0]); info = jout(real("get", addr)) or {}
        pid = (info.get("foreground") or {}).get("pid") or info.get("pid")
        tty = tty_of(pid) if pid else None
        if not tty: out({"error": {"message": f"{addr}: no tty found"}}, 1)
        if "--reset" in args: paint(tty); state.pop(addr, None)
        else: paint(tty, pos[1] if len(pos) > 1 else None, pos[2] if len(pos) > 2 else None); state[addr] = {"pid": pid, "bg": pos[1] if len(pos) > 1 else None}
        with open(state_path, "w") as f: json.dump(state, f)
        out({"tint": addr, "tty": tty, "reset": "--reset" in args})
    painted, reset = [], []
    live = {}
    for t in terminals():
        if t.get("state") != "live": continue
        info = jout(real("get", t["address"])) or {}
        fg = info.get("foreground") or {}
        prog = ((fg.get("argv") or [""])[0]).rsplit("/", 1)[-1]
        pid = fg.get("pid") or info.get("pid")
        live[t["address"]] = (prog, pid)
        want = colors.get(prog)
        prev = state.get(t["address"])
        if want:
            sig = json.dumps(want, sort_keys=True)
            if prev and prev.get("pid") == pid and prev.get("sig") == sig: continue
            tty = tty_of(pid)
            if not tty: continue
            if not dry: paint(tty, want["bg"], want.get("fg"), want.get("palette")); state[t["address"]] = {"pid": pid, "bg": want["bg"], "sig": sig, "prog": prog}
            painted.append(f"{t['address']} {prog}")
        elif prev:
            # The agent is gone (a shell or something else is in front): back to the theme colors.
            tty = tty_of(pid) if pid else None
            if tty and not dry: paint(tty)
            state.pop(t["address"], None); reset.append(t["address"])
    for addr in [a for a in state if a not in live]: state.pop(addr, None)  # finished terminals
    if not dry:
        with open(state_path, "w") as f: json.dump(state, f)
    out({"tint": "auto", "painted": painted, "reset": reset, "dry_run": dry})

def cmd_frozen(args):
    out(load_frozen())

# ---------------------------------------------------------------- share / unshare / shared
def shared_terminals():
    """Live terminals carrying the share=public label."""
    result = []
    for t in terminals("share=public"):
        if t.get("state") != "live":
            continue
        labels = labels_of(t["address"])
        result.append({
            "address": t["address"],
            "name": t.get("name"),
            "labels": {k: labels.get(k) for k in ("herdr.space", "herdr.tab") if k in labels},
        })
    return result

def cmd_share(args):
    if "--dry-run" not in args: take_lock("share")
    kind, ident, name, dry = scope_from(args, "share")
    sh = load_share(); what = f"{kind[:-1]} {name or ident}"
    label = "herdr.space=" if kind == "spaces" else "herdr.tab="
    targets = [t for t in terminals(label + ident) if t.get("state") == "live"]
    if dry:
        out({"share": what, "dry_run": True, "would_label": [t["address"] for t in targets]})
    sh[kind][ident] = {"name": name, "ts": int(time.time() * 1000), "by": ME}
    save_share(sh)
    labeled = []
    for t in targets:
        a = t["address"]
        r = real("label", a, "share=public")
        if r.returncode == 0:
            labeled.append(a)
        else:
            log({"to": a, "kind": "share", "text": f"Subject: shared {what}", "error": (jout(r) or {}).get("error") or r.stderr.strip()[:80]})
    log({"to": "*", "kind": "share", "scope": what, "text": f"Subject: shared {what}"})
    out({"share": what, "labeled": labeled})

def cmd_unshare(args):
    if "--dry-run" not in args: take_lock("unshare")
    kind, ident, name, dry = scope_from(args, "unshare")
    sh = load_share(); entry = sh[kind].get(ident); what = f"{kind[:-1]} {name or (entry or {}).get('name') or ident}"
    label = "herdr.space=" if kind == "spaces" else "herdr.tab="
    targets = [t for t in terminals(label + ident) if t.get("state") == "live"]
    if dry:
        out({"unshare": what, "dry_run": True, "would_unlabel": [t["address"] for t in targets], "was_shared": entry is not None})
    sh[kind].pop(ident, None); save_share(sh)
    unlabeled = []
    for t in targets:
        a = t["address"]
        r = real("label", a, "share=")
        if r.returncode == 0:
            unlabeled.append(a)
        else:
            log({"to": a, "kind": "unshare", "text": f"Subject: unshared {what}", "error": (jout(r) or {}).get("error") or r.stderr.strip()[:80]})
    log({"to": "*", "kind": "unshare", "scope": what, "text": f"Subject: unshared {what}"})
    out({"unshare": what, "unlabeled": unlabeled})

def cmd_shared(args):
    out({"state": load_share(), "terminals": shared_terminals()})

# ---------------------------------------------------------------- fleet snapshot / revive
# A Herdr restart kills herdr-core with the app on this machine (launchd handshake fails); `keep`
# brings every terminal back as a plain shell with the same address, labels and cwd, and the launch
# argv is overwritten. The snapshot is written while agents are alive; revive rebuilds from it.
FLEET = os.path.expanduser("~/.herdr/fleet")
SNAP = os.path.join(FLEET, "snapshot.json")
SHELLS = {"zsh", "bash", "sh", "fish", "login", "-zsh"}
SERVICES = KIT.get("services") or {}  # kit.json "services": {hc name: command}: plain programs revive brings back

def load_snap():
    try:
        with open(SNAP) as f: return json.load(f)
    except Exception: return {"ts": 0, "agents": {}}

def save_snap(snap):
    os.makedirs(FLEET, exist_ok=True)
    if os.path.exists(SNAP):
        try: os.replace(SNAP, os.path.join(FLEET, "snapshot.prev.json"))
        except Exception: pass
    tmp = SNAP + ".tmp"
    with open(tmp, "w") as f: json.dump(snap, f, indent=1)
    os.replace(tmp, SNAP)

def panes_by_terminal():
    """terminal address -> {pane, tab, space} from the Herdr window (empty if the app is not running)."""
    out_ = {}
    try:
        r = subprocess.run(["herdr-app", "ls"], capture_output=True, text=True, timeout=10)
        d = json.loads(r.stdout or "{}")
        for sp in d.get("spaces", []):
            for tb in sp.get("tabs", []):
                for term in tb.get("terminals", []):
                    out_[term["terminal"]] = {"pane": term.get("pane"), "tab": tb["id"], "space": sp["id"]}
    except Exception: pass
    return out_

def take_snapshot(force=False):
    snap = load_snap(); now = int(time.time())
    if not force and now - int(snap.get("ts") or 0) < 60:
        return {"snapshot": "fresh", "age": now - int(snap.get("ts") or 0), "agents": len(snap.get("agents") or {})}
    agents = dict(snap.get("agents") or {}); panes = panes_by_terminal()
    live = terminals(); live_addrs = {t["address"] for t in live}
    updated, kept = [], []
    for t in live:
        a = t["address"]; info = jout(real("get", a)) or {}
        labels = info.get("labels") or {}; fg = info.get("foreground") or {}
        fgname = (fg.get("argv") or [""])[0].rsplit("/", 1)[-1]
        base = {"terminal": a, "name": t.get("name"), "parent": info.get("parent"), "cwd": fg.get("cwd") or info.get("cwd"),
                "labels": labels, "pane": (panes.get(a) or {}).get("pane"), "ts": now, "pid": fg.get("pid")}
        if t.get("name") in SERVICES:
            running = fgname.lower().startswith("python")
            prev = agents.get(a) or {}
            agents[a] = {**base, "program": "python3", "command": SERVICES[t["name"]], "service": True, "argv": SERVICES[t["name"]].split(),
                         "recreate": False, "running": running}
            updated.append(a); continue
        if not is_agent(t): continue
        prev = agents.get(a)
        # Same process as last time: keep the plan, refresh placement only (saves a devin list per tick).
        if prev and not force and prev.get("pid") == fg.get("pid") and prev.get("program") and fg.get("pid"):
            agents[a] = {**prev, **{k: base[k] for k in ("name", "parent", "labels", "pane", "ts")}}
            kept.append(a); continue
        plan = restart_plan(a)
        if plan.get("skip"):
            if prev: agents[a] = {**prev, "last_seen_shell": now}; kept.append(a)
            continue
        agents[a] = {**plan, **base}
        updated.append(a)
    for a, p in agents.items(): p["live"] = a in live_addrs
    # Terminals that should hold an agent (or a service) but show a shell: what the Revive button offers.
    fz = load_frozen(); needs = []
    for a, p in agents.items():
        if a not in live_addrs or frozen_reason(a, fz): continue
        fgname = foreground_name(a)
        if p.get("service"):
            if not (fgname or "").lower().startswith("python"): needs.append(a)
        elif p.get("program") in ("claude", "devin") and fgname in SHELLS: needs.append(a)
    snap = {"ts": now, "agents": agents, "needs_revive": needs}
    save_snap(snap)
    return {"snapshot": "written", "updated": updated, "kept": kept, "agents": len(agents), "needs_revive": needs}

def cmd_snapshot(args):
    out(take_snapshot("--force" in args))

def revive_note(addr, res):
    target = res.get("new_terminal") or addr
    resumed = res.get("resumed", res.get("restarted"))
    real("send", target, f"Subject: revived at {time.strftime('%H:%M')} after a Herdr restart; resumed={'yes' if resumed else 'NO'}; same name, labels and folder\n\n"
         f"From {sender()} via hc revive. Herdr restarted and your process died with it; this terminal came back as a shell and you were relaunched here"
         f"{' with your conversation.' if resumed else ' COLD: your conversation did not resume. Re-read your labels (hc get $HC_TERMINAL_ID), your ticket and your last report before acting.'} "
         f"Run hc state <ticket> <role> (or ~/.herdr/bin/hc state ...) and read it first. Nothing sent to you between the restart and now was delivered. "
         f"Your instructions are unchanged. Reply only if you need something, Subject first.")

def cmd_revive(args):
    dry = "--dry-run" in args; everyone = "--all" in args; quiet = "--quiet" in args
    scope = None
    for flag in ("--tab", "--space"):
        if flag in args:
            i = args.index(flag); scope = (flag[2:], args[i + 1]); args = args[:i] + args[i + 2:]
    pos = [a for a in args if not a.startswith("--")]
    if not pos and not everyone and not scope:
        out({"error": {"message": "usage: hc revive --all | --space <id> | --tab <id> | <t>... [--dry-run] [--quiet]"}}, 2)
    snap = load_snap(); agents = snap.get("agents") or {}
    if not agents: out({"error": {"message": f"no snapshot at {SNAP}; nothing to revive"}}, 1)
    if not dry: take_lock("revive")
    fz = load_frozen(); live = {t["address"]: t for t in terminals()}
    wanted = [resolve(p) for p in pos] if pos else list(agents)
    results = []
    for a in wanted:
        plan = agents.get(a)
        if not plan: results.append({"terminal": a, "skip": "not in snapshot"}); continue
        labels = plan.get("labels") or {}
        if scope and labels.get("herdr." + scope[0]) != scope[1]: continue
        if a == ME: continue
        if frozen_reason(a, fz): results.append({"terminal": a, "skip": "frozen (parked); unfreeze relaunches it"}); continue
        t = live.get(a)
        fgname = foreground_name(a) if t else None
        want = plan.get("program")
        if t and (fgname == want or (want == "python3" and (fgname or "").lower().startswith("python")) or (t.get("status") and want in ("claude", "devin"))):
            results.append({"terminal": a, "program": want, "skip": "already running"}); continue
        if dry:
            results.append({"terminal": a, "program": want, "would": "relaunch in place" if t and fgname in SHELLS else "recreate" if not t else f"skip: foreground is {fgname}", "session": plan.get("session"), "command": plan.get("command")}); continue
        if t and fgname in SHELLS:
            if plan.get("service"):
                real("keys", a, "ctrl+u"); type_line(a, f"cd {plan.get('cwd') or '~'}"); time.sleep(0.5); type_line(a, plan["command"])
                ok = wait_until(lambda: foreground_name(a).lower().startswith("python"), 15)
                res = {**plan, "restarted": ok}
            else:
                res = relaunch_only(a, {**plan, "recreate": False})
                if res.get("restarted") and not quiet: revive_note(a, res)
        elif not t:
            res = do_recreate(a, {**plan, "recreate": True})
            if res.get("restarted") and not quiet: revive_note(a, res)
        else:
            results.append({"terminal": a, "program": want, "skip": f"foreground is {fgname}, not a shell"}); continue
        results.append({k: res.get(k) for k in ("terminal", "program", "restarted", "resumed", "error", "new_terminal", "session")})
        log({"to": a, "kind": "restart", "text": f"Subject: revived {a} after a Herdr restart\n\n{plan.get('command')}", "ok": bool(res.get("restarted")), "error": res.get("error")})
    if not dry:
        rdir = os.path.expanduser("~/.herdr/restart"); os.makedirs(rdir, exist_ok=True)
        with open(os.path.join(rdir, "last.json"), "w") as f: json.dump({"restart": results, "revive": True}, f, indent=1)
        take_snapshot(force=True)
    out({"revive": results, "dry_run": dry})

# ---------------------------------------------------------------- social (per-space peer visibility + Peers pane)
SOCIAL = os.path.join(os.path.dirname(SHARE), "social.json")

def load_social():
    try:
        with open(SOCIAL) as f: return json.load(f)
    except Exception: return {}

def save_social(d):
    os.makedirs(os.path.dirname(SOCIAL), exist_ok=True)
    tmp = SOCIAL + ".tmp"
    with open(tmp, "w") as f: json.dump(d, f, indent=1)
    os.replace(tmp, SOCIAL)

def app_do(cmd, payload):
    try:
        r = subprocess.run(["herdr-app", "do", cmd, json.dumps(payload)], capture_output=True, text=True, timeout=30)
        return json.loads((r.stdout or "").strip() or "{}")
    except Exception as e:
        return {"error": str(e)[:200]}

def daemon_terminal():
    for t in terminals():
        if t.get("name") == "peerd" and t.get("state") == "live":
            return t
    return None

def daemon_start():
    """The tailnet listener runs only while some space is social. Hidden (no herdr.* labels):
    it is not a pane; the Peers pane shows whether it is listening."""
    if daemon_terminal(): return {"daemon": "running"}
    r = real("run", "--bg", "--outlive-parent", "--no-notify", "--no-parent", "--name", "peerd", "--label", "role=peerd",
             "--json", "--", "/usr/bin/python3", os.path.expanduser("~/.herdr/bin/peer.py"), "serve")
    j = jout(r) or {}
    return {"daemon": "started" if j.get("address") else "failed", "address": j.get("address"), "error": (j.get("error") or (r.stderr.strip()[:120] if r.returncode else None))}

def daemon_stop():
    t = daemon_terminal()
    if not t: return {"daemon": "not running"}
    real("kill", t["address"]); real("rm", t["address"])
    return {"daemon": "stopped", "address": t["address"]}

def cmd_social(args):
    """hc social <space id or name>: toggle. On: terminals get share=public + social=<id> and a Peers pane
    opens in the space. Off: labels removed, pane closed, peers can no longer see or message the space."""
    take_lock("social")
    kind, ident, name, dry = scope_from(args, "social")
    if kind != "spaces":
        out({"error": {"kind": "usage", "message": "hc social takes a space, not a tab"}}, 2)
    sh = load_share(); soc = load_social()
    targets = [t for t in terminals("herdr.space=" + ident) if t.get("state") == "live"]
    turning_on = ident not in sh["spaces"]
    done = []
    if turning_on:
        sh["spaces"][ident] = {"name": name, "ts": int(time.time() * 1000), "by": ME, "social": True}
        save_share(sh)
        for t in targets:
            if real("label", t["address"], "share=public", "social=" + ident).returncode == 0:
                done.append(t["address"])
        pane = app_do("tab.new", {"space": ident, "name": "Peers", "mod": "peer-chat", "props": {"space": ident}})
        if pane.get("tab"):
            soc[ident] = {"tab": pane["tab"], "ts": int(time.time() * 1000)}
            save_social(soc)
        daemon = daemon_start()
        log({"to": "*", "kind": "social", "scope": ident, "text": "Subject: social on " + ident})
        out({"social": "on", "space": ident, "labeled": done, "pane": pane, **daemon})
    else:
        sh["spaces"].pop(ident, None); save_share(sh)
        for t in targets:
            if real("label", t["address"], "share=", "social=").returncode == 0:
                done.append(t["address"])
        closed = None
        if soc.get(ident, {}).get("tab"):
            closed = app_do("tab.close", {"id": soc[ident]["tab"], "confirmed": True})
            soc.pop(ident, None); save_social(soc)
        daemon = daemon_stop() if not sh["spaces"] else {"daemon": "running (other social spaces)"}
        log({"to": "*", "kind": "social", "scope": ident, "text": "Subject: social off " + ident})
        out({"social": "off", "space": ident, "unlabeled": done, "pane_closed": closed, **daemon})

def cmd_inbox(args):
    """hc inbox | hc inbox allow <id> [--to t7] | hc inbox dismiss <id> [--reason ...]"""
    sub = args[0] if args and args[0] in ("allow", "dismiss") else None
    _delegate(PEER_PY, "inbox-" + sub if sub else "inbox", args[1:] if sub else args)

# ---------------------------------------------------------------- peers (delegated to peer.py / intake.py)
PEER_PY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "peer.py")
INTAKE_PY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "intake.py")

def _delegate(script, sub, args):
    os.execv("/usr/bin/python3", ["/usr/bin/python3", script, sub, *args])

def cmd_approve(args): _delegate(PEER_PY, "approve", args)
def cmd_deny(args): _delegate(PEER_PY, "deny", args)
def cmd_requests(args): _delegate(PEER_PY, "requests", args)
def cmd_peer(args):
    """hc peer add <login|ip> [--name N] | hc peer ls | hc peer allow-agent <name> on|off | hc peer daemon start|stop|status"""
    sub = args[0] if args else "ls"
    if sub == "daemon":
        what = args[1] if len(args) > 1 else "status"
        if what == "start": out(daemon_start())
        if what == "stop": out(daemon_stop())
        t = daemon_terminal(); out({"daemon": "running" if t else "not running", "address": (t or {}).get("address")})
    _delegate(PEER_PY, "peer-" + sub if sub in ("add", "ls", "allow-agent") else sub, args[1:])
def cmd_intake(args):
    sub = args[0] if args else "status"
    _delegate(INTAKE_PY, sub, args[1:])

COMMANDS = {"send": cmd_send, "social": cmd_social, "inbox": cmd_inbox, "approve": cmd_approve, "deny": cmd_deny, "requests": cmd_requests, "peer": cmd_peer, "intake": cmd_intake, "blast": cmd_blast, "freeze": cmd_freeze, "unfreeze": cmd_unfreeze, "frozen": cmd_frozen, "restart": cmd_restart, "title": cmd_title, "state": cmd_state, "tint": cmd_tint, "snapshot": cmd_snapshot, "revive": cmd_revive, "share": cmd_share, "unshare": cmd_unshare, "shared": cmd_shared}
if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        out({"error": {"kind": "unknown_command", "message": f"unknown command: {sys.argv[1] if len(sys.argv) > 1 else '(none)'}"}}, 2)
    if sys.argv[1] in PEER_COMMANDS and not KIT.get("peers"):
        out({"error": {"kind": "not_installed", "message": f"hc {sys.argv[1]} is part of the herdr-kit peers add-on; install it with install.sh --with-peers"}}, 2)
    COMMANDS[sys.argv[1]](sys.argv[2:])
