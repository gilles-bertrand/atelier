// @vitest-environment jsdom
/** Projets dans l'interface (ADR-003 D7) : colonne, création, page, mémoire, artefacts, tâches. */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  Artifact,
  ArtifactVersion,
  Project,
  ProjectMemory,
  ProjectSummary,
  ScheduledTask,
  SessionSummary,
} from '@atelier/shared';
import { App } from '@renderer/App';
import {
  defaultTestSettings,
  FakeIpcFailure,
  installFakeApi,
  type FakeApi,
} from '@renderer/test/fake-api';
import { ArtifactViewer, ARTIFACT_SANDBOX } from './ArtifactViewer';

const AT = '2026-10-31T09:00:00.000Z';

const project: Project = {
  id: 'p1',
  name: 'Ventes 2026',
  description: 'Suivi mensuel',
  instructions: 'Réponds en tableau.',
  folders: [
    { path: '/Users/test/Atelier/Projets/Ventes 2026', label: 'Ventes 2026', access: 'write' },
    { path: '/Users/test/Compta', label: 'Compta', access: 'read' },
  ],
  createdAt: AT,
  updatedAt: AT,
};

const summary: ProjectSummary = { ...project, conversations: 1, tasks: 1, artifacts: 1 };

const projectSession: SessionSummary = {
  id: 's-proj',
  title: 'Analyse des ventes',
  workspace: project.folders[0]?.path ?? '',
  createdAt: AT,
  updatedAt: AT,
  projectId: 'p1',
};

const folderSession: SessionSummary = {
  id: 's-dir',
  title: 'Notes libres',
  workspace: '/Users/test/Notes',
  createdAt: AT,
  updatedAt: '2026-10-30T09:00:00.000Z',
};

const artifact: Artifact = {
  id: 'a1',
  projectId: 'p1',
  path: '/Users/test/Atelier/Projets/Ventes 2026/Artefacts/ventes.html',
  title: 'Tableau des ventes',
  description: 'Ventes par mois',
  format: 'html',
  version: 3,
  createdAt: AT,
  updatedAt: AT,
  runId: 'r1',
  taskName: 'Rapport hebdo',
};

const versions: ArtifactVersion[] = [3, 2, 1].map((version) => ({
  artifactId: 'a1',
  version,
  size: 100,
  createdAt: AT,
  ...(version === 3 ? { taskName: 'Rapport hebdo' } : {}),
}));

const task: ScheduledTask = {
  id: 't1',
  name: 'Rapport hebdo',
  prompt: 'Mets à jour le tableau de bord',
  workspace: project.folders[0]?.path ?? '',
  projectId: 'p1',
  schedule: { kind: 'weekly', days: [1], time: '08:00' },
  permissions: { fileWrite: true, commands: false, webDomains: [], mcpTools: [] },
  maxDurationMinutes: 20,
  enabled: true,
  createdAt: AT,
  updatedAt: AT,
};

function setup(extra: Parameters<typeof installFakeApi>[0] = {}): FakeApi {
  let memory: ProjectMemory = { content: '## Notes\n\n- 30/10/2026 : PDF', revision: 1 };
  return installFakeApi({
    'settings:get': () => defaultTestSettings({ onboardingCompleted: true }),
    'session:list': ({ projectId }) =>
      projectId === 'p1' ? [projectSession] : [projectSession, folderSession],
    'session:create': ({ workspace, projectId }) => ({
      ...projectSession,
      id: 's-new',
      title: 'Nouvelle conversation',
      workspace,
      ...(projectId ? { projectId } : {}),
    }),
    'session:open': ({ sessionId }) => ({
      session: sessionId === 's-dir' ? folderSession : projectSession,
      messages: [],
    }),
    'project:list': () => [summary],
    'project:get': () => project,
    'project:create': ({ project: input }) => ({
      ...project,
      id: 'p2',
      name: input.name,
      folders: input.folders ?? [
        { path: `/Users/test/Atelier/Projets/${input.name}`, label: input.name, access: 'write' },
      ],
    }),
    'project:update': ({ patch }) => ({ ...project, ...patch }),
    'project:memory': () => memory,
    'project:memory-save': ({ content, baseRevision }) => {
      if (baseRevision !== memory.revision) {
        throw new FakeIpcFailure({
          code: 'project/conflict',
          message: 'changée',
          retryable: false,
        });
      }
      memory = { content, revision: memory.revision + 1, updatedAt: AT };
      return memory;
    },
    'project:memory-history': () => [],
    'artifact:list': () => [artifact],
    'artifact:get': () => artifact,
    'artifact:versions': () => versions,
    'schedule:list': () => [task],
    'llm:list-models': () => [{ name: 'qwen3.5:35b' }],
    'mcp:status': () => ({ servers: [], issues: [] }),
    'dialog:choose-directory': () => '/Users/test/Clients',
    ...extra,
  });
}

