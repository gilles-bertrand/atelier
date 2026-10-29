# Démo finale : répétition des critères d'acceptation

Scénario pour rejouer les six critères d'acceptation de `docs/BRIEF.md`, avec les fichiers de `fixtures/` et les résultats attendus. Les critères 2 à 5 sont aussi automatisés (Playwright, voir `qa/README.md`).

## Fichiers de démo

Générés de façon déterministe (mêmes octets à chaque génération) par `fixtures/generate-demo-fixtures.py` et versionnés, pour que la démo ne demande pas Python :

```bash
uv run --with reportlab --with pillow fixtures/generate-demo-fixtures.py
```

| Fichier                                          | Critère | Contenu                                                                            |
| ------------------------------------------------ | ------- | ---------------------------------------------------------------------------------- |
| `demo-ventes/ventes-{bruxelles,liege,namur}.csv` | 2       | Ventes quotidiennes de 3 magasins, janvier à juin 2026 (environ 600 lignes chacun) |
| `demo-documents/rapport-annuel-2025.pdf`         | 4       | Rapport annuel en texte, 30 pages, 10 chapitres                                    |
| `demo-documents/facture-scannee.pdf`             | 4       | Facture scannée : une image, **sans couche texte** (passage obligé par la vision)  |
| `demo-documents/ticket-de-caisse.jpg`            | 4       | Photo d'un ticket de caisse posé sur une table                                     |

## Préparation

1. **Serveur LLM.** En production, c'est le serveur déployé depuis `server/` (voir `docs/SERVER.md`). Pour une répétition, Ollama sur le Mac de démo suffit, avec au moins 48 Go de RAM :
   ```bash
   ollama pull qwen3.5:35b
   ollama create atelier -f server/Modelfile   # contexte de 32k
   ```
   Dans l'app, l'URL est `http://localhost:11434`, le token reste vide et le modèle est `atelier`.
2. **Dossier de travail.** Copier `fixtures/demo-ventes/` dans un dossier vide, par exemple `~/Atelier-demo/ventes`, et le choisir comme dossier de travail.
3. **App.** Utiliser `pnpm dist:mac` puis installer le `.dmg`, ou lancer `pnpm dev` pour une répétition rapide.

## Critères

### 1. Installation et connexion sans terminal

Sur un Mac Apple Silicon neuf : installer le `.dmg`, lancer Atelier, puis suivre l'onboarding (serveur : URL et token, test de connexion, puis provisionnement de la VM).

- **Attendu :** la connexion est validée et la VM démarre sans ouvrir de terminal.
- **Côté serveur :** `docker compose up -d` dans `server/`, puis `./healthcheck.sh` passe au vert.
- ⚠️ Tant que l'app n'est pas signée et notarisée, macOS bloque le premier lancement (clic droit › Ouvrir). Il faut un certificat « Developer ID Application » pour remplir le critère sur un Mac neuf.

### 2. Excel récapitulatif et résumé

> Fais-moi un Excel récapitulatif par mois avec un graphique, puis un résumé en markdown

- **Attendu :**
  - une liste de tâches visible ;
  - les 3 CSV sont lus ;
  - le skill `xlsx` tourne dans la VM ;
  - **une demande de permission avant chaque écriture** ;
  - `recap.xlsx` et `resume.md` apparaissent en cartes cliquables.
- **Contrôle :** les totaux mensuels du classeur, tous magasins confondus (en euros) :

| Mois      | Bruxelles |    Liège |    Namur |         Total |
| --------- | --------: | -------: | -------: | ------------: |
| 2026-01   |  6 535,50 | 5 138,00 | 3 537,90 |     15 211,40 |
| 2026-02   |  6 252,30 | 4 491,20 | 3 379,20 |     14 122,70 |
| 2026-03   |  6 768,30 | 4 429,60 | 3 457,30 |     14 655,20 |
| 2026-04   |  7 024,30 | 4 510,10 | 3 379,90 |     14 914,30 |
| 2026-05   |  6 681,20 | 4 975,80 | 3 426,20 |     15 083,20 |
| 2026-06   |  7 075,90 | 4 732,40 | 3 442,00 |     15 250,30 |
| **Total** |           |          |          | **89 237,10** |

- **À vérifier :** ouvrir `recap.xlsx` dans Excel (ou Numbers) et contrôler que le graphique s'affiche. Ce point n'a encore jamais été vérifié.

### 3. Recherche web

> Quelle est la dernière version LTS de Node.js ?

- **Attendu :**
  - l'agent appelle `web_search` ;
  - il lit au moins une source avec `web_fetch`, ce qui déclenche une permission par domaine ;
  - sa réponse cite l'URL de la source.

### 4. Documents et vision

Glisser dans le chat `rapport-annuel-2025.pdf`, `facture-scannee.pdf` et `ticket-de-caisse.jpg`, puis :

> Résume le rapport et fais un tableau des montants de la facture et du ticket

- **Attendu :**
  - le PDF de 30 pages est lu **par tranches de pages** ;
  - la facture et le ticket passent par le **modèle vision** (`look_at`) ;
  - l'agent produit un tableau correct.
- **Résumé : faits à retrouver**, un par chapitre. Par exemple :
  - chiffre d'affaires de 4,2 M€ (+12 %) ;
  - 54 personnes ;
  - résultat net de 238 000 € ;
  - objectif 2026 de 4,8 M€ et ouverture d'un magasin à Mons.
- **Tableau attendu :**

| Document                                | Ligne                     | Qté |  P.U. |                     Montant |
| --------------------------------------- | ------------------------- | --: | ----: | --------------------------: |
| Facture F-2026-0142 (12/03/2026)        | Ramettes papier A4 80 g   |  20 |  4,50 |                       90,00 |
|                                         | Cartouches toner noir     |   3 | 62,00 |                      186,00 |
|                                         | Reliure de rapports       |  12 |  7,25 |                       87,00 |
|                                         | Total HT / TVA 21 % / TTC |     |       | 363,00 / 76,23 / **439,23** |
| Ticket Boulangerie du Parc (18/03/2026) | Pain au levain            |   1 |  4,20 |                        4,20 |
|                                         | Croissant                 |   4 |  1,30 |                        5,20 |
|                                         | Tarte aux pommes          |   1 | 12,50 |                       12,50 |
|                                         | Café                      |   2 |  2,80 |                        5,60 |
|                                         | Total TTC (dont TVA 6 %)  |     |       |            **27,50** (1,56) |

### 5. Réseau de la VM coupé par défaut

> Lance `curl https://example.com` dans la VM

- **Attendu :** la commande échoue tant que le réseau de la VM n'est pas autorisé dans le panneau latéral. Une fois l'interrupteur activé, la même commande réussit.

### 6. Qualité

```bash
pnpm test && pnpm lint && pnpm typecheck
```

- **Attendu :** les trois commandes passent, localement et dans la CI (`macos-14`).

## Journal des répétitions

| Date | Machine et modèle | 1   | 2   | 3   | 4   | 5   | 6   | Notes |
| ---- | ----------------- | --- | --- | --- | --- | --- | --- | ----- |
