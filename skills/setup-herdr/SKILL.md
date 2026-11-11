---
name: setup-herdr
description: Install Herdr (app and core) on a Mac and then herdr-kit on top of it, step by step, with checks after each step. Use when someone asks to set up Herdr, install the herdr kit, or get their machine ready to run a fleet of coding agents. Walks a fresh machine from nothing to a working Herdr window with the kit's Board, freeze, restart and revive.
---

# Set up Herdr and herdr-kit on this Mac

You are installing two things for the person in front of you: **Herdr** (the desktop app plus
herdr-core, the small server that keeps terminals alive) and **herdr-kit** (an `hc` wrapper, six
window mods, a layout and a skill that add fleet management on top). Everything lands in the
person's home folder. Nothing needs `sudo`.

## Rules for you

- **Ask before you download or install software.** Show the exact command, say what it fetches
  and from where, and wait for a yes. The person may prefer the `.dmg`.
- **Never do a login for them.** Herdr needs no account. Claude Code, the Devin CLI, `gh` and
  Tailscale are theirs to sign into; you only check whether each is present.
- **Edit nothing under `~/.config/herdr-app/mods` or `~/.config/herdr-core` by hand.** The kit
  owns those files; the installer is the only way they change.
- **One step at a time, verify, then report** in a line or two. If a check fails, stop and show
  the output rather than guessing a fix.
- **Do not run `install.sh` with `--with-peers`.** The peers add-on is work in progress.

## 0. Before anything

```sh
sw_vers -productVersion; uname -m
herdr-app --version 2>/dev/null; hc --version 2>/dev/null; ls /Applications/Herdr.app 2>/dev/null | head -1
command -v git python3 claude devin gh
```

- `uname -m` must print `arm64`. Herdr for macOS is Apple silicon only; stop if it is `x86_64`.
- If `herdr-app` and `hc` already print versions, skip to step 3.
- `git` and `python3` are required (the ones macOS ships are fine). `claude`, `devin` and `gh`
  are optional: note which are missing and tell the person what they lose (step 7).

## 1. Install the Herdr app

Two ways; let the person choose.

- **Download:** `https://releases.herdr.dev/app/Herdr.dmg`, drag Herdr to Applications.
- **Terminal:**
  ```sh
  curl -fsSL https://releases.herdr.dev/app/install.sh | sh
  ```
  This installs the app and sets up herdr-core if it is not there. The app updates itself later.

Then open it once so it finishes setting up the core and creates its config folder:

```sh
open -a Herdr
sleep 5
ls ~/.config/herdr-app/AGENTS.md ~/.local/bin/hc ~/.local/bin/herdr-app
```

All three paths must exist. If `~/.local/bin/hc` is missing after the app has been open for a
minute, install the core on its own (ask first):

```sh
curl -fsSL https://releases.herdr.dev/core/install.sh | sh
```

## 2. Put Herdr's commands on PATH

```sh
grep -n '\.local/bin' ~/.zshrc ~/.zprofile 2>/dev/null
```

If nothing matches, ask, then append to `~/.zshrc`:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Check from a fresh login shell, since your current shell will not see the change:

```sh
zsh -lic 'command -v hc herdr-app && hc server status --json | head -c 200'
```

`hc server status` printing JSON with a `version` means the core is running.

## 3. Get herdr-kit

The repo is `rohanwagh01/herdr-kit` on GitHub. If this skill file is already inside a clone, use
that clone. Otherwise (the repo may be private, so go through `gh` if they have it):

```sh
gh repo clone rohanwagh01/herdr-kit ~/herdr-kit || git clone https://github.com/rohanwagh01/herdr-kit ~/herdr-kit
```

Read `~/herdr-kit/README.md`, section "Installation rules", before continuing.

## 4. Install the kit

Ask the person for their first name (it appears in notices agents receive) and write a config:

