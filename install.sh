#!/usr/bin/env bash
# hookbus-publisher-amp v0.2.2 - one-shot installer.
#
# Drops the HookBus TypeScript plugin to ~/.config/amp/plugins/hookbus.ts,
# writes a per-publisher config file at ~/.config/amp/plugins/hookbus.env
# (mode 600, contains the bus token), and installs launcher wrappers so both
# `amp` and `amp-hookbus` start Amp with the HookBus plugin enabled.
#
# This installer NEVER writes to shell profiles. Per the 20 April 2026
# HookBus contamination incident: exporting HOOKBUS_URL / HOOKBUS_TOKEN /
# HOOKBUS_SOURCE to ~/.bashrc leaks into every other publisher on the host
# (Cursor, Claude Code, Hermes), mislabels their events and clobbers their
# bus URLs. Environment for this publisher lives in the config file above.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/plugin/hookbus.ts"
PLUGIN_DIR="$HOME/.config/amp/plugins"
PLUGIN_DST="$PLUGIN_DIR/hookbus.ts"
ENV_FILE="$PLUGIN_DIR/hookbus.env"
BIN_DIR="$HOME/.local/bin"
WRAPPER="$BIN_DIR/amp-hookbus"
AMP_SHIM="$BIN_DIR/amp"

say()  { printf "\033[1;32m[amp-publisher]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[amp-publisher]\033[0m %s\n" "$*"; }
die()  { printf "\033[1;31m[amp-publisher] error:\033[0m %s\n" "$*"; exit 1; }
ask()  { local p="$1"; local d="${2:-n}"; printf "\033[1;36m[amp-publisher]\033[0m %s [%s]: " "$p" "$d"; read -r r; r="${r:-$d}"; [[ "$r" =~ ^[Yy]$ ]]; }

[ -f "$SRC" ] || die "Source plugin not found at $SRC. Run this from the repo root."

# 1. Plugin file.
mkdir -p "$PLUGIN_DIR"
install -Dm644 "$SRC" "$PLUGIN_DST"
say "installed plugin to $PLUGIN_DST"

# 2. Per-publisher env file (NOT ~/.bashrc). Reinstalls preserve the token
#    already on disk unless the caller exports HOOKBUS_TOKEN in the invoking
#    shell. Mode 600 because it contains the bus bearer token.
BUS_URL="${HOOKBUS_URL:-http://localhost:18800/event}"
FAIL_MODE="${HOOKBUS_FAIL_MODE:-open}"
SOURCE_LABEL="${HOOKBUS_SOURCE:-amp}"
if [ -n "${HOOKBUS_TOKEN:-}" ]; then
    TOKEN="$HOOKBUS_TOKEN"
elif [ -f "$ENV_FILE" ] && grep -q '^HOOKBUS_TOKEN=' "$ENV_FILE"; then
    TOKEN="$(grep '^HOOKBUS_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
    say "re-using existing HOOKBUS_TOKEN from $ENV_FILE"
else
    TOKEN=""
    warn "HOOKBUS_TOKEN not set. Authenticated buses will reject events."
    warn "Fetch with:  docker exec hookbus cat /root/.hookbus/.token"
    warn "Then rerun: HOOKBUS_TOKEN=<token> bash install.sh"
fi

TMP_ENV=$(mktemp "$PLUGIN_DIR/.hookbus.env.XXXXXX")
trap 'rm -f "$TMP_ENV"' EXIT
chmod 600 "$TMP_ENV"
{
    echo "# hookbus-publisher-amp config. Mode 600. Read by the plugin at startup."
    echo "# Do not source this in your shell, it is scoped to amp only."
    echo "HOOKBUS_URL=$BUS_URL"
    echo "HOOKBUS_TOKEN=$TOKEN"
    echo "HOOKBUS_SOURCE=$SOURCE_LABEL"
    echo "HOOKBUS_FAIL_MODE=$FAIL_MODE"
} > "$TMP_ENV"
mv "$TMP_ENV" "$ENV_FILE"
trap - EXIT
chmod 600 "$ENV_FILE"
say "wrote per-publisher config to $ENV_FILE (mode 600)"

# 3. Launcher wrappers. Users can type the normal `amp` command and get
#    PLUGINS=all applied for that invocation only. We also keep amp-hookbus
#    as an explicit launcher for users who do not put ~/.local/bin first.
mkdir -p "$BIN_DIR"
cat > "$WRAPPER" <<'WRAPPER_EOF'
#!/usr/bin/env bash
# amp-hookbus: amp launcher with HookBus plugin enabled.
# PLUGINS=all is scoped to this invocation only, never exported to the shell.
set -eu
SELF="$(readlink -f "$0" 2>/dev/null || printf "%s" "$0")"
REAL_AMP=""
OLD_IFS="$IFS"; IFS=:
for dir in $PATH; do
    candidate="$dir/amp"
    [ -x "$candidate" ] || continue
    real_candidate="$(readlink -f "$candidate" 2>/dev/null || printf "%s" "$candidate")"
    [ "$real_candidate" = "$SELF" ] && continue
    REAL_AMP="$candidate"
    break
