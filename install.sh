#!/usr/bin/env bash
# OpenClicky installer — macOS / Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/ranaalyan1/openclicky/main/install.sh | bash
#
# What it does, in order:
#   1. checks Node 18+ (tells you exactly how to get it if missing)
#   2. downloads OpenClicky to ~/.openclicky (or updates it)
#   3. installs every dependency automatically
#   4. compiles the workspace
#   5. asks for the two keys and verifies them live
#        KEY 1 · model   — any OpenAI-compatible key   (required)
#        KEY 2 · search  — Brave Search, free tier     (optional)
#   6. tells you how to start it
#
# Flags:  --start   launch the panel when setup finishes
#         --dir DIR install somewhere other than ~/.openclicky
#         --yes     skip prompts in step 5 (keys can be added later)

set -euo pipefail

REPO_URL="${OPENCLICKY_REPO:-https://github.com/ranaalyan1/openclicky.git}"
TARBALL_URL="${OPENCLICKY_TARBALL:-https://codeload.github.com/ranaalyan1/openclicky/tar.gz/refs/heads/main}"
DEST="${OPENCLICKY_HOME:-$HOME/.openclicky}"
START=0
ASSUME_YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --start) START=1 ;;
    --dir) shift; DEST="${1:-$DEST}" ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
dim() { printf '\033[2m%s\033[0m\n' "$1"; }
ok() { printf '\033[32m✓\033[0m %s\n' "$1"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; [ -n "${2:-}" ] && dim "$2"; exit 1; }

# ---------- 1. node ----------
if ! command -v node >/dev/null 2>&1; then
  die "Node.js is not installed." "Install Node 20 LTS from https://nodejs.org (or: curl -fsSL https://fnm.vercel.app/install | bash && fnm install 20) then re-run this script."
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  die "Node $(node -v) is too old — OpenClicky needs 18+." "Get Node 20 LTS from https://nodejs.org and re-run."
fi
ok "node $(node -v)"

if ! command -v npm >/dev/null 2>&1; then
  die "npm is missing (it ships with Node)." "Reinstall Node from https://nodejs.org."
fi
ok "npm $(npm -v)"

# ---------- 2. fetch the source ----------
if [ -d "$DEST/.git" ]; then
  dim "updating $DEST"
  git -C "$DEST" pull --ff-only --quiet || dim "could not update (local changes kept) — continuing"
elif [ -f "$DEST/package.json" ]; then
  dim "using existing checkout at $DEST"
elif command -v git >/dev/null 2>&1; then
  dim "cloning into $DEST"
  mkdir -p "$(dirname "$DEST")"
  git clone --depth 1 "$REPO_URL" "$DEST" || die "clone failed" "Check your network, or download the zip from $REPO_URL"
else
  dim "git not found — downloading a release tarball instead"
  mkdir -p "$DEST"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$TARBALL_URL" | tar -xz -C "$DEST" --strip-components=1 || die "download failed" "Install git or fetch $TARBALL_URL manually."
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$TARBALL_URL" | tar -xz -C "$DEST" --strip-components=1 || die "download failed" "Install git or fetch $TARBALL_URL manually."
  else
    die "neither git nor curl/wget is available" "Install git (or curl) and re-run."
  fi
fi
ok "source at $DEST"

cd "$DEST"

# ---------- 3 + 4 + 5. deps, build, the two keys ----------
bold ""
bold "Installing dependencies — this is the only slow step."
if [ "$ASSUME_YES" -eq 1 ]; then
  export OPENCLICKY_SKIP_SETUP=1
fi
node scripts/setup.mjs

# ---------- 6. how to run ----------
bold ""
bold "OpenClicky is installed."
echo "  panel     cd \"$DEST\" && npm start      → http://127.0.0.1:4747"
echo "  terminal  cd \"$DEST\" && npm run chat"
echo "  re-key    cd \"$DEST\" && npm run setup"
echo "  update    cd \"$DEST\" && git pull && npm install"
echo ""

if [ "$START" -eq 1 ]; then
  dim "starting the panel (Ctrl+C to stop)"
  exec npm start
fi
