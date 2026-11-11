#!/bin/sh
# herdr-kit installer. Installs over a stock Herdr; never touches agent state.
#   ./install.sh [--with-peers] [--config kit.json] [--yes] [--dry-run]
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
KIT="$HERE/bin/kit"
CONFIG=""; YES=""; EXTRA=""
while [ $# -gt 0 ]; do
  case "$1" in
    --config) CONFIG="$2"; shift ;;
    --yes) YES="--yes" ;;
    --with-peers) EXTRA="$EXTRA $1"; echo "note: the peers add-on is work in progress (see README)" ;;
    --dry-run|--skip-preflight) EXTRA="$EXTRA $1" ;;
    -h|--help) sed -n 2,4p "$0"; exit 0 ;;
    *) echo "install.sh: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

command -v python3 >/dev/null 2>&1 || { echo "install.sh: python3 is required" >&2; exit 1; }
PY=$(command -v python3)
HOME_DIR="${KIT_HOME:-$HOME}"

# Core is a hard requirement: hc must be the real one at ~/.local/bin/hc for the wrapper to wrap.
if [ ! -x "$HOME_DIR/.local/bin/hc" ]; then
  echo "install.sh: herdr-core's hc is not at $HOME_DIR/.local/bin/hc; install Herdr first (https://herdr.dev)" >&2
  exit 1
fi

if [ -n "$CONFIG" ]; then
  "$PY" "$KIT" init --config "$CONFIG"
elif [ -f "$HOME_DIR/.herdr/kit.json" ] && [ -n "$YES" ]; then
  :
else
  "$PY" "$KIT" init $YES
fi

# shellcheck disable=SC2086
"$PY" "$KIT" install $EXTRA

cat <<EOF

Installed. Open a new shell so $HOME_DIR/.herdr/bin/hc (the wrapper) is first on PATH, then
restart the Herdr window once so the mods and the main-tabs layout load. \`kit doctor\` checks it.
EOF
