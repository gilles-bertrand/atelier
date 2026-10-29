# Mesures (2026-10-29)

## Modèle atelier

- Chargement initial en mémoire : 2 ms (0 si déjà chargé)
- Génération : **103.6 tokens/s (min 99.8, max 105.8, n=3)**
- Préremplissage (prompt de ~6309 tokens) : 1671 tokens/s (min 1557, max 1917, n=3)
- Premier token via /v1 en streaming (thinking coupé) : 4032 ms (min 3626, max 4738, n=3)

## VM Lima (instance provisionnée, 4 CPU / 4 Gio)

- Démarrage (arrêtée → prête) : **6.9 s (min 6.2, max 7.0, n=3)**
- Changement de dossier (arrêt + remontage + démarrage) : **7.5 s (min 7.5, max 7.6, n=3)** (objectif < 15 s)
- Aller-retour d'une commande (`true`) : 51 ms (min 48, max 55, n=15)
