---
name: artefact-html
description: Créer ou mettre à jour un artefact, c'est-à-dire une page HTML autonome publiée dans l'app (tableau de bord, page de suivi, rapport visuel avec graphiques et tableaux), qui évolue de version en version à chaque mise à jour ou exécution planifiée. À utiliser pour tout tableau de bord ou toute page à consulter dans Atelier.
triggers: [tableau de bord, artefact, page html]
---

# Skill artefact-html : une page publiée qui évolue

Un artefact est une page HTML que l'utilisateur ouvre dans Atelier, avec l'historique de ses
versions. Republier le même fichier crée une nouvelle version de la même page : c'est ainsi
qu'un tableau de bord suit les exécutions d'une tâche planifiée.

## Étapes

1. **Rassemble les données** : lis les fichiers (`read_file`), calcule les chiffres dans la
   machine isolée (Python) plutôt qu'à la main. Ne mets dans la page que des chiffres lus ou
   calculés pendant ce tour.
2. **Pars du modèle** `/skills/artefact-html/modele.html` : lis-le avec `read_file`, puis écris
   ta page avec `write_file` dans `Artefacts/<nom>.html` du dossier principal (nom court, sans
   espace : `Artefacts/tableau-ventes.html`). Remplace le titre, la date, les indicateurs, les
   données du graphique et les lignes du tableau.
3. **Publie** avec `publish_artifact` : `path` = le fichier, `title` = 2 à 5 mots
   (« Tableau des ventes »), `description` = une phrase.
4. **Mise à jour** (nouvelle exécution, nouvelles données) : modifie le **même fichier**
   (`edit_file` pour un changement ciblé, `write_file` pour tout réécrire), puis republie-le
   avec le même chemin. Ne crée jamais `tableau-ventes-v2.html` : la version est gérée par l'app.

## Règles de la page

- **Autonome** : CSS dans `<style>`, script dans `<script>`, données dans le fichier (bloc
  JSON `<script type="application/json" id="donnees">`), images en SVG ou en `data:`.
- **Aucune ressource externe** : ni CDN, ni police en ligne, ni image distante. La page
  s'affiche sans internet et le réseau y est coupé : une ressource externe serait bloquée.
- **Graphiques** : Chart.js est la seule bibliothèque disponible, à charger avec
  `<script src="atelier-artifact://lib/chart.umd.min.js"></script>`. Pour un graphique
  simple, un SVG écrit à la main convient aussi.
- **Pas de stockage** : `localStorage`, cookies et formulaires ne fonctionnent pas dans
  la visionneuse. Les filtres et tris restent dans la page (JavaScript).
- **Lisible** : titre, date de mise à jour, 3 ou 4 indicateurs clés en tête, puis les
  graphiques, puis le détail. Nombres au format français (`toLocaleString('fr-FR')`).
- **Thèmes** : le modèle gère le mode clair et le mode sombre ; garde ses variables CSS.

## Liste de contrôle

- [ ] Le fichier est dans `Artefacts/` et porte le même nom qu'à la version précédente.
- [ ] Aucune URL `http://`, `https://` ou `//` dans `src`, `href` de `<link>` ou `url(...)`.
- [ ] Chaque chiffre affiché vient d'un fichier lu ou d'un calcul fait pendant ce tour.
- [ ] La date de mise à jour est celle du jour.
- [ ] `publish_artifact` a été appelé après la dernière modification.
