# ADR-001 : consommation de tokens, jauge de contexte et KPI d'utilisation

- **Statut** : accepté (spec validée par Gilles le 2026-10-30). L0 livré (PR `feat/lead-shared-token-usage`), L1 livré (PR #91), L2 et L3 en cours (PR #92).
- **Ticket** : #10 « Afficher les tokens consommés par modèle dans les paramètres, avec des KPI »
- **Auteur** : architect
- **Impact** : `packages/shared` (Lead), `packages/agent-core` (Core), `apps/desktop` main et renderer (UI)

## 1. Contexte

L'utilisateur veut :

1. une **jauge permanente** du remplissage du contexte, dans la zone de saisie (capture du ticket : `● ✱ 6 %`), mise à jour en temps réel ;
2. une rubrique **Réglages › Utilisation** avec les tokens consommés **par modèle** et des KPI.

KPI retenus par Gilles : tokens par modèle, tours et moyenne par tour, débit tokens/s, remplissage du contexte, fiabilité du modèle. **Écarté** : « équivalent cloud évité ».

État du code au 2026-10-30 :

- `runTurn` (agent-core, `loop/agent.ts`) calcule un `TokenUsage` : `inputTokens` = entrée de la **dernière** étape, `outputTokens` = sortie cumulée du tour, `contextWindow`. Il le renvoie dans `TurnResult.usage` et dans l'event `done`.
- Il ne cumule pas l'entrée sur les étapes, ne mesure aucune durée et ne compte pas ses relances (`continuation`, `stream_cut`…).
- Sur une erreur, `runTurn` renvoie `TurnResult.usage` **sans** émettre `done` : un compteur alimenté par les events perdrait ces tours.
- Le renderer n'exploite pas `done.usage`. Rien n'est persisté, le nom du modèle n'est nulle part dans l'usage.
- `COMPACTION_THRESHOLD = 0.75` est déjà dans `@atelier/shared` (importable par le renderer).

## 2. Décisions

### D1. Deux flux, deux usages

| Flux                        | Source                                          | Rôle                     | Garantie                                                 |
| --------------------------- | ----------------------------------------------- | ------------------------ | -------------------------------------------------------- |
| **Event `usage`** (nouveau) | émis par `runTurn` à chaque `finish-step`       | jauge en temps réel      | « au mieux » : un event perdu est corrigé par le suivant |
| **`TurnResult.usage`**      | valeur de retour de `session.send` dans le main | registre persistant, KPI | autoritaire : présent même quand le tour échoue          |

Le main est la seule source de vérité. Le renderer n'est qu'une projection : il ne calcule aucun agrégat.

### D2. Registre append-only dans SQLite, une ligne par tour

- Table `usage_turns`, clé primaire `turn_id`. L'écriture est un **upsert** : rejouer l'écriture d'un même tour est idempotent, jamais de double comptage.
- Un « Réessayer » crée un nouveau `turnId`. Les deux tentatives sont comptées, car les tokens ont réellement été consommés.
- Le modèle enregistré est celui du runtime **au moment du tour** (`settings.llm.model`). Changer de modèle entre deux tours donne donc une répartition juste.
- `session_id` passe à `NULL` quand la conversation est supprimée (`ON DELETE SET NULL`). Les statistiques survivent à la suppression des conversations.
- Les agrégats sont calculés en SQL (`GROUP BY model`, `GROUP BY day, model`), jamais dans le renderer.
- Souveraineté : ces données restent dans `userData/atelier.db`. Aucune télémétrie, rien ne sort de la machine.

Volumétrie : 100 tours/jour donnent environ 36 000 lignes/an. Un index sur `day` suffit et aucune purge n'est nécessaire.

### D3. Jauge = taille du contexte de la prochaine requête

`contextTokens` = entrée de la dernière étape + sortie de la dernière étape. C'est ce que le modèle relira au prochain appel, avant les nouveaux résultats d'outils. Ratio affiché : `contextTokens / contextWindow`.

### D4. Débit mesuré côté app

`generationMs` est la somme, sur les étapes, du temps entre le **premier chunk** stream (texte, raisonnement ou entrée d'outil) et `finish-step`. Le débit vaut `outputTokens / generationMs × 1000`. Il exclut le prefill (temps avant le premier token), qui dépend surtout de la taille du prompt. `@ai-sdk/openai-compatible` ne remonte pas `eval_duration` d'Ollama : la mesure se fait à l'horloge, ce qui inclut la latence réseau du tunnel. Le chiffre sert à comparer des modèles sur un même serveur, pas à faire un benchmark absolu.

### D5. Fiabilité = relances automatiques comptées par type

`runTurn` compte ses relances par type : `continuation`, `stream_cut`, `tool_call_parse`, `empty_final`, `announce_only`, `verification`. Le registre ajoute l'issue du tour (`stop`, `aborted`, `max_steps`, `length`, `error`) et les compactions (event `compaction` observé par le main pendant le tour).

KPI affiché : **taux de tours relancés** = tours avec au moins une relance / tours. Le détail par type apparaît au survol. Le **taux d'erreur** = tours `error` / tours.

## 3. Contrat `packages/shared` (demande au Lead)

Tous les ajouts sont **optionnels ou nouveaux** : rien ne casse pour les consommateurs actuels, sauf les `switch` exhaustifs sur `event.type` (ajouter `case 'usage'`).

```ts
// messages.ts : TokenUsage enrichi (champs optionnels)
// + constante RELAUNCH_KINDS (liste exhaustive, ordre stable)
export type RelaunchKind =
  | 'continuation' | 'stream_cut' | 'tool_call_parse'
  | 'empty_final' | 'announce_only' | 'verification';

export interface TokenUsage {
  inputTokens: number;          // existant : entrée de la dernière étape
  outputTokens: number;         // existant : sortie cumulée du tour
  contextWindow?: number;       // existant
  /** Entrée cumulée sur toutes les étapes du tour (tokens réellement traités). */
  totalInputTokens?: number;
  /** Taille du contexte après la dernière étape (entrée + sortie de cette étape) : la jauge. */
  contextTokens?: number;
  /** Nombre d'appels au modèle pendant le tour. */
  steps?: number;
  /** Temps de génération cumulé (1er chunk → fin d'étape), en ms. */
  generationMs?: number;
  /** Relances automatiques du tour, par type (absent = aucune). */
  relaunches?: Partial<Record<RelaunchKind, number>>;
}

// events.ts : nouvel event, membre d'AgentEvent
/** Usage cumulé du tour en cours, émis après chaque étape (jauge en temps réel). */
export interface UsageEvent extends AgentEventBase {
  type: 'usage';
  usage: TokenUsage;
}

// usage.ts (nouveau module)
export type UsagePeriod = '7d' | '30d' | 'all';
export type TurnOutcome = DoneReason | 'error';

export interface ModelUsageStats {
  model: string;
  turns: number;
  steps: number;
  inputTokens: number;          // somme des totalInputTokens
  outputTokens: number;
  avgTokensPerTurn: number;     // (input + output) / turns
  tokensPerSecond?: number;     // absent si generationMs = 0
  avgContextRatio?: number;     // moyenne de contextTokens / contextWindow (0..1)
  peakContextRatio?: number;
  compactions: number;
  relaunchedTurns: number;      // tours avec au moins une relance
  relaunches: Partial<Record<RelaunchKind, number>>;
  errorTurns: number;
  lastUsedAt: string;           // ISO 8601
}

export interface UsageDailyPoint {
  day: string;                  // AAAA-MM-JJ, heure locale
  model: string;
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

export interface UsageSummary {
  period: UsagePeriod;
  models: ModelUsageStats[];    // tri : total décroissant
  daily: UsageDailyPoint[];     // tri : day croissant
}

// ipc.ts
'usage:summary': { request: { period: UsagePeriod }; response: UsageSummary };
// 'session:open' : response gagne `usage?: TokenUsage` (dernier tour connu de la session,
//                  pour afficher la jauge dès la réouverture d'une conversation)
```

## 4. Répartition

| Lot | Responsable       | Contenu                                                                                                                                                                                                                                                  | Dépend de                      |
| --- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| L0  | **Lead**          | PR `feat/lead-shared-token-usage` : §3 tel quel (ou amendé)                                                                                                                                                                                              | n/a                            |
| L1  | **Core**          | `runTurn` : `totalInputTokens`, `contextTokens`, `steps`, `generationMs`, `relaunches`, event `usage` à chaque `finish-step` ; usage complet aussi sur les sorties en erreur ; CLI : affichage du débit                                                  | L0 (types locaux en attendant) |
| L2  | **UI** (main)     | migration SQLite n° 2 `usage_turns` ; écriture depuis `ChatManager.#run` à partir de `TurnResult` (+ compactions observées) ; `InMemoryUsageStore` pour les tests et le mode dégradé ; handler `usage:summary` ; `session:open` renvoie le dernier usage | L0, L1                         |
| L3  | **UI** (renderer) | jauge `ContextGauge` dans le Composer ; rubrique Réglages › Utilisation ; `case 'usage'` dans `chat-reducer`                                                                                                                                             | L0, L2                         |

Écarts validés pendant L1 (PR #91) :

- L'horloge injectée s'appelle `clock?: () => number`, car `AgentOptions.now` existe déjà et sert à la date du prompt.
- L'event `usage` est derrière `usageEvents?: boolean`, désactivé par défaut, parce que les reducers de l'app n'ont pas de `default`. **Le drapeau est temporaire** : il disparaît une fois L0 et L3 mergées, et l'event est alors toujours émis.

Branches : `feat/lead-shared-token-usage`, `feat/core-token-usage`, `feat/ui-token-usage`. Core et UI peuvent démarrer avec des types locaux et basculer sur `@atelier/shared` au merge de L0.

## 5. Spécification fonctionnelle

### Jauge (Composer, en bas à droite)

- Pastille `● 6 %` : pastille de couleur, puis pourcentage arrondi à l'entier.
- Couleurs : vert si < 50 %, orange de 50 % à `COMPACTION_THRESHOLD` (75 %), rouge au-delà (compaction imminente).
- Infobulle : « Contexte : 12,4 k / 32 k tokens · compaction automatique à 75 % ».
- Valeur inconnue (nouvelle conversation, pas encore de tour) : `● —` en gris, infobulle « Le remplissage s'affichera après la première réponse ».
- Fenêtre inconnue (`contextWindow` absent, serveur injoignable au démarrage) : `● —` en gris, infobulle « Fenêtre de contexte inconnue ».
- Mise à jour à chaque event `usage` de la session affichée, et à l'ouverture d'une session (`session:open`.usage).
- Après une compaction, la valeur ne redescend qu'au `usage` suivant. C'est voulu : on ne fait pas d'estimation côté renderer.
- Accessibilité : `role="meter"`, `aria-valuemin=0`, `aria-valuemax=100`, `aria-valuenow`, `aria-label="Remplissage du contexte"`.
- Performance : au plus un rendu par étape (pas par token), et la jauge ne re-rend pas la liste de messages (état isolé).

### Réglages › Utilisation (nouvelle rubrique, après « Serveur et modèle »)

1. Sélecteur de période : 7 jours, 30 jours (par défaut), Tout.
2. Quatre tuiles KPI :
   - tokens totaux, avec le détail entrée/sortie ;
   - tours, avec la moyenne de tokens par tour ;
   - débit moyen (tokens/s) ;
   - pic de remplissage du contexte, avec le nombre de compactions.
3. Barres quotidiennes (entrée et sortie empilées), en SVG ou CSS, **sans nouvelle dépendance**.
4. Tableau par modèle : Modèle · Tours · Entrée · Sortie · Moy./tour · tokens/s · Contexte moy./pic · Compactions · Tours relancés (taux) · Erreurs (taux). Le détail des relances par type s'affiche au survol.
5. État vide : « Aucune consommation enregistrée sur la période. »
6. Les données sont relues à l'ouverture de la rubrique et au changement de période. Pas d'abonnement temps réel : ce n'est pas un tableau de bord live.
7. Nombres au format `fr-FR` (`12,4 k`, `1,2 M`).

## 6. Tests attendus (Definition of Done)

- **agent-core** (`MockLanguageModelV4`) :
  - cumul de `totalInputTokens` et `steps` sur un tour à plusieurs étapes ;
  - `contextTokens` = entrée + sortie de la dernière étape ;
  - un event `usage` par étape ;
  - `relaunches` compté pour au moins `continuation` et `empty_final` ;
  - usage présent dans `TurnResult` sur une erreur de stream ;
  - `generationMs` ≥ 0 avec une horloge injectée.
- **main** : migration v1 → v2 sur une base existante ; upsert idempotent (même `turnId` écrit deux fois = une ligne) ; agrégats par modèle et par jour ; période `7d` qui exclut une ligne plus ancienne ; `ON DELETE SET NULL` ; `ChatManager` qui enregistre un tour en erreur et un tour annulé.
- **renderer** : `ContextGauge` (seuils de couleur, états inconnus, `aria-valuenow`) ; rubrique Utilisation avec une fausse `window.atelier` (tuiles, tableau, état vide, changement de période).
- `pnpm test && pnpm lint && pnpm typecheck` verts.

## 7. Options écartées

- **Compter dans le renderer à partir des events** : les tours en erreur sont perdus (pas de `done`), le compte est faux après un rechargement et plusieurs fenêtres comptent en double.
- **Agréger en mémoire et sauvegarder un JSON** : écriture non atomique, pas de requêtes par période, et ça duplique la base SQLite existante.
- **Jauge estimée côté renderer** (estimation de tokens en JS) : diverge des chiffres du serveur. Les chiffres d'Ollama font foi.
- **Lire `eval_duration` d'Ollama** : non exposé par l'API OpenAI-compatible utilisée, et ça lierait le code à Ollama (repli vLLM prévu).

## 8. Suites possibles (hors ticket)

- Temps avant le premier token (prefill) comme KPI distinct.
- Export CSV et bouton « Réinitialiser les statistiques ».
- Comparaison avant/après d'un changement de modèle (9b → 35b) sur le taux de relances.
