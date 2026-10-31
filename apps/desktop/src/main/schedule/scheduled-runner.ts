/**
 * Exécution d'un run planifié (ADR-002 D3 à D5) : bail de la VM si la tâche
 * peut lancer des commandes, nouvelle conversation liée à la tâche, tour sans
 * témoin via `ChatManager`, durée maximale, compte rendu, fichiers produits et
 * actions refusées.
 */
import {
  serializeError,
  type ChatMessage,
  type DeniedAction,
  type PermissionHandler,
  type ScheduledPermissions,
  type ScheduledTask,
} from '@atelier/shared';
import type { ChatManager } from '../runtime/chat-manager.js';
import { systemClock, type Clock } from './clock.js';
import type { RunPatch } from './schedule-store.js';
import {
  LeaseBusyError,
  type LeaseHolder,
  type Release,
  type WorkspaceLease,
} from './workspace-lease.js';

/** Attente maximale de la VM tenue dans un autre dossier (D5). */
export const LEASE_WAIT_MS = 30 * 60_000;

/** Lignes et caractères du compte rendu copiés dans le run (D3). */
export const SUMMARY_MAX_LINES = 5;
export const SUMMARY_MAX_CHARS = 500;

/** Gestionnaire non interactif (`unattendedPermissionHandler` d'agent-core) : accorde la politique, refuse le reste. */
export type UnattendedHandlerFactory = (
  policy: ScheduledPermissions,
  onDenied: (denied: DeniedAction) => void,
) => PermissionHandler;

export interface ScheduledRunnerOptions {
  chats: Pick<ChatManager, 'create' | 'runUnattended'>;
  lease: WorkspaceLease;
  permissionHandler: UnattendedHandlerFactory;
  /** Consignes du mode autonome (`UNATTENDED_INSTRUCTIONS` d'agent-core). */
  instructions?: string;
  clock?: Clock;
  /** Empêche l'App Nap pendant le run (`powerSaveBlocker`) ; renvoie la levée. */
  keepAwake?: () => () => void;
  /** Titre de la conversation du run (« Rapport hebdo · 31/10 08:00 »). */
  title?: (task: ScheduledTask, at: Date) => string;
  /**
   * Tâche d'un projet (ADR-003) : nom du projet et signature de ses montages,
   * pour que le bail couvre les dossiers rattachés montés dans la VM.
   */
  leaseFor?: (task: ScheduledTask) => Pick<LeaseHolder, 'projectName' | 'mounts'> | undefined;
}

/** Ce que le scheduler confie au runner pour un run déjà en file. */
export interface RunRequest {
  runId: string;
  task: ScheduledTask;
  /** Arrêt du run (bouton « Arrêter », suppression de la tâche). */
  signal: AbortSignal;
  /** Enregistre l'avancement (statut `running`, conversation créée…). */
  update: (patch: RunPatch) => void;
}

/** Les cinq premières lignes du dernier texte de l'assistant (500 caractères au plus). */
export function runSummary(message: ChatMessage): string | undefined {
  const texts = message.parts.filter((p) => p.type === 'text').map((p) => p.text.trim());
  const last = texts.filter((t) => t !== '').at(-1);
  if (last === undefined) return undefined;
  const lines = last
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
    .slice(0, SUMMARY_MAX_LINES)
    .join('\n');
  return lines.length > SUMMARY_MAX_CHARS ? `${lines.slice(0, SUMMARY_MAX_CHARS - 1)}…` : lines;
}

/** Chemins (relatifs au dossier) des fichiers créés ou modifiés pendant le tour. */
export function producedFiles(message: ChatMessage): string[] {
  const paths = new Set<string>();
  for (const part of message.parts) {
    if (part.type !== 'tool_call') continue;
    const cards = [
      ...(part.display?.type === 'file' ? [part.display.file] : []),
      ...(part.files ?? []),
    ];
    for (const card of cards) if (card.action !== 'presented') paths.add(card.path);
  }
  return [...paths];
}