async function start(
  api?: FakeApi,
): Promise<{ user: ReturnType<typeof userEvent.setup>; api: FakeApi }> {
  const installed = api ?? setup();
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('list', { name: 'Projets' });
  return { user, api: installed };
}

describe('colonne de gauche : projets', () => {
  it('liste les projets ; les conversations de projet quittent la section Dossiers', async () => {
    await start();
    const projects = screen.getByRole('list', { name: 'Projets' });
    expect(within(projects).getByRole('button', { name: 'Ventes 2026' })).toBeInTheDocument();
    const folders = screen.getByRole('list', { name: 'Dossiers' });
    expect(within(folders).getByText('Notes')).toBeInTheDocument();
    expect(within(folders).queryByText('Ventes 2026')).toBeNull();
    // Déplié, le projet montre sa conversation.
    await userEvent.click(screen.getByRole('button', { name: 'Déplier le projet Ventes 2026' }));
    expect(
      within(screen.getByRole('list', { name: 'Conversations du projet Ventes 2026' })).getByText(
        'Analyse des ventes',
      ),
    ).toBeInTheDocument();
  });

  it('« Créer un projet à partir de ce dossier » appelle le main et ouvre la page', async () => {
    const api = setup({ 'project:from-folder': () => project });
    const { user } = await start(api);
    await user.click(screen.getByRole('button', { name: 'Actions pour le dossier « Notes »' }));
    await user.click(
      screen.getByRole('menuitem', { name: 'Créer un projet à partir de ce dossier' }),
    );
    expect(api.callsTo('project:from-folder')).toEqual([{ workspace: '/Users/test/Notes' }]);
    expect(await screen.findByRole('tablist', { name: 'Sections du projet' })).toBeInTheDocument();
  });
});

