#!/usr/bin/env bash
# Deploy this checkout as an isolated release for the cloudcli systemd user service.
#
# Layout (outside the dev tree, so editing / rebuilding here never touches the running server):
#   ~/.local/opt/cloudcli/releases/<version>-<time>-<sha>/   self-contained copy (npm pack + npm ci --omit=dev)
#   ~/.local/opt/cloudcli/current -> releases/<...>          what cloudcli.service runs
# Data stays in ~/.cloudcli (DATABASE_PATH default), shared by every release.
#
# Usage:
#   scripts/deploy-local.sh              build, install a new release, switch `current` (no restart)
#   scripts/deploy-local.sh --restart    ... and restart the service; rolls back if /health fails
#   scripts/deploy-local.sh --no-build   reuse the existing dist/ and dist-server/
#   scripts/deploy-local.sh rollback     point `current` at the previous release and restart
#   scripts/deploy-local.sh list         show releases
#
# Restarting cloudcli.service kills the claude sessions it spawned (KillMode=control-group),
# so --restart is opt-in. Don't run it from a session hosted by CloudCLI itself.
set -euo pipefail

PREFIX="${CLOUDCLI_PREFIX:-$HOME/.local/opt/cloudcli}"
RELEASES="$PREFIX/releases"
CURRENT="$PREFIX/current"
UNIT="cloudcli.service"
UNIT_FILE="$HOME/.config/systemd/user/$UNIT"
PORT="${CLOUDCLI_PORT:-3001}"
KEEP="${CLOUDCLI_KEEP:-5}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; exit 1; }

switch_to() {
  # Atomic: create the new symlink beside `current`, then rename over it.
  ln -sfn "$1" "$CURRENT.tmp"
  mv -T "$CURRENT.tmp" "$CURRENT"
  log "current -> $(readlink "$CURRENT")"
}

ensure_unit() {
  [[ -f "$UNIT_FILE" ]] || die "$UNIT_FILE not found"
  local want="ExecStart=%h/.local/opt/cloudcli/current/dist-server/server/index.js"
  if [[ "$PREFIX" != "$HOME/.local/opt/cloudcli" ]]; then
    want="ExecStart=$CURRENT/dist-server/server/index.js"
  fi
  local node_bin
  node_bin="$(grep -oP '^ExecStart=\K\S+' "$UNIT_FILE")"
  want="${want/ExecStart=/ExecStart=$node_bin }"
  if ! grep -qxF "$want" "$UNIT_FILE"; then
    cp "$UNIT_FILE" "$UNIT_FILE.bak.$(date +%Y%m%d-%H%M%S)"
    sed -i "s|^ExecStart=.*|$want|" "$UNIT_FILE"
    systemctl --user daemon-reload
    log "updated $UNIT_FILE (backup saved next to it): $want"
  fi
}

healthy() {
  local i
  for i in $(seq 1 30); do
    sleep 1
    if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/health"; then return 0; fi
  done
  return 1
}

restart_or_rollback() {
  local prev="$1"
  log "restarting $UNIT"
  systemctl --user restart "$UNIT"
  if healthy; then
    log "healthy on :$PORT"
    return 0
  fi
  if [[ -n "$prev" ]]; then
    log "health check failed, rolling back to $prev"
    switch_to "$prev"
    systemctl --user restart "$UNIT"
    healthy && log "rolled back, healthy" || log "rollback also unhealthy; see: journalctl --user -u $UNIT -n 100"
  fi
  die "deploy failed health check; see: journalctl --user -u $UNIT -n 100"
}

previous_release() {
  # Newest release that isn't the current one.
  local cur
  cur="$(readlink -f "$CURRENT" 2>/dev/null || true)"
  ls -1dt "$RELEASES"/*/ 2>/dev/null | sed 's:/$::' | while read -r r; do
    [[ "$(readlink -f "$r")" != "$cur" ]] && { echo "$r"; break; }
  done
}

case "${1:-}" in
  list)
    cur="$(readlink -f "$CURRENT" 2>/dev/null || true)"
    ls -1dt "$RELEASES"/*/ 2>/dev/null | sed 's:/$::' | while read -r r; do
      [[ "$r" == "$cur" ]] && echo "* $r" || echo "  $r"
    done
    exit 0 ;;
  rollback)
    prev="$(previous_release)"
    [[ -n "$prev" ]] || die "no previous release to roll back to"
    switch_to "$prev"
    restart_or_rollback ""
    exit 0 ;;
esac

BUILD=1 RESTART=0
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --restart) RESTART=1 ;;
    *) die "unknown argument: $arg" ;;
  esac
done

cd "$REPO"
if (( BUILD )); then
  log "building in $REPO"
  npm run build
fi
[[ -f dist-server/server/index.js && -f dist/index.html ]] || die "build output missing (run without --no-build)"

version="$(node -p "require('./package.json').version")"
sha="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
git diff --quiet HEAD 2>/dev/null || sha="$sha-dirty"
rel="$RELEASES/$version-$(date +%Y%m%d-%H%M%S)-$sha"
mkdir -p "$RELEASES"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
log "packing"
npm pack --silent --pack-destination "$tmp" >/dev/null
mkdir -p "$rel"
tar -xzf "$tmp"/*.tgz -C "$rel" --strip-components=1
cp package-lock.json "$rel/"
# `prepare` runs husky (a dev dependency, git hooks only); a release has neither.
(cd "$rel" && npm pkg delete scripts.prepare)

log "installing production dependencies into $rel"
if ! (cd "$rel" && npm ci --omit=dev --no-audit --no-fund --loglevel=error); then
  rm -rf "$rel"
  die "npm ci failed; release removed, current untouched"
fi

log "smoke test"
if ! (cd "$rel" && node -e "require('better-sqlite3'); require('node-pty')" \
      && test -f dist-server/server/index.js && test -f dist/index.html); then
  rm -rf "$rel"
  die "smoke test failed; release removed, current untouched"
fi

prev="$(readlink -f "$CURRENT" 2>/dev/null || true)"
switch_to "$rel"
ensure_unit

# Prune old releases, never the current or the previous one.
ls -1dt "$RELEASES"/*/ | sed 's:/$::' | tail -n +"$((KEEP + 1))" | while read -r r; do
  [[ "$r" == "$rel" || "$r" == "$prev" ]] && continue
  log "pruning $r"; rm -rf "$r"
done

if (( RESTART )); then
  restart_or_rollback "$prev"
else
  log "installed; the running server is unchanged until: systemctl --user restart $UNIT"
  log "(or re-run with --restart to restart + health-check + auto-rollback)"
fi