function defaultTitle(task: ScheduledTask, at: Date): string {
  const date = at.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
  const time = at.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return `${task.name} · ${date} ${time}`;
}

export class ScheduledRunner {
  readonly #o: ScheduledRunnerOptions;

  constructor(options: ScheduledRunnerOptions) {
    this.#o = options;
  }

  /** Joue le run jusqu'au bout ; renvoie son état final (jamais d'exception). */
  async execute(request: RunRequest): Promise<RunPatch> {
    const { task, signal } = request;
    const clock = this.#o.clock ?? systemClock;
    const finished = (patch: RunPatch): RunPatch => ({
      ...patch,
      finishedAt: clock.now().toISOString(),
    });

    // 1. La VM n'est réservée que si la tâche peut lancer des commandes (D5).
    let release: Release | undefined;
    if (task.permissions.commands) {
      try {
        release = await this.#o.lease.acquire(
          {
            workspace: task.workspace,
            runId: request.runId,
            taskName: task.name,
            ...this.#o.leaseFor?.(task),
          },
          { signal, timeoutMs: LEASE_WAIT_MS },
        );
      } catch (error) {
        return error instanceof LeaseBusyError
          ? finished({ status: 'skipped', skipReason: 'busy' })
          : finished({ status: 'aborted' });
      }
    }

    const denied: DeniedAction[] = [];
    const stopKeepAwake = this.#o.keepAwake?.();
    const controller = new AbortController();
    // Objet : le minuteur le modifie hors du flot que TypeScript suit.
    const deadline = { reached: false };
    const onStop = (): void => {
      controller.abort();
    };
    signal.addEventListener('abort', onStop, { once: true });
    const cancelTimeout = clock.setTimer(() => {
      deadline.reached = true;
      controller.abort();
    }, task.maxDurationMinutes * 60_000);

    try {
      if (signal.aborted) return finished({ status: 'aborted' });
      const startedAt = clock.now();
      const session = this.#o.chats.create(task.workspace, {
        scheduledTaskId: task.id,
        title: (this.#o.title ?? defaultTitle)(task, startedAt),
        ...(task.model !== undefined ? { model: task.model } : {}),
        // Tâche de projet : la conversation du run appartient au projet (ADR-003 D6).
        ...(task.projectId !== undefined ? { projectId: task.projectId } : {}),
      });
      request.update({
        status: 'running',
        startedAt: startedAt.toISOString(),
        sessionId: session.id,
      });

      const result = await this.#o.chats.runUnattended(session.id, task.prompt, {
        requestPermission: this.#o.permissionHandler(task.permissions, (action) => {
          denied.push(action);
        }),
        ...(this.#o.instructions !== undefined ? { instructions: this.#o.instructions } : {}),
        useSandbox: task.permissions.commands,
        // Sans la case « mémoire », les outils de mémoire ne sont pas proposés (ADR-003 D4).
        memory: task.permissions.memory === true,
        signal: controller.signal,
      });
      const summary = runSummary(result.message);
      const common: RunPatch = {
        turnId: result.turnId,
        files: producedFiles(result.message),
        denied,
        ...(summary !== undefined ? { summary } : {}),
      };
      if (deadline.reached) return finished({ ...common, status: 'timeout' });
      if (result.reason === 'aborted') return finished({ ...common, status: 'aborted' });
      // Réussi : tour terminé normalement, même avec des refus (signalés au tableau de bord).
      if (result.reason === 'stop' && !result.error)
        return finished({ ...common, status: 'success' });
      return finished({
        ...common,
        status: 'error',
        ...(result.error ? { error: result.error } : {}),
      });
    } catch (error) {
      return finished({ status: 'error', error: serializeError(error), denied });
    } finally {
      cancelTimeout();
      signal.removeEventListener('abort', onStop);
      stopKeepAwake?.();
      release?.();
    }
  }
}
