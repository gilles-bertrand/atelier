// @vitest-environment jsdom
/**
 * Déplacement d'une conversation dans la colonne de gauche (#21) : glisser sur
 * un projet ou sur « Dossiers », refus avec motif, menu « Déplacer vers le
 * projet… » au clavier.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ProjectSummary, SessionSummary } from '@atelier/shared';
import { App } from '@renderer/App';
import {
  defaultTestSettings,
  FakeIpcFailure,
  installFakeApi,
  type FakeApi,
} from '@renderer/test/fake-api';
import { ConversationList } from './ConversationList';
import {
  canMove,
  compatibleProjects,
  moveVerdict,
  SESSION_DRAG_TYPE,
  type SessionMoveState,
} from './session-move';

const AT = '2026-11-10T09:00:00.000Z';
const VENTES = '/Users/test/Ventes';
const COMPTA = '/Users/test/Compta';

const projectOf = (id: string, name: string, primary: string): ProjectSummary => ({
  id,
  name,
  description: '',
  instructions: '',
  folders: [{ path: primary, label: name, access: 'write' }],
  createdAt: AT,
  updatedAt: AT,
  conversations: 0,
  tasks: 0,
  artifacts: 0,
});

const ventesProject = projectOf('p-ventes', 'Ventes 2026', VENTES);
const comptaProject = projectOf('p-compta', 'Compta 2026', COMPTA);

const session = (
  id: string,
  title: string,
  workspace: string,
  extra: Partial<SessionSummary> = {},
): SessionSummary => ({ id, title, workspace, createdAt: AT, updatedAt: AT, ...extra });

/** DataTransfer factice (jsdom n'en a pas) : un même objet suit tout le glissement. */
function dataTransfer() {
  const data = new Map<string, string>();
  return {
    dropEffect: 'none',
    effectAllowed: 'all',
    get types() {
      return [...data.keys()];
    },
    setData: (type: string, value: string) => {
      data.set(type, value);
    },
    getData: (type: string) => data.get(type) ?? '',
  };
}

let api: FakeApi;
let sessions: SessionSummary[];

beforeEach(() => {
  sessions = [
    session('s-dir', 'Notes ventes', VENTES),
    session('s-proj', 'Analyse compta', COMPTA, { projectId: 'p-compta' }),
    session('s-libre', 'Idées', '/Users/test/Notes'),
  ];
  api = installFakeApi({
    'settings:get': () => defaultTestSettings({ onboardingCompleted: true }),
    'session:list': () => sessions,
    'session:open': ({ sessionId }) => ({
      session: sessions.find((s) => s.id === sessionId) ?? session(sessionId, '?', VENTES),
      messages: [],
    }),
    'project:list': () => [ventesProject, comptaProject],
    'session:set-project': ({ sessionId, projectId }) => {
      const current = sessions.find((s) => s.id === sessionId);
      if (!current) throw new Error('inconnue');
      const { projectId: _old, ...rest } = current;
      const moved = projectId === null ? rest : { ...rest, projectId };
      sessions = sessions.map((s) => (s.id === sessionId ? moved : s));
      return moved;
    },
  });
});

async function start() {
  const user = userEvent.setup();
  render(<App />);
  const sidebar = await screen.findByRole('navigation', { name: 'Barre latérale' });
  await within(sidebar).findByRole('list', { name: 'Conversations récentes' });
  await within(sidebar).findByRole('list', { name: 'Projets' });
  return { user, sidebar };
}

/** Ligne glissable d'une conversation dans « Récentes ». */
function recentRow(title: string): HTMLElement {
  const recent = screen.getByRole('list', { name: 'Conversations récentes' });
  const row = within(recent).getByText(title).closest('li');
  if (!row) throw new Error(`ligne ${title} introuvable`);
  return row;
}

/** Ligne (cible de dépôt) d'un projet. */
function projectRow(name: string): HTMLElement {
  const list = screen.getByRole('list', { name: 'Projets' });
  const row = within(list).getByRole('button', { name }).closest('li');
  if (!row) throw new Error(`projet ${name} introuvable`);
  return row;
}

