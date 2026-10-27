#!/usr/bin/env bash
# Vérifie le serveur LLM d'Atelier de bout en bout, comme le ferait l'app.
# Usage : ./healthcheck.sh [https://llm.example.com] [token] [modèle]
#   (sinon lit ATELIER_DOMAIN / ATELIER_API_TOKEN depuis .env)
set -euo pipefail

cd "$(dirname "$0")"
if [[ -f .env ]]; then set -a; source .env; set +a; fi

BASE_URL="${1:-https://${ATELIER_DOMAIN:-localhost}}"
TOKEN="${2:-${ATELIER_API_TOKEN:-}}"
MODEL="${3:-atelier}"
AUTH=(-H "Authorization: Bearer ${TOKEN}")
fail() { echo "❌ $*" >&2; exit 1; }
ok() { echo "✅ $*"; }

command -v curl >/dev/null || fail "curl requis"
command -v jq >/dev/null || fail "jq requis"

curl -fsS --max-time 10 "${BASE_URL}/healthz" >/dev/null || fail "proxy injoignable (${BASE_URL}/healthz)"
ok "proxy joignable"

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${BASE_URL}/api/version")
[[ "$code" == "401" ]] || fail "sans token, /api/version devrait répondre 401 (reçu ${code})"
ok "authentification exigée"

version=$(curl -fsS --max-time 10 "${AUTH[@]}" "${BASE_URL}/api/version" | jq -r .version) || fail "token refusé"
ok "Ollama ${version}"

models=$(curl -fsS --max-time 10 "${AUTH[@]}" "${BASE_URL}/api/tags" | jq -r '.models[].name')
echo "${models}" | grep -qx "${MODEL}\(:latest\)\?" || fail "modèle « ${MODEL} » absent. Disponibles : $(echo ${models})"
ok "modèle ${MODEL} présent"

ctx=$(curl -fsS --max-time 10 "${AUTH[@]}" "${BASE_URL}/api/show" -d "{\"model\":\"${MODEL}\"}" \
  | jq -r '[.parameters // "" | capture("num_ctx\\s+(?<n>[0-9]+)").n] | first // "défaut serveur"')
ok "contexte : ${ctx}"

start=$(date +%s)
answer=$(curl -fsS --max-time 300 "${AUTH[@]}" -H 'Content-Type: application/json' \
  "${BASE_URL}/v1/chat/completions" \
  -d "{\"model\":\"${MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"Réponds juste OK.\"}],\"max_tokens\":200}" \
  | jq -r '.choices[0].message.content') || fail "échec de /v1/chat/completions"
ok "génération en $(( $(date +%s) - start )) s : ${answer:0:60}"
