/**
 * Demandes de permission construites par agent-core.
 *
 * Les outils `permission: 'always'` sont protégés génériquement par l'adaptateur
 * (voir `registry.ts`), après leur vérification préalable ({@link precheckTool}) ;
 * les outils `conditional` (ex. `bash`) appellent {@link askPermission} eux-mêmes
 * dans leur `execute`.
 */
import { randomUUID } from 'node:crypto';
import {
  isAllowed,
  type AnyToolDefinition,
  type PermissionDecision,
  type PermissionDescription,
  type DeniedAction,
  type PermissionHandler,
  type PermissionRequest,
  type ScheduledPermissions,
  type ToolExecutionContext,
  type ToolOutput,
  type ToolPrecheckFailure,
} from '@atelier/shared';

/**
 * Vérification préalable d'un outil (ADR-003, D9) : l'échec à rendre au modèle
 * sans poser de question, ou `undefined` pour continuer.
 *
 * Indicative : une exception laisse poser la question, puis `execute` décide.
 * Seule l'annulation du tour est propagée. L'échec est recopié champ par champ,
 * pour qu'aucun `denied` ni `display` ne passe : l'utilisateur n'a rien refusé.
 */
export async function precheckTool(
  definition: AnyToolDefinition,
  input: unknown,
  context: ToolExecutionContext,
): Promise<ToolPrecheckFailure | undefined> {
  if (!definition.precheck) return undefined;
  try {
    const failure = await definition.precheck(input, context);
    return failure ? { ok: false, content: failure.content } : undefined;
  } catch (error) {
    if (context.abortSignal.aborted) throw error;
    return undefined;
  }
}

/**
 * Libellés de permission fournis par l'application (`AgentOptions.describePermission`).
 * Renvoyer `undefined` laisse la main au repli générique.
 */
export type PermissionDescriber = (
  toolName: string,
  input: unknown,
) => PermissionDescription | undefined;