describe('glisser-déposer une conversation (#21)', () => {
  it('entre dans le projet de son dossier : cible en évidence, dépôt, conversation rangée', async () => {
    const { sidebar } = await start();
    const source = recentRow('Notes ventes');
    expect(source).toHaveAttribute('draggable', 'true');
    const dt = dataTransfer();
    fireEvent.dragStart(source, { dataTransfer: dt });
    expect(dt.getData(SESSION_DRAG_TYPE)).toBe('s-dir');
    expect(dt.effectAllowed).toBe('move');

    const target = projectRow('Ventes 2026');
    // `dragover` annulé : le dépôt est permis.
    expect(fireEvent.dragEnter(target, { dataTransfer: dt })).toBe(false);
    expect(fireEvent.dragOver(target, { dataTransfer: dt })).toBe(false);
    expect(dt.dropEffect).toBe('move');
    expect(target).toHaveAttribute('data-drop-target', 'allowed');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    fireEvent.drop(target, { dataTransfer: dt });
    fireEvent.dragEnd(source, { dataTransfer: dt });
    await waitFor(() => {
      expect(api.callsTo('session:set-project')).toEqual([
        { sessionId: 's-dir', projectId: 'p-ventes' },
      ]);
    });
    // Le projet se déplie sur sa nouvelle conversation ; plus de mise en évidence.
    const list = await within(sidebar).findByRole('list', {
      name: 'Conversations du projet Ventes 2026',
    });
    expect(within(list).getByText('Notes ventes')).toBeInTheDocument();
    expect(projectRow('Ventes 2026')).not.toHaveAttribute('data-drop-target');
  });

  it('projet d’un autre dossier : pas de mise en évidence, curseur interdit, motif en infobulle', async () => {
    await start();
    const dt = dataTransfer();
    fireEvent.dragStart(recentRow('Notes ventes'), { dataTransfer: dt });
    const target = projectRow('Compta 2026');
    // `dragover` non annulé : Chromium affiche le curseur « interdit » et ignore le lâcher.
    expect(fireEvent.dragOver(target, { dataTransfer: dt })).toBe(true);
    expect(target).not.toHaveAttribute('data-drop-target');
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent(
      'Cette conversation travaille dans un autre dossier que celui du projet « Compta 2026 »',
    );
    expect(target).toHaveAttribute('aria-describedby', tip.id);

    fireEvent.dragLeave(target, { dataTransfer: dt, relatedTarget: document.body });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    fireEvent.drop(target, { dataTransfer: dt });
    expect(api.callsTo('session:set-project')).toEqual([]);
  });

  it('d’une cible à l’autre : dragenter(B) avant dragleave(A) laisse B en évidence', async () => {
    await start();
    const dt = dataTransfer();
    fireEvent.dragStart(recentRow('Notes ventes'), { dataTransfer: dt });
    const refused = projectRow('Compta 2026');
    const allowed = projectRow('Ventes 2026');
    fireEvent.dragOver(refused, { dataTransfer: dt });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    // Ordre de Chromium, dans un même rendu : la closure de A lit encore « A survolé ».
    act(() => {
      fireEvent.dragEnter(allowed, { dataTransfer: dt });
      fireEvent.dragLeave(refused, { dataTransfer: dt, relatedTarget: allowed });
    });
    expect(allowed).toHaveAttribute('data-drop-target', 'allowed');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('sur « Dossiers » : sort la conversation de son projet ; sans effet hors projet', async () => {
    await start();
    const folders = screen.getByRole('region', { name: 'Dossiers' });

    // Conversation déjà hors projet : rien à faire, ni mise en évidence ni motif.
    const idle = dataTransfer();
    fireEvent.dragStart(recentRow('Notes ventes'), { dataTransfer: idle });
    expect(fireEvent.dragOver(folders, { dataTransfer: idle })).toBe(true);
    expect(folders).not.toHaveAttribute('data-drop-target');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    fireEvent.dragEnd(recentRow('Notes ventes'), { dataTransfer: idle });

    const dt = dataTransfer();
    const source = recentRow('Analyse compta');
    fireEvent.dragStart(source, { dataTransfer: dt });
    expect(fireEvent.dragOver(folders, { dataTransfer: dt })).toBe(false);
    expect(folders).toHaveAttribute('data-drop-target', 'allowed');
    fireEvent.drop(folders, { dataTransfer: dt });
    await waitFor(() => {
      expect(api.callsTo('session:set-project')).toEqual([
        { sessionId: 's-proj', projectId: null },
      ]);
    });
    // Son dossier apparaît dans « Dossiers », déplié sur elle.
    const compta = await within(folders).findByRole('list', {
      name: 'Conversations du dossier Compta',
    });
    expect(within(compta).getByText('Analyse compta')).toBeInTheDocument();
  });

  it('refus du main (règle revérifiée) : le motif s’affiche', async () => {
    api.handlers['session:set-project'] = () => {
      throw new FakeIpcFailure({
        code: 'session/move_refused',
        message: 'Le projet « Ventes 2026 » est archivé : désarchivez-le d’abord.',
        retryable: false,
      });
    };
    await start();
    const dt = dataTransfer();
    fireEvent.dragStart(recentRow('Notes ventes'), { dataTransfer: dt });
    const target = projectRow('Ventes 2026');
    fireEvent.dragOver(target, { dataTransfer: dt });
    fireEvent.drop(target, { dataTransfer: dt });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Le projet « Ventes 2026 » est archivé : désarchivez-le d’abord.',
    );
  });
});

describe('menu « Déplacer vers le projet… » (#21)', () => {
  async function openMove(user: ReturnType<typeof userEvent.setup>, title: string) {
    const recent = screen.getByRole('list', { name: 'Conversations récentes' });
    await user.click(within(recent).getByRole('button', { name: `Actions pour « ${title} »` }));
    await user.click(screen.getByRole('menuitem', { name: 'Déplacer vers le projet…' }));
    return screen.getByRole('group', { name: `Déplacer « ${title} » vers :` });
  }

  it('propose les projets compatibles ; Entrée déplace la conversation ouverte', async () => {
    const { user } = await start();
    await user.click(within(recentRow('Notes ventes')).getByText('Notes ventes'));
    await screen.findByText('Que puis-je faire pour vous ?');

    const panel = await openMove(user, 'Notes ventes');
    const destinations = within(panel).getByRole('list', { name: 'Destinations' });
    // « Compta 2026 » travaille dans un autre dossier ; pas de « Hors projet » hors projet.
    expect(
      within(destinations)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Ventes 2026']);
    expect(within(destinations).getByRole('button', { name: 'Ventes 2026' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(api.callsTo('session:set-project')).toEqual([
        { sessionId: 's-dir', projectId: 'p-ventes' },
      ]);
    });
    // La conversation ouverte suit : la puce du projet remplace le nom du dossier.
    expect(await screen.findByTitle('Ouvrir le projet « Ventes 2026 »')).toBeInTheDocument();
  });

  it('conversation de projet : « Hors projet » ; Échap annule', async () => {
    const { user } = await start();
    let panel = await openMove(user, 'Analyse compta');
    await user.keyboard('{Escape}');
    expect(panel).not.toBeInTheDocument();
    expect(api.callsTo('session:set-project')).toEqual([]);
    // Le focus revient au bouton « … » de la ligne, comme à la fermeture du menu.
    expect(
      within(screen.getByRole('list', { name: 'Conversations récentes' })).getByRole('button', {
        name: 'Actions pour « Analyse compta »',
      }),
    ).toHaveFocus();

    panel = await openMove(user, 'Analyse compta');
    const leave = within(panel).getByRole('button', { name: 'Hors projet' });
    expect(leave).toHaveFocus();
    await user.click(leave);
    await waitFor(() => {
      expect(api.callsTo('session:set-project')).toEqual([
        { sessionId: 's-proj', projectId: null },
      ]);
    });
  });

  it('aucun projet dans ce dossier : explique comment en créer un', async () => {
    const { user } = await start();
    const panel = await openMove(user, 'Idées');
    expect(within(panel).queryByRole('list', { name: 'Destinations' })).not.toBeInTheDocument();
    expect(panel).toHaveTextContent('Aucun projet ne travaille dans le dossier « Notes »');
    expect(within(panel).getByRole('button', { name: 'Annuler' })).toHaveFocus();
  });
});

describe('règle côté renderer (sans IPC)', () => {
  it('verdicts : permis, sans effet, refusé ; run planifié jamais déplacé', () => {
    const dir = session('a', 'A', VENTES);
    expect(moveVerdict(dir, ventesProject)).toEqual({ kind: 'allowed' });
    expect(moveVerdict(dir, null)).toEqual({ kind: 'none' });
    expect(moveVerdict(dir, comptaProject)).toMatchObject({ kind: 'refused' });
    expect(moveVerdict({ ...dir, projectId: 'p-ventes' }, ventesProject)).toEqual({
      kind: 'none',
    });
    expect(moveVerdict({ ...dir, projectId: 'p-ventes' }, null)).toEqual({ kind: 'allowed' });
    expect(
      moveVerdict({ ...dir, projectId: 'p-ventes' }, { ...ventesProject, id: 'p-jumeau' }),
    ).toEqual({ kind: 'allowed' });
    expect(compatibleProjects(dir, [ventesProject, comptaProject])).toEqual([ventesProject]);
    expect(canMove({ scheduledTaskId: 't1' })).toBe(false);
  });

  it('un run planifié n’est ni glissable ni dans le menu', async () => {
    const user = userEvent.setup();
    const state: SessionMoveState = {
      projects: [ventesProject],
      dragging: undefined,
      hover: undefined,
      startDrag: () => undefined,
      setHover: () => undefined,
      clearHover: () => undefined,
      endDrag: () => undefined,
      move: () => undefined,
    };
    render(
      <ConversationList
        label="Liste"
        sessions={[
          session('run', 'Run du lundi', VENTES, { scheduledTaskId: 't1' }),
          session('libre', 'Libre', VENTES),
        ]}
        currentId={undefined}
        onOpen={() => undefined}
        onDelete={() => Promise.resolve()}
        move={state}
      />,
    );
    const run = screen.getByText('Run du lundi').closest('li');
    expect(run).not.toHaveAttribute('draggable');
    expect(screen.getByText('Libre').closest('li')).toHaveAttribute('draggable', 'true');
    await user.click(screen.getByRole('button', { name: 'Actions pour « Run du lundi »' }));
    expect(screen.getByRole('menuitem', { name: 'Supprimer' })).toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: 'Déplacer vers le projet…' }),
    ).not.toBeInTheDocument();
  });
});
