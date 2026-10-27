# Atelier

Assistant IA local de type « Cowork » pour macOS : choisissez un dossier, discutez avec un agent qui lit, crée et modifie vos fichiers (rapports, tableurs, synthèses de documents), exécute des commandes dans une VM isolée et cherche sur le web. Le modèle (Qwen 3.5) tourne sur **votre** serveur : aucune clé d'API cloud n'est nécessaire et les données restent chez vous.

## Prérequis

- **Client** : Mac Apple Silicon (M1 ou plus récent), macOS 14+, 16 Go de RAM suffisent.
- **Serveur** : un serveur Ollama accessible (GPU NVIDIA). Voir [`docs/SERVER.md`](docs/SERVER.md) ; le déploiement se fait par `docker compose up -d` depuis `server/`.
- **Développement** : Node 22+, pnpm 11 (`corepack enable`).

## Démarrage en 3 commandes

```bash
pnpm install
pnpm test && pnpm lint && pnpm typecheck
pnpm dev
```

## Documentation

- [`docs/BRIEF.md`](docs/BRIEF.md) : spécification et décisions de stack
- [`docs/STATUS.md`](docs/STATUS.md) : état d'avancement
- [`docs/SERVER.md`](docs/SERVER.md) : serveur LLM
- [`CLAUDE.md`](CLAUDE.md) : conventions pour les agents