```sh
cat > /tmp/kit.json <<'EOF'
{"owner": "THEIR_NAME", "org_domain": "@example.com", "services": {}, "peers": false}
EOF
cd ~/herdr-kit && ./install.sh --config /tmp/kit.json
```

Expected: a list of files written under `~/.herdr/bin`, `~/.config/herdr-app/mods`,
`~/.config/herdr-app/layouts`, `~/.config/herdr-core/skills/herdr`, `~/.herdr/tint`, then
`doctor: ok (6 mods, herdr skill, hc wrapper)`. Warnings about a mod being "cloned from ... app is
..." are normal when Herdr is newer than the kit; doctor's `herdr-app check` run is what matters.
If the installer stops at "missing tools", fix step 0 or 1 first.

## 5. Put the wrapper first on PATH

The kit's `hc` must shadow Herdr's. Ask, then append to `~/.zshrc` **after** the line from step 2:

```sh
export PATH="$HOME/.herdr/bin:$PATH"
```

Verify:

```sh
zsh -lic 'command -v hc'
```

Must print `/Users/<them>/.herdr/bin/hc`. If it prints `~/.local/bin/hc`, the order of the two
export lines is wrong.

## 6. Restart the window and check

Quit and reopen Herdr so the mods and the `main-tabs` layout load:

```sh
osascript -e 'quit app "Herdr"'; sleep 3; open -a Herdr; sleep 8
herdr-app status
~/.herdr/bin/kit doctor
```

`herdr-app status` must list no errors. Then look at the window with the person:

- Sidebar on the left with Spaces and Agents; tab bar on top with a **Restart all** button.
- Right panel toggles for **Files**, **Changes** and **Board** (the Board may be empty).
- Right-click a space in the sidebar: a **Freeze** item.

A quick functional check without starting any agent:

```sh
~/.herdr/bin/hc blast --dry-run "hello"      # lists recipients (none yet) instead of sending
~/.herdr/bin/hc snapshot --force              # writes ~/.herdr/fleet/snapshot.json
~/.herdr/bin/hc frozen                        # empty freeze state
```

Each prints JSON without an `error` key.

## 7. Agents

Herdr starts agents from the **+** in the tab bar; it lists the ones it finds on PATH. Tell the
person which of these they have and what the kit does with each:

- **Claude Code** (`claude`): the kit's `herdr` skill is linked into `~/.claude/skills`, so every
  Claude started in Herdr knows how to message other agents, name itself and keep a state file.
  `hc restart` and `hc revive` resume Claude conversations.
- **Devin CLI** (`devin`): `hc title` names sessions; restart and revive resume them by name.
- **`gh`**: the Changes panel boxes commits by open pull request; without `gh` it still shows
  commits and the diff.

Conventions agents need, from the README: label each agent (`hc label <t> role=<role>`), name it
`<role>-<topic>` at spawn (`hc run --bg --name ...`), and label the person's own helper agent
`restart=skip` so **Restart all** leaves it alone.

## 8. Hand over

Tell the person, in a few lines: what was installed and where, the two PATH lines added, that
`cd ~/herdr-kit && git pull && ./install.sh --yes` updates, that `~/.herdr/bin/kit doctor` checks
after a Herdr update, and that `~/.herdr/bin/kit uninstall` removes the kit and restores what it
replaced. Their agent state lives under `~/.herdr/state` and is never touched by the kit.

## If something fails

- **`install.sh: herdr-core's hc is not at ~/.local/bin/hc`**: Herdr has not set up the core.
  Open the app, wait, re-check; otherwise the core installer in step 1.
- **doctor: `herdr-app check <mod>` reports an error**: the kit's mod clone does not match this
  Herdr version. Report the error text and stop; do not edit the mod.
- **`herdr-app status` shows errors after restart**: paste them to the person; `kit uninstall`
  returns the window to stock Herdr.
- **Permission prompts from Claude Code while running these steps**: expected for `curl | sh` and
  for appending to `~/.zshrc`; the person approves each.
