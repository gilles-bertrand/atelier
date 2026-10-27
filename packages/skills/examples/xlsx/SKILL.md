---
name: xlsx
description: Créer un classeur Excel (.xlsx) propre avec plusieurs feuilles, des formules, une ligne de totaux et des graphiques (histogramme, barres, courbe, camembert), à partir de données (CSV, tableaux, résultats d'analyse). À utiliser dès qu'on demande un fichier Excel, un tableur ou un récapitulatif chiffré avec graphique.
---

# Skill xlsx : créer un classeur Excel

Ce skill fournit un script prêt à l'emploi, `scripts/build-workbook.cjs`, qui produit un
`.xlsx` à partir d'une description JSON. Il tourne dans la VM (Node 22 + exceljs déjà
installés) : **n'écris pas ton propre code exceljs**, décris le classeur et lance le script.

## Étapes

1. **Prépare les données** : lis les fichiers sources (CSV, xlsx…) et calcule les agrégats
   nécessaires (par mois, par catégorie…). Pour des CSV volumineux, utilise Python dans la VM
   (`python3` avec `pandas`) plutôt que de recopier les données à la main.
2. **Écris la spec JSON** dans le dossier de travail, par exemple `/workspace/.atelier/recap-spec.json`
   (voir le format ci-dessous ; `node /skills/xlsx/scripts/build-workbook.cjs --example` affiche un exemple complet).
3. **Génère le classeur** :
   ```bash
   node /skills/xlsx/scripts/build-workbook.cjs /workspace/.atelier/recap-spec.json /workspace/recap.xlsx
   ```
   Le script affiche un résumé JSON (feuilles, lignes, graphiques) ou une erreur explicite en français
   (code de sortie 1) : corrige la spec et relance.
4. **Présente le fichier** à l'utilisateur (`present_file`) et résume son contenu en 2-3 phrases.

## Format de la spec

```json
{
  "properties": { "title": "Récapitulatif des ventes 2026" },
  "sheets": [
    {
      "name": "Ventes par mois",
      "columns": [
        { "header": "Mois", "key": "mois" },
        { "header": "Quantité", "key": "qte", "type": "integer" },
        { "header": "Prix moyen", "key": "prix", "type": "currency" },
        {
          "header": "Chiffre d'affaires",
          "key": "ca",
          "type": "currency",
          "formula": "={qte}*{prix}"
        }
      ],
      "rows": [
        { "mois": "Janvier", "qte": 120, "prix": 12.5 },
        { "mois": "Février", "qte": 95, "prix": 12.5 }
      ],
      "totals": { "label": "Total", "functions": { "qte": "SUM", "ca": "SUM", "prix": "AVERAGE" } },
      "charts": [
        {
          "type": "column",
          "title": "Chiffre d'affaires par mois",
          "categories": "mois",
          "series": ["ca"]
        }
      ]
    }
  ]
}
```

| Élément                              | Règles                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sheets[].name`                      | 31 caractères max, sans `\ / ? * [ ] :`, unique                                                                                                  |
| `columns[].key`                      | identifiant (lettres, chiffres, `_`), utilisé dans `rows`, `formula`, `charts`                                                                   |
| `columns[].type`                     | `text` (défaut), `number`, `integer`, `currency` (€), `percent` (0.25 → 25 %), `date` (ISO `2026-01-31`)                                         |
| `columns[].width`                    | optionnel : largeur en caractères (sinon calculée)                                                                                               |
| `columns[].formula`                  | formule appliquée à chaque ligne sans valeur : `{clé}` = cellule de la même ligne, `{row}` = numéro de ligne                                     |
| `rows`                               | objets `{ clé: valeur }` ou tableaux dans l'ordre des colonnes ; une valeur qui commence par `=` est une formule (mêmes jetons `{clé}`, `{row}`) |
| `totals`                             | `true` (SUM des colonnes numériques) ou `{ "label", "functions": { clé: "SUM" \| "AVERAGE" \| "MIN" \| "MAX" \| "COUNT" } }`                     |
| `formulas`                           | cellules libres : `[{ "cell": "G2", "formula": "=D6/B6" }]`                                                                                      |
| `charts[].type`                      | `column` (histogramme), `bar` (barres horizontales), `line` (courbe), `pie` (camembert, une seule série)                                         |
| `charts[].categories` / `series`     | clés de colonnes (étiquettes / valeurs) ; les lignes de données, sans les totaux                                                                 |
| `charts[].anchor`, `width`, `height` | optionnels : cellule du coin haut-gauche (ex. `F2`), taille en colonnes / lignes                                                                 |

## Bonnes pratiques

- Une feuille par vue (« Ventes par mois », « Par produit », « Données brutes ») ; les données
  brutes en dernière feuille.
- Préfère des formules (`formula`, `totals`) à des valeurs recalculées à la main : l'utilisateur
  peut modifier les chiffres dans Excel et tout se met à jour. Les résultats sont aussi
  pré-calculés pour les aperçus.
- Les mois dans l'ordre chronologique, des en-têtes courts et explicites, l'unité dans l'en-tête
  si elle n'est pas évidente (« Montant (€) »).
- Vérifie le résultat : relis le fichier généré avec `read_file` (les valeurs calculées s'y affichent).
