/**
 * Définition d'outil d'Atelier, compatible avec `tool()` du Vercel AI SDK.
 *
 * Un {@link ToolDefinition} porte tout ce qu'il faut pour produire un outil AI SDK
 * (`description`, `inputSchema` Zod, `execute`) plus des métadonnées propres à
 * Atelier (flag de permission, catégorie). La conversion vers l'objet `tools` de
 * `streamText` est faite par `agent-core` (qui injecte le contexte d'exécution).
 */
import type { z } from 'zod';
import type { PermissionDescription, PermissionHandler } from './permissions.js';
import type { ProjectFolder } from './projects.js';
import type { Sandbox } from './sandbox.js';
import type { ToolDisplay } from './messages.js';
import { AtelierError } from './errors.js';

/** Provenance d'un outil, pour le filtrage et l'affichage. */
export type ToolSource = 'native' | 'documents' | 'web' | 'mcp' | 'skills';

/**
 * Politique de permission d'un outil.
 * - `never` : jamais de confirmation (lecture, todo…) ;
 * - `always` : confirmation systématique (via le {@link PermissionHandler}), après
 *   la vérification préalable de l'outil s'il en a une (`precheck`) ;
 * - `conditional` : l'outil décide lui-même dans `execute` (ex. `bash` hors liste
 *   blanche, `web_fetch` la première fois par domaine).
 */
export type ToolPermission = 'never' | 'always' | 'conditional';

/**
 * Dossier rattaché d'une conversation de projet (ADR-003 D1), en plus du
 * dossier de travail : les outils fichiers y lisent, et y écrivent si
 * `access` vaut `write`.
 */
export interface WorkspaceFolder extends ProjectFolder {
  /** Chemin dans la VM (`/dossiers/<nom>`), présent si le dossier y est monté. */
  guestPath?: string;
}

/**
 * Contexte injecté à chaque exécution d'outil par `agent-core`.
 * Les outils ne lisent jamais d'état global : tout passe par ici (testabilité).
 */
export interface ToolExecutionContext {
  /** Identifiant de la session de chat. */
  sessionId: string;
  /** Identifiant de l'appel d'outil (fourni par l'AI SDK). */
  toolCallId: string;
  /**
   * Dossier de travail autorisé, chemin absolu et résolu côté hôte. Pour une
   * conversation de projet : le dossier principal (racine des chemins relatifs).
   */
  workspace: string;
  /**
   * Dossiers rattachés du projet (ADR-003 D1), relus à chaque tour. Absent ou
   * vide : seul `workspace` est accessible.
   */
  folders?: readonly WorkspaceFolder[];
  /** Signal d'annulation du tour (bouton stop). */
  abortSignal: AbortSignal;
  /** Demande une permission à l'utilisateur. */
  requestPermission: PermissionHandler;
  /** VM d'exécution (absente tant que la sandbox n'est pas prête). */
  sandbox?: Sandbox;
  /**
   * Publie un affichage riche dans le chat pendant l'exécution
   * (ex. carte de fichier pour `present_file`, progression d'un outil long).
   * `agent-core` le relaie en event `tool_display` ; l'affichage final reste
   * celui de `ToolOutput.display`.
   */
  emitDisplay?: (display: ToolDisplay) => void;
}

/**
 * Résultat renvoyé par un outil : un texte pour le modèle, et éventuellement un
 * affichage riche pour l'UI. Un refus de permission est un résultat normal
 * (`ok: false`), pas une exception.
 */
export interface ToolOutput {
  /** Succès de l'opération. */
  ok: boolean;
  /** Texte renvoyé au modèle (toujours présent, tronqué par l'outil si besoin). */
  content: string;
  /**
   * Vrai si l'utilisateur a refusé la permission (implique `ok: false`).
   * Reporté tel quel dans `ToolResultEvent.denied` (statut « refusé » dans l'UI).
   */
  denied?: boolean;
  /** Affichage riche optionnel pour l'UI (jamais envoyé au modèle). */
  display?: ToolDisplay;
}

/**
 * Contexte d'une vérification préalable ({@link ToolDefinition.precheck}) : celui
 * de l'exécution, sans ce qui permet d'agir ou de demander (permission, affichage,
 * VM). « Ne demande rien, ne modifie rien » est ainsi vérifié par les types.
 */
export type ToolPrecheckContext = Omit<
  ToolExecutionContext,
  'requestPermission' | 'emitDisplay' | 'sandbox'
>;

/**
 * Échec d'une vérification préalable ({@link ToolDefinition.precheck}) : l'appel
 * échouerait de toute façon. Il est rendu au modèle comme un résultat d'outil en
 * échec. Ce n'est pas un refus de l'utilisateur, d'où l'absence de `denied`.
 */
export interface ToolPrecheckFailure {
  ok: false;
  /** Raison, en français, pour le modèle (« Le dossier « Archives » est en lecture seule… »). */
  content: string;
}

/**
 * Définition d'un outil Atelier.
 *
 * @typeParam I - Type de l'entrée, inféré depuis `inputSchema`.
 * @example
 * ```ts
 * const echo = defineTool({
 *   name: 'echo',
 *   description: 'Renvoie le texte fourni.',
 *   inputSchema: z.object({ text: z.string() }),
 *   permission: 'never',
 *   source: 'native',
 *   execute: async ({ text }) => ({ ok: true, content: text }),
 * });
 * ```
 */
