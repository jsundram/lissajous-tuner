#!/usr/bin/env bash
# Dependency check + (optional) install for the build-time toolchain. The DEPLOYED app has zero
# runtime deps — this is only what you need to regenerate assets and run the lints:
#
#   rsvg-convert (librsvg)   rasterize icon.svg / og.svg  (make-icons.sh, make-og.sh)
#   pngquant                 compress the share card       (make-og.sh + og-lint.py's budget)
#   python3 >= 3.9           the lint scripts              (sw-lint.py, og-lint.py; no pip packages)
#   git, bash                the lints + hooks             (assumed present)
#
# Designed to be run from a SessionStart hook (see .claude/settings.json) so a fresh clone or cloud
# session isn't missing tools mid-build — and to be cheap when everything's already there. Two rules
# keep it safe as an every-session hook:
#   - IDEMPOTENT: if a tool is present it does nothing; re-running is a no-op.
#   - NON-FATAL: always exits 0 so it never blocks a session — a missing tool is reported, not thrown.
#
# It only auto-installs in an unattended environment (CI / a container running as root / an explicit
# opt-in). On your own laptop it just prints the one-liner to run, rather than mutating your system
# via brew/apt without asking. Force an install anywhere with:  SETUP_AUTO_INSTALL=1 tools/setup-environment.sh
set -uo pipefail

# Auto-install only when unattended: opt-in env, CI, or running as root (typical sandbox/container).
auto=0
if [ "${SETUP_AUTO_INSTALL:-0}" = "1" ] || [ -n "${CI:-}" ] || [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then
  auto=1
fi

# Pick the platform package manager + the package names that carry each binary.
mgr="" ; install_cmd=""
if command -v brew >/dev/null 2>&1; then
  mgr="brew";     rsvg_pkg="librsvg";        pngquant_pkg="pngquant"; install_cmd="brew install"
elif command -v apt-get >/dev/null 2>&1; then
  mgr="apt-get";  rsvg_pkg="librsvg2-bin";   pngquant_pkg="pngquant"; install_cmd="sudo apt-get install -y"
fi

missing=()

# ensure <binary> <package-var-name> — check; auto-install if unattended; else record as missing.
ensure(){
  local bin="$1" pkg="$2"
  command -v "$bin" >/dev/null 2>&1 && return 0
  if [ "$auto" = "1" ] && [ -n "$mgr" ]; then
    echo "setup: installing $pkg ($bin) via $mgr…"
    [ "$mgr" = "apt-get" ] && sudo apt-get update -qq >/dev/null 2>&1
    $install_cmd "$pkg" >/dev/null 2>&1 || true
    command -v "$bin" >/dev/null 2>&1 && return 0
  fi
  missing+=("$bin|$pkg")
}

ensure rsvg-convert "$rsvg_pkg"
ensure pngquant "$pngquant_pkg"

# python3 / git aren't things we install for you — just flag if absent (both are near-universal, and
# the lints degrade to a warn-only no-op without git anyway).
for b in python3 git; do
  command -v "$b" >/dev/null 2>&1 || missing+=("$b|$b")
done

if [ ${#missing[@]} -eq 0 ]; then
  echo "setup: toolchain OK (rsvg-convert, pngquant, python3, git)."
  exit 0
fi

echo "setup: missing build tools — asset generation / lints may not run:"
for m in "${missing[@]}"; do echo "  - ${m%%|*}"; done
if [ -n "$install_cmd" ]; then
  # Suggest the exact one-liner for the tools a package manager can supply (skip python3/git).
  pkgs=""
  for m in "${missing[@]}"; do
    case "${m%%|*}" in rsvg-convert) pkgs="$pkgs $rsvg_pkg";; pngquant) pkgs="$pkgs $pngquant_pkg";; esac
  done
  [ -n "$pkgs" ] && echo "  install:$install_cmd$pkgs" && echo "  (or re-run with SETUP_AUTO_INSTALL=1 to install now)"
else
  echo "  (no brew/apt found — install rsvg-convert + pngquant with your platform's package manager)"
fi
exit 0   # never block a session on a missing build tool
