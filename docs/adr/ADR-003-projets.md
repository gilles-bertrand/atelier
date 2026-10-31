# ADR-003 : projets (dossiers multiples, consignes, mémoire, tâches planifiées et artefacts)

- **Statut** : accepté. Gilles a validé le 2026-10-31 les options recommandées : D2 `~/Atelier/Projets`, D4 « l'agent propose, l'utilisateur valide », D5 artefacts interactifs isolés, et la livraison par un seul responsable (§5).
- **Ticket** : #22 « Project Management Feature ». Liés : #24 (dossiers créés par l'app), #21 (dossier d'une conversation : « les dossiers servent-ils de mémoire ? »).
- **Auteur** : fullstack
- **Impact** : `packages/shared` (Lead), `packages/agent-core` et `packages/documents`, `packages/sandbox`, `apps/desktop` main et renderer, `qa/`

## 1. Contexte

Le ticket demande la notion de **projet**, comme dans Claude (Cowork, Code) :

- un projet regroupe des **tâches qui s'exécutent de manière répétitive** et des **artefacts** : rapports et pages HTML qui évoluent à chaque exécution ;
- il a une **mémoire centrale** ;
- l'agent doit pouvoir **lire et écrire dans plusieurs dossiers**, pas un seul ;
- les artefacts sont gérés **comme dans Claude Code** : une page publiée a une identité stable, et la republier crée une nouvelle version au lieu d'une nouvelle page.

État du code au 2026-10-31 :