done
IFS="$OLD_IFS"
if [ -z "$REAL_AMP" ]; then
    echo "amp-hookbus: error: real 'amp' binary not found on PATH" >&2
    exit 127
fi
export PLUGINS=all
exec "$REAL_AMP" "$@"
WRAPPER_EOF
chmod 755 "$WRAPPER"
say "installed launcher at $WRAPPER"

if [ -e "$AMP_SHIM" ] && ! grep -q "HookBus-managed amp shim" "$AMP_SHIM" 2>/dev/null; then
    warn "$AMP_SHIM already exists and is not HookBus-managed; leaving normal 'amp' unchanged."
    warn "Use amp-hookbus, or move ~/.local/bin before the real amp and rerun after removing the conflicting file."
else
    cat > "$AMP_SHIM" <<'AMP_SHIM_EOF'
#!/usr/bin/env bash
# HookBus-managed amp shim. Runs the real amp with the HookBus plugin enabled.
set -eu
SELF="$(readlink -f "$0" 2>/dev/null || printf "%s" "$0")"
REAL_AMP=""
OLD_IFS="$IFS"; IFS=:
for dir in $PATH; do
    candidate="$dir/amp"
    [ -x "$candidate" ] || continue
    real_candidate="$(readlink -f "$candidate" 2>/dev/null || printf "%s" "$candidate")"
    [ "$real_candidate" = "$SELF" ] && continue
    REAL_AMP="$candidate"
    break
done
IFS="$OLD_IFS"
if [ -z "$REAL_AMP" ]; then
    echo "amp: error: real amp binary not found on PATH" >&2
    exit 127
fi
export PLUGINS=all
exec "$REAL_AMP" "$@"
AMP_SHIM_EOF
    chmod 755 "$AMP_SHIM"
    say "installed normal-command shim at $AMP_SHIM"
fi

# 4. Bun check (amp plugin runtime).
if command -v bun >/dev/null 2>&1; then
    say "bun already installed ($(bun --version))"
else
    warn "Bun runtime not found. Amp's plugin API requires Bun to execute TypeScript plugins."
    if ask "install Bun now via bun.sh/install?" "y"; then
        curl -fsSL https://bun.sh/install | bash
        export PATH="$HOME/.bun/bin:$PATH"
        if command -v bun >/dev/null 2>&1; then
            say "bun installed at $(command -v bun)"
        else
            warn "Bun install finished but 'bun' still not on PATH. Restart your shell."
        fi
    else
        warn "Skipping bun install. Install manually before launching amp-hookbus."
    fi
fi

# 5. Detect and warn on legacy bashrc pollution from v0.2.1 and earlier.
BASHRC="$HOME/.bashrc"
if [ -f "$BASHRC" ] && grep -qE '^export HOOKBUS_(URL|TOKEN|SOURCE)=|^export PLUGINS=all' "$BASHRC"; then
    warn "Legacy HOOKBUS_* / PLUGINS=all exports detected in $BASHRC."
    warn "These were written by earlier versions of this installer and now"
    warn "contaminate OTHER publishers on this host. Remove them manually:"
    warn "    sed -i.bak '/^export HOOKBUS_\\(URL\\|TOKEN\\|SOURCE\\)=/d; /^export PLUGINS=all/d; /^# HookBus/d' $BASHRC"
    warn "or run:   bash $SCRIPT_DIR/install.sh --clean-bashrc"
fi

# 6. Optional cleanup flag.
if [ "${1:-}" = "--clean-bashrc" ] && [ -f "$BASHRC" ]; then
    cp "$BASHRC" "$BASHRC.bak.$(date +%s)"
    sed -i '/^export HOOKBUS_\(URL\|TOKEN\|SOURCE\)=/d; /^export PLUGINS=all/d; /^# HookBus/d' "$BASHRC"
    say "scrubbed HOOKBUS / PLUGINS exports from $BASHRC (backup kept)"
fi

# 7. Summary.
cat <<EOF

-----------------------------------------------------------------
Done. Launch amp with the HookBus plugin enabled:

  amp                  (normal command, when ~/.local/bin is first on PATH)
  amp-hookbus          (explicit wrapper)

The HookBus config lives at:

  $ENV_FILE

and is read by the plugin at startup. It is NOT in your shell profile.

Event coverage (5 of 5 lifecycle events):

  session.start  -> SessionStart
  agent.start    -> UserPromptSubmit  (can inject context)
  tool.call      -> PreToolUse        (can allow / deny / modify)
  tool.result    -> PostToolUse
  agent.end      -> Stop

Fetch / rotate the bus token:
  docker exec hookbus cat /root/.hookbus/.token
  HOOKBUS_TOKEN=<new> bash install.sh
EOF
