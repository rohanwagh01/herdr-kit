#!/usr/bin/env python3
"""Herdr peer daemon: let other people's herdr-cores reach this one over the tailnet,
through a policy filter.

  peer.py serve [--bind IP] [--port 7477] [--session NAME] [--dev-local LOGIN]
      Listen on the tailnet IP. Each connection is identified with `tailscale whois`,
      then proxied to a local `hc connect` with only allowed methods forwarded.
  peer.py dial HOST[:PORT] [SHELL-LINE]
      The `--via` transport for `hc machine add`: relays stdin/stdout to a peer daemon.

Wire protocol (learned from herdr-core 0.1.19): newline-delimited JSON-RPC 2.0 until a
`hello` with framed:true is answered, then frames: u32le channel, u8 kind, u32le length,
payload. Channel 0 / kind 0 carries JSON-RPC; other channels carry stream data (events,
attach); kind 1 is flow-control credit. Only channel-0 JSON-RPC requests are inspected.
"""
import argparse
import json
import os
import re
import socket
import struct
import subprocess
import sys
import threading
import time
import uuid

HOME = os.path.expanduser("~")
REAL_HC = os.path.join(HOME, ".local", "bin", "hc")
TAILSCALE = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
PEER_DIR = os.path.join(HOME, ".herdr", "peer")
PEERS = os.path.join(PEER_DIR, "peers.json")
POLICY = os.path.join(PEER_DIR, "policy.json")
INTAKE_DIR = os.path.join(HOME, ".herdr", "intake")
REQUESTS = os.path.join(INTAKE_DIR, "requests.jsonl")
RECEIPTS = os.path.join(INTAKE_DIR, "receipts.jsonl")
INBOX = os.path.join(INTAKE_DIR, "inbox.jsonl")


def inbox_path(session=None):
    """One inbox per core: the default core uses inbox.jsonl, a named session its own file."""
    session = session or os.environ.get("HC_SESSION")
    return os.path.join(INTAKE_DIR, "inbox.%s.jsonl" % session) if session else INBOX
MSG_LOG = os.path.join(HOME, ".herdr", "messages", "log.jsonl")
def _kit():
    try:
        with open(os.path.join(HOME, ".herdr", "kit.json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}
KIT = _kit()
OWNER = KIT.get("owner") or "the owner"
ORG_DOMAIN = KIT.get("org_domain") or "@example.com"  # tailnet logins must end with this to connect
DEFAULT_PORT = 7477
HDR = struct.Struct("<IBI")  # channel, kind, length
DEBUG = bool(os.environ.get("PEER_DEBUG"))
SHELL_LINE_RE = re.compile(r"herdr-core.*\bconnect\b|\bhc connect\b|^web$")
OUTBOX_DIR = os.path.join(PEER_DIR, "outbox")

DEFAULT_POLICY = {
    "auto_register": True,
    "allow": ["hello", "rpc.discover", "server.status", "templates.list",
              "terminal.list", "events.subscribe",
              "terminal.get", "terminal.read", "terminal.wait", "terminal.send", "doc.get"],
    "queue": ["terminal.run", "terminal.attach", "terminal.keys", "terminal.put",
              "file.write", "file.edit"],
    "deny": ["server.stop", "server.restart", "terminal.kill", "terminal.rm", "terminal.keep",
             "terminal.label", "terminal.interrupt", "machine.add", "machine.rm", "machine.rename",
             "machine.connect", "machine.list", "machine.exec", "doc.set", "file.read"],
    "terminal_scoped": ["terminal.get", "terminal.read", "terminal.wait", "terminal.send"],
    "auto_approve": [],
}


# ----------------------------------------------------------------- small helpers
def now_ms():
    return int(time.time() * 1000)


def append_jsonl(path, rec):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save_json(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, indent=1, sort_keys=True)
        f.write("\n")
    os.replace(tmp, path)


def log(msg):
    sys.stderr.write("%s %s\n" % (time.strftime("%H:%M:%S"), msg))
    sys.stderr.flush()


def tailscale_ip():
    out = subprocess.run([TAILSCALE, "ip", "-4"], capture_output=True, text=True, timeout=10)
    ip = out.stdout.strip().splitlines()
    if out.returncode != 0 or not ip:
        raise SystemExit("cannot get the tailnet IP: %s" % (out.stderr.strip() or "tailscale ip -4 failed"))
    return ip[0]


def whois(ip):
    out = subprocess.run([TAILSCALE, "whois", "--json", ip], capture_output=True, text=True, timeout=10)
    if out.returncode != 0:
        return None
    try:
        return json.loads(out.stdout).get("UserProfile", {}).get("LoginName")
    except ValueError:
        return None


def peer_name_for(login):
    local = login.split("@", 1)[0]
    return re.sub(r"[^a-z0-9_-]", "-", local.split(".", 1)[0].lower())[:32] or "peer"


# ----------------------------------------------------------------- terminal cache
class TerminalCache:
    """Labels of this core's terminals, refreshed from `hc ls` at most every 2 s."""

    def __init__(self, session):
        self.session = session
        self.lock = threading.Lock()
        self.at = 0.0
        self.by_addr = {}
        self.by_name = {}

    def env(self):
        env = dict(os.environ)
        if self.session:
            env["HC_SESSION"] = self.session
        return env

    def refresh(self):
        with self.lock:
            if time.monotonic() - self.at < 2.0:
                return
            try:
                # `hc ls --json` is a summary without labels; ask the API for full records.
                req = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "terminal.list", "params": {}}) + "\n"
                out = subprocess.run([REAL_HC, "connect"], input=req, capture_output=True, text=True,
                                     timeout=15, env=self.env())
                data = json.loads(out.stdout.splitlines()[0]).get("result", {})
            except (OSError, ValueError, IndexError, subprocess.TimeoutExpired):
                return
            by_addr, by_name = {}, {}
            for t in data.get("terminals", []):
                by_addr[t["address"]] = t
                if t.get("name"):
                    by_name[t["name"]] = t
            self.by_addr, self.by_name, self.at = by_addr, by_name, time.monotonic()

    def lookup(self, ref):
        if not isinstance(ref, str):
            return None
        ref = ref.rsplit("/", 1)[-1]
        self.refresh()
        return self.by_addr.get(ref) or self.by_name.get(ref)

    def intake(self):
        self.refresh()
        for t in self.by_addr.values():
            if t.get("labels", {}).get("intake") == "1":
                return t
        return None


