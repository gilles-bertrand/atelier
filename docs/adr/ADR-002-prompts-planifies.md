# ADR-002 : prompts planifiés (tâches récurrentes) et tableau de bord des exécutions

- **Statut** : accepté (ADR validé par Gilles le 2026-10-31, y compris D1 scheduler dans le main, D4 permissions par cases à cocher, D7 tableau de bord global). L0 livré (PR #106), L1 livré (PR #105).
- **Ticket** : « Ajouter la notion de prompt qui s'exécute toutes les X temps »
- **Auteur** : architect
- **Impact** : `packages/shared` (Lead), `packages/agent-core` (Core), `apps/desktop` main et renderer (UI), `qa/` (QA)

## 1. Contexte

L'utilisateur veut enregistrer un prompt qui s'exécute tout seul à intervalle régulier : toutes les N minutes, chaque jour, chaque semaine, chaque mois ou chaque année. Le prompt doit pouvoir lire des fichiers, utiliser les connecteurs MCP et produire des fichiers. Les résultats doivent être consultables dans un tableau de bord, comme dans Claude Code.

Le ticket impose trois décisions : le scheduler, les permissions d'un agent qui tourne en l'absence de l'utilisateur, et le format d'affichage.

État du code au 2026-10-31 :

- **Cycle de vie.** Sur macOS, l'app reste active quand on ferme toutes les fenêtres (`window-all-closed` ne quitte pas sur `darwin`). En revanche, rien ne tourne une fois l'app quittée.
- **Permissions.** Toute demande porte une `scopeKey` stable : `write_file`, `edit_file`, `bash`, `web_fetch:<domaine>` ou `mcp__<serveur>__<outil>`. Elle porte aussi un `kind` (`file_write`, `command`, `network`, `mcp_write`, `other`…). `PermissionBroker` ouvre la modale et `withSessionMemory` mémorise les `allow_session`. Les outils en lecture (`read_file`, `list_files`, MCP `readOnlyHint`, `web_search`) ne demandent rien.
- **VM.** Il n'existe **qu'une seule VM, montée sur un seul dossier**. `SandboxManager.prepareForTurn(sessionId, workspace)` remonte la VM (arrêt puis démarrage, 7 à 9 s) quand le dossier change. Un run planifié dans un autre dossier pendant un tour interactif couperait donc les commandes de ce tour.
- **Persistance.** `userData/atelier.db` (node:sqlite) a des migrations versionnées par `PRAGMA user_version`, dont `usage_turns` (ADR-001), qui donne déjà les tokens de chaque tour.
- **Aperçu de fichiers.** Il sert le `.html` en `text/plain` (choix de sécurité). Afficher un rapport HTML produit par l'agent n'est donc pas gratuit (voir §8).

## 2. Décisions

### D1. Scheduler dans le process main, avec rattrapage (validé)

`TaskScheduler` (main) arme **un seul** `setTimeout` sur la plus proche `next_run_at` des tâches actives :

- le délai est plafonné à 1 h, puis le minuteur est réarmé, ce qui absorbe les dérives d'horloge et les changements d'heure ;
- l'état vit dans SQLite, rien n'est gardé en mémoire seulement ;
- au démarrage de l'app, au réveil du Mac (`powerMonitor` `resume`) et au déverrouillage, le scheduler appelle `catchUp()`.

**Rattrapage.** Une tâche active dont `next_run_at` est passée s'exécute **une seule fois** (`trigger: 'catch_up'`), quel que soit le nombre d'occurrences manquées. `next_run_at` est ensuite recalculée à partir de maintenant. On ne rejoue jamais une série : un rapport quotidien manqué pendant 5 jours de vacances donne un seul run au retour, pas cinq.

**L'app doit tourner.** Les Réglages gagnent l'option « Ouvrir Atelier à la connexion, fenêtre masquée » (`app.setLoginItemSettings({ openAtLogin, openAsHidden })`). Elle est proposée dès la création de la première tâche. Pendant un run, `powerSaveBlocker.start('prevent-app-suspension')` évite l'App Nap. Il n'empêche pas la mise en veille du Mac : c'est voulu, et le rattrapage s'en charge.

`TaskScheduler` dépend d'une interface `Clock` (`now()`, `setTimer()`) injectée. Les tests utilisent des minuteurs factices. Un futur déclencheur launchd (§8) remplacerait ce composant sans toucher au reste.

### D2. Récurrence : préréglages en français, calcul pur

```ts
type Schedule =
  | { kind: 'interval'; every: number; unit: 'minutes' | 'hours' } // every × unit ≥ 15 min
  | { kind: 'daily'; time: string } // 'HH:MM'
  | { kind: 'weekly'; days: IsoWeekday[]; time: string } // 1 = lundi … 7 = dimanche
  | { kind: 'monthly'; day: number; time: string } // 1..31, borné au dernier jour du mois
  | { kind: 'yearly'; month: number; day: number; time: string };
```

- `nextRunAt(schedule, after: Date): Date` est une **fonction pure**. Elle calcule en heure locale du Mac. Une heure qui n'existe pas (passage à l'heure d'été) est décalée à la première minute valide qui suit. Une heure ambiguë (passage à l'heure d'hiver) prend la première occurrence.
- Un `interval` part de `last_run_at`, sinon de la date de création. Il ne s'aligne pas sur l'horloge.
- **Plancher de 15 minutes.** Un tour local prend de 30 s à plusieurs minutes, et le serveur LLM est partagé avec l'utilisateur. Le plancher est validé dans `validateSchedule` et dans l'UI.
- `describeSchedule(schedule)` → « Tous les lundis et jeudis à 08:00 ». C'est la même fonction côté main (notifications) et côté renderer (aperçu des 3 prochaines exécutions dans le formulaire). Elle va donc dans `shared`.
- Aucune dépendance cron : les cinq formes couvrent la demande, et une expression cron n'a aucun sens pour un non-développeur.

### D3. Un run = une conversation dédiée

Chaque exécution crée une **nouvelle session**, liée à la tâche par `SessionSummary.scheduledTaskId`. Le prompt de la tâche y est le premier message. Le tour passe par le chemin existant de `ChatManager` : events, persistance, `usage_turns`, cartes de fichiers, aperçu.

Ce qu'on y gagne :

- pas d'historique qui grossit de run en run, donc pas de compaction ;
- chaque run se relit comme une conversation, et l'utilisateur peut y **répondre** pour poursuivre à la main ;
- les tokens remontent dans Réglages › Utilisation sans rien changer.

Ces sessions n'apparaissent pas dans les « Récentes » de la colonne de gauche : `session:list` les exclut sauf `includeScheduled: true`. On y accède par le tableau de bord.

**Instructions du mode autonome.** Elles sont ajoutées au prompt système via `extraInstructions` : « Tu travailles en l'absence de l'utilisateur. Ne pose pas de question et ne demande pas de confirmation. Si une action t'est refusée, n'essaie pas de la contourner et continue avec ce que tu peux faire. Termine par un compte rendu court : ce que tu as fait, les fichiers produits, ce qui a échoué. »

Les cinq premières lignes de ce compte rendu (500 caractères au plus) sont copiées dans `scheduled_runs.summary` pour le tableau de bord.

### D4. Permissions : politique déclarée par cases à cocher (validé)

À la création, l'utilisateur coche ce que la tâche a le droit de faire **sans lui**. Le run reçoit un `PermissionHandler` **non interactif** : il accorde ce qui est coché, **refuse tout le reste sans jamais ouvrir de modale**, et enregistre chaque refus dans le run.

| Case (libellé UI)                                                                      | Requêtes accordées                                                                                                                                   | Défaut  |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| _(toujours)_ Lire les fichiers du dossier, chercher sur le web, connecteurs en lecture | outils `permission: 'never'` : rien n'est demandé                                                                                                    | inclus  |
| Créer et modifier des fichiers dans le dossier                                         | `kind: 'file_write'` (`write_file`, `edit_file`)                                                                                                     | coché   |
| Exécuter des commandes dans la machine isolée                                          | `kind: 'command'` (`bash`)                                                                                                                           | décoché |
| Lire des pages web : « tous les sites » ou une liste de domaines                       | `kind: 'network'`, `scopeKey` `web_fetch:<domaine>` dans la liste ; réseau de la VM activé pour le run seulement si les commandes sont aussi cochées | décoché |
| Connecteurs en écriture : choix outil par outil dans le catalogue MCP                  | `kind: 'mcp_write'` dont la `scopeKey` figure dans la liste                                                                                          | aucun   |

Règles fixes, qu'on ne peut pas cocher :

- `kind: 'file_delete'` et `kind: 'other'` sont **toujours refusés** en mode autonome. Une suppression ou une action d'un type inconnu attend l'utilisateur.
- Les écritures restent confinées au dossier de la tâche : c'est la garde actuelle des outils, rien ne change.
- Domaines web **nominatifs** : la comparaison ignore la casse et un `www.` en tête, mais `example.com` ne couvre pas `docs.example.com`. Une demande `network` qui ne vient pas de `web_fetch:` est refusée, même avec `'*'` (amendement du 2026-10-31, PR #105).
- Les `permission_request` d'un run ne sont **pas relayés** au renderer. Le main filtre l'émetteur dans `runUnattended`, et le refus reste visible par `tool_result.denied` et `scheduled_runs.denied`.
- Une politique ne s'élargit jamais d'elle-même : pas d'apprentissage, pas de « toujours » mémorisé entre deux runs.

**Boucle de correction.** Le tableau de bord affiche « 3 actions refusées » sur le run. Un bouton « Autoriser pour cette tâche » ouvre le formulaire avec les cases correspondantes pré-cochées, et l'utilisateur valide. C'est la seule façon d'élargir les droits.

Le handler est une fonction pure d'agent-core : `unattendedPermissionHandler(policy, onDenied)`. Il est testable sans Electron.

### D5. Exclusion mutuelle sur la VM et le serveur

- **Un seul run planifié à la fois** (file FIFO). Il n'y a qu'un serveur LLM et une VM.
- **Pas de chevauchement par tâche.** Si la tâche a déjà un run en cours ou en file, l'occurrence est enregistrée `skipped` (motif `overlap`).
- **Bail sur la VM** (`WorkspaceLease`, main). Il n'est pris que si la politique coche « commandes », car seul `bash` utilise la VM. Un run sans commandes ne touche pas à la VM et ne bloque personne.
  - Un run qui a besoin de la VM alors qu'un tour interactif l'occupe dans **un autre dossier** attend : nouvel essai chaque minute pendant 30 minutes, puis `skipped` (motif `busy`).
  - Un tour interactif qui arrive pendant qu'un run occupe la VM dans un autre dossier attend la fin du run. Le Composer affiche « Une tâche planifiée utilise la machine isolée · Arrêter ».
  - Même dossier : aucun conflit, pas d'attente.
  - _Amendement du 2026-10-31 (retour d'UI)_ : le bail est **unique et partagé par dossier**. Les tours interactifs le prennent aussi, avec une attente sans limite que le bouton Arrêter interrompt. Effet de bord voulu : deux conversations dans des dossiers différents ne se coupent plus la VM. Qui tient le bail est publié dans `SandboxStatus.heldBy` (§3).
    - Un run planifié tient le bail : « Une tâche planifiée utilise la machine isolée · Arrêter », et Arrêter appelle `schedule:stop-run`.
    - Une autre conversation tient le bail (`runId` absent) : « Une autre conversation utilise la machine isolée », sans bouton.
  - Un run sans commandes ne remonte pas la VM : `beforeTurn` reçoit `sandbox: false`.
- **Durée maximale par run** : 20 minutes par défaut, réglable par tâche de 5 à 120. Au-delà, le run est annulé par l'`AbortSignal` existant et finit en statut `timeout`.

### D6. Persistance (migration SQLite n° 4)

```sql
CREATE TABLE scheduled_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  workspace TEXT NOT NULL,
  model TEXT,                       -- NULL = modèle par défaut des Réglages au moment du run
  schedule TEXT NOT NULL,           -- JSON Schedule
  permissions TEXT NOT NULL,        -- JSON ScheduledPermissions
  max_duration_min INTEGER NOT NULL DEFAULT 20,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT,                 -- ISO 8601 ; NULL si désactivée
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE scheduled_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  turn_id TEXT,                     -- jointure avec usage_turns (tokens)
  trigger TEXT NOT NULL,            -- schedule | catch_up | manual
  status TEXT NOT NULL,             -- queued | running | success | error | timeout | aborted | skipped | interrupted
  skip_reason TEXT,                 -- overlap | busy | disabled_model
  scheduled_for TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  summary TEXT,
  files TEXT,                       -- JSON : chemins relatifs des fichiers produits (FileCard)
  denied TEXT,                      -- JSON : [{ toolName, kind, scopeKey, title }]
  error TEXT                        -- JSON SerializedAtelierError
);
CREATE INDEX scheduled_runs_task ON scheduled_runs (task_id, scheduled_for DESC);
CREATE INDEX scheduled_runs_day ON scheduled_runs (scheduled_for);
```

- Au démarrage, un run resté `running` ou `queued` (app tuée, plantage) passe en `interrupted`. Il ne compte pas comme une erreur du modèle.
- **Statut `success`.** Le tour se termine en `stop`, sans erreur. Un run avec des refus reste `success`, mais le tableau de bord le signale. Un tour `max_steps` ou `length` donne `error`.
- **Volume.** Une tâche toutes les 15 minutes donne 35 000 runs par an. On purge les runs de plus de 90 jours, en gardant leur session si l'utilisateur l'a rouverte et y a écrit (`messages` > 2).

### D7. Affichage : tableau de bord global (validé)

Nouvelle entrée « Tâches planifiées » dans la colonne de gauche, sous les dossiers. La page présente, dans l'ordre :

1. **En-tête** : sélecteur de période (7 jours par défaut, 30 jours, Tout) et bouton « Nouvelle tâche ».
2. **Quatre tuiles** :
   - tâches actives et prochaine exécution (« dans 12 min ») ;
   - runs sur la période et taux de réussite ;
   - durée moyenne d'un run et tokens consommés (jointure `usage_turns`) ;
   - actions refusées et runs sautés ou interrompus.
3. **Barres quotidiennes** des runs empilés par statut (réussi, erreur, sauté), en SVG ou CSS. On réutilise le composant de barres d'ADR-001 : **pas de nouvelle dépendance**.
4. **Tableau des tâches** : Nom · Récurrence (`describeSchedule`) · Dossier · Prochaine exécution · Dernier statut · Réussite sur la période · interrupteur Actif. Actions : Exécuter maintenant, Modifier, Supprimer.
5. **Derniers runs** (paginés par 50) : Date · Tâche · Déclencheur · Statut · Durée · Tokens · Fichiers (nombre) · Refus (nombre) · extrait du compte rendu. Un clic ouvre la conversation du run. Un bandeau en haut de la conversation indique « Exécution planifiée de “<tâche>” du 31/10 à 08:00 » et le bouton « Autoriser pour cette tâche » si le run a des refus.

**Mise à jour en direct.** Le main émet `schedule:changed` (statut d'un run, prochaine exécution) et la page relit son résumé. Contrairement à Réglages › Utilisation, cette page doit refléter un run en cours.

**Notification macOS** à la fin de chaque run qui n'est pas `skipped` : « Rapport hebdo · terminé, 2 fichiers » ou « … · échec ». Un clic ouvre la conversation du run. Une erreur de run ne vole jamais le focus.

**Formulaire de tâche.** Champs :

- nom, dossier (`dialog:choose-directory`), prompt (zone multiligne), modèle (sélecteur de #13, par défaut celui des Réglages) ;
- récurrence : liste des cinq formes, champs dépendants et aperçu « Prochaines exécutions : … » ;
- cases de D4 et durée maximale.

Le bouton « Exécuter maintenant » est disponible dès l'enregistrement, pour tester la tâche avec sa vraie politique de permissions.

## 3. Contrat `packages/shared` (demande au Lead)

Tout est **nouveau ou optionnel**. Aucun `AgentEvent` n'est ajouté, donc aucun `switch` exhaustif à compléter.

```ts
// schedule.ts (nouveau module) : types + fonctions pures, sans dépendance
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type Schedule = /* §D2 */;
export const MIN_INTERVAL_MINUTES = 15;

export interface ScheduledPermissions {
  fileWrite: boolean;
  commands: boolean;
  /** `'*'` = tous les domaines ; liste vide = pas d'accès aux pages web. */
  webDomains: '*' | string[];
  /** Noms complets `mcp__<serveur>__<outil>` autorisés en écriture. */
  mcpTools: string[];
}

export interface ScheduledTaskInput {
  name: string;
  prompt: string;
  workspace: string;
  model?: string;
  schedule: Schedule;
  permissions: ScheduledPermissions;
  maxDurationMinutes?: number;     // défaut 20, 5..120
  enabled?: boolean;               // défaut true
}

export interface ScheduledTask extends Required<Omit<ScheduledTaskInput, 'model'>> {
  id: string;
  model?: string;
  nextRunAt?: string;              // absent si désactivée
  lastRun?: Pick<ScheduledRun, 'id' | 'status' | 'scheduledFor'>;
  createdAt: string;
  updatedAt: string;
}

export type ScheduledRunTrigger = 'schedule' | 'catch_up' | 'manual';
export type ScheduledRunStatus =
  | 'queued' | 'running' | 'success' | 'error' | 'timeout' | 'aborted' | 'skipped' | 'interrupted';
export type ScheduledRunSkipReason = 'overlap' | 'busy' | 'disabled_model';

export interface DeniedAction {
  toolName: string;
  kind: PermissionKind;
  scopeKey: string;
  title: string;
}

export interface ScheduledRun {
  id: string;
  taskId: string;
  taskName: string;
  sessionId?: string;
  trigger: ScheduledRunTrigger;
  status: ScheduledRunStatus;
  skipReason?: ScheduledRunSkipReason;
  scheduledFor: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  totalTokens?: number;            // jointure usage_turns
  summary?: string;
  files: string[];
  denied: DeniedAction[];
  error?: SerializedAtelierError;
}

export interface ScheduleDashboard {
  period: UsagePeriod;             // réutilisé d'ADR-001
  activeTasks: number;
  nextRunAt?: string;
  runs: number;
  successRate?: number;            // 0..1, hors skipped et interrupted
  avgDurationMs?: number;
  totalTokens: number;
  deniedActions: number;
  skippedRuns: number;
  daily: { day: string; success: number; error: number; skipped: number }[];
  tasks: (ScheduledTask & { periodRuns: number; periodSuccessRate?: number })[];
}

export function nextRunAt(schedule: Schedule, after: Date): Date;
export function validateSchedule(schedule: Schedule): string | undefined; // message FR ou undefined
export function describeSchedule(schedule: Schedule): string;             // « Chaque jour à 08:00 »

// messages.ts
SessionSummary.scheduledTaskId?: string;

// settings.ts
AppSettings.openAtLogin?: boolean;   // absent = false

// sandbox.ts (amendement du 2026-10-31) : qui tient le bail de la VM (D5)
SandboxStatus.heldBy?: {
  workspace: string;
  runId?: string;      // présent : un run planifié ; absent : une conversation interactive
  taskName?: string;   // présent avec runId
  sessionId?: string;  // présent pour une conversation interactive
};

// ipc.ts : canaux d'invocation
'schedule:list':        { request: undefined; response: ScheduledTask[] };
'schedule:save':        { request: { id?: string; task: ScheduledTaskInput }; response: ScheduledTask };
'schedule:delete':      { request: { id: string }; response: undefined };
'schedule:set-enabled': { request: { id: string; enabled: boolean }; response: ScheduledTask };
'schedule:run-now':     { request: { id: string }; response: ScheduledRun };      // run en file
'schedule:stop-run':    { request: { runId: string }; response: undefined };
'schedule:dashboard':   { request: { period: UsagePeriod }; response: ScheduleDashboard };
'schedule:runs':        { request: { taskId?: string; before?: string; limit?: number }; response: ScheduledRun[] };
'session:list' :        request gagne includeScheduled?: boolean
// canal d'événement
'schedule:changed':     { taskId: string; run?: ScheduledRun };

// errors.ts
'schedule/invalid'   // details.field, message FR de validateSchedule
'schedule/not_found'
```

Écarts de la PR #106 (L0), validés le 2026-10-31 :

- **Constantes exportées** : `DEFAULT_MAX_DURATION_MINUTES = 20`, `MIN_MAX_DURATION_MINUTES = 5` et `MAX_MAX_DURATION_MINUTES = 120`.
- **`nextRunAt` lève une `RangeError`** si la récurrence est invalide. Le main appelle donc `validateSchedule` d'abord, puis lève `schedule/invalid` avec le message français et `details.field`. Le renderer affiche ce message tel quel.
- **Cas particuliers de `describeSchedule`** : « Du lundi au vendredi », « Le week-end », et « Chaque jour » quand les 7 jours sont cochés.
- **`SandboxHolder`** est exporté et sert de type à `SandboxStatus.heldBy`.
- **Tests en fuseau `Europe/Paris`** (`vitest.config` de shared).

## 4. Répartition

| Lot | Responsable       | Contenu                                                                                                                                                                                                                                                                                                                                                | Dépend de |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| L0  | **Lead**          | PR `feat/lead-shared-scheduled-tasks` : §3, y compris `nextRunAt`, `validateSchedule`, `describeSchedule` et leurs tests (changement d'heure, 31 du mois, 29 février)                                                                                                                                                                                  | n/a       |
| L1  | **Core**          | `unattendedPermissionHandler(policy, onDenied)` (D4) ; constante `UNATTENDED_INSTRUCTIONS` (D3) exportée par agent-core ; **`CreateSessionOptions.extraInstructions?`**, ajouté à celles du runtime (les runtimes sont partagés par modèle, amendement du 2026-10-31)                                                                                  | L0        |
| L2  | **UI** (main)     | migration n° 4 ; `ScheduleStore` (SQLite et mémoire) ; `TaskScheduler` (D1, `Clock` injectée, rattrapage, `powerMonitor`) ; `ScheduledRunner` qui passe par `ChatManager` avec le handler non interactif ; `WorkspaceLease` partagé avec les tours interactifs (D5) ; durée maximale ; notifications ; handlers IPC ; `openAtLogin` ; purge à 90 jours | L0, L1    |
| L3  | **UI** (renderer) | entrée de la colonne de gauche ; page tableau de bord (D7) ; formulaire de tâche avec aperçu des prochaines exécutions ; bandeau de run dans la conversation et « Autoriser pour cette tâche » ; attente « machine isolée occupée » dans le Composer ; option des Réglages                                                                             | L0, L2    |
| L4  | **QA**            | e2e en mode mock (§6) ; scénario réel « rapport hebdo » dans `docs/QA.md`                                                                                                                                                                                                                                                                              | L3        |

Choix d'implémentation de L2, validés le 2026-10-31 :

- `TaskScheduler` reçoit `nextRunAt` et une `Clock` injectées.
- `ChatManager.runUnattended(sessionId, prompt, { requestPermission, instructions, useSandbox, signal })` renvoie `{ turnId, reason, error, finalText, files }` à la fin du tour.
- La session agent est recréée quand le mode change : l'utilisateur qui répond dans la conversation d'un run repasse en interactif, avec la modale.

Branches : `feat/lead-shared-scheduled-tasks`, `feat/core-unattended-permissions`, `feat/ui-scheduled-tasks-main`, `feat/ui-scheduled-tasks-dashboard`, `feat/qa-scheduled-tasks`. Core et UI démarrent avec des types locaux et basculent au merge de L0.

## 5. Sécurité (brief §8)

- **Le prompt planifié vaut instruction ; tout le reste reste de la donnée.** Fichiers, pages web et réponses MCP lus pendant un run sont de la donnée. Le risque nouveau : une injection lue pendant un run agit **sans témoin**. La réponse est la politique fermée par défaut de D4 : pas de suppression, pas d'action inconnue, des domaines et des outils MCP listés nommément, et la VM pour toute commande.
- **Aucune élévation implicite.** Les droits d'une tâche ne changent que par le formulaire, jamais depuis un run.
- **Les refus sont tracés.** Chaque refus est visible dans le tableau de bord et dans la conversation : l'utilisateur voit ce que l'agent a tenté.
- **Modèle désactivé.** Si le modèle de la tâche n'est plus sur le serveur (`llm/model_not_found`), le run passe en `error`. Il n'y a pas de repli silencieux sur un autre modèle.
- **Souveraineté.** Tout reste dans `userData/atelier.db` et le dossier de la tâche. Rien ne part ailleurs qu'au serveur LLM déjà configuré.

## 6. Tests attendus (Definition of Done)

- **shared**
  - `nextRunAt` pour les cinq formes ;
  - 31 du mois en février (borné au 28 ou au 29) ;
  - 29 février sur une année non bissextile (`yearly` passe au 28) ;
  - passage à l'heure d'été (02:30 inexistant → 03:00) et à l'heure d'hiver ;
  - `interval` ancré sur le dernier run ;
  - `validateSchedule` refuse moins de 15 min, `HH:MM` invalide et `days` vide ;
  - libellés de `describeSchedule`.
- **agent-core** : le handler accorde et refuse selon chaque case ; `file_delete` et `other` sont toujours refusés ; `web_fetch:<domaine>` hors liste est refusé ; `'*'` accepte tout domaine ; `onDenied` est appelé une fois par refus ; aucune décision ne vaut `allow_session` (pas de mémorisation).
- **main** (minuteurs factices)
  - migration n° 3 → n° 4 sur une base existante ;
  - un run au bon moment, puis réarmement ;
  - rattrapage unique après trois occurrences manquées ;
  - `skipped/overlap` ;
  - file FIFO d'un run à la fois ;
  - `WorkspaceLease` : run sans commandes jamais bloqué, run avec commandes dans un autre dossier en attente puis `skipped/busy` après 30 min ;
  - `timeout` à la durée maximale ;
  - `interrupted` au redémarrage ;
  - session créée avec `scheduledTaskId` et absente de `session:list` par défaut ;
  - refus enregistrés dans `denied` ;
  - agrégats du tableau de bord ;
  - purge à 90 jours.
- **renderer** (fausse `window.atelier`) : formulaire (validation, aperçu des prochaines exécutions, cases), tableau de bord (tuiles, barres, tableaux, état vide, mise à jour sur `schedule:changed`), bandeau de run.
- **e2e mock** : créer une tâche, « Exécuter maintenant », le run passe à « réussi » avec un fichier produit ; une tâche sans « Créer des fichiers » finit avec 1 refus, et « Autoriser pour cette tâche » pré-coche la case.
- `pnpm test && pnpm lint && pnpm typecheck` verts.

## 7. Options écartées

- **launchd (LaunchAgent).** Les runs auraient lieu même app quittée, mais cela demande un mode sans fenêtre, le verrou d'instance unique, un plist signé, et un démarrage de VM à froid à chaque run. Environ deux fois le travail pour la V1. Reporté (§8).
- **Planification côté serveur LLM.** Le serveur n'a ni les fichiers ni les connecteurs, et cela contredit l'architecture : fichiers, VM et MCP sont sur le Mac.
- **Essai qui apprend les droits.** Plus simple pour l'utilisateur, mais les droits seraient implicites. Gilles a préféré des cases explicites. Le bouton « Autoriser pour cette tâche » garde l'avantage de l'apprentissage sans élévation automatique.
- **Pause et notification à chaque permission.** Le run ne serait plus autonome, et l'attente bloquerait la file.
- **Une seule conversation par tâche, qui s'allonge.** Compaction à répétition, contexte pollué par les runs précédents, et pas de relecture run par run.
- **Expression cron.** Illisible pour un non-développeur ; les cinq préréglages suffisent.
- **Plusieurs VM pour paralléliser.** 4 Gio de RAM par VM. C'est disproportionné tant qu'un seul serveur LLM répond.

## 8. Suites possibles (hors ticket)

- Déclencheur launchd derrière l'interface `Clock`/`TaskScheduler`, pour exécuter les tâches app quittée.
- Rapport HTML produit par l'agent, rendu dans une iframe `sandbox` sans script et sans réseau (`srcdoc`, CSP `default-src 'none'`), après relecture de sécurité.
- Déclencheurs par événement : nouveau fichier dans le dossier, webhook MCP.
- Export CSV des runs.
