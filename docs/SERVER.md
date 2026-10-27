# Serveur LLM d'Atelier

Atelier tourne sur le Mac de l'utilisateur, mais le modèle (Qwen 3.5 via Ollama) tourne sur un **serveur GPU distant**. L'app y accède par l'API OpenAI-compatible `https://<serveur>/v1` avec un token. Ce document décrit le déploiement de ce serveur.

> **Règle absolue : ne jamais exposer le port 11434 d'Ollama.** Ollama n'a aucune authentification. Deux options sont supportées : un **reverse proxy Caddy** (TLS + token), ou un **VPN Tailscale / WireGuard**.

## 1. Option A : Docker Compose + Caddy (fourni dans `server/`)

### Prérequis

- Linux x86_64 avec un GPU NVIDIA (voir le [dimensionnement](#4-dimensionnement-gpu--vram)), pilote NVIDIA ≥ 550.
- Docker Engine ≥ 24 + plugin Compose, et le [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) (`nvidia-ctk runtime configure --runtime=docker`).
- Un nom de domaine (enregistrement A/AAAA) qui pointe vers le serveur, et les ports 80 et 443 ouverts (Let's Encrypt).

### Déploiement

```bash
cd server
cp .env.example .env
# Éditer .env : ATELIER_DOMAIN, ACME_EMAIL, et un token fort :
sed -i "s/^ATELIER_API_TOKEN=.*/ATELIER_API_TOKEN=$(openssl rand -hex 32)/" .env

docker compose up -d                       # construit Caddy (module rate limit) et démarre
docker compose exec ollama ollama pull qwen3.5:35b
docker compose exec ollama ollama create atelier -f /modelfiles/atelier.Modelfile
./healthcheck.sh                           # vérifie proxy, auth, modèle, contexte, génération
```

Dans l'app (onboarding ou Réglages › Serveur) : URL `https://llm.example.com`, le token de `.env`, puis le modèle `atelier` (ou `qwen3.5:35b` si `OLLAMA_CONTEXT_LENGTH` suffit).

### Ce que fait le proxy (`Caddyfile`)

| Fonction         | Détail                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| TLS              | Certificat Let's Encrypt automatique pour `ATELIER_DOMAIN`                                                                     |
| Authentification | `Authorization: Bearer <ATELIER_API_TOKEN>` obligatoire, sinon `401` ; le header est retiré avant Ollama                       |
| Surface exposée  | Seulement `/v1/*`, `/api/tags`, `/api/show`, `/api/version`, `/api/ps`. Pas de `pull`, `delete`, `create` ni `push` à distance |
| Rate limiting    | `ATELIER_RATE_LIMIT` requêtes/minute par couple token + IP (module `caddy-ratelimit`)                                          |
| Streaming        | `flush_interval -1`, délais longs (10 min) pour les réponses en SSE                                                            |
| Confidentialité  | Journal d'accès sans headers ni query string ; les corps (prompts, documents) ne sont jamais journalisés                       |
| Santé            | `GET /healthz` public, sans information                                                                                        |

Pour faire tourner le token : modifiez `.env`, puis `docker compose up -d caddy`, et mettez à jour le token dans l'app de chaque utilisateur.

## 2. Option B : Tailscale (recommandée pour une petite équipe)

Pas de port public, pas de certificat : le trafic passe dans le tunnel WireGuard chiffré.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
# Ollama n'écoute que sur l'IP Tailscale du serveur (100.x.y.z) :
sudo systemctl edit ollama   # [Service] Environment="OLLAMA_HOST=100.x.y.z:11434"
sudo systemctl restart ollama
```

Avec Docker, remplacez la section `caddy` par la publication `ports: ["100.x.y.z:11434:11434"]` sur le service `ollama` : l'IP Tailscale, **jamais** `0.0.0.0`.

Dans l'app, l'URL `http://100.x.y.z:11434` (ou `http://<machine>.<tailnet>.ts.net:11434`) est acceptée en `http://`, car l'app n'autorise le `http://` que pour `localhost` et les adresses Tailscale (`100.64.0.0/10`, `*.ts.net`). Le token peut rester vide, ou être ajouté avec Caddy en écoute sur l'IP Tailscale. Restreignez l'accès au port avec les ACL Tailscale (groupe `atelier-users`).

## 3. Variables `OLLAMA_*`

| Variable                   | Valeur fournie                                     | Rôle                                                                                                           |
| -------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `OLLAMA_HOST`              | `0.0.0.0:11434` (réseau Docker interne uniquement) | Interface d'écoute                                                                                             |
| `OLLAMA_CONTEXT_LENGTH`    | `32768`                                            | Contexte par défaut. **Indispensable** : l'endpoint `/v1` ignore `num_ctx`                                     |
| `OLLAMA_NUM_PARALLEL`      | `2`                                                | Requêtes simultanées par modèle. Chaque slot réserve son propre cache KV : `VRAM KV ≈ NUM_PARALLEL × contexte` |
| `OLLAMA_MAX_LOADED_MODELS` | `1`                                                | Modèles en mémoire simultanément (un seul, multimodal)                                                         |
| `OLLAMA_KEEP_ALIVE`        | `-1`                                               | Modèle gardé chaud (pas de rechargement de 10 à 60 s)                                                          |
| `OLLAMA_MAX_QUEUE`         | `128`                                              | Requêtes en attente avant de répondre `503`                                                                    |
| `OLLAMA_FLASH_ATTENTION`   | `1`                                                | Attention plus économe en mémoire, nécessaire au cache quantifié                                               |
| `OLLAMA_KV_CACHE_TYPE`     | `q8_0`                                             | Cache KV quantifié : environ deux fois moins de VRAM, perte négligeable                                        |

**Contexte** : deux façons de le fixer, et l'app lit la valeur réelle via `/api/show` pour piloter la compaction (à 75 %).

1. `OLLAMA_CONTEXT_LENGTH=32768` (s'applique à tous les modèles) ;
2. le modèle dérivé `atelier` (`server/Modelfile`, `PARAMETER num_ctx 32768`), recommandé, car explicite et visible dans `/api/show`.

## 4. Dimensionnement GPU / VRAM

Ordres de grandeur pour une quantification Q4_K_M (valeur par défaut d'Ollama), contexte 32k, cache KV `q8_0`, `NUM_PARALLEL=1`. Ajoutez environ 1 à 3 Go par slot parallèle supplémentaire. Vérifiez sur place avec `docker compose exec ollama ollama ps` (colonne `PROCESSOR` : `100% GPU` attendu).

| Modèle                   | Poids (≈)  | VRAM conseillée | Exemples de GPU                            | Usage                                      |
| ------------------------ | ---------- | --------------- | ------------------------------------------ | ------------------------------------------ |
| `qwen3.5:9b`             | 6 Go       | 12 à 16 Go      | RTX 4070 Ti / 4080, L4 (24 Go)             | Tests, 1 ou 2 utilisateurs, tâches simples |
| `qwen3.5:27b`            | 17 Go      | 24 Go           | RTX 4090 / 5090, L4, A10                   | Bon compromis pour une petite équipe       |
| `qwen3.5:35b` _(défaut)_ | 22 à 24 Go | 32 à 48 Go      | RTX 5090 (32 Go), L40S / A6000 (48 Go)     | Recommandé : analyse, documents, vision    |
| `qwen3.5:122b`           | 70 à 80 Go | 96 Go et plus   | H100 / H200, 2× L40S, RTX PRO 6000 (96 Go) | Qualité maximale, équipe                   |

- Si le modèle ne tient pas entièrement en VRAM, Ollama déborde sur le CPU et les performances s'effondrent (affichage `xx%/yy% CPU/GPU`) : réduisez le modèle, `NUM_PARALLEL` ou le contexte.
- La RAM système doit couvrir au moins la taille des poids (chargement), et le disque tous les modèles téléchargés (prévoir 100 Go et plus).
- Débit indicatif : pour une interface fluide, visez au moins 20 tokens/s en génération par utilisateur.

## 5. Au-delà de quelques utilisateurs : vLLM

Ollama sert les requêtes avec un parallélisme limité (`NUM_PARALLEL`). Au-delà de 5 à 10 utilisateurs simultanés, ou pour un débit soutenu, passez à **vLLM** (continuous batching, PagedAttention). L'API est la même (OpenAI-compatible) : **rien à changer dans l'app**, sauf le nom du modèle.

```yaml
# Remplace le service `ollama` dans docker-compose.yml
vllm:
  image: vllm/vllm-openai:latest
  command: >
    --model Qwen/Qwen3.5-35B-Instruct-AWQ
    --served-model-name atelier
    --max-model-len 32768
    --enable-auto-tool-choice --tool-call-parser hermes
    --reasoning-parser qwen3
    --gpu-memory-utilization 0.90
  volumes: [hf-cache:/root/.cache/huggingface]
  deploy:
    {
      resources:
        { reservations: { devices: [{ driver: nvidia, count: all, capabilities: [gpu] }] } },
    }
```

Dans le `Caddyfile`, faites pointer `reverse_proxy` vers `vllm:8000`. Points d'attention :

- `/api/tags`, `/api/show` et `/api/version` n'existent pas dans vLLM : l'app doit se rabattre sur `GET /v1/models` (liste des modèles) et sur `max_model_len` (contexte). Ce comportement de repli est à prévoir dans `agent-core` et l'onboarding ; d'ici là, renseignez `num_ctx` dans les Réglages.
- Le tool calling et le parser de raisonnement doivent correspondre au modèle (voir la documentation vLLM pour Qwen 3.5) ; validez avec les critères d'acceptation 2 et 3 du brief.
- Les noms de dépôts Hugging Face ci-dessus sont des exemples : prenez la variante quantifiée officielle qui tient dans votre VRAM.

## 6. Confidentialité

- Les documents et images envoyés au modèle **transitent par ce serveur**. Hébergez-le on-premise ou chez un fournisseur établi dans l'UE.
- Aucun prompt n'est journalisé (`OLLAMA_DEBUG=0`, proxy sans journal des corps). N'activez pas de journal applicatif supplémentaire.
- L'app affiche à l'onboarding : « Vos fichiers sont envoyés au serveur X ».
- Le token est stocké sur le Mac via `safeStorage` (trousseau macOS).
