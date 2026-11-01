#!/usr/bin/env bash
# dsh-watch-together installer (git-bash / WSL on Windows).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGES=(dsh-watch-eyes dsh-watch-ears dsh-watch-mouth dsh-watch-browser dsh-watch-hands dsh-watch-panel)
PROFILE="${1:-desktop}"
for p in "${PACKAGES[@]}"; do
  echo "[install] link $HERE/packages/$p"
  dsh plugin --profile "$PROFILE" add "link:$HERE/packages/$p"
done
echo "[install] done. restart DSH so the patches mount."
