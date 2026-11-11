# herdr-kit

The operating layer for running a fleet of coding agents in [Herdr](https://herdr.dev): a message
Board with Subject lines, freeze and unfreeze for a space or tab, restart of a Claude or Devin in
place with its conversation, snapshot and revive after the app restarts, terminal tinting by
program, per-agent state files, and Changes / Files panels that understand branches and PRs.

Herdr itself is the application. The kit is an `hc` wrapper, six window mods, a layout and one
skill that install over a stock Herdr. It ships no agent templates and no automations: how you
start agents, which roles exist, and what they talk to (tickets, chat, CI) stays yours.

## Let a Claude install it

From nothing (no Herdr yet) to a working window, with checks after each step: clone this repo,
open Claude Code in it, and say

> Read skills/setup-herdr/SKILL.md and follow it.

It asks before downloading anything, never signs into services for you, and reports each step.
To have it available in every session, link it: `ln -s "$PWD/skills/setup-herdr" ~/.claude/skills/`.

## Installation rules

1. **Install Herdr first** (app and core) from [herdr.dev](https://herdr.dev) and open it once so
   `~/.config/herdr-app` exists and `~/.local/bin/hc` is on your PATH. The installer refuses to run
   without them. You also need `git` and `python3` (the macOS ones are fine).
2. **Clone and run the installer from the clone.** Do not copy files by hand.
   ```sh
   git clone https://github.com/rohanwagh01/herdr-kit && cd herdr-kit
   ./install.sh
   ```
   It asks for your first name, writes `~/.herdr/kit.json`, copies the code, renders the skill,
   links it into `~/.claude/skills`, sets the `main-tabs` layout and runs `kit doctor`.
   Non-interactive: `./install.sh --config my-kit.json` (see `kit.example.json`).
3. **Put the wrapper first on PATH** and open a new shell:
   ```sh
   export PATH="$HOME/.herdr/bin:$PATH"
   ```
   `~/.herdr/bin/hc` must shadow `~/.local/bin/hc`; every `hc send`, `blast`, `freeze`, `restart`
   and `revive` goes through the wrapper. `which hc` should print the `~/.herdr/bin` one.
4. **Restart the Herdr window once** after the first install so the mods and layout load. Later
   installs reload mods in place.
5. **Keep the clone.** `~/.herdr/bin/kit` is a copy that reads the repo path from `kit.json`;
   updating is `git pull && ./install.sh --yes` inside the clone.
6. **Edit in the repo, not in `~/.config`.** A file you change by hand under `~/.config/herdr-app`
   or `~/.config/herdr-core` is treated as yours: the next install leaves it alone and writes the new
   version beside it as `.new`. Resolve by taking the `.new` or deleting it.
7. **Agents must be labeled and named** for the operating layer to work: `role=<role>` labels
   (`hc label <t> role=reviewer`), terminal names `<role>-<topic>` (`hc run --name`), Devin
   sessions titled with `hc title`. Label your own operator agent `restart=skip` so "Restart all"
   leaves it alone.
8. **Run `kit doctor` after any Herdr update.** The mods are clones pinned to a Herdr version;
   doctor warns about skew and loads each mod with `herdr-app check`.
9. **No secrets, no logins.** The installer stores nothing but `~/.herdr/kit.json` (your first
   name, the peers flag, `services`) and sends nothing anywhere. Sign in to Herdr, Claude Code,
   the Devin CLI and, for peers, Tailscale yourself before or after; the kit only drives tools that
   are already logged in. Peer identity comes from `tailscale whois`, so no key is kept.
10. **Uninstall is `kit uninstall`.** It removes what it wrote, leaves files you edited, and restores
   anything it replaced from `~/.herdr/kit-backup`.

The kit never touches `~/.herdr/state`, `~/.herdr/messages`, `frozen`, `fleet`, your own templates
in `~/.config/herdr-core/templates`, or anything under `~/.claude` except the one skill symlink.

## What goes where

| Kit folder | Installed to | Notes |
|---|---|---|
| `bin/hc`, `bin/hc_ext.py`, `bin/kit` | `~/.herdr/bin/` | `hc` wraps `~/.local/bin/hc` |
| `mods/*` | `~/.config/herdr-app/mods/<name>/` | clones of shipped mods, pinned by `cloned_from` |
| `layouts/main-tabs.json` | `~/.config/herdr-app/layouts/` | the window layout; set as current |
| `skills/herdr/SKILL.md.tmpl` | `~/.config/herdr-core/skills/herdr/SKILL.md` + symlink in `~/.claude/skills` | rendered with your name |
| `tint/colors.json` | `~/.herdr/tint/` | colors for `hc tint --auto` |
| `peers/` | same places | only with `--with-peers`; work in progress |

`~/.herdr/kit-manifest.json` records every file the kit wrote and its hash. That is how install
tells your edits from its own files, and how uninstall knows what to remove.

## What you get

- **`hc` wrapper**: `send` logged to the Board, with `--hold` for frozen recipients and bare
  acknowledgements dropped; `blast` to every agent (Devin skipped unless `--include-devin`);
  `freeze` / `unfreeze` / `frozen` for a space or tab (agents are parked and relaunched with their
  conversation); `restart` (quit and resume a Claude or Devin in place); `snapshot` every minute and
  `revive` after a Herdr restart; `state <topic> <role> "<text>"` for per-agent state files under
  `~/.herdr/state`; `title` for Devin session names; `tint --auto`.
- **Window**: tabs bar with Restart all / Restart tab / Revive, sidebar with freeze marks, context
  menu with Freeze / Unfreeze, Board panel (This tab / All / Blasts), Changes panel (vs origin/main,
  uncommitted, per commit, per open PR) and Files panel (branch-wide change marks, File / File +
  diff / Diff view, changes-only filter) with GitHub syntax colors.
- **`herdr` skill**: how agents message each other (Subject first), name themselves, keep state
  files, and behave around blasts, freezes and restarts.

## Peers add-on (work in progress)

`./install.sh --with-peers` adds `hc social`, `hc inbox`, `hc peer`, `hc intake` and `hc share`:
other people's Herdr cores reach yours over Tailscale through a policy filter, with an intake
agent that routes their requests. It came out of a hackathon and is not finished: expect rough
edges, missing checks and changes to the commands. Requires Tailscale.app and an org email domain
in `kit.json` (`org_domain`), which every connecting login must match. Leave it off unless you are
working on it.

## Configuration

`~/.herdr/kit.json` holds your name, the peers flag, your org's email domain (peers only) and
`services`, a map of hc terminal names to commands that `hc revive` should bring back after a
Herdr restart. See `kit.example.json`. After editing it, run `kit install` again to re-render.

## License

Apache License 2.0, see `LICENSE`. Six mods are modified copies of mods shipped with Herdr, which
is Apache-2.0 as well; `NOTICE` lists them with the version each was copied from, and each file
carries a change notice. Herdr is a trademark of its owners; this kit is not published or endorsed
by them.
