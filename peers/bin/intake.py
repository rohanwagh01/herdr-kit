#!/usr/bin/env python3
"""Intake space for Herdr peers.

  intake.py init [--session S] [--owner NAME]   create the Intake space (tab with the peer-chat
                                                mod) and start the intake agent in it
  intake.py status                              show the space, the agent, pending requests
  intake.py log '<json>'                        append one receipt (used by the intake agent)
"""
import argparse
import json
import os
import subprocess
import sys
import time

HOME = os.path.expanduser("~")
REAL_HC = os.path.join(HOME, ".local", "bin", "hc")
HERDR_APP = "herdr-app"
TAILSCALE = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
INTAKE_DIR = os.path.join(HOME, ".herdr", "intake")
SPACE_FILE = os.path.join(INTAKE_DIR, "space.json")
RECEIPTS = os.path.join(INTAKE_DIR, "receipts.jsonl")
REQUESTS = os.path.join(INTAKE_DIR, "requests.jsonl")
PEERS = os.path.join(HOME, ".herdr", "peer", "peers.json")
MOD = "peer-chat"


def jload(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def jsave(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, indent=1)
        f.write("\n")
    os.replace(tmp, path)


def run(argv, env=None, timeout=60):
    out = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, env=env)
    text = (out.stdout or "").strip() or (out.stderr or "").strip()
    for candidate in (text, text.splitlines()[-1] if text else "{}"):
        try:
            return out.returncode, json.loads(candidate)
        except ValueError:
            continue
    return out.returncode, {"raw": text[:500]}


def my_login():
    try:
        ip = subprocess.run([TAILSCALE, "ip", "-4"], capture_output=True, text=True, timeout=10).stdout.strip()
        who = subprocess.run([TAILSCALE, "whois", "--json", ip], capture_output=True, text=True, timeout=10).stdout
        return json.loads(who).get("UserProfile", {}).get("LoginName") or os.environ.get("USER", "owner")
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return os.environ.get("USER", "owner")


def app_terminals_by_space(space_id):
    code, data = run([HERDR_APP, "ls", "--json"])
    found = []
    for sp in (data.get("spaces") or []) if isinstance(data, dict) else []:
        if sp.get("id") == space_id:
            for tab in sp.get("tabs") or []:
                for pane in tab.get("panes") or []:
                    if pane.get("terminal"):
                        found.append((tab.get("id"), pane.get("terminal")))
    return found


def cmd_init(args):
    env = dict(os.environ)
    if args.session:
        env["HC_SESSION"] = args.session
    state = jload(SPACE_FILE, {})
    owner = args.owner or my_login()
    peers = jload(PEERS, {})

    if not state.get("space"):
        code, res = run([HERDR_APP, "do", "space.new", json.dumps({"name": "Intake", "folder": HOME})])
        if code != 0 or not isinstance(res, dict) or not res.get("space"):
            print(json.dumps({"error": "space.new failed", "detail": res}))
            return 1
        state = {"space": res.get("space"), "first_tab": res.get("tab"), "first_terminal": res.get("terminal"),
                 "created": int(time.time() * 1000)}
        jsave(SPACE_FILE, state)
        # a tab whose only pane is the peer-chat mod
        code, res2 = run([HERDR_APP, "do", "tab.new", json.dumps({"space": state["space"], "name": "Peers", "mod": MOD})])
        state["mod_tab"] = res2.get("tab") if isinstance(res2, dict) else None
        jsave(SPACE_FILE, state)

    if not state.get("agent"):
        tab = state.get("first_tab")
        brief = (
            "OWNER: %s\nINTAKE_SPACE: %s\nPEERS: %s\n"
            "Label yourself now: hc label $HC_TERMINAL_ID role=intake. Then write your state line and say you are ready."
            % (owner, state["space"], ", ".join("%s (%s)" % (n, p.get("login")) for n, p in sorted(peers.items())) or "none yet")
        )
        argv = [REAL_HC, "run", "--bg", "--json", "--name", "intake", "--outlive-parent", "--no-notify",
                "--label", "intake=1", "--label", "share=public", "--label", "role=intake",
                "--label", "herdr.space=%s" % state["space"]]
        if tab:
            argv += ["--label", "herdr.tab=%s" % tab]
        argv += ["--cwd", args.cwd or HOME, "intake", brief]
        code, res = run(argv, env=env, timeout=120)
        if code != 0 or not isinstance(res, dict) or not res.get("address"):
            print(json.dumps({"error": "could not start the intake agent", "detail": res}))
            return 1
        state["agent"] = res["address"]
        state["agent_started"] = int(time.time() * 1000)
        jsave(SPACE_FILE, state)
        # the space's first terminal is a plain shell Herdr created; leave it (owner's scratch shell)

    print(json.dumps({"intake": state, "owner": owner}))
    return 0


def cmd_status(args):
    state = jload(SPACE_FILE, {})
    code, agent = run([REAL_HC, "get", state.get("agent", "intake"), "--json"]) if state.get("agent") else (1, {})
    pending = []
    latest = {}
    try:
        with open(REQUESTS, encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                cur = latest.get(r["id"], {})
                cur.update(r)
                latest[r["id"]] = cur
    except OSError:
        pass
    pending = [r for r in latest.values() if r.get("status") == "pending"]
    print(json.dumps({"space": state, "agent": {k: agent.get(k) for k in ("address", "state", "status", "name")} if isinstance(agent, dict) else None,
                      "pending_requests": len(pending)}))
    return 0


def cmd_log(args):
    try:
        rec = json.loads(args.json)
    except ValueError:
        rec = {"note": args.json}
    rec.setdefault("ts", int(time.time() * 1000))
    rec.setdefault("by", os.environ.get("HC_TERMINAL_ID", "intake"))
    os.makedirs(INTAKE_DIR, exist_ok=True)
    with open(RECEIPTS, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    print(json.dumps({"logged": True}))
    return 0


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    i = sub.add_parser("init")
    i.add_argument("--session")
    i.add_argument("--owner")
    i.add_argument("--cwd", help="folder the intake agent starts in (use one Claude already trusts)")
    i.set_defaults(fn=cmd_init)
    s = sub.add_parser("status")
    s.set_defaults(fn=cmd_status)
    l = sub.add_parser("log")
    l.add_argument("json")
    l.set_defaults(fn=cmd_log)
    args = p.parse_args()
    sys.exit(args.fn(args) or 0)


if __name__ == "__main__":
    main()