- **Une conversation = un dossier** (`SessionSummary.workspace`). La colonne de gauche groupe les conversations par dossier. Rien ne relie deux conversations entre elles : chacune repart de zéro.
- **Outils fichiers confinés à un dossier.** `resolveWorkspacePath` refuse tout chemin hors du dossier de travail (liens symboliques compris). Seule exception : la racine des skills, en lecture seule (`readRoots`, #60), avec la correspondance chemin hôte ↔ chemin VM.
- **VM : un seul dossier monté** sur `/workspace` (écriture), plus `/skills` (lecture seule). Changer de dossier redémarre la VM (7 à 9 s). `WorkspaceLease` sérialise les tours par dossier (ADR-002 D5).
- **Runtimes partagés par modèle** (LRU de 3). Tout ce qui est propre à une conversation passe par `CreateSessionOptions`, jamais par le runtime (leçon d'ADR-002).
- **Tâches planifiées liées à un dossier** ; chaque run est une conversation (`scheduledTaskId`).
- **Aperçu** : `atelier-file:` sert le HTML en `text/plain`, et `file:open` refuse le HTML (liste blanche). C'est ce qu'a rencontré #24 : la tâche a produit une page, mais l'app ne pouvait pas l'afficher ni l'ouvrir.

## 2. Modèle

| Élément           | Contenu                                                                                                               | Stockage                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Identité          | nom, description                                                                                                      | SQLite `projects`                       |
| Dossiers          | 1 à 10 dossiers : le **principal** puis les dossiers **rattachés**, chacun en lecture seule ou en lecture et écriture | SQLite `project_folders`                |
| Consignes         | texte écrit par l'utilisateur, suivi dans chaque conversation et chaque run du projet                                 | SQLite `projects.instructions`          |
| Mémoire           | notes retenues par l'agent et l'utilisateur, relues à chaque tour, avec historique                                    | SQLite `project_memory_revisions`       |
| Conversations     | conversations du projet                                                                                               | `sessions.project_id`                   |
| Tâches planifiées | tâches du projet ; leurs runs héritent des dossiers, des consignes et de la mémoire                                   | `scheduled_tasks.project_id`            |
| Artefacts         | pages HTML ou Markdown publiées, versionnées                                                                          | SQLite `artifacts`, `artifact_versions` |

Les conversations **hors projet** ne changent pas : un dossier, la section « Dossiers » de la colonne de gauche. Réponse à la question de #21 : **un dossier ne porte ni consignes ni mémoire ; c'est le rôle du projet.**

## 3. Décisions

### D1. Dossiers multiples : un principal et des dossiers rattachés

- Le **dossier principal** est la racine des chemins relatifs, `/workspace` dans la VM, et la destination par défaut des livrables. Il est toujours en lecture et écriture.
- Chaque **dossier rattaché** a :
  - un **libellé** unique dans le projet (par défaut le nom du dossier), montré au modèle et dans les cartes de fichiers ;
  - un **accès** : « lecture seule » ou « lecture et écriture » (défaut) ;
  - un point de montage `/dossiers/<libellé normalisé>` dans la VM, monté en lecture seule si le dossier l'est. La VM applique donc elle aussi l'accès choisi.
- **Règles d'ajout.** Ce sont celles du dossier de travail actuel : pas la racine du disque, pas le `$HOME` entier, pas les données de la VM ni le dossier des skills, un dossier qui existe. S'y ajoute une règle : **pas d'imbrication**. Un dossier contenu dans un autre dossier du projet est refusé, sinon un dossier « lecture seule » serait modifiable par le montage de son parent.
- **Résolution des chemins** (agent-core, fonction pure, testée sans Electron) :
  1. Un chemin relatif part du principal. S'il n'existe pas dans le principal et que son premier segment est le libellé d'un dossier rattaché, il part de ce dossier (« Compta/bilan.xlsx »). C'est la même tolérance que `skills/<nom>/…` (#60), utile à Qwen.
  2. Un chemin absolu côté hôte doit se trouver, une fois canonique (liens symboliques résolus), dans l'un des dossiers du projet.
  3. Un chemin VM (`/workspace/…`, `/dossiers/<x>/…`) est ramené au chemin hôte.
  4. Les outils d'écriture (`write_file`, `edit_file`) refusent un dossier en lecture seule : « Le dossier « Archives » est en lecture seule. »
- **Ce que voit le modèle.** Le prompt système liste les dossiers : libellé, chemin hôte, chemin VM et accès. `list_dir` à la racine du principal les rappelle.
- **Fichiers produits.** Une carte hors du principal s'affiche `<libellé>/<chemin relatif>`. La photo des fichiers produits (#44) couvre tous les dossiers en écriture, sous le plafond commun de 5 000 entrées.
- **Ouverture et aperçu.** Les dossiers des projets connus s'ajoutent aux lieux autorisés de `file:open`, `file:reveal` et `atelier-file:`.
- **VM.** Tous les dossiers du projet sont montés. Passer d'un projet à un autre remonte la VM (7 à 9 s, comme un changement de dossier aujourd'hui). Le bail `WorkspaceLease` porte sur **l'ensemble des montages** (principal, dossiers rattachés, accès), et non plus sur le seul dossier : deux conversations du même projet ne se gênent pas.
- **Relecture à chaque tour.** Les conversations d'un projet relisent ses dossiers au début de chaque tour. Un dossier ajouté sert dès le tour suivant, jamais pendant un tour.

### D2. Dossier créé pour un nouveau projet (validé : `~/Atelier/Projets`)

À la création, l'utilisateur choisit le dossier principal :

- « Créer un dossier pour ce projet » (choix par défaut) : l'app crée `<racine des projets>/<Nom du projet>/` ;
- « Utiliser un dossier existant » : un projet créé à partir d'un dossier de travail actuel.

Racine des projets, deux options :

| Option                                | Pour                                                                                                                                                                                  | Contre                                                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`~/Atelier/Projets/`** (recommandé) | Même racine que `~/Atelier/skills` et `~/Atelier/mcp.json` : un seul dossier pour tout ce que crée l'app (#24). Visible dans le Finder. Hors de la synchronisation iCloud par défaut. | Moins habituel que Documents pour un non-développeur.                                                                                                                   |
| `~/Documents/Atelier/Projets/`        | Là où l'utilisateur cherche ses fichiers (demande de #24).                                                                                                                            | Si « Bureau et Documents » est synchronisé dans iCloud (réglage fréquent), les livrables et les artefacts partent chez Apple : contraire à la souveraineté des données. |

La racine est modifiable dans les Réglages (`AppSettings.projectsDir`). Renommer un projet ne renomme pas son dossier : les chemins déjà cités dans les conversations restent valides.

### D3. Consignes du projet

- Texte libre d'au plus 4 000 caractères, écrit par l'utilisateur dans la page du projet (« Réponds en tableau », « Le client s'appelle… »).
- Il est ajouté au prompt système de chaque conversation et de chaque run du projet, dans une section « Consignes du projet ».
- Il a la confiance des messages de l'utilisateur : c'est une **instruction**, contrairement à la mémoire (D4).

### D4. Mémoire du projet (validé : l'agent propose, l'utilisateur valide)

**Contenu et lecture.**

- Un document Markdown par projet, stocké dans SQLite avec **chaque révision** : contenu, source (`user` ou `agent`), conversation ou run d'origine, date.
- Il est relu au début de chaque tour, conversation ou run, et injecté dans le prompt système, section « Mémoire du projet ». Il est borné à 8 000 caractères (environ 2 300 tokens). Au-delà, la fin est coupée, avec une note, et la page du projet affiche une jauge qui invite à faire le tri.
- **Cadrage de sécurité.** La mémoire est présentée au modèle comme des **notes de travail, donc de la donnée**. Seuls les messages de l'utilisateur et les Consignes (D3) sont des instructions. Raison : l'agent écrit la mémoire après avoir lu des fichiers et des pages web, donc une injection pourrait s'y glisser et revenir dans toutes les conversations suivantes.

**Écriture**, option recommandée : l'agent propose, l'utilisateur valide.

- `memory_add({ note })` ajoute une ligne datée sous « Notes » ; `memory_rewrite({ content })` réécrit le tout (« fais le tri dans la mémoire »).
- Les deux outils demandent une permission de nature **`memory_write`** (nouvelle valeur de `PermissionKind`). La modale affiche la note ou le diff, avec « une fois », « toujours pour cette conversation » ou « refuser ».
- **Runs planifiés** : nouvelle case « Mettre à jour la mémoire du projet », décochée par défaut (`ScheduledPermissions.memory`). « Créer et modifier des fichiers » ne la couvre pas : la mémoire n'est pas un fichier, aucun `edit_file` ne la contourne.
- **Page du projet** : lecture, édition, historique des révisions avec leur source, et « Revenir à cette version ».
- **Prompt** : il dit quoi retenir (décisions, préférences, informations durables comme des noms, échéances ou conventions, l'état d'un travail en plusieurs fois) et quoi ne jamais retenir (secrets, contenu brut d'un document).

Autres options présentées à Gilles :

- **Automatique** : l'agent écrit sans demander, comme la mémoire de Claude. C'est fluide, mais une page web piégée peut écrire une consigne permanente sans témoin. L'historique la montrerait après coup.
- **Manuelle** : seul l'utilisateur écrit, l'agent lit. C'est sûr, mais l'agent n'apprend rien.

Pourquoi pas un fichier `MEMOIRE.md` dans le dossier du projet : c'est souverain et lisible dans le Finder, mais `edit_file` le modifierait avec la seule permission « fichiers ». Un run planifié qui écrit des rapports pourrait alors modifier la mémoire, et la case dédiée n'aurait plus de sens. Un export Markdown reste possible depuis la page du projet.

### D5. Artefacts (validé : pages interactives isolées)

**Définition.** Un artefact est une page **publiée** par l'agent, avec un titre, une description et des versions. C'est le modèle de Claude Code : republier le même fichier met à jour la même page et crée une nouvelle version.

**Publication.**

- L'outil `publish_artifact({ path, title, description? })` publie un fichier `.html`, `.htm` ou `.md` qui existe dans un dossier du projet, écrit avant par `write_file`, `edit_file` ou `bash`.
- Publier photographie le contenu dans `artifact_versions`. Aucun fichier n'est modifié, donc aucune permission n'est demandée : la page a déjà été écrite avec permission.
- Identité : le projet et le chemin canonique du fichier. Une conversation hors projet peut aussi publier (`project_id` NULL).
- Limites : 5 Mio par version, 30 versions gardées par artefact. Les plus anciennes sont purgées.
- Le chat affiche une carte « Artefact publié · v3 » (nouvelle variante `ToolDisplay` `artifact`). Un clic ouvre la page dans le panneau droit, à la place de l'aperçu de fichier.

**Ce que dit le prompt.**

- Pour un rapport, un tableau de bord ou une page à consulter, écrire `Artefacts/<nom>.html` dans le dossier principal puis publier.
- La page est **autonome** : CSS, script, données et images (SVG ou `data:`) intégrés, aucune ressource externe.
- Une page qui doit évoluer (tableau de bord, rapport récurrent) réutilise **toujours le même fichier**.
- Le prompt liste les artefacts du projet (titre et chemin, 20 au plus), pour que le modèle retrouve le fichier à republier.
- Un skill d'exemple `artefact-html` fournit un gabarit (structure, styles, graphique) que le modèle n'a qu'à remplir.

**Évolution à chaque exécution.** Un run planifié qui republie la page crée une nouvelle version, marquée avec la tâche et le run : « v12 · Rapport hebdo · 31/10 à 08:00 ». C'est « la page qui évolue selon l'exécution » du ticket.

**Affichage.** La page du projet a un onglet Artefacts : vignettes (titre, description, dernière mise à jour, auteur : conversation ou tâche), puis une visionneuse plein écran avec le sélecteur de version et « Afficher dans le Finder ». Le fichier source reste visible dans `Artefacts/` du dossier principal (#24). Le Markdown est rendu par le composant Markdown existant, sans HTML brut.

**Isolation**, quelle que soit l'option retenue sur les scripts :

- **Protocole dédié** `atelier-artifact://<id>/v<N>/`, servi depuis SQLite, avec une CSP stricte : `default-src 'none'`, `connect-src 'none'`, `form-action 'none'`.
- **`<iframe sandbox>` sans `allow-same-origin`.** La page a une origine opaque : elle n'accède ni à `window.atelier` (le preload n'expose l'API qu'au cadre principal), ni au stockage, ni aux cookies. Sans `allow-forms`, `allow-popups` ni `allow-top-navigation`, elle n'envoie aucun formulaire, n'ouvre aucune fenêtre et ne remplace pas l'app.
- **Aucun réseau.** Le main bloque toute navigation de sous-cadre hors `atelier-artifact:` (`will-frame-navigate`). Sans ce garde-fou, une page piégée pourrait se rediriger vers `https://…?donnees` et faire sortir des données. Les CSP actuelles ne couvrent que le cadre principal (`will-navigate`).
- **Pas d'« Ouvrir dans le navigateur ».** Hors de l'app, la page tournerait avec le réseau. `file:open` continue de refuser le HTML ; « Afficher dans le Finder » reste possible.

**Choix des scripts** (option « Interactive » validée par Gilles le 2026-10-31).

| Option                       | Ce que permet la page                                                                                                                                                                                                                                                          | Risque résiduel                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Interactive** (recommandé) | Scripts intégrés (`script-src 'unsafe-inline'`) : tableaux triables, filtres, onglets, graphiques. Une bibliothèque de graphiques (Chart.js) est servie **localement** (`atelier-artifact://lib/…`), jamais par un CDN : la page fonctionne hors ligne et rien ne sort du Mac. | Une page piégée peut boucler et figer sa vue. Elle tourne dans un processus séparé (isolation de sites de Chromium), ce que L5 vérifie. Repli prévu : une `WebContentsView` dédiée. |
| Statique                     | HTML, CSS et SVG seulement : graphiques dessinés en SVG par le modèle, pas de tri ni de filtre.                                                                                                                                                                                | Quasi nul.                                                                                                                                                                          |

### D6. Tâches planifiées d'un projet

- `ScheduledTaskInput.projectId?` : la tâche hérite des dossiers, des consignes et de la mémoire du projet. `workspace` reste le dossier principal (affichage, compatibilité).
- Le formulaire gagne un champ « Projet ». « Aucun » garde le dossier unique d'aujourd'hui.
- Politique de permissions d'ADR-002 D4 :
  - « Créer et modifier des fichiers » vaut pour tous les dossiers en lecture et écriture du projet. Les dossiers en lecture seule restent refusés par les outils et par la VM.
  - S'y ajoute la case « Mettre à jour la mémoire du projet » (D4).
  - `publish_artifact` ne demande rien (D5).
- Le run d'une tâche de projet crée une conversation de ce projet (`projectId`), toujours absente des « Récentes ».
- Le tableau de bord global garde toutes les tâches, avec une colonne Projet. La page du projet montre les siennes.
- Archiver un projet désactive ses tâches ; le désarchiver ne les réactive pas d'office.

### D7. Interface

**Colonne de gauche** (spec #7, plus ADR-002) :

1. ＋ Nouvelle conversation. ⌘N l'ouvre dans le projet de la conversation courante, sinon dans son dossier.
2. Recherche (⌘K).
3. « Récentes », avec le nom du projet ou du dossier.
4. **« Projets »** (nouveau) : une ligne par projet, dépliable sur ses conversations. Un clic sur le nom ouvre la page du projet. Un bouton « Nouveau projet » sur le titre de section. Menu « … » : Nouvelle conversation, Afficher le dossier dans le Finder, Archiver.
5. « Dossiers » : les conversations hors projet. Le menu « … » gagne « Créer un projet à partir de ce dossier » : le dossier devient le principal, et ses conversations rejoignent le projet.
6. Pied de colonne : Tâches planifiées, Environnement, Réglages.

**Page du projet** :

- **En-tête** : nom (renommable), description, et une zone de saisie qui démarre une conversation dans le projet.
- **Onglets** :
  - **Conversations** ;
  - **Artefacts** (D5) ;
  - **Tâches** : celles du projet, et « Nouvelle tâche » avec le projet présélectionné ;
  - **Mémoire et consignes** (D3, D4) ;
  - **Dossiers** : ajouter, retirer, renommer le libellé, changer l'accès, choisir le principal.

**Conversation d'un projet** :

- une pastille du projet dans l'en-tête, qui ramène à sa page ;
- le panneau Environnement liste les dossiers montés.

**Nouveau projet** : une modale demande le nom, la description (facultative), le dossier principal (D2) et des dossiers rattachés (facultatifs, ajoutables plus tard).

**Archiver** masque le projet et suspend ses tâches.

**Supprimer** retire de l'app, après confirmation, le projet, ses conversations, ses tâches, sa mémoire et l'historique de ses artefacts. La confirmation donne les nombres. **Aucun fichier n'est supprimé du disque**, et le message le dit.

### D8. Persistance (migration SQLite n° 5)

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE TABLE project_folders (
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,          -- 0 = dossier principal
  path TEXT NOT NULL,
  label TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('read', 'write')),
  PRIMARY KEY (project_id, path),
  UNIQUE (project_id, label)
);
CREATE TABLE project_memory_revisions (
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('user', 'agent')),
  session_id TEXT REFERENCES sessions (id) ON DELETE SET NULL,
  run_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, revision)
);
ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects (id) ON DELETE CASCADE;
ALTER TABLE scheduled_tasks ADD COLUMN project_id TEXT REFERENCES projects (id) ON DELETE CASCADE;
CREATE INDEX sessions_project ON sessions (project_id, updated_at DESC);
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects (id) ON DELETE CASCADE,
  path TEXT NOT NULL,                 -- chemin canonique du fichier source
  title TEXT NOT NULL,
  description TEXT,
  format TEXT NOT NULL CHECK (format IN ('html', 'markdown')),
  version INTEGER NOT NULL,           -- dernière version publiée
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX artifacts_identity ON artifacts (COALESCE(project_id, ''), path);
CREATE TABLE artifact_versions (
  artifact_id TEXT NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content BLOB NOT NULL,
  size INTEGER NOT NULL,
  session_id TEXT REFERENCES sessions (id) ON DELETE SET NULL,
  run_id TEXT,
  task_name TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, version)
);
```

- **Mémoire.** La mémoire courante est la dernière révision. On garde 100 révisions par projet ; les plus anciennes sont purgées, sauf la première.
- **Concurrence.** L'enregistrement depuis la page du projet passe la révision lue (`baseRevision`). Si l'agent a écrit entre-temps, l'app répond `project/conflict` et la page propose de fusionner.
- **Purge des runs** (ADR-002, 90 jours). Elle ne touche pas aux versions d'artefacts : celles-ci ont leur propre plafond de 30.

## 4. Contrat `packages/shared` (demande au Lead)

Tout est **nouveau ou optionnel**, sauf deux unions qui gagnent un membre : `ToolDisplay` (`artifact`) et `PermissionKind` (`memory_write`). Les `switch` exhaustifs sur ces deux unions sont à compléter : renderer (`ToolDisplays`, modale de permission), `chat-reducer`, CLI d'agent-core et `unattendedPermissionHandler`.

```ts
// projects.ts (nouveau module)
export type ProjectFolderAccess = 'read' | 'write';
export interface ProjectFolder {
  path: string;                 // absolu côté hôte
  label: string;                // unique dans le projet
  access: ProjectFolderAccess;  // le principal (index 0) est toujours 'write'
}
export interface ProjectInput {
  name: string;                 // 1..80 caractères
  description?: string;         // ≤ 500
  instructions?: string;        // ≤ 4 000
  /** Absent à la création : l'app crée `<projectsDir>/<name>/` comme principal. */
  folders?: ProjectFolder[];    // 1..10, le premier est le principal
}
export interface Project {
  id: string;
  name: string;
  description: string;
  instructions: string;
  folders: ProjectFolder[];
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}
export interface ProjectSummary extends Project {
  conversations: number;
  tasks: number;
  artifacts: number;
  lastActivityAt?: string;
}
export interface ProjectMemory {
  content: string;
  revision: number;             // 0 = vide, jamais écrite
  updatedAt?: string;
}
export interface MemoryRevision {
  revision: number;
  content: string;
  source: 'user' | 'agent';
  sessionId?: string;
  runId?: string;
  createdAt: string;
}
export type ArtifactFormat = 'html' | 'markdown';
export interface Artifact {
  id: string;
  projectId?: string;
  path: string;
  title: string;
  description?: string;
  format: ArtifactFormat;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Provenance de la dernière version. */
  sessionId?: string;
  runId?: string;
  taskName?: string;
}
export interface ArtifactVersion {
  artifactId: string;
  version: number;
  size: number;
  createdAt: string;
  sessionId?: string;
  runId?: string;
  taskName?: string;
}
export const ARTIFACT_SCHEME = 'atelier-artifact';
export const GUEST_FOLDERS = '/dossiers';
export const MAX_PROJECT_FOLDERS = 10;
export const MAX_PROJECT_INSTRUCTIONS_CHARS = 4_000;
export const MEMORY_PROMPT_CHARS = 8_000;
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
export const MAX_ARTIFACT_VERSIONS = 30;
export function artifactUrl(id: string, version?: number): string;       // atelier-artifact://<id>/v<N>/
export function folderGuestPath(label: string): string;                   // /dossiers/<libellé normalisé>
export function validateProjectInput(input: ProjectInput): ProjectValidationIssue | undefined;

// tools.ts : dossiers rattachés de la session (en plus de `workspace`, le principal)
export interface WorkspaceFolder extends ProjectFolder {
  guestPath?: string;           // présent si monté dans la VM
}
ToolExecutionContext.folders?: readonly WorkspaceFolder[];

// messages.ts
SessionSummary.projectId?: string;
ToolDisplay |= { type: 'artifact'; artifact: Pick<Artifact, 'id' | 'title' | 'version' | 'format' | 'path'> };

// permissions.ts
PermissionKind |= 'memory_write';

// schedule.ts
ScheduledTaskInput.projectId?: string;
ScheduledPermissions.memory?: boolean;    // absent = false

// sandbox.ts
export interface SandboxFolderMount { host: string; guest: string; writable: boolean }
Sandbox.setWorkspace(hostDir: string, folders?: readonly SandboxFolderMount[]): Promise<void>;
SandboxStatus.folders?: SandboxFolderMount[];
SandboxHolder.projectName?: string;

// settings.ts
AppSettings.projectsDir?: string;         // absent = ~/Atelier/Projets (D2)

// ipc.ts : canaux d'invocation
'project:list':           { request: { includeArchived?: boolean }; response: ProjectSummary[] };
'project:get':            { request: { id: string }; response: Project };
'project:create':         { request: { project: ProjectInput }; response: Project };
'project:update':         { request: { id: string; patch: Partial<ProjectInput> }; response: Project };
'project:set-archived':   { request: { id: string; archived: boolean }; response: Project };
'project:delete':         { request: { id: string }; response: undefined };
/** Projet dont le principal est `workspace` ; les conversations hors projet de ce dossier le rejoignent. */
'project:from-folder':    { request: { workspace: string; name?: string }; response: Project };
'project:memory':         { request: { id: string }; response: ProjectMemory };
'project:memory-save':    { request: { id: string; content: string; baseRevision: number }; response: ProjectMemory };
'project:memory-history': { request: { id: string; limit?: number }; response: MemoryRevision[] };
'artifact:list':          { request: { projectId?: string }; response: Artifact[] };
'artifact:get':           { request: { id: string }; response: Artifact };
'artifact:versions':      { request: { id: string }; response: ArtifactVersion[] };
/** Retire l'artefact de l'app (versions comprises) ; le fichier source reste sur le disque. */
'artifact:delete':        { request: { id: string }; response: undefined };
'session:create'          // request gagne projectId?: string ; workspace = alors le dossier principal du projet
'session:list'            // request gagne projectId?: string (filtre)
// canaux d'événement
'project:changed':        { projectId: string };
'artifact:changed':       { artifact: Artifact; deleted?: boolean };

// errors.ts
'project/invalid'      // details.field, message français de validateProjectInput
'project/not_found'
'project/conflict'     // mémoire modifiée entre la lecture et l'enregistrement
'artifact/not_found'
'tool/read_only'       // écriture dans un dossier en lecture seule
```

Précisions apportées par la PR de L0 (`feat/lead-shared-projects`) :

- **Fonctions pures en plus** : `artifactFormatOf` (avec `ARTIFACT_EXTENSIONS`), `defaultFolderLabel`, `projectDirName` (nom du dossier créé, sans `/`, `:` ni point de tête) et `isSameOrInside` (inclusion par segments entiers). Sont aussi ajoutés `folderGuestName`, `MAX_PROJECT_NAME_CHARS`, `MAX_PROJECT_DESCRIPTION_CHARS`, `MAX_FOLDER_LABEL_CHARS`, `MAX_MEMORY_CHARS` et `MAX_MEMORY_REVISIONS`.
- **`validateProjectInput` valide un projet complet.** Une modification se valide sur le projet enregistré auquel on applique le patch. Le résultat `ProjectValidationIssue` porte `field` et, pour un dossier, `index`. Deux noms courts qui donnent le même dossier dans la VM (« Été 2026 » et « Ete-2026 ») sont refusés.
- **Emplacements** : `GUEST_FOLDERS` vit dans `sandbox.ts`, à côté de `GUEST_WORKSPACE`. `ArtifactCard` et `MemorySource` sont des types nommés.
- **`session:create`** garde `workspace` obligatoire, ce qui ne casse aucun appel existant. Avec `projectId`, le main vérifie que `workspace` est le dossier principal du projet.
- **Nouveaux éléments** : le canal `artifact:get` (carte du chat → visionneuse) et `deleted?` dans `artifact:changed`.
- **Le main compte toujours sur l'IPC partiel** (`IpcHandlers`) : un canal pas encore branché répond `internal`, comme pour ADR-002.

## 5. Répartition

| Lot | Contenu                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Dépend de  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| L0  | **shared** : §4, avec `validateProjectInput`, `folderGuestPath` et `artifactUrl` testés. PR `feat/lead-shared-projects`.                                                                                                                                                                                                                                                                                                                                                                              | n/a        |
| L1  | **agent-core et documents** : résolution multi-dossiers (D1) pour les outils natifs et pour `read_file`, `look_at` et les pièces jointes de documents ; sections du prompt (dossiers, consignes, mémoire, artefacts) ; `CreateSessionOptions.project` (getters relus à chaque tour) ; outils `memory_add`, `memory_rewrite` et `publish_artifact` (I/O injectées) ; `memory_write` dans `unattendedPermissionHandler` ; skill d'exemple `artefact-html`.                                              | L0         |
| L2  | **sandbox** : montages multiples (`/dossiers/<x>`, lecture seule selon l'accès), correspondance hôte ↔ VM, règles d'ajout pour chaque dossier, comparaison des montages au démarrage.                                                                                                                                                                                                                                                                                                                 | L0         |
| L3  | **main** : migration n° 5 ; `ProjectStore`, `MemoryStore`, `ArtifactStore` (SQLite et mémoire) ; création du dossier du projet ; protocole `atelier-artifact:` et garde `will-frame-navigate` ; Chart.js servi localement ; handlers IPC ; `ChatManager` et `AgentRuntimeHost` passent le contexte de projet par session ; bail sur la signature des montages ; photo multi-dossiers ; lieux autorisés de l'ouverture et de l'aperçu ; tâches de projet ; « Créer un projet à partir de ce dossier ». | L0, L1, L2 |
| L4  | **renderer** : section Projets, page du projet et ses onglets, modale de création, visionneuse d'artefacts et sélecteur de version, carte d'artefact dans le chat, pastille de projet, champ Projet et case mémoire dans le formulaire de tâche, modale `memory_write`, Réglages (`projectsDir`).                                                                                                                                                                                                     | L0, L3     |
| L5  | **QA** : e2e en mode mock (§7) ; scénario réel « tableau de bord hebdo » dans `docs/QA.md`.                                                                                                                                                                                                                                                                                                                                                                                                           | L4         |

**Livraison (validée le 2026-10-31) : un seul responsable.**

- fullstack réalise L0 à L5, une PR par lot.
- La PR de L0 est soumise au Lead, qui la relit et la merge (règle n° 1 de `CLAUDE.md`).
- Core et UI relisent les PR de leur périmètre.
- Raison : les lots touchent les mêmes contrats (chemins, montages, contexte de session), et un seul auteur les garde cohérents.
- Option écartée, la répartition par rôle comme ADR-002 : chaque agent aurait dû être relancé par Gilles, et la coordination aurait coûté des allers-retours.

## 6. Sécurité (brief §8)

- **Dossiers.** L'accès est appliqué deux fois : par les outils (chemin canonique, liens symboliques compris) et par la VM (montage en lecture seule). L'imbrication est interdite. Les dossiers interdits restent ceux du dossier de travail (racine, `$HOME` entier, données de la VM, skills).
- **Instructions contre données.** Les Consignes et les messages de l'utilisateur sont des instructions. Mémoire, fichiers, pages web, réponses MCP et artefacts restent de la donnée.
- **Mémoire.** Ses écritures sont soumises à permission (D4). Les runs ont besoin d'une case explicite. Chaque révision est tracée avec sa source et peut être annulée.
- **Artefacts.** Isolation de D5 : origine opaque, aucun réseau, aucune navigation, aucun accès à l'API de l'app. Le HTML n'est jamais ouvert hors de l'app par `file:open`. Taille et nombre de versions sont plafonnés.
- **Souveraineté.** Tout reste sur le Mac : `userData/atelier.db` et les dossiers du projet. Pas de CDN dans les artefacts. D2 recommande une racine hors de la synchronisation iCloud.

## 7. Tests attendus (Definition of Done)

- **shared** : `validateProjectInput` (nom vide ou trop long, 0 ou 11 dossiers, libellés en double, principal en lecture seule) ; `folderGuestPath` (accents, espaces, caractères spéciaux) ; `artifactUrl`.
- **agent-core**
  - Résolution : relatif → principal ; « libellé/… » → dossier rattaché ; absolu dans un dossier rattaché accepté et hors des dossiers refusé ; chemin VM `/dossiers/x/…` ; lien symbolique qui sort refusé ; écriture en lecture seule refusée (`tool/read_only`).
  - Prompt : sections dossiers, consignes, mémoire (troncature à 8 000 caractères avec la note) et artefacts.
  - Outils : `memory_add` (ligne datée, permission `memory_write`, refus) ; `publish_artifact` (fichier absent, hors des dossiers, extension refusée, trop gros, même chemin = nouvelle version).
  - `unattendedPermissionHandler` : `memory_write` accordé seulement avec `memory: true`.
- **documents** : `read_file` et `look_at` dans un dossier rattaché ; pièce jointe dans le principal.
- **sandbox** : expression des montages ; `mountsMatch` avec dossiers rattachés ; lecture seule ; `toGuestPath` et `toHostPath` pour `/dossiers/x` ; refus des dossiers interdits.
- **main**
  - Migration n° 4 → n° 5 sur une base existante.
  - CRUD des projets ; création du dossier du projet ; refus de l'imbrication.
  - Mémoire : révisions, `project/conflict`, purge à 100.
  - Artefacts : publication, versions, plafond de 30, provenance (run ou tâche).
  - Protocole : version servie, CSP, 404 sur un artefact inconnu.
  - Navigation de sous-cadre bloquée hors `atelier-artifact:`.
  - Bail : deux conversations du même projet sans attente, deux projets différents en attente.
  - Session de run avec `projectId` ; suppression d'un projet sans toucher au disque ; « Créer un projet à partir de ce dossier ».
- **renderer** (fausse `window.atelier`) : section Projets ; création ; onglets ; mémoire (édition, conflit, historique) ; visionneuse (iframe `sandbox="allow-scripts"` sans `allow-same-origin`, sélecteur de version) ; carte d'artefact dans le chat ; formulaire de tâche avec le projet.
- **e2e mock**
  - Créer un projet avec un dossier rattaché en écriture et un en lecture seule. L'agent écrit dans le premier, et l'écriture dans le second est refusée.
  - La mémoire écrite dans une conversation apparaît dans le prompt de la suivante.
  - Une tâche du projet, exécutée deux fois, publie la même page en v1 puis en v2, visible dans l'onglet Artefacts.
- `pnpm test && pnpm lint && pnpm typecheck` verts.

## 8. Options écartées

- **Projet réduit à une étiquette sur des conversations.** Ni dossiers multiples, ni mémoire : ne répond pas au ticket.
- **Copier les dossiers externes dans le dossier du projet.** Doublons et versions divergentes ; l'utilisateur ne sait plus quel fichier est le bon.
- **Monter tout le `$HOME` dans la VM pour accéder à plusieurs dossiers.** Contraire au brief §8.
- **Une VM par projet.** 4 Gio de RAM par VM, et un seul serveur LLM répond de toute façon.
- **Mémoire en notes structurées avec recherche** (à la manière d'AgentsRoom). Une étape de recherche de plus pour un modèle 9b ou 35b ; un document unique toujours présent dans le contexte est plus fiable. C'est une évolution possible (§9).
- **Artefacts servis par `atelier-file:` en `text/html`.** Même protocole que l'aperçu, servi au même cadre que l'app : pas d'isolation.
- **Bibliothèques des artefacts depuis un CDN.** Fuite (adresse IP, contenu des requêtes) et page inutilisable hors ligne.

## 9. Suites possibles (hors ticket)

- Artefacts « vivants » qui relisent un fichier de données du projet (`connect-src` limité aux fichiers de l'artefact), sans republier la page.
- Déplacer une conversation d'un projet à l'autre par glisser-déposer (#21).
- Export d'un artefact : HTML autonome ou PDF.
- Mémoire structurée et recherche sémantique (embeddings locaux).
- Fichiers de connaissance du projet, indexés et cités.