/** Extrait un champ texte d'une entrée d'outil (pour les libellés). */
export function stringField(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const value: unknown = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** Tronque un aperçu affiché dans la modale de permission. */
export function preview(text: string | undefined, max = 2_000): string | undefined {
  if (text === undefined) return undefined;
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

/** Repli générique quand ni l'outil ni l'application ne fournissent de libellé. */
export function genericDescribePermission(toolName: string, input: unknown): PermissionDescription {
  return {
    kind: toolName.startsWith('mcp__') ? 'mcp_write' : 'other',
    title: `Utiliser l'outil ${toolName}`,
    detail: preview(safeJson(input)),
    scopeKey: toolName,
  };
}

/**
 * Description d'une demande de permission, par priorité :
 * `describePermission` de l'outil, puis celui de l'application, puis le repli générique.
 */
export function describePermissionFor(
  definition: AnyToolDefinition,
  input: unknown,
  appDescriber?: PermissionDescriber,
): PermissionDescription {
  // Un libellé qui lève (outil MCP mal écrit…) ne doit pas faire échouer l'appel :
  // on passe au niveau suivant. La demande de permission a lieu quoi qu'il arrive.
  return (
    safely(() => definition.describePermission?.(input)) ??
    safely(() => appDescriber?.(definition.name, input)) ??
    genericDescribePermission(definition.name, input)
  );
}

function safely(
  describe: () => PermissionDescription | undefined,
): PermissionDescription | undefined {
  try {
    const description = describe();
    // Libellé vide ou mal formé (JS non typé, MCP) : on l'ignore.
    return description && typeof description.title === 'string' && description.title.trim() !== ''
      ? description
      : undefined;
  } catch {
    return undefined;
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Construit la demande complète puis interroge le gestionnaire du contexte. */
export async function askPermission(
  context: ToolExecutionContext,
  toolName: string,
  input: unknown,
  description: PermissionDescription,
): Promise<PermissionDecision> {
  const request: PermissionRequest = {
    id: randomUUID(),
    sessionId: context.sessionId,
    toolCallId: context.toolCallId,
    toolName,
    input,
    kind: description.kind,
    title: description.title,
    ...(description.detail !== undefined ? { detail: description.detail } : {}),
    scopeKey: description.scopeKey ?? toolName,
  };
  try {
    return await context.requestPermission(request, context.abortSignal);
  } catch (error) {
    // Annulation du tour : on la laisse remonter.
    if (context.abortSignal.aborted) throw error;
    // Gestionnaire en échec (modale fermée, fenêtre détruite…) : refus par défaut.
    // Une erreur d'outil inciterait le modèle à réessayer, voire à contourner via bash.
    return 'deny';
  }
}

/** Message renvoyé au modèle quand l'utilisateur refuse. */
export function deniedOutput(title: string): ToolOutput {
  return {
    ok: false,
    denied: true,
    content:
      `L'utilisateur a refusé l'action « ${title} ». Ne la retente pas, ni telle quelle ni par ` +
      `un autre moyen (autre outil, commande bash) : explique ce que tu voulais faire et ` +
      `demande à l'utilisateur comment il souhaite procéder.`,
  };
}

export { isAllowed };

/**
 * Enveloppe un gestionnaire pour mémoriser les `allow_session` par `scopeKey`
 * (utile en CLI et en test ; l'app fournit son propre gestionnaire).
 */
export function withSessionMemory(handler: PermissionHandler): PermissionHandler {
  const granted = new Set<string>();
  return async (request, signal) => {
    const key = request.scopeKey ?? request.toolName;
    if (granted.has(key)) return 'allow_session';
    const decision = await handler(request, signal);
    if (decision === 'allow_session') granted.add(key);
    return decision;
  };
}

/**
 * Consignes ajoutées au prompt système d'un run planifié (`extraInstructions`,
 * ADR-002 D3).
 */
export const UNATTENDED_INSTRUCTIONS =
  "Tu travailles en l'absence de l'utilisateur. Ne pose pas de question et ne demande pas de " +
  "confirmation. Si une action t'est refusée, n'essaie pas de la contourner et continue avec ce " +
  'que tu peux faire. Termine par un compte rendu court : ce que tu as fait, les fichiers ' +
  'produits, ce qui a échoué.';

const WEB_FETCH_SCOPE = 'web_fetch:';

/** Domaine comparable : minuscules, sans `www.` (comme `permissionDomain` de @atelier/web). */
function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');
}

function webFetchAllowed(scopeKey: string, domains: ScheduledPermissions['webDomains']): boolean {
  if (!scopeKey.startsWith(WEB_FETCH_SCOPE)) return false;
  if (domains === '*') return true;
  const domain = normalizeDomain(scopeKey.slice(WEB_FETCH_SCOPE.length));
  return domain !== '' && domains.some((d) => normalizeDomain(d) === domain);
}

/** Vrai si la politique couvre la demande. `file_delete` et `other` ne le sont jamais. */
function unattendedAllows(request: PermissionRequest, policy: ScheduledPermissions): boolean {
  const scopeKey = request.scopeKey ?? request.toolName;
  switch (request.kind) {
    case 'file_write':
      return policy.fileWrite;
    case 'command':
      return policy.commands;
    case 'network':
      return webFetchAllowed(scopeKey, policy.webDomains);
    case 'mcp_write':
      return policy.mcpTools.includes(scopeKey);
    case 'memory_write':
      // Mémoire du projet : case dédiée, « fichiers » ne la couvre pas (ADR-003 D4).
      return policy.memory === true;
    default:
      return false;
  }
}

/**
 * Gestionnaire non interactif des runs planifiés (ADR-002 D4) : ne pose jamais
 * de question. Accorde ce que la politique coche (`allow_once`, jamais
 * mémorisé) ; refuse tout le reste et le signale à `onDenied`, le modèle
 * recevant le {@link deniedOutput} habituel.
 */
export function unattendedPermissionHandler(
  policy: ScheduledPermissions,
  onDenied: (denied: DeniedAction) => void,
): PermissionHandler {
  return (request) => {
    if (unattendedAllows(request, policy)) return Promise.resolve('allow_once');
    onDenied({
      toolName: request.toolName,
      kind: request.kind,
      scopeKey: request.scopeKey ?? request.toolName,
      title: request.title,
    });
    return Promise.resolve('deny');
  };
}