describe('nouveau projet', () => {
  it('crée le dossier par défaut, puis rattache les dossiers ajoutés', async () => {
    const { user, api } = await start();
    await user.click(screen.getByRole('button', { name: 'Nouveau projet' }));
    const dialog = screen.getByRole('dialog', { name: 'Nouveau projet' });
    await user.click(within(dialog).getByRole('button', { name: 'Créer le projet' }));
    expect(within(dialog).getByText('Donnez un nom au projet.')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Nom'), 'Clients');
    expect(within(dialog).getByText('~/Atelier/Projets/Clients')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Ajouter un dossier' }));
    await user.selectOptions(
      within(dialog).getByLabelText('Accès au dossier Clients'),
      'Lecture seule',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Créer le projet' }));
    await waitFor(() => {
      expect(api.callsTo('project:create')).toEqual([{ project: { name: 'Clients' } }]);
    });
    expect(api.callsTo('project:update')[0]?.patch.folders).toEqual([
      { path: '/Users/test/Atelier/Projets/Clients', label: 'Clients', access: 'write' },
      { path: '/Users/test/Clients', label: 'Clients', access: 'read' },
    ]);
    expect(await screen.findByRole('tablist', { name: 'Sections du projet' })).toBeInTheDocument();
  });
});

describe('page du projet', () => {
  async function openProject(): Promise<{
    user: ReturnType<typeof userEvent.setup>;
    api: FakeApi;
  }> {
    const started = await start();
    await started.user.click(screen.getByRole('button', { name: 'Ventes 2026' }));
    await screen.findByRole('tablist', { name: 'Sections du projet' });
    return started;
  }

  it('conversations, puis nouvelle conversation dans le dossier principal du projet', async () => {
    const { user, api } = await openProject();
    expect(await screen.findByRole('list', { name: 'Conversations du projet' })).toHaveTextContent(
      'Analyse des ventes',
    );
    await user.click(screen.getByRole('button', { name: 'Nouvelle conversation dans le projet' }));
    await waitFor(() => {
      expect(api.callsTo('session:create')).toEqual([
        { workspace: '/Users/test/Atelier/Projets/Ventes 2026', projectId: 'p1' },
      ]);
    });
  });

  it('mémoire : édition avec révision lue, conflit expliqué ; consignes enregistrées', async () => {
    const { user, api } = await openProject();
    await user.click(screen.getByRole('tab', { name: 'Mémoire et consignes' }));
    await screen.findByText(/30\/10\/2026 : PDF/);
    await user.click(screen.getByRole('button', { name: 'Modifier' }));
    const editor = screen.getByLabelText('Mémoire du projet');
    await user.clear(editor);
    await user.type(editor, 'Nouvelle mémoire');
    await user.click(screen.getByRole('button', { name: 'Enregistrer la mémoire' }));
    await waitFor(() => {
      expect(api.callsTo('project:memory-save')).toEqual([
        { id: 'p1', content: 'Nouvelle mémoire', baseRevision: 1 },
      ]);
    });
    // Seconde édition avec une révision dépassée côté main : message clair.
    api.handlers['project:memory'] = () => ({ content: 'autre', revision: 1 });
    act(() => {
      api.emit('project:changed', { projectId: 'p1' });
    });
    await user.click(await screen.findByRole('button', { name: 'Modifier' }));
    await user.click(screen.getByRole('button', { name: 'Enregistrer la mémoire' }));
    expect(await screen.findByText(/a changé entre-temps/)).toBeInTheDocument();

    const instructions = screen.getByLabelText('Consignes du projet');
    await user.clear(instructions);
    await user.type(instructions, 'Toujours en tableau.');
    await user.click(screen.getByRole('button', { name: 'Enregistrer les consignes' }));
    await waitFor(() => {
      expect(api.callsTo('project:update')).toEqual([
        { id: 'p1', patch: { instructions: 'Toujours en tableau.' } },
      ]);
    });
  });

  it('dossiers : changer un accès puis enregistrer toute la liste', async () => {
    const { user, api } = await openProject();
    await user.click(screen.getByRole('tab', { name: 'Dossiers' }));
    expect(screen.getByText('Principal')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Définir comme principal' })).toBeInTheDocument();
    await user.selectOptions(
      screen.getByLabelText('Accès au dossier Compta'),
      'Lecture et écriture',
    );
    await user.click(screen.getByRole('button', { name: 'Enregistrer les dossiers' }));
    await waitFor(() => {
      expect(api.callsTo('project:update')[0]?.patch.folders?.[1]).toEqual({
        path: '/Users/test/Compta',
        label: 'Compta',
        access: 'write',
      });
    });
  });

  it('artefacts : vignette, puis page dans une iframe isolée avec ses versions', async () => {
    const { user } = await openProject();
    await user.click(screen.getByRole('tab', { name: 'Artefacts' }));
    await user.click(
      await screen.findByRole('button', { name: 'Ouvrir l’artefact « Tableau des ventes »' }),
    );
    const frame = await screen.findByTitle('Page « Tableau des ventes »');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame).toHaveAttribute('src', 'atelier-artifact://a1/v3/');
    await user.selectOptions(screen.getByLabelText('Version affichée'), '1');
    expect(screen.getByTitle('Page « Tableau des ventes »')).toHaveAttribute(
      'src',
      'atelier-artifact://a1/v1/',
    );
  });

  it('tâches du projet ; « Nouvelle tâche » présélectionne le projet et propose la mémoire', async () => {
    const { user, api } = await openProject();
    await user.click(screen.getByRole('tab', { name: 'Tâches' }));
    expect(await screen.findByRole('list', { name: 'Tâches du projet' })).toHaveTextContent(
      'Chaque lundi à 08:00',
    );
    await user.click(screen.getByRole('button', { name: 'Nouvelle tâche' }));
    const projectSelect = await screen.findByLabelText('Projet');
    await waitFor(() => {
      expect(projectSelect).toHaveValue('p1');
    });
    expect(screen.queryByRole('button', { name: 'Choisir…' })).toBeNull();
    await user.click(screen.getByLabelText('Mettre à jour la mémoire du projet'));
    await user.type(screen.getByLabelText('Nom'), 'Tableau hebdo');
    await user.type(screen.getByLabelText('Demande'), 'Mets à jour le tableau de bord');
    api.handlers['schedule:save'] = ({ task: input }) => ({ ...task, ...input, id: 't2' });
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => {
      expect(api.callsTo('schedule:save')[0]?.task).toMatchObject({
        projectId: 'p1',
        workspace: '/Users/test/Atelier/Projets/Ventes 2026',
        permissions: { fileWrite: true, memory: true },
      });
    });
  });
});

describe('visionneuse d’artefact', () => {
  it('rend un artefact Markdown sans iframe et suit les nouvelles versions', async () => {
    const api = setup({
      'artifact:get': () => ({ ...artifact, format: 'markdown', version: 1 }),
      'artifact:versions': () => [{ artifactId: 'a1', version: 1, size: 10, createdAt: AT }],
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('# Bilan du mois', { status: 200 }));
    render(<ArtifactViewer id="a1" />);
    expect(await screen.findByRole('heading', { name: 'Bilan du mois' })).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith('atelier-artifact://a1/v1/');
    expect(screen.queryByTitle(/Page/)).toBeNull();
    expect(ARTIFACT_SANDBOX).toBe('allow-scripts');
    act(() => {
      api.emit('artifact:changed', { artifact: { ...artifact, id: 'a1' }, deleted: true });
    });
    expect(await screen.findByText('Cet artefact a été retiré de l’app.')).toBeInTheDocument();
    fetchSpy.mockRestore();
  });
});

describe('artefact publié dans le chat', () => {
  it('la carte ouvre la page dans le panneau droit, à la place du suivi', async () => {
    const api = setup({
      'session:open': () => ({
        session: projectSession,
        messages: [
          {
            id: 'm1',
            sessionId: 's-proj',
            role: 'assistant',
            createdAt: AT,
            parts: [
              {
                type: 'tool_call',
                toolCallId: 'c1',
                toolName: 'publish_artifact',
                input: { path: 'Artefacts/ventes.html', title: 'Tableau des ventes' },
                status: 'success',
                output: 'Artefact publié',
                display: {
                  type: 'artifact',
                  artifact: {
                    id: 'a1',
                    title: 'Tableau des ventes',
                    version: 3,
                    format: 'html',
                    path: artifact.path,
                  },
                },
              },
              { type: 'text', text: 'Voici le tableau de bord.' },
            ],
          },
        ],
      }),
    });
    const { user } = await start(api);
    await user.click(screen.getByRole('button', { name: 'Déplier le projet Ventes 2026' }));
    await user.click(
      within(screen.getByRole('list', { name: 'Conversations du projet Ventes 2026' })).getByText(
        'Analyse des ventes',
      ),
    );
    // La pastille du projet remplace le nom du dossier dans l'en-tête.
    expect(await screen.findByTitle('Ouvrir le projet « Ventes 2026 »')).toBeInTheDocument();
    const card = await screen.findByRole('button', {
      name: 'Ouvrir l’artefact « Tableau des ventes » (version 3)',
    });
    await user.click(card);
    const frame = await screen.findByTitle('Page « Tableau des ventes »');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    expect(card).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Fermer l’artefact' }));
    expect(screen.queryByTitle('Page « Tableau des ventes »')).toBeNull();
  });
});
