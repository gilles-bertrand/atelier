#!/bin/bash
# SearXNG (métamoteur de recherche) en service systemd sous l'utilisateur `searxng`,
# format JSON activé, sur 127.0.0.1:8888 (forwardé vers 127.0.0.1:8888 côté hôte).
# L'utilisateur `searxng` n'est pas soumis au blocage réseau de `agent`.
set -euo pipefail

# Commit épinglé (SearXNG ne publie pas de versions) ; mettre à jour volontairement.
SEARXNG_COMMIT=28423d332d660bc1c4ab2177adf24938244c8d06
base=/usr/local/searxng
src="$base/searxng-src"
venv="$base/searx-pyenv"

as_searxng() { sudo -H -u searxng "$@"; }

echo "::atelier:: 65 Téléchargement de SearXNG…"
install -d -o searxng -g searxng -m 755 "$base"
if [ "$(as_searxng git -C "$src" rev-parse HEAD 2>/dev/null || true)" != "$SEARXNG_COMMIT" ]; then
  rm -rf "$src"
  as_searxng git init -q "$src"
  as_searxng git -C "$src" remote add origin https://github.com/searxng/searxng.git
  as_searxng git -C "$src" fetch -q --depth 1 origin "$SEARXNG_COMMIT"
  as_searxng git -C "$src" checkout -q FETCH_HEAD
  rm -f "$base/.installed"
fi

if [ "$(cat "$base/.installed" 2>/dev/null || true)" != "$SEARXNG_COMMIT" ]; then
  echo "::atelier:: 75 Installation de SearXNG (environnement Python)…"
  [ -x "$venv/bin/python" ] || as_searxng python3 -m venv "$venv"
  as_searxng "$venv/bin/pip" install -q -U pip setuptools wheel pyyaml msgspec typing_extensions
  as_searxng bash -c "cd '$src' && '$venv/bin/pip' install -q --use-pep517 --no-build-isolation -e . && '$venv/bin/pip' install -q -r requirements-server.txt"
  echo "$SEARXNG_COMMIT" >"$base/.installed"
fi

echo "::atelier:: 88 Configuration du service de recherche…"
install -d -m 755 /etc/searxng
if [ ! -f /etc/searxng/settings.yml ]; then
  secret="$(openssl rand -hex 32)"
  cat >/etc/searxng/settings.yml <<SETTINGS
# SearXNG pour Atelier : instance privée, locale à la VM.
use_default_settings: true
general:
  instance_name: "Atelier"
  enable_metrics: false
search:
  safe_search: 0
  formats:
    - html
    - json
server:
  bind_address: "127.0.0.1"
  port: 8888
  secret_key: "$secret"
  limiter: false
  public_instance: false
  image_proxy: false
valkey:
  url: false
SETTINGS
  chown root:searxng /etc/searxng/settings.yml
  chmod 640 /etc/searxng/settings.yml
fi

cat >/etc/systemd/system/searxng.service <<UNIT
[Unit]
Description=SearXNG (recherche web d'Atelier)
After=network-online.target
Wants=network-online.target

[Service]
User=searxng
Group=searxng
WorkingDirectory=$src
Environment=SEARXNG_SETTINGS_PATH=/etc/searxng/settings.yml
Environment=GRANIAN_INTERFACE=wsgi
Environment=GRANIAN_HOST=127.0.0.1
Environment=GRANIAN_PORT=8888
Environment=GRANIAN_WORKERS=1
Environment=GRANIAN_BLOCKING_THREADS=4
ExecStart=$venv/bin/granian searx.webapp:app
Restart=on-failure
RestartSec=2
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$base
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable searxng.service >/dev/null 2>&1
systemctl restart searxng.service

echo "::atelier:: 95 Vérification de SearXNG…"
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null http://127.0.0.1:8888/healthz; then
    exit 0
  fi
  sleep 1
done
echo "SearXNG ne répond pas sur 127.0.0.1:8888" >&2
journalctl -u searxng.service -n 50 --no-pager >&2 || true
exit 1
