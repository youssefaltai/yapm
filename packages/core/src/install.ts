/** Where the hub serves the runner package; the web build puts it there (see apps/web). */
export const RUNNER_PACKAGE_PATH = "/downloads/life-os-runner.tgz";

/**
 * The one-line installer: `curl -fsSL <hub>/install.sh | sh -s -- --token lms_…`.
 *
 * Installs the runner from this hub into ~/.life-os-runner (with its own Node.js when the
 * machine has none new enough, so nothing needs sudo), connects it to this hub, signs in to
 * Claude if needed and runs it in the background at login (launchd on macOS, systemd on
 * Linux). Run again without a token to update.
 */
export function installScript(hub: string): string {
  return SCRIPT.replaceAll("__HUB__", hub).replace("__PACKAGE__", `${hub}${RUNNER_PACKAGE_PATH}`);
}

const SCRIPT = `#!/bin/sh
# Keep this file ASCII: macOS sh (bash 3.2) reads bytes after "$VAR" as part of its name.
# Life OS runner installer. Usage:
#   curl -fsSL __HUB__/install.sh | sh -s -- --token <setup token> [--name "My laptop"] [--tags a,b]
# Run it again without a token to update a machine that is already connected.
set -eu

HUB="__HUB__"
PACKAGE="__PACKAGE__"
NODE_MAJOR=22
HOME_DIR="\${LIFE_OS_RUNNER_HOME:-$HOME/.life-os-runner}"
TOKEN=""
NAME=""
TAGS=""
NO_SERVICE=""

say() { printf '\\033[1m%s\\033[0m\\n' "$*"; }
fail() { printf 'Error: %s\\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="\${2:-}"; shift 2 ;;
    --name) NAME="\${2:-}"; shift 2 ;;
    --tags) TAGS="\${2:-}"; shift 2 ;;
    --no-service) NO_SERVICE=1; shift ;;
    -h|--help) echo "Usage: install.sh --token <setup token> [--name <name>] [--tags a,b] [--no-service]"; exit 0 ;;
    *) fail "Unknown option $1" ;;
  esac
done

case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) fail "The runner installs on macOS and Linux (on Windows, use WSL)." ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) fail "Unsupported processor: $(uname -m)" ;;
esac
command -v curl >/dev/null 2>&1 || fail "curl is needed."
mkdir -p "$HOME_DIR"

# Node.js: the machine's own if it is new enough, otherwise a private copy for the runner.
NODE=""
if command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "$major" -ge "$NODE_MAJOR" ] && command -v npm >/dev/null 2>&1; then
    NODE=$(command -v node)
    NPM=$(command -v npm)
  fi
fi
if [ -z "$NODE" ]; then
  NODE_DIR="$HOME_DIR/node"
  if [ ! -x "$NODE_DIR/bin/node" ]; then
    say "Downloading Node.js \${NODE_MAJOR} for the runner..."
    base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
    file=$(curl -fsSL "$base/SHASUMS256.txt" | awk '{print $2}' | grep -E "^node-v[0-9.]+-$OS-$ARCH\\.tar\\.gz$" | head -n 1)
    [ -n "$file" ] || fail "No Node.js $NODE_MAJOR build for $OS-$ARCH."
    sum=$(curl -fsSL "$base/SHASUMS256.txt" | grep " $file\\$" | awk '{print $1}')
    tmp=$(mktemp -d)
    curl -fsSL "$base/$file" -o "$tmp/$file"
    if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$tmp/$file" | awk '{print $1}');
    else got=$(shasum -a 256 "$tmp/$file" | awk '{print $1}'); fi
    [ "$got" = "$sum" ] || fail "The Node.js download didn't match its checksum."
    rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
    tar -xzf "$tmp/$file" -C "$NODE_DIR" --strip-components 1
    rm -rf "$tmp"
  fi
  NODE="$NODE_DIR/bin/node"
  NPM="$NODE_DIR/bin/npm"
  PATH="$NODE_DIR/bin:$PATH"
  export PATH
fi

say "Installing the runner from \${HUB}..."
tmp=$(mktemp -d)
curl -fsSL "$PACKAGE" -o "$tmp/life-os-runner.tgz" || fail "Couldn't download the runner from $HUB."
mkdir -p "$HOME_DIR/app"
[ -f "$HOME_DIR/app/package.json" ] || printf '{"private":true}\\n' > "$HOME_DIR/app/package.json"
# Replace the runner itself; its dependencies stay and only change when it needs new ones.
rm -rf "$HOME_DIR/app/node_modules/@life-os/runner"
"$NPM" install --prefix "$HOME_DIR/app" --no-update-notifier --no-save --no-package-lock --omit=dev --no-audit \\
  --no-fund --loglevel=error "$tmp/life-os-runner.tgz" >/dev/null
rm -rf "$tmp"

# A launcher that keeps working whatever is on PATH later.
mkdir -p "$HOME_DIR/bin"
BIN="$HOME_DIR/bin/life-os-runner"
cat > "$BIN" <<EOF
#!/bin/sh
export LIFE_OS_RUNNER_HOME="$HOME_DIR"
exec "$NODE" "$HOME_DIR/app/node_modules/@life-os/runner/dist/main.js" "\\$@"
EOF
chmod 755 "$BIN"
LINK_DIR="$HOME/.local/bin"
mkdir -p "$LINK_DIR" && ln -sf "$BIN" "$LINK_DIR/life-os-runner"

if [ -n "$TOKEN" ] && grep -qF "\\"hub\\": \\"$HUB\\"" "$HOME_DIR/config.json" 2>/dev/null &&
  "$BIN" status >/dev/null 2>&1; then
  say "This machine is already connected; updated the runner."
elif [ -n "$TOKEN" ]; then
  set -- enrol --hub "$HUB" --token "$TOKEN"
  [ -n "$NAME" ] && set -- "$@" --name "$NAME"
  [ -n "$TAGS" ] && set -- "$@" --tags "$TAGS"
  "$BIN" "$@"
elif ! "$BIN" status >/dev/null 2>&1; then
  fail "This machine isn't connected yet. Copy the install command from Machines in Life OS: it carries a setup token."
fi

# Agents use this machine's Claude subscription; sign in once if it isn't already.
# The terminal's own device: Claude Code crashes reading /dev/tty on macOS (kqueue refuses it).
TTY=$(tty 0<&2 2>/dev/null) || TTY=
if [ -n "$TTY" ]; then "$BIN" login <"$TTY"; else "$BIN" login; fi

if [ -n "$NO_SERVICE" ]; then
  say "Installed. Run: life-os-runner start"
else
  "$BIN" service install
fi
case ":$PATH:" in
  *":$LINK_DIR:"*) ;;
  *) echo "Tip: add $LINK_DIR to your PATH to use the life-os-runner command." ;;
esac
`;