# ----------------------------------------------------------------- policy
class Policy:
    def __init__(self, cache, peer, login):
        self.cache = cache
        self.peer = peer
        self.login = login
        self.rules = dict(DEFAULT_POLICY)
        self.rules.update(load_json(POLICY, {}))

    def receipt(self, method, terminal, decision, request_id=None, note=None):
        rec = {"ts": now_ms(), "peer": self.peer, "login": self.login, "method": method,
               "terminal": terminal, "decision": decision}
        if request_id:
            rec["request_id"] = request_id
        if note:
            rec["note"] = note
        append_jsonl(RECEIPTS, rec)

    def is_public(self, t):
        labels = t.get("labels", {})
        return labels.get("share") == "public" or labels.get("intake") == "1"

    def queue(self, method, params, kind):
        rid = uuid.uuid4().hex[:8]
        append_jsonl(REQUESTS, {"id": rid, "ts": now_ms(), "from": self.peer, "peer_login": self.login,
                                "kind": kind, "method": method, "params": params, "status": "pending"})
        intake = self.cache.intake()
        if intake:
            detail = json.dumps(params, ensure_ascii=False)[:600]
            text = ("Subject: REQUEST %s from %s (id %s)\n\nPeer %s (%s) asked for %s, which needs %s's approval. "
                    "Params: %s\n\nAsk %s. On yes: hc approve %s. On no: hc deny %s." %
                    (kind, self.peer, rid, self.peer, self.login, method, OWNER, detail, OWNER, rid, rid))
            subprocess.Popen([REAL_HC, "send", intake["address"], text], env=self.cache.env(),
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return rid

    def decide(self, req):
        """Returns ('forward', req) or ('reply', response_dict)."""
        method = req.get("method")
        params = req.get("params") or {}
        rid = req.get("id")
        terminal = params.get("terminal") if isinstance(params, dict) else None

        def error(code, message, data=None):
            err = {"code": code, "message": message}
            if data:
                err["data"] = data
            return "reply", {"jsonrpc": "2.0", "id": rid, "error": err}

        if method == "peer.whoami":
            self.receipt(method, None, "allow")
            return "reply", {"jsonrpc": "2.0", "id": rid, "result": {"peer": self.peer, "login": self.login}}
        if method == "peer.poll":
            since = int(params.get("since") or 0)
            rows = []
            try:
                with open(os.path.join(OUTBOX_DIR, self.peer + ".jsonl"), encoding="utf-8") as f:
                    for line in f:
                        try:
                            r = json.loads(line)
                        except ValueError:
                            continue
                        if r.get("ts", 0) > since:
                            rows.append(r)
            except OSError:
                pass
            self.receipt(method, None, "allow", note="%d rows" % len(rows))
            return "reply", {"jsonrpc": "2.0", "id": rid, "result": {"messages": rows[-200:]}}
        if method == "hello":
            params["calls_you"] = self.peer
            req["params"] = params
            self.receipt(method, None, "allow")
            return "forward", req

        if method in ("terminal.list", "events.subscribe"):
            labels = dict(params.get("labels") or {})
            labels["share"] = "public"
            params["labels"] = labels
            req["params"] = params
            self.receipt(method, None, "allow", note="filtered to share=public")
            return "forward", req

        if method == "doc.get":
            # The app layout document would reveal private space names: answer empty.
            self.receipt(method, None, "masked")
            return "reply", {"jsonrpc": "2.0", "id": rid, "result": {"value": None, "version": 0}}

        if method in self.rules["deny"]:
            self.receipt(method, terminal, "deny")
            return error(-32002, "not allowed for peers")

        if method in self.rules["terminal_scoped"]:
            t = self.cache.lookup(terminal)
            if t is None:
                self.receipt(method, terminal, "deny", note="unknown terminal")
                return error(-32002, "no such shared terminal")
            if not self.is_public(t):
                if method == "terminal.send":
                    qid = self.queue(method, params, "send")
                    self.receipt(method, terminal, "queued", qid)
                    return error(-32001, "needs owner approval", {"request_id": qid})
                self.receipt(method, terminal, "deny", note="not public")
                return error(-32002, "no such shared terminal")
            if method == "terminal.send":
                # A peer's text is never typed into an agent by itself. kind=chat is for the person
                # and only shows in the conversation; kind=agent waits for the owner's Allow unless the
                # peer is marked auto_agent, in which case it goes to the space's default agent now.
                raw = params.get("text", "")
                kind, raw = pop_kind(raw)
                text = self.tag_inbound(raw)
                caller = "%s/%s" % (self.peer, params.get("caller") or "peer")
                subject, body = split_subject(text)
                mid = uuid.uuid4().hex[:8]
                space = t.get("labels", {}).get("herdr.space")
                auto = bool((load_json(PEERS, {}).get(self.peer) or {}).get("auto_agent"))
                status = "chat" if kind == "chat" else ("auto" if auto else "queued")
                append_jsonl(inbox_path(self.cache.session),
                             {"id": mid, "ts": now_ms(), "from": self.peer, "peer_login": self.login, "caller": caller,
                              "to": t["address"], "space": space, "kind": kind, "subject": subject, "body": body,
                              "text": text, "status": status})
                append_jsonl(MSG_LOG, {"ts": now_ms(), "from": caller, "to": t["address"], "text": text,
                                       "dir": "in", "peer": self.peer, "from_user": self.login, "kind": kind,
                                       "space": space, "inbox": mid, "status": status})
                if status == "auto":
                    threading.Thread(target=auto_deliver, args=(mid, space, t["address"], text, self.cache.session),
                                     daemon=True).start()
                self.receipt(method, t["address"], "inbox-" + status, mid)
                return "reply", {"jsonrpc": "2.0", "id": rid,
                                 "result": {"started": None, "status": status, "turn": 0}}
            self.receipt(method, t["address"], "allow")
            return "forward", req

        if method in self.rules["queue"]:
            qid = self.queue(method, params, method.split(".")[-1])
            self.receipt(method, terminal, "queued", qid)
            return error(-32001, "needs owner approval", {"request_id": qid})

        if method in self.rules["allow"]:
            self.receipt(method, terminal, "allow")
            return "forward", req

        self.receipt(method, terminal, "deny", note="not in policy")
        return error(-32002, "not allowed for peers")

    def tag_inbound(self, text):
        text = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", str(text))
        text = re.sub(r"<(\s*/?\s*hc\b)", r"<\1", text)  # keep but do not let it look like our own tags
        text = re.sub(r"<\s*hc\b", "< hc", text, flags=re.I)
        m = re.match(r"\s*subject\s*:\s*", text, re.I)
        tag = "[%s] " % self.peer
        if m:
            return text[:m.end()] + tag + text[m.end():]
        return "Subject: %smessage\n\n%s" % (tag, text)


# ----------------------------------------------------------------- proxy connection
class Session:
    def __init__(self, conn, peer, login, cache, initial=b""):
        self.conn = conn
        self.initial = initial
        self.peer = peer
        self.login = login
        self.cache = cache
        self.policy = Policy(cache, peer, login)
        self.framed = threading.Event()
        self.framed_hello_id = None
        self.lock = threading.Lock()  # serializes writes toward the dialer
        self.child = None

    # -- writes
    def to_dialer(self, data):
        with self.lock:
            self.conn.sendall(data)

    def to_core(self, data):
        self.child.stdin.write(data)
        self.child.stdin.flush()

    def reply(self, obj):
        payload = (json.dumps(obj, separators=(",", ":")) + "\n").encode()
        if self.framed.is_set():
            self.to_dialer(HDR.pack(0, 0, len(payload)) + payload)
        else:
            self.to_dialer(payload)

    # -- request handling (one JSON-RPC message)
    def handle_request(self, raw):
        try:
            req = json.loads(raw)
        except ValueError:
            self.policy.receipt("?", None, "deny", note="unparseable")
            return None
        if not isinstance(req, dict) or "method" not in req:
            return raw  # a response or notification from the dialer: pass through
        if req.get("method") == "hello" and (req.get("params") or {}).get("framed"):
            self.framed_hello_id = req.get("id")
        verdict, obj = self.policy.decide(req)
        if DEBUG:
            log("%s: %s -> %s" % (self.peer, req.get("method"), verdict))
        if verdict == "reply":
            self.reply(obj)
            return None
        return (json.dumps(obj, separators=(",", ":")) + "\n").encode()

    # -- dialer -> core
    def pump_in(self):
        buf = self.initial
        src = self.conn
        try:
            while True:
                if not self.framed.is_set():
                    nl = buf.find(b"\n")
                    if nl < 0:
                        chunk = src.recv(65536)
                        if not chunk:
                            break
                        buf += chunk
                        continue
                    line, buf = buf[:nl + 1], buf[nl + 1:]
                    out = self.handle_request(line)
                    if out:
                        self.to_core(out)
                    continue
                if len(buf) < HDR.size:
                    chunk = src.recv(65536)
                    if not chunk:
                        break
                    buf += chunk
                    continue
                channel, kind, length = HDR.unpack_from(buf, 0)
                if len(buf) < HDR.size + length:
                    chunk = src.recv(65536)
                    if not chunk:
                        break
                    buf += chunk
                    continue
                payload, buf = buf[HDR.size:HDR.size + length], buf[HDR.size + length:]
                if channel == 0 and kind == 0:
                    out = self.handle_request(payload)
                    if out:
                        self.to_core(HDR.pack(0, 0, len(out)) + out)
                else:
                    self.to_core(HDR.pack(channel, kind, length) + payload)
        except (OSError, ValueError) as exc:
            log("%s: inbound ended: %s" % (self.peer, exc))
        finally:
            try:
                self.child.stdin.close()
            except OSError:
                pass

    # -- core -> dialer
    def pump_out(self):
        buf = b""
        src = self.child.stdout
        try:
            while True:
                if not self.framed.is_set():
                    nl = buf.find(b"\n")
                    if nl < 0:
                        chunk = src.read1(65536)
                        if not chunk:
                            break
                        buf += chunk
                        continue
                    line, buf = buf[:nl + 1], buf[nl + 1:]
                    self.to_dialer(line)
                    if self.framed_hello_id is not None:
                        try:
                            msg = json.loads(line)
                            if msg.get("id") == self.framed_hello_id and (msg.get("result") or {}).get("framed"):
                                self.framed.set()
                                log("%s: framed mode" % self.peer)
                        except ValueError:
                            pass
                    continue
                chunk = src.read1(65536)
                if not chunk:
                    break
                self.to_dialer(chunk)  # frames from the core pass through unchanged
        except OSError as exc:
            log("%s: outbound ended: %s" % (self.peer, exc))
        finally:
            try:
                self.conn.shutdown(socket.SHUT_WR)
            except OSError:
                pass

    def run(self, shell_line):
        env = self.cache.env()
        self.child = subprocess.Popen([REAL_HC, "connect"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                      stderr=subprocess.DEVNULL, env=env)
        self.policy.receipt("connect", None, "allow", note=shell_line[:120])
        t_out = threading.Thread(target=self.pump_out, daemon=True)
        t_out.start()
        self.pump_in()
        try:
            self.child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.child.kill()
        t_out.join(timeout=5)
        try:
            self.conn.close()
        except OSError:
            pass
        log("%s: connection closed" % self.peer)


# ----------------------------------------------------------------- serve
def recv_line(conn, limit=65536):
    """First line and whatever else already arrived (the dialer's hello may share the packet)."""
    buf = b""
    while b"\n" not in buf:
        chunk = conn.recv(4096)
        if not chunk:
            return None, b""
        buf += chunk
        if len(buf) > limit:
            return None, b""
    line, rest = buf.split(b"\n", 1)
    return line, rest


def identify(ip, args):
    if ip in ("127.0.0.1", "::1") and args.dev_local:
        return args.dev_local
    if ip.startswith("100.") or ip.startswith("fd7a:"):
        return whois(ip)
    return None


def my_login():
    try:
        ip = subprocess.run([TAILSCALE, "ip", "-4"], capture_output=True, text=True, timeout=10).stdout.strip()
        return whois(ip)
    except (OSError, subprocess.TimeoutExpired):
        return None


def register_peer(login, ip, policy_rules):
    peers = load_json(PEERS, {})
    if login == my_login():
        # Our own login dialing in (a local test from the web page): keep it as a peer named
        # "self" so replies can be routed to it, flagged so the pane shows it as "you".
        if "self" not in peers:
            peers["self"] = {"login": login, "ip": ip, "port": DEFAULT_PORT, "added": now_ms(), "auto": True, "self": True}
            save_json(PEERS, peers)
        return "self"
    for name, p in peers.items():
        if p.get("login") == login:
            if p.get("ip") != ip:
                p["ip"] = ip
                save_json(PEERS, peers)
            return name
    if not policy_rules.get("auto_register", True):
        return None
    name = peer_name_for(login)
    base, n = name, 2
    while name in peers:
        name = "%s%d" % (base, n)
        n += 1
    peers[name] = {"login": login, "ip": ip, "port": DEFAULT_PORT, "added": now_ms(), "auto": True}
    save_json(PEERS, peers)
    log("registered new peer %s (%s)" % (name, login))
    return name


def dial_back(name, ip, port, session):
    """Add the dialing peer as a machine here, so routing works both ways."""
    env = dict(os.environ)
    if session:
        env["HC_SESSION"] = session
    via = "python3 %s dial %s:%d" % (os.path.abspath(__file__), ip, port)
    out = subprocess.run([REAL_HC, "machine", "add", "--via", via, "--name", name, "--json"],
                         capture_output=True, text=True, timeout=60, env=env)
    log("dial-back to %s: %s" % (name, (out.stdout or out.stderr).strip()[:160]))


def handle_connection(conn, addr, args, cache):
    ip = addr[0]
    login = identify(ip, args)
    if not login or not login.endswith(ORG_DOMAIN):
        append_jsonl(RECEIPTS, {"ts": now_ms(), "ip": ip, "login": login, "decision": "refused",
                                "note": "unknown identity"})
        log("refused %s (%s)" % (ip, login))
        conn.close()
        return
    rules = dict(DEFAULT_POLICY)
    rules.update(load_json(POLICY, {}))
    peer = register_peer(login, ip, rules)
    if not peer:
        append_jsonl(RECEIPTS, {"ts": now_ms(), "ip": ip, "login": login, "decision": "refused",
                                "note": "not a registered peer"})
        conn.close()
        return
    first, rest = recv_line(conn)
    try:
        shell_line = json.loads(first or b"{}").get("line", "")
    except ValueError:
        shell_line = ""
    if not SHELL_LINE_RE.search(shell_line or ""):
        append_jsonl(RECEIPTS, {"ts": now_ms(), "peer": peer, "login": login, "decision": "refused",
                                "note": "unexpected shell line: %r" % (shell_line or "")[:200]})
        log("%s: refused shell line %r" % (peer, (shell_line or "")[:80]))
        conn.close()
        return
    log("%s (%s) connected from %s%s" % (peer, login, ip, " [web]" if shell_line == "web" else ""))
    if shell_line == "web":
        peers = load_json(PEERS, {})
        if peer in peers and peers[peer].get("kind") != "web":
            peers[peer]["kind"] = "web"
            save_json(PEERS, peers)
    if not args.no_dialback and ip not in ("127.0.0.1", "::1") and shell_line != "web":
        known = subprocess.run([REAL_HC, "machine", "ls", "--json"], capture_output=True, text=True,
                               timeout=20, env=cache.env())
        if ('"name":"%s"' % peer) not in known.stdout.replace(" ", ""):
            threading.Thread(target=dial_back, args=(peer, ip, args.port, args.session), daemon=True).start()
    Session(conn, peer, login, cache, rest).run(shell_line)


def cmd_serve(args):
    os.makedirs(PEER_DIR, exist_ok=True)
    os.makedirs(INTAKE_DIR, exist_ok=True)
    if not os.path.exists(POLICY):
        save_json(POLICY, DEFAULT_POLICY)
    bind = args.bind or tailscale_ip()
    cache = TerminalCache(args.session)
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((bind, args.port))
    srv.listen(16)
    log("peer daemon listening on %s:%d (hc session: %s)" % (bind, args.port, args.session or "default"))
    try:
        while True:
            conn, addr = srv.accept()
            threading.Thread(target=handle_connection, args=(conn, addr, args, cache), daemon=True).start()
    except KeyboardInterrupt:
        log("stopped")


# ----------------------------------------------------------------- dial
def cmd_dial(args):
    host, _, port = args.target.partition(":")
    port = int(port or DEFAULT_PORT)
    shell_line = args.rest[-1] if args.rest else "hc connect"
    s = socket.create_connection((host, port), timeout=15)
    s.settimeout(None)
    s.sendall((json.dumps({"line": shell_line}) + "\n").encode())

    def stdin_to_sock():
        try:
            while True:
                b = os.read(0, 65536)
                if not b:
                    break
                s.sendall(b)
        except OSError:
            pass
        finally:
            try:
                s.shutdown(socket.SHUT_WR)
            except OSError:
                pass

    t = threading.Thread(target=stdin_to_sock, daemon=True)
    t.start()
    try:
        while True:
            b = s.recv(65536)
            if not b:
                break
            os.write(1, b)
    except OSError:
        pass
    finally:
        try:
            s.close()
        except OSError:
            pass


# ----------------------------------------------------------------- approve / deny
def rpc_once(obj, session=None):
    env = dict(os.environ)
    if session:
        env["HC_SESSION"] = session
    out = subprocess.run([REAL_HC, "connect"], input=json.dumps(obj) + "\n", capture_output=True,
                         text=True, timeout=120, env=env)
    for line in out.stdout.splitlines():
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if msg.get("id") == obj.get("id"):
            return msg
    return {"error": {"message": (out.stderr or "no reply").strip()[:300]}}


def load_requests():
    rows = []
    try:
        with open(REQUESTS, encoding="utf-8") as f:
            for line in f:
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    pass
    except OSError:
        pass
    return rows


def set_request_status(rid, status, result=None):
    """Append a status row; readers take the last row per id."""
    rec = {"id": rid, "ts": now_ms(), "status": status}
    if result is not None:
        rec["result"] = result
    append_jsonl(REQUESTS, rec)


def latest_requests():
    latest = {}
    for r in load_requests():
        cur = latest.get(r["id"], {})
        cur.update(r)
        latest[r["id"]] = cur
    return latest


def notify_requester(req, text, session=None):
    """Tell the peer what happened: their intake if we can reach them, else nothing."""
    peer = req.get("from")
    if not peer:
        return
    env = dict(os.environ)
    if session:
        env["HC_SESSION"] = session
    subprocess.run([REAL_HC, "send", "%s/intake" % peer, text], capture_output=True, text=True,
                   timeout=30, env=env)


def cmd_approve(args):
    reqs = latest_requests()
    req = reqs.get(args.id)
    if not req:
        print(json.dumps({"error": "unknown request %s" % args.id}))
        return 1
    if req.get("status") != "pending":
        print(json.dumps({"error": "request %s is %s" % (args.id, req.get("status"))}))
        return 1
    params = dict(req.get("params") or {})
    params.pop("caller", None)
    if req.get("method") == "terminal.run":
        labels = dict(params.get("labels") or {})
        labels["share"] = "public"
        labels["peer.request"] = args.id
        labels["peer.from"] = req.get("from", "")
        params["labels"] = labels
        params["no_parent"] = True
        params["outlive_parent"] = True
        params.pop("wait", None)
    resp = rpc_once({"jsonrpc": "2.0", "id": 1, "method": req["method"], "params": params}, args.session)
    ok = "result" in resp
    set_request_status(args.id, "done" if ok else "failed", resp.get("result") or resp.get("error"))
    append_jsonl(RECEIPTS, {"ts": now_ms(), "peer": req.get("from"), "method": req.get("method"),
                            "decision": "approved", "request_id": args.id, "ok": ok})
    summary = json.dumps(resp.get("result") or resp.get("error"), ensure_ascii=False)[:400]
    notify_requester(req, "Subject: your request %s was %s\n\n%s %s" %
                     (args.id, "run" if ok else "attempted but failed", req.get("method"), summary), args.session)
    print(json.dumps({"approved": args.id, "ok": ok, "method": req.get("method"), "result": resp.get("result") or resp.get("error")}, ensure_ascii=False))
    return 0 if ok else 1


def cmd_deny(args):
    reqs = latest_requests()
    req = reqs.get(args.id)
    if not req or req.get("status") != "pending":
        print(json.dumps({"error": "no pending request %s" % args.id}))
        return 1
    set_request_status(args.id, "denied", args.reason)
    append_jsonl(RECEIPTS, {"ts": now_ms(), "peer": req.get("from"), "method": req.get("method"),
                            "decision": "denied", "request_id": args.id})
    notify_requester(req, "Subject: your request %s was denied\n\n%s" % (args.id, args.reason or "No reason given."), args.session)
    print(json.dumps({"denied": args.id}))
    return 0


def cmd_requests(args):
    rows = [r for r in latest_requests().values() if args.all or r.get("status") == "pending"]
    rows.sort(key=lambda r: r.get("ts", 0), reverse=True)
    for r in rows:
        print(json.dumps({k: r.get(k) for k in ("id", "status", "from", "kind", "method", "ts")}))
    return 0


KIND_RE = re.compile(r"^[ \t]*herdr-kind[ \t]*:[ \t]*(chat|agent)[ \t]*\n?", re.I | re.M)


def pop_kind(text):
    """Read and remove the 'Herdr-Kind: chat|agent' header. No header means agent (a raw hc
    send from an agent without the wrapper), so nothing bypasses approval by omission."""
    m = KIND_RE.search(text or "")
    if not m:
        return "agent", text
    return m.group(1).lower(), text[:m.start()] + text[m.end():]


def auto_deliver(mid, space, fallback, text, session):
    """A peer marked auto_agent: deliver to the space's first-created agent right away."""
    try:
        agents = space_agents(space, session) if space else []
        target = agents[0]["address"] if agents else fallback
        env = dict(os.environ)
        if session:
            env["HC_SESSION"] = session
        out = subprocess.run([REAL_HC, "send", target, text], capture_output=True, text=True, timeout=120, env=env)
        ok = out.returncode == 0
        append_jsonl(inbox_path(session), {"id": mid, "ts": now_ms(), "status": "delivered" if ok else "failed",
                                           "delivered_to": target, "auto": True,
                                           "result": (out.stdout or out.stderr).strip()[:200]})
    except Exception as exc:  # never take the daemon down over one delivery
        append_jsonl(inbox_path(session), {"id": mid, "ts": now_ms(), "status": "failed", "result": str(exc)[:200]})


def split_subject(text):
    m = re.match(r"\s*subject\s*:\s*(.*?)(?:\n[ \t]*\n|\n|$)", text, re.I | re.S)
    if m:
        subject = re.sub(r"\s+", " ", m.group(1)).strip()
        body = text[m.end():].strip()
        return subject, body
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    return (lines[0][:120] if lines else "(no subject)"), text.strip()


# ----------------------------------------------------------------- inbox
def latest_inbox(session=None):
    latest = {}
    try:
        with open(inbox_path(session), encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if not r.get("id"):
                    continue
                cur = latest.get(r["id"], {})
                cur.update(r)
                latest[r["id"]] = cur
    except OSError:
        pass
    return latest


def space_agents(space, session=None):
    """This core's agent terminals in a space, oldest first."""
    cache = TerminalCache(session)
    cache.refresh()
    out = []
    for t in cache.by_addr.values():
        if t.get("labels", {}).get("herdr.space") != space:
            continue
        fg = (t.get("foreground") or {}).get("name") or ""
        if t.get("status") or fg in ("claude", "devin", "codex", "pi", "node"):
            out.append(t)
    out.sort(key=lambda t: t.get("created_ms", 0))
    return out


def cmd_inbox(args):
    rows = [r for r in latest_inbox(getattr(args, "session", None)).values() if args.all or r.get("status") == "queued"]
    rows.sort(key=lambda r: r.get("ts", 0), reverse=True)
    for r in rows:
        print(json.dumps({k: r.get(k) for k in ("id", "status", "from", "to", "space", "subject", "ts", "delivered_to")},
                         ensure_ascii=False))
    return 0


def cmd_inbox_allow(args):
    msg = latest_inbox(args.session).get(args.id)
    if not msg or msg.get("status") != "queued":
        print(json.dumps({"error": "no queued message %s" % args.id}))
        return 1
    target = args.to
    if not target:
        agents = space_agents(msg.get("space"), args.session) if msg.get("space") else []
        target = agents[0]["address"] if agents else msg.get("to")
    env = dict(os.environ)
    if args.session:
        env["HC_SESSION"] = args.session
    out = subprocess.run([REAL_HC, "send", target, msg.get("text", "")], capture_output=True, text=True,
                         timeout=120, env=env)
    ok = out.returncode == 0
    append_jsonl(inbox_path(args.session), {"id": args.id, "ts": now_ms(), "status": "delivered" if ok else "failed",
                         "delivered_to": target, "result": (out.stdout or out.stderr).strip()[:300]})
    append_jsonl(RECEIPTS, {"ts": now_ms(), "peer": msg.get("from"), "method": "inbox.allow",
                            "terminal": target, "decision": "delivered" if ok else "failed", "request_id": args.id})
    print(json.dumps({"delivered": ok, "id": args.id, "to": target, "hc": (out.stdout or out.stderr).strip()[:200]}))
    return 0 if ok else 1


def cmd_inbox_dismiss(args):
    msg = latest_inbox(getattr(args, "session", None)).get(args.id)
    if not msg or msg.get("status") != "queued":
        print(json.dumps({"error": "no queued message %s" % args.id}))
        return 1
    append_jsonl(inbox_path(getattr(args, "session", None)), {"id": args.id, "ts": now_ms(), "status": "dismissed", "reason": args.reason})
    append_jsonl(RECEIPTS, {"ts": now_ms(), "peer": msg.get("from"), "method": "inbox.dismiss",
                            "terminal": msg.get("to"), "decision": "dismissed", "request_id": args.id})
    print(json.dumps({"dismissed": args.id}))
    return 0


# ----------------------------------------------------------------- peer add / ls
def resolve_tailnet(target):
    """A login, a tailnet hostname, or an IP -> (ip, login)."""
    if re.match(r"^\d+\.\d+\.\d+\.\d+$", target):
        return target, whois(target)
    out = subprocess.run([TAILSCALE, "status", "--json"], capture_output=True, text=True, timeout=15)
    st = json.loads(out.stdout)
    users = {str(k): v.get("LoginName") for k, v in (st.get("User") or {}).items()}
    for p in (st.get("Peer") or {}).values():
        login = users.get(str(p.get("UserID")))
        host = (p.get("HostName") or "").lower()
        dns = (p.get("DNSName") or "").lower().rstrip(".")
        if target.lower() in (login or "", host, dns, dns.split(".")[0]) or \
           (login and "@" not in target and login.split("@")[0] == target.lower()):
            ips = p.get("TailscaleIPs") or []
            if ips and p.get("Online", True):
                return ips[0], login
    return None, None


def cmd_peer_add(args):
    ip, login = resolve_tailnet(args.target)
    if not ip:
        print(json.dumps({"error": "no online tailnet device for %r" % args.target}))
        return 1
    name = args.name or (peer_name_for(login) if login else args.target)
    peers = load_json(PEERS, {})
    peers[name] = {"login": login, "ip": ip, "port": args.port, "added": now_ms(), "auto": False}
    save_json(PEERS, peers)
    env = dict(os.environ)
    if args.session:
        env["HC_SESSION"] = args.session
    via = "python3 %s dial %s:%d" % (os.path.abspath(__file__), ip, args.port)
    out = subprocess.run([REAL_HC, "machine", "add", "--via", via, "--name", name, "--json"],
                         capture_output=True, text=True, timeout=90, env=env)
    print(json.dumps({"peer": name, "login": login, "ip": ip, "machine": (out.stdout or out.stderr).strip()[:300]}))
    return out.returncode


def cmd_peer_allow_agent(args):
    peers = load_json(PEERS, {})
    if args.name not in peers:
        print(json.dumps({"error": "unknown peer %s" % args.name}))
        return 1
    on = args.state != "off"
    peers[args.name]["auto_agent"] = on
    save_json(PEERS, peers)
    append_jsonl(RECEIPTS, {"ts": now_ms(), "peer": args.name, "method": "peer.auto_agent", "decision": "on" if on else "off"})
    print(json.dumps({"peer": args.name, "auto_agent": on}))
    return 0


def cmd_peer_ls(args):
    peers = load_json(PEERS, {})
    out = subprocess.run([REAL_HC, "machine", "ls", "--json"], capture_output=True, text=True, timeout=20)
    states = {}
    try:
        for m in json.loads(out.stdout).get("machines", []):
            states[m["name"]] = m.get("state")
    except ValueError:
        pass
    for name, p in sorted(peers.items()):
        print(json.dumps({"peer": name, "login": p.get("login"), "ip": p.get("ip"), "auto_agent": bool(p.get("auto_agent")), "machine": states.get(name, "not added")}))
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve", help="listen for peers")
    s.add_argument("--bind", help="IP to listen on (default: the tailnet IPv4)")
    s.add_argument("--port", type=int, default=DEFAULT_PORT)
    s.add_argument("--session", help="HC_SESSION of the core to expose (default: the default core)")
    s.add_argument("--dev-local", help="treat loopback connections as this login (local testing only)")
    s.add_argument("--no-dialback", action="store_true", help="do not add dialing peers as machines here")
    s.set_defaults(fn=cmd_serve)
    for name, fn in (("approve", cmd_approve), ("deny", cmd_deny)):
        a = sub.add_parser(name, help="%s a held peer request" % name)
        a.add_argument("id")
        a.add_argument("--reason", default="")
        a.add_argument("--session")
        a.set_defaults(fn=fn)
    pa = sub.add_parser("peer-add", help="register a peer and add it as an hc machine")
    pa.add_argument("target", help="login, tailnet hostname, or IP")
    pa.add_argument("--name")
    pa.add_argument("--port", type=int, default=DEFAULT_PORT)
    pa.add_argument("--session")
    pa.set_defaults(fn=cmd_peer_add)
    paa = sub.add_parser("peer-allow-agent", help="deliver a peer's agent messages to your default agent without Allow")
    paa.add_argument("name")
    paa.add_argument("state", nargs="?", default="on", choices=["on", "off"])
    paa.set_defaults(fn=cmd_peer_allow_agent)
    pl = sub.add_parser("peer-ls", help="list peers")
    pl.set_defaults(fn=cmd_peer_ls)
    ib = sub.add_parser("inbox", help="queued peer messages")
    ib.add_argument("--all", action="store_true")
    ib.add_argument("--session")
    ib.set_defaults(fn=cmd_inbox)
    ia = sub.add_parser("inbox-allow", help="deliver a queued message to one of your agents")
    ia.add_argument("id")
    ia.add_argument("--to", help="terminal to deliver to (default: the space's first agent)")
    ia.add_argument("--session")
    ia.set_defaults(fn=cmd_inbox_allow)
    idm = sub.add_parser("inbox-dismiss", help="drop a queued message")
    idm.add_argument("id")
    idm.add_argument("--reason", default="")
    idm.add_argument("--session")
    idm.set_defaults(fn=cmd_inbox_dismiss)
    r = sub.add_parser("requests", help="list held requests")
    r.add_argument("--all", action="store_true")
    r.set_defaults(fn=cmd_requests)
    d = sub.add_parser("dial", help="--via transport: relay to a peer daemon")
    d.add_argument("target", help="HOST[:PORT]")
    d.add_argument("rest", nargs="*", help="shell line appended by hc")
    d.set_defaults(fn=cmd_dial)
    args = p.parse_args(argv)
    rc = args.fn(args)
    sys.exit(rc or 0)


if __name__ == "__main__":
    main()
