/**
 * Déplacement d'une conversation dans la colonne de gauche (#21) : glisser une
 * ligne de conversation sur une ligne de projet (elle y entre) ou sur la
 * section « Dossiers » (elle sort de son projet). Le menu « … › Déplacer vers
 * le projet… » fait la même chose au clavier.
 *
 * La règle est celle de `checkSessionMove` (shared) : le dossier de travail ne
 * change jamais, donc une conversation n'entre que dans un projet dont son
 * dossier est le dossier principal. Elle est évaluée ici pendant le survol,
 * sans IPC, puis revérifiée par le main (`session:set-project`).
 */
import type { DragEvent } from 'react';
import { checkSessionMove, type ProjectSummary, type SessionSummary } from '@atelier/shared';

/**
 * Type du glissement : jamais `text/plain`, pour que la saisie du Composer
 * n'accepte pas le dépôt, ni `Files`, réservé aux pièces jointes.
 */
export const SESSION_DRAG_TYPE = 'application/x-yodai-session';

/** Cible d'un dépôt : un projet, ou `null` pour « Hors projet » (section Dossiers). */
export type MoveTarget = ProjectSummary | null;

/** Verdict d'un dépôt : sans effet (déjà à sa place), permis, ou refusé avec son motif. */
export type MoveVerdict =
  { kind: 'none' } | { kind: 'allowed' } | { kind: 'refused'; reason: string };

/** Clé d'une cible de dépôt (survol en cours). */
export function targetKey(target: MoveTarget): string {
  return target === null ? 'folders' : `project:${target.id}`;
}

/** Un run planifié reste rattaché à sa tâche : il ne se glisse pas. */
export function canMove(session: Pick<SessionSummary, 'scheduledTaskId'>): boolean {
  return session.scheduledTaskId === undefined;
}

export function moveVerdict(session: SessionSummary, target: MoveTarget): MoveVerdict {
  if ((session.projectId ?? null) === (target?.id ?? null)) return { kind: 'none' };
  const reason = checkSessionMove(session, target ?? undefined);
  return reason === undefined ? { kind: 'allowed' } : { kind: 'refused', reason };
}

/** Projets où la conversation peut entrer (menu « Déplacer vers le projet… »). */
export function compatibleProjects(
  session: SessionSummary,
  projects: readonly ProjectSummary[],
): ProjectSummary[] {
  return projects.filter((project) => moveVerdict(session, project).kind === 'allowed');
}

export interface SessionMoveState {
  /** Projets non archivés de la colonne. */
  projects: readonly ProjectSummary[];
  /** Conversation en cours de glissement. */
  dragging: SessionSummary | undefined;
  /** Cible survolée ({@link targetKey}). */
  hover: string | undefined;
  startDrag: (session: SessionSummary) => void;
  setHover: (key: string | undefined) => void;
  /** Fin du glissement (dépôt, Échap, lâcher ailleurs). */
  endDrag: () => void;
  /** Appelle `session:set-project` ; l'appelant affiche le motif d'un refus. */
  move: (session: SessionSummary, target: MoveTarget) => void;
}

/** Props d'une ligne de conversation glissable (appelé dans une boucle : pas un hook). */
export function dragSource(
  ctx: SessionMoveState | undefined,
  session: SessionSummary,
): {
  draggable: boolean;
  /** Cette ligne est celle qui est glissée. */
  dragging: boolean;
  props: {
    onDragStart?: (event: DragEvent<HTMLElement>) => void;
    onDragEnd?: () => void;
  };
} {
  if (!ctx || !canMove(session)) return { draggable: false, dragging: false, props: {} };
  return {
    draggable: true,
    dragging: ctx.dragging?.id === session.id,
    props: {
      onDragStart: (event) => {
        event.dataTransfer.setData(SESSION_DRAG_TYPE, session.id);
        event.dataTransfer.effectAllowed = 'move';
        ctx.startDrag(session);
      },
      onDragEnd: ctx.endDrag,
    },
  };
}

/** Gestionnaires d'une cible de dépôt (vides hors glissement). */
export interface DropTargetProps {
  onDragEnter?: (event: DragEvent<HTMLElement>) => void;
  onDragOver?: (event: DragEvent<HTMLElement>) => void;
  onDragLeave?: (event: DragEvent<HTMLElement>) => void;
  onDrop?: (event: DragEvent<HTMLElement>) => void;
}

/**
 * Props et verdict d'une cible de dépôt (appelé dans une boucle : pas un hook).
 * Seul un dépôt permis annule `dragover` : sinon Chromium affiche le curseur
 * « interdit » et ignore le lâcher, et la cible affiche le motif.
 */
export function dropTarget(
  ctx: SessionMoveState | undefined,
  target: MoveTarget,
): {
  /** Verdict pour la conversation glissée, `none` hors survol. */
  verdict: MoveVerdict;
  props: DropTargetProps;
} {
  const dragging = ctx?.dragging;
  if (!ctx || !dragging) return { verdict: { kind: 'none' }, props: {} };
  const key = targetKey(target);
  const verdict = moveVerdict(dragging, target);
  const accept = (event: DragEvent<HTMLElement>): void => {
    if (ctx.hover !== key) ctx.setHover(key);
    if (verdict.kind !== 'allowed') return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  };
  return {
    verdict: ctx.hover === key ? verdict : { kind: 'none' },
    props: {
      onDragEnter: accept,
      onDragOver: accept,
      onDragLeave: (event) => {
        // Passage sur un élément de la cible : on la survole toujours.
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        if (ctx.hover === key) ctx.setHover(undefined);
      },
      onDrop: (event) => {
        event.preventDefault();
        const id = event.dataTransfer.getData(SESSION_DRAG_TYPE);
        ctx.endDrag();
        if (verdict.kind === 'allowed' && (id === '' || id === dragging.id)) {
          ctx.move(dragging, target);
        }
      },
    },
  };
}

/** Motif d'un refus, affiché sous la cible survolée (le `title` natif ne s'affiche pas pendant un glissement). */
export function RefusalTooltip({ id, reason }: { id: string; reason: string }) {
  return (
    <p
      id={id}
      role="tooltip"
      className="pointer-events-none absolute left-2 right-2 top-full z-30 mt-1 rounded-md border bg-popover px-2 py-1.5 text-xs text-popover-foreground shadow-md"
    >
      {reason}
    </p>
  );
}