export interface ToolDefinition<I = unknown> {
  /** Nom unique exposé au modèle (`snake_case`, ou `mcp__<serveur>__<outil>`). */
  name: string;
  /** Description pour le modèle : quand et comment utiliser l'outil. */
  description: string;
  /** Schéma Zod de l'entrée ; sert d'`inputSchema` AI SDK et de validation. */
  inputSchema: z.ZodType<I>;
  /** Politique de permission (voir {@link ToolPermission}). */
  permission: ToolPermission;
  /** Provenance de l'outil. */
  source: ToolSource;
  /**
   * Libellé de la demande de permission pour cette entrée, en français et lisible
   * par un non-développeur (ex. « Créer l'issue “Bug login” sur GitHub »).
   * Utilisé par `agent-core` pour les outils `permission: 'always'` ; sans lui,
   * un libellé générique est produit. Doit être pur et rapide (pas d'I/O).
   */
  describePermission?(input: I): PermissionDescription;
  /**
   * Vérification préalable d'un outil `permission: 'always'` (ADR-003, D9).
   * `agent-core` l'appelle **avant** la demande de permission. Si l'appel
   * échouera de toute façon (chemin hors des dossiers, dossier en lecture seule,
   * fichier ou passage introuvable), l'échec est rendu au modèle sans rien
   * demander à l'utilisateur. Renvoie `undefined` pour continuer.
   *
   * Ne modifie rien et ne demande aucune permission. Ce n'est pas une garde de
   * sécurité : l'état peut changer pendant que la modale est ouverte, donc
   * `execute` refait tous ses contrôles. Une exception vaut `undefined` (la
   * question est posée, puis `execute` décide), sauf l'annulation du tour.
   * Ignorée pour `never` et `conditional` : ces outils ordonnent leurs contrôles
   * eux-mêmes dans `execute`.
   */
  precheck?(input: I, context: ToolPrecheckContext): Promise<ToolPrecheckFailure | undefined>;
  /**
   * Exécute l'outil. Ne doit lever que pour des erreurs inattendues : les cas
   * métier (refus, fichier introuvable…) renvoient `{ ok: false, content }`.
   * (Syntaxe méthode volontaire : bivariance, pour stocker des outils hétérogènes.)
   */
  execute(input: I, context: ToolExecutionContext): Promise<ToolOutput>;
}

/** Outil dont le type d'entrée est effacé (stockage hétérogène dans un registre). */
export type AnyToolDefinition = ToolDefinition;

/** Aide à l'inférence du type d'entrée depuis le schéma Zod. */
export function defineTool<I>(definition: ToolDefinition<I>): ToolDefinition<I> {
  return definition;
}

/**
 * Registre d'outils injectable (natifs, documents, web, MCP).
 * `agent-core` le convertit en objet `tools` de l'AI SDK à chaque étape, ce qui
 * permet l'activation paresseuse des outils MCP via `tool_search`.
 */
export interface ToolRegistry {
  /** Ajoute un outil ; lève `tool/invalid_input` si le nom est déjà pris. */
  register<I>(tool: ToolDefinition<I>): void;
  /** Ajoute plusieurs outils. */
  registerAll(tools: readonly AnyToolDefinition[]): void;
  /** Retire un outil ; renvoie `true` s'il existait. */
  unregister(name: string): boolean;
  /** Récupère un outil par son nom. */
  get(name: string): AnyToolDefinition | undefined;
  /** Indique si un outil existe. */
  has(name: string): boolean;
  /** Liste les outils, éventuellement filtrés. */
  list(filter?: (tool: AnyToolDefinition) => boolean): AnyToolDefinition[];
}

/** Motif de nom d'outil accepté par les API OpenAI-compatibles. */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** Implémentation en mémoire de {@link ToolRegistry}. */
export class InMemoryToolRegistry implements ToolRegistry {
  readonly #tools = new Map<string, AnyToolDefinition>();

  constructor(tools: readonly AnyToolDefinition[] = []) {
    this.registerAll(tools);
  }

  register<I>(tool: ToolDefinition<I>): void {
    if (!TOOL_NAME_PATTERN.test(tool.name)) {
      throw new AtelierError('tool/invalid_input', `Nom d'outil invalide : "${tool.name}"`);
    }
    if (this.#tools.has(tool.name)) {
      throw new AtelierError('tool/invalid_input', `Outil déjà enregistré : "${tool.name}"`);
    }
    this.#tools.set(tool.name, tool);
  }

  registerAll(tools: readonly AnyToolDefinition[]): void {
    for (const tool of tools) this.register(tool);
  }

  unregister(name: string): boolean {
    return this.#tools.delete(name);
  }

  get(name: string): AnyToolDefinition | undefined {
    return this.#tools.get(name);
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  list(filter?: (tool: AnyToolDefinition) => boolean): AnyToolDefinition[] {
    const all = [...this.#tools.values()];
    return filter ? all.filter(filter) : all;
  }
}

/** Construit le nom d'un outil MCP : `mcp__<serveur>__<outil>`. */
export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64);
}
