#!/bin/bash
# Paquets système : python3 + bibliothèques de données, rendu PDF, outils CLI courants.
# Idempotent ; exécuté en root par l'hôte (voir lima/README.md).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt_get() { apt-get -o DPkg::Lock::Timeout=600 -o Acquire::Retries=3 "$@"; }

echo "::atelier:: 2 Mise à jour de la liste des paquets…"
apt_get update -qq

echo "::atelier:: 8 Installation de Python et des bibliothèques de données…"
apt_get install -y -qq --no-install-recommends \
  python3 python3-pip python3-venv python3-dev build-essential \
  python3-pandas python3-openpyxl python3-xlsxwriter python3-matplotlib python3-requests

echo "::atelier:: 25 Installation des outils en ligne de commande…"
apt_get install -y -qq --no-install-recommends \
  poppler-utils pandoc jq curl wget ca-certificates gnupg git unzip zip xz-utils \
  ripgrep fd-find file bc sqlite3 less tree rsync locales

# Locale UTF-8 pour les sorties texte de l'agent (accents).
if ! locale -a 2>/dev/null | grep -qi '^fr_FR.utf8$'; then
  sed -i 's/^# *fr_FR.UTF-8 UTF-8/fr_FR.UTF-8 UTF-8/' /etc/locale.gen
  locale-gen >/dev/null
fi
cat >/etc/profile.d/atelier-locale.sh <<'PROFILE'
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
PROFILE
