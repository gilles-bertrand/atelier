#!/bin/bash
# Node.js 22 (dépôt NodeSource) + exceljs global, utilisable via require('exceljs').
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt_get() { apt-get -o DPkg::Lock::Timeout=600 -o Acquire::Retries=3 "$@"; }

NODE_MAJOR=22
EXCELJS_VERSION=4.4.0
JSZIP_VERSION=3.10.1 # graphiques du skill xlsx (post-traitement du .xlsx)

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" != "$NODE_MAJOR" ]; then
  echo "::atelier:: 40 Installation de Node.js $NODE_MAJOR…"
  install -d -m 755 /etc/apt/keyrings
  curl -fsSL --retry 3 https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
    gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" \
    >/etc/apt/sources.list.d/nodesource.list
  cat >/etc/apt/preferences.d/nodesource <<'PIN'
Package: nodejs
Pin: origin deb.nodesource.com
Pin-Priority: 1001
PIN
  apt_get update -qq
  apt_get install -y -qq nodejs
fi

echo "::atelier:: 55 Installation d'exceljs…"
installed="$(npm ls -g --depth=0 2>/dev/null || true)"
if ! grep -q "exceljs@$EXCELJS_VERSION" <<<"$installed" || ! grep -q "jszip@$JSZIP_VERSION" <<<"$installed"; then
  npm install -g --no-fund --no-audit --loglevel=error "exceljs@$EXCELJS_VERSION" "jszip@$JSZIP_VERSION"
fi
cat >/etc/profile.d/atelier-node.sh <<PROFILE
export NODE_PATH="$(npm root -g)"
PROFILE
